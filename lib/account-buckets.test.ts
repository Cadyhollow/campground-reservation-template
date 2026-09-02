// Unit tests for the two-bucket view. Pure — `node --test`, no server, no DB.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { accountBuckets, paymentLaneForBucket, LANE_BUCKET, billAccountBalance, filterToBucket, seasonalBalanceOf, campFromAccount } from './account-buckets.ts'
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


// ── THE STAFF-FACING CAMP FIGURE ─────────────────────────────────────────────────────────────
//
// For screens that already hold a whole-account balance and need Camp without a second query.
// The scenario: a seasonal camper owing $1,600 of season fee and $32 of electric must not appear
// on the ELECTRIC screen as owing $1,632.

test('⚠ THE ELECTRIC SCREEN SHOWS CAMP, NOT THE WHOLE ACCOUNT', () => {
  const items = [
    { line_total: 160000, lane: 'seasonal' },
    { line_total: 3200, lane: 'electric' },
  ]
  const payments: { amount: number; lane?: string | null }[] = []
  const account = 163200
  const seasonal = seasonalBalanceOf(items, payments)
  assert.equal(seasonal, 160000)
  assert.equal(campFromAccount(account, seasonal), 3200, 'the pill must read $32.00, not $1,632.00')
})

test('an untagged payment reduces Camp, leaving the season fee owing', () => {
  const items = [{ line_total: 160000, lane: 'seasonal' }, { line_total: 3200, lane: 'electric' }]
  const payments = [{ amount: 3200 }]   // untagged — everyday money
  const account = 163200 - 3200
  const seasonal = seasonalBalanceOf(items, payments)
  assert.equal(seasonal, 160000, 'untagged money never touches Seasonal')
  assert.equal(campFromAccount(account, seasonal), 0, 'and it settles Camp exactly')
})

test('a seasonal payment reduces Seasonal only', () => {
  const items = [{ line_total: 160000, lane: 'seasonal' }, { line_total: 3200, lane: 'electric' }]
  const payments = [{ amount: 60000, lane: 'seasonal' }]
  assert.equal(seasonalBalanceOf(items, payments), 100000)
  assert.equal(campFromAccount(163200 - 60000, seasonalBalanceOf(items, payments)), 3200)
})

test('a camper with no seasonal money at all shows the whole account as Camp', () => {
  // The ordinary monthly/nightly camper on an electric screen — nothing changes for them.
  const items = [{ line_total: 3200, lane: 'electric' }, { line_total: 900 }]
  assert.equal(seasonalBalanceOf(items, []), 0)
  assert.equal(campFromAccount(4100, 0), 4100)
})

test('a seasonal overpayment is a Seasonal credit and does not inflate Camp', () => {
  const items = [{ line_total: 160000, lane: 'seasonal' }, { line_total: 3200 }]
  const payments = [{ amount: 200000, lane: 'seasonal' }]
  const seasonal = seasonalBalanceOf(items, payments)
  assert.equal(seasonal, -40000, 'a credit in its own bucket')
  assert.equal(campFromAccount(163200 - 200000, seasonal), 3200, 'Camp still owes its $32')
})

test('the surcharge is netted off a seasonal payment, as everywhere else', () => {
  const items = [{ line_total: 100000, lane: 'seasonal' }]
  const payments = [{ amount: 51500, surcharge_amount: 1500, lane: 'seasonal' }]
  assert.equal(seasonalBalanceOf(items, payments), 50000)
})

test('lane matching tolerates case and stray whitespace, and ignores anything else', () => {
  assert.equal(seasonalBalanceOf([{ line_total: 500, lane: ' Seasonal ' }], []), 500)
  assert.equal(seasonalBalanceOf([{ line_total: 500, lane: 'seasonally' }], []), 0)
  assert.equal(seasonalBalanceOf([{ line_total: 500, lane: null }], []), 0)
  assert.equal(seasonalBalanceOf(null, null), 0)
})

