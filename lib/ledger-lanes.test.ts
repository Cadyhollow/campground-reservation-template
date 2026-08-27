import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  normalizeBillingMode, classifyLineItem, laneBalances, filterToLane, LANES,
} from './ledger-lanes.ts'

// Money lanes.
//
// The property that matters most is the LAST test in this file: however the lanes slice it, the
// whole-account balance must still equal what the folio shows today. Everything else is detail;
// that one is what proves separating the lanes neither lost nor invented money.

// ── the switch ───────────────────────────────────────────────────────────────────────────────

test("only the exact string 'separated' turns lanes on", () => {
  assert.equal(normalizeBillingMode('separated'), 'separated')
  assert.equal(normalizeBillingMode(' Separated '), 'separated', 'trimmed and case-insensitive')
})

test('EVERYTHING ELSE FAILS SAFE TO COMBINED', () => {
  // The direction is the point: a wrong 'separated' sends a camper a bill missing money they owe;
  // a wrong 'combined' sends the bill their park already sends today.
  for (const v of [null, undefined, '', '   ', 'combined', 'seperated', 'SEPARATE', 'lanes', 0, 1, true, {}, []]) {
    assert.equal(normalizeBillingMode(v), 'combined', `${JSON.stringify(v)} should read as combined`)
  }
})

// ── classification ───────────────────────────────────────────────────────────────────────────

const ctx = { electricLineItemIds: new Set(['elec-1']) }

test('an item linked from an electric reading is ELECTRIC', () => {
  assert.equal(classifyLineItem({ id: 'elec-1', line_total: 4200, category: 'Fees' }, ctx), 'electric')
})

test("CATEGORY 'Fees' IS NOT AN ELECTRIC SIGNAL — the POS uses it too", () => {
  // The reason classification keys on the electric_readings link and not on category. The
  // electric charge is written with category 'Fees'; 'Fees' is ALSO one of the POS's fallback
  // store categories, so a store sale filed under it is byte-identical by category.
  const posSaleUnderFees = { id: 'pos-9', line_total: 500, category: 'Fees', product_id: 'prod-1' }
  assert.equal(classifyLineItem(posSaleUnderFees, ctx), 'store',
    'a store sale categorised "Fees" must not become an electric charge')

  // And a park-created category NAMED "Electric" means nothing without the link.
  const decoy = { id: 'decoy', line_total: 999, category: 'Electric', product_id: null }
  assert.equal(classifyLineItem(decoy, ctx), 'other')
})

test('an item with a product_id is STORE', () => {
  assert.equal(classifyLineItem({ id: 'x', line_total: 500, product_id: 'p1', category: 'Candy' }, ctx), 'store')
})

test('anything else is OTHER — the honest catch-all', () => {
  // Today that is the manual "custom item" charge: product_id null, category 'General'.
  assert.equal(classifyLineItem({ id: 'x', line_total: 500, product_id: null, category: 'General' }, ctx), 'other')
  assert.equal(classifyLineItem({ id: 'y', line_total: 500 }, ctx), 'other')
})

test('NOTHING classifies as seasonal yet — the lane is reserved for the next PR', () => {
  const rows = [
    { id: 'elec-1', line_total: 100 },
    { id: 'p', line_total: 100, product_id: 'p1' },
    { id: 'm', line_total: 100, category: 'General' },
  ]
  assert.ok(rows.every(r => classifyLineItem(r, ctx) !== 'seasonal'))
  assert.ok((LANES as readonly string[]).includes('seasonal'), 'but the lane exists, ready for it')
})

// ── lane maths ───────────────────────────────────────────────────────────────────────────────

const items = [
  { id: 'elec-1', line_total: 4200 },                        // electric
  { id: 'pos-1', line_total: 1500, product_id: 'p1' },       // store
  { id: 'man-1', line_total: 1000, category: 'General' },    // other
  { id: 'void-1', line_total: 9999, product_id: 'p2', voided: true }, // excluded everywhere
]

test('charges land in their lanes and voided items are excluded from every total', () => {
  const b = laneBalances(items, [], ctx)
  assert.equal(b.byLane.electric.charges, 4200)
  assert.equal(b.byLane.store.charges, 1500, 'the voided $99.99 store row is not counted')
  assert.equal(b.byLane.other.charges, 1000)
  assert.equal(b.byLane.seasonal.charges, 0)
  assert.equal(b.totalCharges, 6700)
})

