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

// ── PR 2: the explicit lane tag ──────────────────────────────────────────────────────────────

test('an explicit lane tag WINS over inference', () => {
  // The seasonal fee has no product_id and no electric reading, so inference alone would file it
  // under `other`. It declares itself instead.
  assert.equal(classifyLineItem({ id: 's1', line_total: 250000, lane: 'seasonal' }, ctx), 'seasonal')
  // And a tag overrides what inference would otherwise have said.
  assert.equal(classifyLineItem({ id: 'elec-1', line_total: 100, lane: 'store' }, ctx), 'store')
  assert.equal(classifyLineItem({ id: 'x', line_total: 100, product_id: 'p1', lane: 'other' }, ctx), 'other')
})

test('EVERY PRE-PR-2 ROW CLASSIFIES EXACTLY AS IT DID BEFORE', () => {
  // The safety property of the whole change. The column is NULL on every row that existed before
  // the migration, and NULL falls straight through to PR 1's inference.
  const historical = [
    { row: { id: 'elec-1', line_total: 4200, category: 'Fees' }, was: 'electric' },
    { row: { id: 'pos-1', line_total: 1500, product_id: 'p1' }, was: 'store' },
    { row: { id: 'man-1', line_total: 1000, category: 'General' }, was: 'other' },
  ] as const
  for (const { row, was } of historical) {
    assert.equal(classifyLineItem(row, ctx), was, `${row.id} must still be ${was}`)
    assert.equal(classifyLineItem({ ...row, lane: null }, ctx), was, 'explicit NULL behaves the same')
  }
})

test('an unrecognised lane string falls back to inference rather than inventing a lane', () => {
  assert.equal(classifyLineItem({ id: 'pos-1', line_total: 100, product_id: 'p1', lane: 'firewood' }, ctx), 'store')
  assert.equal(classifyLineItem({ id: 'elec-1', line_total: 100, lane: '' }, ctx), 'electric')
  assert.equal(classifyLineItem({ id: 'z', line_total: 100, lane: '   ' }, ctx), 'other')
})

test('a tag is read case- and whitespace-insensitively', () => {
  assert.equal(classifyLineItem({ id: 'z', line_total: 100, lane: ' Seasonal ' }, ctx), 'seasonal')
})

test('a posted seasonal fee lands in the seasonal lane and nowhere else', () => {
  const withSeasonal = [...items, { id: 'seas-1', line_total: 250000, lane: 'seasonal' }]
  const b = laneBalances(withSeasonal, [], ctx)
  assert.equal(b.byLane.seasonal.charges, 250000)
  assert.equal(b.byLane.other.charges, 1000, 'it did NOT land in the catch-all')
  assert.equal(b.byLane.electric.charges, 4200)
  assert.equal(b.byLane.store.charges, 1500)
})

test('THE INVARIANT STILL HOLDS WITH A SEASONAL CHARGE POSTED', () => {
  // PR 1's guarantee, re-asserted now that a fourth lane carries real money: lanes are a VIEW of
  // the same rows and can neither lose nor invent a cent.
  const withSeasonal = [...items, { id: 'seas-1', line_total: 250000, lane: 'seasonal' }]
  const payments = [
    { amount: 4200, lane: 'electric' },
    { amount: 50000, lane: 'seasonal' },
    { amount: 1000 },   // untagged
  ]
  const b = laneBalances(withSeasonal, payments, ctx)

  const chargesToday = withSeasonal.filter(i => i.voided !== true).reduce((s, i) => s + i.line_total, 0)
  const paymentsToday = payments.reduce((s, p) => s + (p.amount - (p.surcharge_amount || 0)), 0)
  assert.equal(b.accountBalance, chargesToday - paymentsToday)

  const laneCharges = LANES.reduce((s, l) => s + b.byLane[l].charges, 0)
  const lanePayments = LANES.reduce((s, l) => s + b.byLane[l].payments, 0)
  assert.equal(laneCharges, b.totalCharges)
  assert.equal(lanePayments + b.untaggedPayments, b.totalPayments)
  assert.equal(b.byLane.seasonal.balance, 200000, '$2500 owed less $500 paid')
})

test('a VOIDED seasonal charge leaves no debt — what cancel relies on', () => {
  const cancelled = [...items, { id: 'seas-1', line_total: 250000, lane: 'seasonal', voided: true }]
  const b = laneBalances(cancelled, [], ctx)
  assert.equal(b.byLane.seasonal.charges, 0)
  assert.equal(b.byLane.seasonal.balance, 0)
})

