// Unit tests for the two-bucket view. Pure — `node --test`, no server, no DB.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { accountBuckets, paymentLaneForBucket, LANE_BUCKET, billAccountBalance, filterToBucket } from './account-buckets.ts'
import { laneBalances, type LaneBalances } from './ledger-lanes.ts'

const totals = (charges: number, payments: number) => ({ charges, payments, balance: charges - payments })

/** Build a LaneBalances directly, so bucket maths is tested in isolation from classification. */
function mkLanes(input: {
  electric?: [number, number]
  store?: [number, number]
  seasonal?: [number, number]
  other?: [number, number]
  untaggedPayments?: number
}): LaneBalances {
  const e = input.electric ?? [0, 0]
  const s = input.store ?? [0, 0]
  const se = input.seasonal ?? [0, 0]
  const o = input.other ?? [0, 0]
  const untagged = input.untaggedPayments ?? 0
  const byLane = {
    electric: totals(e[0], e[1]),
    store: totals(s[0], s[1]),
    seasonal: totals(se[0], se[1]),
    other: totals(o[0], o[1]),
  }
  const totalCharges = e[0] + s[0] + se[0] + o[0]
  const totalPayments = e[1] + s[1] + se[1] + o[1] + untagged
  return { byLane, untaggedPayments: untagged, totalCharges, totalPayments, accountBalance: totalCharges - totalPayments }
}

test('Karija (live): whole balance is seasonal, Camp is paid up', () => {
  // Real shape from the live park: account balance $903.63, all of it the unpaid half of a
  // $1,895 seasonal fee; everyday is fully paid via untagged checks.
  const b = accountBuckets(mkLanes({ store: [205618, 0], seasonal: [189500, 99137], untaggedPayments: 205618 }))
  assert.equal(b.seasonal.balance, 90363)      // $903.63 seasonal
  assert.equal(b.camp.balance, 0)              // Camp paid up — NOT the phantom "$1,865 store due"
  assert.equal(b.accountBalance, 90363)
  assert.equal(b.camp.balance + b.seasonal.balance, b.accountBalance)
})

test('Dannheim (live): paid in full is $0 / $0', () => {
  const b = accountBuckets(mkLanes({ store: [185080, 0], seasonal: [169500, 169500], untaggedPayments: 185080 }))
  assert.equal(b.camp.balance, 0)
  assert.equal(b.seasonal.balance, 0)
  assert.equal(b.accountBalance, 0)
})

test('THE INVARIANT: camp.balance + seasonal.balance === accountBalance', () => {
  const b = accountBuckets(mkLanes({
    electric: [5000, 1200], store: [8000, 0], seasonal: [190000, 90000], other: [1500, 0], untaggedPayments: 6000,
  }))
  assert.equal(b.seasonal.balance, 100000)
  assert.equal(b.camp.balance, 7300)
  assert.equal(b.camp.charges, 14500)          // electric + store + other
  assert.equal(b.camp.payments, 7200)          // electric-tagged 1200 + untagged 6000
  assert.equal(b.camp.balance + b.seasonal.balance, b.accountBalance)
})

test('a seasonal overpayment stays a Seasonal credit and does not bleed into Camp', () => {
  const b = accountBuckets(mkLanes({ store: [20000, 0], seasonal: [100000, 130000], untaggedPayments: 20000 }))
  assert.equal(b.seasonal.balance, -30000)     // $300 credit, in the Seasonal bucket
  assert.equal(b.camp.balance, 0)              // Camp unaffected
  assert.equal(b.camp.balance + b.seasonal.balance, b.accountBalance)
})

test('untagged (whole-account) payments reduce Camp, not Seasonal', () => {
  const b = accountBuckets(mkLanes({ store: [50000, 0], seasonal: [100000, 100000], untaggedPayments: 30000 }))
  assert.equal(b.seasonal.balance, 0)
  assert.equal(b.camp.balance, 20000)          // 50000 charged − 30000 untagged
  assert.equal(b.camp.payments, 30000)
})

test('paymentLaneForBucket: seasonal is tagged, camp stays untagged', () => {
  assert.equal(paymentLaneForBucket('seasonal'), 'seasonal')
  assert.equal(paymentLaneForBucket('camp'), null)
})

test('LANE_BUCKET folds electric/store/other into camp, seasonal alone', () => {
  assert.equal(LANE_BUCKET.electric, 'camp')
  assert.equal(LANE_BUCKET.store, 'camp')
  assert.equal(LANE_BUCKET.other, 'camp')
  assert.equal(LANE_BUCKET.seasonal, 'seasonal')
})

test('end to end through laneBalances(): real classification composes to the two buckets', () => {
  const items = [
    { id: 'sea1', line_total: 189500, lane: 'seasonal' },           // explicit seasonal tag
    { id: 'store1', line_total: 205618, product_id: 'p-firewood' }, // store by product_id
  ]
  const payments = [
    { amount: 99137, lane: 'seasonal' },  // tagged seasonal deposit
    { amount: 205618 },                   // untagged whole-account (everyday)
  ]
  const lanes = laneBalances(items, payments, { electricLineItemIds: new Set<string>() })
  const b = accountBuckets(lanes)
  assert.equal(b.seasonal.balance, 90363)
  assert.equal(b.camp.balance, 0)
  assert.equal(b.accountBalance, 90363)
})