test('a tagged payment reduces ONLY its own lane', () => {
  const b = laneBalances(items, [{ amount: 4200, lane: 'electric' }], ctx)
  assert.equal(b.byLane.electric.balance, 0, 'electric is settled')
  assert.equal(b.byLane.store.balance, 1500, 'the store tab is untouched by it')
  assert.equal(b.untaggedPayments, 0)
})

test('AN UNTAGGED PAYMENT IS NOT GUESSED INTO A LANE', () => {
  // Every payment predating Phase 4 is untagged. Distributing them would rewrite a park's
  // financial history; they stay whole-account, exactly as they have always behaved.
  const b = laneBalances(items, [{ amount: 5000 }], ctx)
  assert.equal(b.untaggedPayments, 5000)
  for (const lane of LANES) assert.equal(b.byLane[lane].payments, 0, `${lane} got none of it`)
  assert.equal(b.accountBalance, 1700, '6700 charged − 5000 paid')
})

test('an unrecognised lane string degrades to untagged rather than throwing', () => {
  const b = laneBalances(items, [{ amount: 100, lane: 'firewood' }], ctx)
  assert.equal(b.untaggedPayments, 100)
})

test('a payment counts NET of its card surcharge, matching buildLedger', () => {
  // Same arithmetic lib/ledger.ts uses, so lane maths and the folio agree to the cent.
  const b = laneBalances(items, [{ amount: 4300, surcharge_amount: 100, lane: 'electric' }], ctx)
  assert.equal(b.byLane.electric.payments, 4200)
  assert.equal(b.byLane.electric.balance, 0)
})

test('overpaying a lane shows as a credit in that lane only', () => {
  const b = laneBalances(items, [{ amount: 5000, lane: 'electric' }], ctx)
  assert.equal(b.byLane.electric.balance, -800, 'negative = credit')
  assert.equal(b.byLane.store.balance, 1500, 'and it does NOT bleed into the store tab')
})

test('THE INVARIANT: the whole-account balance is unchanged by lanes', () => {
  // What proves the split neither lost nor invented money. Lanes are a VIEW of the same rows.
  const payments = [
    { amount: 2000, lane: 'electric' },
    { amount: 500, lane: 'store' },
    { amount: 1000 },                       // untagged
    { amount: 620, surcharge_amount: 20 },  // untagged, with a surcharge
  ]
  const b = laneBalances(items, payments, ctx)

  const chargesToday = items.filter(i => i.voided !== true).reduce((s, i) => s + i.line_total, 0)
  const paymentsToday = payments.reduce((s, p) => s + (p.amount - (p.surcharge_amount || 0)), 0)
  assert.equal(b.accountBalance, chargesToday - paymentsToday)
  assert.equal(b.totalPayments, paymentsToday)

  // And the lanes account for every cent: lane payments + untagged = all payments.
  const laneSum = LANES.reduce((s, l) => s + b.byLane[l].payments, 0)
  assert.equal(laneSum + b.untaggedPayments, b.totalPayments)
  assert.equal(LANES.reduce((s, l) => s + b.byLane[l].charges, 0), b.totalCharges)
})

test('empty and null inputs produce zeroes, not a crash', () => {
  const b = laneBalances(null, undefined, { electricLineItemIds: new Set() })
  assert.equal(b.accountBalance, 0)
  for (const lane of LANES) assert.deepEqual(b.byLane[lane], { charges: 0, payments: 0, balance: 0 })
})

// ── filtering to one lane (what the electric bill is built from) ─────────────────────────────

test('filterToLane returns that lane\'s items and ONLY its tagged payments', () => {
  const payments = [
    { amount: 4200, lane: 'electric' },
    { amount: 500, lane: 'store' },
    { amount: 1000 },   // untagged — a whole-account payment
  ]
  const f = filterToLane('electric', items, payments, ctx)
  assert.deepEqual(f.items.map(i => i.id), ['elec-1'])
  assert.equal(f.payments.length, 1)
  assert.equal(f.payments[0].amount, 4200)
})

test('AN UNTAGGED PAYMENT NEVER APPEARS ON A LANE STATEMENT', () => {
  // Pulling one in would show a camper a credit against their electricity that was never made
  // against it — the electric bill would under-state what they owe.
  const f = filterToLane('electric', items, [{ amount: 9999 }], ctx)
  assert.equal(f.payments.length, 0)
})

test('filterToLane keeps voided items for display; totals still exclude them', () => {
  const f = filterToLane('store', items, [], ctx)
  assert.deepEqual(f.items.map(i => i.id), ['pos-1', 'void-1'])
  assert.equal(laneBalances(f.items, [], ctx).byLane.store.charges, 1500)
})