// ── PR 3c: the folio, the lanes and the account must tell ONE story ──────────────────────────
//
// Two bugs found on real sandbox data motivated these, and they are worth naming because both
// were invisible until the lanes and the folio were put side by side:
//   1. a VOIDED charge was counted toward the folio's balance (but not the lanes'), so the two
//      screens disagreed by the whole canceled amount;
//   2. a kept overpayment credit carried NO lane, so it floated outside every lane and the lanes
//      stopped summing to the account — a camper could be shown more owing on one lane than they
//      owed in total.

test('A VOIDED CHARGE COUNTS NOWHERE — not in its lane, not in the account', () => {
  const withVoid = [
    { id: 'seas-1', line_total: 250000, lane: 'seasonal', voided: true },  // canceled packet
    { id: 'pos-1', line_total: 1800, product_id: 'p1' },
  ]
  const b = laneBalances(withVoid, [], ctx)
  assert.equal(b.byLane.seasonal.charges, 0, 'the canceled fee is not owed')
  assert.equal(b.totalCharges, 1800)
  assert.equal(b.accountBalance, 1800)
  // The bug this pins: the folio summed line items raw, so it read 251800 while the lane page
  // read 1800 — the same camper, two screens, a $2,500 disagreement.
  const rawSum = withVoid.reduce((s, i) => s + i.line_total, 0)
  assert.notEqual(rawSum, b.totalCharges)
})

test('A CREDIT TAGGED TO ITS LANE OFFSETS THAT LANE, and the lanes still sum to the account', () => {
  const items = [
    { id: 'pos-1', line_total: 1800, product_id: 'p1' },
    { id: 'seas-1', line_total: 250000, lane: 'seasonal' },
  ]
  // $20 tendered against an $18 store tab, the $2 kept as credit ON THE STORE LANE.
  const payments = [
    { amount: 1800, lane: 'store' },
    { amount: 200, lane: 'store' },
  ]
  const b = laneBalances(items, payments, ctx)
  assert.equal(b.byLane.store.balance, -200, 'the store lane carries the $2 credit')
  assert.equal(b.untaggedPayments, 0, 'nothing floats outside the lanes')
  assert.equal(
    LANES.reduce((s, l) => s + b.byLane[l].balance, 0) - b.untaggedPayments,
    b.accountBalance,
    'lane balances less untagged reconcile exactly to the account')
})

test('AN UNTAGGED CREDIT IS THE CASE THAT BROKE — it must be visible, never absorbed', () => {
  const items = [{ id: 'pos-1', line_total: 5000, product_id: 'p1' }]
  const payments = [{ amount: 1200 }]   // a floating credit, as Ortiz's $12 was
  const b = laneBalances(items, payments, ctx)
  assert.equal(b.byLane.store.balance, 5000, 'the store lane still reads its full charge…')
  assert.equal(b.untaggedPayments, 1200, '…and the $12 is reported separately, not hidden')
  assert.equal(b.accountBalance, 3800, 'while the account is $38')
  // The screens must therefore SHOW the remainder, which is what makes 5000 and 3800 reconcile.
  assert.equal(b.byLane.store.balance - b.untaggedPayments, b.accountBalance)
})

test('MOVING A CREDIT BETWEEN LANES CHANGES NO TOTAL', () => {
  // What the "Move to" control does: it sets `lane` and nothing else. The account balance is
  // identical before and after, which is the guarantee that makes the control safe.
  const items = [
    { id: 'pos-1', line_total: 5000, product_id: 'p1' },
    { id: 'e1', line_total: 4200, lane: 'electric' },
  ]
  const before = laneBalances(items, [{ amount: 1200, lane: 'store' }], ctx)
  const after = laneBalances(items, [{ amount: 1200, lane: 'electric' }], ctx)

  assert.equal(before.accountBalance, after.accountBalance, 'the account is untouched by the move')
  assert.equal(before.totalPayments, after.totalPayments)
  assert.equal(before.byLane.store.balance, 3800)
  assert.equal(after.byLane.store.balance, 5000, 'the credit left the store lane')
  assert.equal(after.byLane.electric.balance, 3000, 'and landed on electric')
})