// ── WHAT AN ELECTRIC BILL SAYS IS OWED ───────────────────────────────────────────────────────
//
// The scenario these protect against, stated once: a camper owes $32 for October's electric and
// still has $1,600 of their season fee outstanding. The bill must say $32.

test('⚠ SEPARATED: THE ELECTRIC BILL SHOWS CAMP, NEVER THE WHOLE ACCOUNT', () => {
  // Camp $32, Seasonal $1,600, account $1,632.
  const b = accountBuckets({
    byLane: {
      electric: { charges: 3200, payments: 0, balance: 3200 },
      store: { charges: 0, payments: 0, balance: 0 },
      seasonal: { charges: 160000, payments: 0, balance: 160000 },
      other: { charges: 0, payments: 0, balance: 0 },
    },
    untaggedPayments: 0,
    totalCharges: 163200,
    totalPayments: 0,
    accountBalance: 163200,
  })
  assert.equal(b.camp.balance, 3200)
  assert.equal(b.accountBalance, 163200)
  assert.equal(billAccountBalance('separated', b.camp.balance, b.accountBalance), 3200,
    'the bill must read $32.00, not $1,632.00')
})

test('COMBINED IS UNCHANGED: the bill shows the whole account, as it always has', () => {
  // Even when a camp balance is available, combined mode ignores it entirely.
  assert.equal(billAccountBalance('combined', 3200, 163200), 163200)
  assert.equal(billAccountBalance('combined', null, 163200), 163200)
})

test('a Camp balance that could not be derived falls back to the whole account, not to zero', () => {
  // No folio, or a read that failed. Sending the old figure beats sending "$0.00 due" — and
  // beats not sending at all.
  assert.equal(billAccountBalance('separated', null, 163200), 163200)
  assert.equal(billAccountBalance('separated', undefined, 163200), 163200)
})

test('a Camp balance of exactly zero is a real answer, not a missing one', () => {
  // The falsy trap: `campBalance || whole` would print the whole account for a paid-up camper.
  assert.equal(billAccountBalance('separated', 0, 163200), 0)
})

test('a Camp credit reaches the bill as a credit', () => {
  assert.equal(billAccountBalance('separated', -2500, 160000), -2500)
})


// ── SCOPING A STATEMENT TO ONE BUCKET ────────────────────────────────────────────────────────
//
// What the electric bill is built from. The camp statement must include the store tab — this park
// bills firewood and visitor fees ON the electric bill — and must include untagged payments, or
// its running balance would not reconcile to the Camp figure in the headline.

test('filterToBucket splits camp (electric+store+other, untagged pmts) from seasonal', () => {
  const ctx = { electricLineItemIds: new Set(['e1']) }
  const items = [
    { id: 'sea1', line_total: 189500, lane: 'seasonal' },
    { id: 'store1', line_total: 205618, product_id: 'p1' },
    { id: 'e1', line_total: 5211 },
  ]
  const payments = [
    { amount: 99137, lane: 'seasonal' },
    { amount: 205618 },                 // untagged → camp
    { amount: 5211, lane: 'electric' }, // electric-tagged → camp
  ]
  const camp = filterToBucket('camp', items, payments, ctx)
  assert.deepEqual(camp.items.map(i => i.id), ['store1', 'e1'])
  assert.equal(camp.payments.length, 2) // untagged + electric-tagged, NOT seasonal
  const seasonal = filterToBucket('seasonal', items, payments, ctx)
  assert.deepEqual(seasonal.items.map(i => i.id), ['sea1'])
  assert.equal(seasonal.payments.length, 1)
})

test('filterToBucket(camp) reconciles to accountBuckets(...).camp.balance', () => {
  const ctx = { electricLineItemIds: new Set<string>() }
  // Typed rather than cast: the optional fields are declared here so the sums below can read
  // `voided` and `surcharge_amount` without an `any` escape hatch.
  const items: { id: string; line_total: number; lane?: string; product_id?: string; voided?: boolean }[] = [
    { id: 'sea1', line_total: 189500, lane: 'seasonal' },
    { id: 'store1', line_total: 205618, product_id: 'p1' },
  ]
  const payments: { amount: number; lane?: string; surcharge_amount?: number }[] = [
    { amount: 99137, lane: 'seasonal' },
    { amount: 205618 },
  ]
  const camp = filterToBucket('camp', items, payments, ctx)
  const chargeSum = camp.items.filter(i => i.voided !== true).reduce((s, i) => s + i.line_total, 0)
  const paySum = camp.payments.reduce((s, p) => s + (p.amount - (p.surcharge_amount || 0)), 0)
  assert.equal(chargeSum - paySum, accountBuckets(laneBalances(items, payments, ctx)).camp.balance)
})