test('seasonalBalanceOf agrees with accountBuckets on the same rows', () => {
  // The two derivations must not drift: one is the full classifier, the other the shortcut.
  const items = [
    { id: 'a', line_total: 189500, lane: 'seasonal' },
    { id: 'b', line_total: 205618, product_id: 'p1' },
  ]
  const payments = [{ amount: 99137, lane: 'seasonal' }, { amount: 205618 }]
  const full = accountBuckets(laneBalances(items, payments, { electricLineItemIds: new Set<string>() }))
  assert.equal(seasonalBalanceOf(items, payments), full.seasonal.balance)
  assert.equal(campFromAccount(full.accountBalance, seasonalBalanceOf(items, payments)), full.camp.balance)
})


// ── VOIDED CHARGES ARE NOT OWED, IN EITHER MODE ──────────────────────────────────────────────
//
// The Electric Billing page used to sum every folio line item with no void filter, so a camper
// with a voided charge showed a HIGHER balance there than on their own folio. Every other balance
// in the app — the folio, /api/guests/balances, laneBalances() — excludes them.
//
// The rule these pin: whatever the caller filters out of its account total must ALSO be filtered
// out of the seasonal slice, or camp + seasonal stops equalling the account.

const VOID_ITEMS = [
  { line_total: 160000, lane: 'seasonal' },
  { line_total: 50000, lane: 'seasonal', voided: true },   // voided seasonal charge
  { line_total: 3200, lane: 'electric' },
  { line_total: 900, voided: true },                        // voided store charge
]

test('⚠ A VOIDED CHARGE IS EXCLUDED FROM BOTH BUCKETS, AND FROM THE ACCOUNT', () => {
  const live = VOID_ITEMS.filter(i => i.voided !== true)
  const payments: { amount: number; lane?: string | null }[] = []

  // laneBalances already filters voided; this is the reference answer.
  const full = accountBuckets(laneBalances(VOID_ITEMS, payments, { electricLineItemIds: new Set<string>() }))
  assert.equal(full.accountBalance, 163200, 'the two voided charges are not owed')
  assert.equal(full.seasonal.balance, 160000)
  assert.equal(full.camp.balance, 3200)

  // The page's shortcut must reach the same figures when fed the same void-filtered rows.
  const account = live.reduce((sum, i) => sum + i.line_total, 0)
  const seasonal = seasonalBalanceOf(live, payments)
  assert.equal(account, full.accountBalance, 'the page balance matches the folio balance')
  assert.equal(seasonal, full.seasonal.balance)
  assert.equal(campFromAccount(account, seasonal), full.camp.balance)
})

test('⚠ MIXING THE TWO RULES IS THE ONLY WAY TO GET A WRONG ANSWER — pinned', () => {
  // Filtering the account total but NOT the seasonal slice: camp + seasonal no longer reconciles.
  // Stated as a failing shape so the requirement in seasonalBalanceOf's comment is testable
  // rather than merely written down.
  const live = VOID_ITEMS.filter(i => i.voided !== true)
  const account = live.reduce((sum, i) => sum + i.line_total, 0)
  const seasonalUnfiltered = seasonalBalanceOf(VOID_ITEMS, [])   // WRONG: includes the voided fee
  assert.notEqual(campFromAccount(account, seasonalUnfiltered), 3200)
  // ...and the correct pairing does reconcile.
  assert.equal(campFromAccount(account, seasonalBalanceOf(live, [])), 3200)
})

test('a combined park benefits too — a voided charge is not owed there either', () => {
  // Combined never splits buckets, but the account total is the same figure, and it is the one
  // the electric page shows. This is the one combined-visible change in this batch, and it is a
  // fix: the page now agrees with the camper's folio.
  const live = VOID_ITEMS.filter(i => i.voided !== true)
  assert.equal(live.reduce((s, i) => s + i.line_total, 0), 163200)
  assert.notEqual(VOID_ITEMS.reduce((s, i) => s + i.line_total, 0), 163200)
})

test('a voided PAYMENT is out of scope here — payments are filtered by status, not voided', () => {
  // Documented so nobody adds a voided filter to payments by symmetry: the app excludes
  // non-completed payments with .eq('status','completed') at the query, and laneBalances counts
  // every payment it is handed.
  const items = [{ line_total: 10000, lane: 'seasonal' }]
  const payments = [{ amount: 4000, lane: 'seasonal' }]
  assert.equal(seasonalBalanceOf(items, payments), 6000)
})
