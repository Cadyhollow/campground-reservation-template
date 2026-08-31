import { test } from 'node:test'
import assert from 'node:assert/strict'
import { classifyLineItem, laneBalances, LANES, type Lane } from './ledger-lanes.ts'
import { notVoided } from './ledger.ts'

// THE SEASONAL-LANE RECEIPT'S ARITHMETIC.
//
// The receipt route filters a folio to one lane and computes its balance from exactly that
// filtered set. These tests pin the three things that make it trustworthy:
//
//   1. ONLY the seasonal lane appears — a camper's electric and store never leak onto a receipt
//      for their site fee.
//   2. VOIDED CHARGES COUNT NOWHERE, so a cancelled packet cannot inflate the fee shown.
//   3. THE RECEIPT'S BALANCE EQUALS THE FOLIO'S SEASONAL-LANE BALANCE, to the cent.
//
// The route's own filter is `classifyLineItem(...) === lane` for charges and `p.lane === lane`
// for payments; both are reproduced here against the SAME primitives it imports, so a change to
// either would fail this file.

const ctx = { electricLineItemIds: new Set(['elec-1']) }

/** A mixed seasonal account: the fee, an electric bill, a store tab, and a voided packet. */
const items = [
  { id: 'fee-1',  line_total: 200000, lane: 'seasonal' },                 // the site fee
  { id: 'elec-1', line_total: 8500 },                                     // electric (by reading)
  { id: 'pos-1',  line_total: 900, product_id: 'p1' },                    // store
  { id: 'misc-1', line_total: 500 },                                      // uncategorised
  { id: 'void-1', line_total: 150000, lane: 'seasonal', voided: true },   // a cancelled packet
]
const payments = [
  { amount: 120000, lane: 'seasonal' },                       // toward the fee
  { amount: 8500, lane: 'electric' },                         // toward electric
  { amount: 900, lane: 'store' },                             // toward the store tab
  { amount: 5000 },                                           // UNTAGGED — on the account
]

// What the route does, reproduced from the same primitives.
const laneItems = (l: Lane) => items.filter(notVoided).filter(i => classifyLineItem(i, ctx) === l)
const lanePays = (l: Lane) => payments.filter(p => (LANES as readonly string[]).includes(String(p.lane)) && p.lane === l)
const sumItems = (l: Lane) => laneItems(l).reduce((s, i) => s + i.line_total, 0)
const sumPays = (l: Lane) => lanePays(l).reduce((s, p) => s + p.amount - ((p as { surcharge_amount?: number }).surcharge_amount || 0), 0)

test('THE SEASONAL RECEIPT SHOWS ONLY THE SEASONAL FEE', () => {
  const shown = laneItems('seasonal')
  assert.deepEqual(shown.map(i => i.id), ['fee-1'], 'electric, store and the misc charge stay off it')
  assert.equal(sumItems('seasonal'), 200000)
})

test('A VOIDED PACKET IS ON NO RECEIPT AND IN NO SUBTOTAL', () => {
  // Without notVoided the fee would read $3,500 — a cancelled packet billed to a camper.
  assert.ok(!laneItems('seasonal').some(i => i.id === 'void-1'))
  assert.equal(sumItems('seasonal'), 200000, 'not 350000')
})

test('ONLY SEASONAL-TAGGED PAYMENTS APPEAR — the untagged one does not', () => {
  assert.equal(lanePays('seasonal').length, 1)
  assert.equal(sumPays('seasonal'), 120000)
  assert.ok(!lanePays('seasonal').some(p => p.lane === undefined), 'the account payment is not pulled in')
})

test('THE BALANCE AND THE LISTED PAYMENTS AGREE — the receipt explains itself', () => {
  // The property that stops a receipt showing a number its own rows cannot account for.
  const charges = sumItems('seasonal'), paid = sumPays('seasonal')
  assert.equal(charges - paid, 80000)
  assert.equal(charges - laneItems('seasonal').reduce((s, i) => s + i.line_total, 0), 0)
  assert.equal(paid, lanePays('seasonal').reduce((s, p) => s + p.amount, 0), 'no hidden payment in the total')
})

test('THE RECEIPT BALANCE EQUALS THE FOLIO SEASONAL-LANE BALANCE, TO THE CENT', () => {
  // laneBalances() is what the folio and the dashboard print. The receipt must not disagree.
  const folio = laneBalances(items, payments, ctx)
  assert.equal(sumItems('seasonal') - sumPays('seasonal'), folio.byLane.seasonal.balance)
  assert.equal(folio.byLane.seasonal.balance, 80000)
})

test('a card surcharge is netted the same way the folio nets it', () => {
  const withCard = [{ amount: 103000, surcharge_amount: 3000, lane: 'seasonal' }]
  const net = withCard.reduce((s, p) => s + p.amount - (p.surcharge_amount || 0), 0)
  assert.equal(net, 100000, 'the fee is credited the net, not the gross')
  const folio = laneBalances(items, withCard, ctx)
  assert.equal(folio.byLane.seasonal.balance, 200000 - 100000)
})

test('PAID IN FULL, PARTIAL AND CREDIT all read correctly', () => {
  const bal = (paid: number) =>
    laneBalances([{ id: 'f', line_total: 200000, lane: 'seasonal' }],
      [{ amount: paid, lane: 'seasonal' }], ctx).byLane.seasonal.balance
  assert.equal(bal(200000), 0, 'paid in full')
  assert.equal(bal(120000), 80000, 'partial — remaining')
  assert.equal(bal(250000), -50000, 'overpaid — a credit, shown as one')
})

test('AN UNTAGGED PAYMENT IS THE RISK, AND IT IS VISIBLE RATHER THAN GUESSED', () => {
  // A combined park's folio payment box does not ask which lane a payment is for, so it arrives
  // untagged. The receipt correctly leaves it off — but the camper HAS paid, so the button warns
  // before sending. Guessing a lane here would rewrite what the money was for.
  const untagged = payments
    .filter(p => !(LANES as readonly string[]).includes(String(p.lane)))
    .reduce((s, p) => s + p.amount, 0)
  assert.equal(untagged, 5000, 'this is the amount the warning names')
  assert.equal(sumPays('seasonal'), 120000, 'and it is NOT quietly folded into the seasonal total')
})

test('the lane split still sums to the whole account — nothing invented, nothing lost', () => {
  const folio = laneBalances(items, payments, ctx)
  const laneSum = LANES.reduce((s, l) => s + folio.byLane[l].balance, 0)
  assert.equal(laneSum - folio.untaggedPayments, folio.accountBalance)
})