test('THE FULL PICTURE RECONCILES: voided charge + lane credit + a floating remainder', () => {
  // Ortiz, in miniature: a canceled seasonal fee, a store tab, a credit filed on a lane, and one
  // historical payment still unassigned.
  const items = [
    { id: 'seas-void', line_total: 250000, lane: 'seasonal', voided: true },
    { id: 'pos-1', line_total: 5000, product_id: 'p1' },
    { id: 'e1', line_total: 4200, lane: 'electric' },
  ]
  const payments = [
    { amount: 4200, lane: 'electric' },  // electric settled
    { amount: 200, lane: 'store' },      // a credit filed on store
    { amount: 1000 },                    // historical, still unassigned
  ]
  const b = laneBalances(items, payments, ctx)

  assert.equal(b.byLane.seasonal.balance, 0, 'the canceled packet owes nothing')
  assert.equal(b.byLane.electric.balance, 0, 'electric settled')
  assert.equal(b.byLane.store.balance, 4800, '$50 tab less the $2 credit')
  assert.equal(b.untaggedPayments, 1000)
  assert.equal(b.accountBalance, 3800, '$92 charged (voided excluded) less $54 paid')

  // THE INVARIANT, stated the way the screens must display it:
  //   every lane balance, less whatever is still unassigned, equals the account.
  const laneSum = LANES.reduce((s, l) => s + b.byLane[l].balance, 0)
  assert.equal(laneSum - b.untaggedPayments, b.accountBalance)
})

// ── Changing a POSTED seasonal price must leave the folio reconciled ─────────────────────────
//
// Found in the wild on the sandbox: a contract had been edited to $1,695 while the charge already
// posted to the camper's folio still read $2,500. The agreement and the books disagreed, and
// nothing on either screen said so. syncSeasonalCharge() adjusts the EXISTING row — these pin
// what "adjusted" has to mean for the account to stay correct.

test('adjusting a posted seasonal price keeps ONE charge and re-reconciles', () => {
  const store = { id: 'pos-1', line_total: 5000, product_id: 'p1' }
  const before = laneBalances([store, { id: 'seas-1', line_total: 250000, lane: 'seasonal' }], [], ctx)
  const after = laneBalances([store, { id: 'seas-1', line_total: 189500, lane: 'seasonal' }], [], ctx)

  assert.equal(before.byLane.seasonal.charges, 250000)
  assert.equal(after.byLane.seasonal.charges, 189500, 'the lane follows the new price')
  assert.equal(after.accountBalance, before.accountBalance - 60500, 'and so does the account, exactly')
  assert.equal(after.byLane.store.charges, 5000, 'no other lane moved')
})

test('A PRICE CHANGE MUST ADJUST, NEVER STACK — two live seasonal charges would double-bill', () => {
  // The failure this guards: posting a second charge instead of updating the first. The lanes
  // would still "reconcile" — both rows are real — while the camper is billed twice.
  const stacked = [
    { id: 'seas-1', line_total: 250000, lane: 'seasonal' },
    { id: 'seas-2', line_total: 189500, lane: 'seasonal' },
  ]
  const adjusted = [{ id: 'seas-1', line_total: 189500, lane: 'seasonal' }]
  assert.equal(laneBalances(stacked, [], ctx).byLane.seasonal.charges, 439500)
  assert.equal(laneBalances(adjusted, [], ctx).byLane.seasonal.charges, 189500)
  assert.notEqual(
    laneBalances(stacked, [], ctx).accountBalance,
    laneBalances(adjusted, [], ctx).accountBalance,
    'stacking and adjusting are NOT the same account — which is why the sync updates in place')
})

test('clearing the price VOIDS the charge rather than leaving a $0 line', () => {
  // Zero owed and "no fee agreed" are the same thing on a folio, and a voided row keeps the
  // audit trail that a fee was once posted.
  const voided = laneBalances([{ id: 'seas-1', line_total: 250000, lane: 'seasonal', voided: true }], [], ctx)
  assert.equal(voided.byLane.seasonal.charges, 0)
  assert.equal(voided.accountBalance, 0)
})

test('a price change with payments already made re-reconciles, credit included', () => {
  // The real sandbox shape: money already paid against the old, higher price. Lowering it turns
  // the difference into a credit — and the lanes must still sum to the account.
  const items = [
    { id: 'seas-1', line_total: 189500, lane: 'seasonal' },
    { id: 'pos-1', line_total: 5000, product_id: 'p1' },
  ]
  const payments = [
    { amount: 250000, lane: 'seasonal' },   // paid against the OLD $2,500 price
    { amount: 1700, lane: 'store' },
    { amount: 1000 },                        // historical, unassigned
  ]
  const b = laneBalances(items, payments, ctx)
  assert.equal(b.byLane.seasonal.balance, -60500, 'overpaid seasonal is now a credit in that lane')
  assert.equal(b.accountBalance, 194500 - 252700)
  const laneSum = LANES.reduce((s, l) => s + b.byLane[l].balance, 0)
  assert.equal(laneSum - b.untaggedPayments, b.accountBalance, 'still reconciles exactly')
})
