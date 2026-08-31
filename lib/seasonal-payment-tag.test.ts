import { test } from 'node:test'
import assert from 'node:assert/strict'
import { laneBalances, LANES, normalizeBillingMode } from './ledger-lanes.ts'
import { normalizeLaneSplit, laneSplitTotal } from './lane-payments.ts'

// TAGGING A SEASONAL PAYMENT IN COMBINED MODE.
//
// The load-bearing test is THE WHOLE-ACCOUNT BALANCE INVARIANT: a lane tag is metadata, so the
// account must total to exactly the same figure with it and without it. If that ever stops being
// true, a display grouping has started moving money and the change must not ship.

const ctx = { electricLineItemIds: new Set(['elec-1']) }
const items = [
  { id: 'fee-1',  line_total: 169500, lane: 'seasonal' },   // the $1,695 seasonal fee
  { id: 'elec-1', line_total: 8500 },                       // electric
  { id: 'pos-1',  line_total: 900, product_id: 'p1' },      // store tab
]
/** The same $1,695 payment, recorded the old way and the new way. */
const untaggedPay = [{ amount: 169500 }]
const taggedPay   = [{ amount: 169500, lane: 'seasonal' }]

test('THE WHOLE-ACCOUNT BALANCE IS IDENTICAL WITH AND WITHOUT THE TAG', () => {
  const before = laneBalances(items, untaggedPay, ctx)
  const after  = laneBalances(items, taggedPay, ctx)
  assert.equal(after.accountBalance, before.accountBalance,
    'tagging a lane must not move the account balance by one cent')
  assert.equal(after.totalCharges, before.totalCharges)
  assert.equal(after.totalPayments, before.totalPayments)
  assert.equal(before.accountBalance, 169500 + 8500 + 900 - 169500)
})

test('AND THE SEASONAL SUB-BALANCE NOW REFLECTS THE PAYMENT — the point of the change', () => {
  const before = laneBalances(items, untaggedPay, ctx)
  const after  = laneBalances(items, taggedPay, ctx)
  assert.equal(before.byLane.seasonal.balance, 169500, 'untagged: the fee looks unpaid')
  assert.equal(after.byLane.seasonal.balance, 0, 'tagged: the fee is settled')
  assert.equal(before.untaggedPayments, 169500)
  assert.equal(after.untaggedPayments, 0)
})

test('STORE AND ELECTRIC ARE UNTOUCHED by tagging the seasonal payment', () => {
  const after = laneBalances(items, taggedPay, ctx)
  assert.equal(after.byLane.electric.balance, 8500, 'electric is still owed, on its own tab')
  assert.equal(after.byLane.store.balance, 900, 'so is the store tab')
})

test('the lane split still sums to the account, tagged or not', () => {
  for (const pays of [untaggedPay, taggedPay]) {
    const b = laneBalances(items, pays, ctx)
    const laneSum = LANES.reduce((s, l) => s + b.byLane[l].balance, 0)
    assert.equal(laneSum - b.untaggedPayments, b.accountBalance)
  }
})

test('COMBINED MODE IS NOT A GATE — the tag is written whatever the mode says', () => {
  // billing_mode governs DISPLAY. The bug this fixes was tagging only in separated mode, which
  // left combined parks — the default, and Cady — unable to separate seasonal money at all.
  assert.equal(normalizeBillingMode(null), 'combined')
  assert.equal(normalizeBillingMode('separated'), 'separated')
  // laneBalances reads the tag identically either way; nothing here consults the mode.
  const b = laneBalances(items, taggedPay, ctx)
  assert.equal(b.byLane.seasonal.balance, 0)
})

test('a "whole account" payment is byte-identical to one recorded before this existed', () => {
  // The escape hatch has to be a true no-op, or the change is not additive.
  const b = laneBalances(items, [{ amount: 50000 }], ctx)
  assert.equal(b.untaggedPayments, 50000)
  assert.equal(b.byLane.seasonal.balance, 169500, 'not applied to any lane')
  assert.equal(b.accountBalance, 169500 + 8500 + 900 - 50000)
})

// ── the card path sends a ONE-LANE split ─────────────────────────────────────────────────────

test('A ONE-LANE SPLIT MUST CARRY THE GROSS — this caught a real undercharge', () => {
  // ⚠ In a split row `amount` is the GROSS, surcharge included: laneSplitTotal() sums exactly it
  // to decide what the card is charged, and folio_payments.amount is stored gross. Passing the
  // NET here would have charged the card $1,695 instead of $1,745.85 and silently dropped the
  // surcharge — the untagged path sends the gross, so the tagged one must too.
  const gross = 169500 + 5085
  const split = normalizeLaneSplit([{ lane: 'seasonal', amount: gross, surchargeAmount: 5085 }])
  assert.equal(split.length, 1)
  assert.equal(split[0].lane, 'seasonal')
  assert.equal(laneSplitTotal(split), gross, 'the card is charged exactly what the untagged path charges')
  const b = laneBalances(items, [{ amount: gross, surcharge_amount: 5085, lane: 'seasonal' }], ctx)
  assert.equal(b.byLane.seasonal.balance, 0, 'and the fee still settles on the NET')
})

test('no lane means no split — the untagged card path is unchanged', () => {
  assert.deepEqual(normalizeLaneSplit(undefined), [])
  assert.deepEqual(normalizeLaneSplit([]), [])
})

test('A CARD SURCHARGE IS NOT PAID AGAINST THE FEE', () => {
  // The fee is settled by the net; the surcharge is the processor's, not the camper's site.
  const b = laneBalances([{ id: 'f', line_total: 169500, lane: 'seasonal' }],
    [{ amount: 174585, surcharge_amount: 5085, lane: 'seasonal' }], ctx)
  assert.equal(b.byLane.seasonal.balance, 0)
  assert.equal(b.totalPayments, 169500, 'not 174585')
})
