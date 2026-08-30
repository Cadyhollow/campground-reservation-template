import { test } from 'node:test'
import assert from 'node:assert/strict'
import { segmentOf, bucketGuestAccountCharges, rollUpLanes, SEGMENTS } from './report-buckets.ts'
import { laneBalances, LANES } from './ledger-lanes.ts'
import { LANE_LABEL, LANE_COLOR, SEASONAL_CAMPER_LANES } from './lane-display.ts'

// Reporting buckets.
//
// Two properties carry this file, and they are the two an owner would notice being wrong:
//
//   1. NO DOLLAR IS DROPPED OR DOUBLE-COUNTED. The segments partition guest-account money —
//      every non-voided charge lands in exactly one, and they add back up to the independent
//      total. That is the "long-term money went missing" bug, pinned.
//   2. THE LANE ROLL-UP EQUALS THE FOLIOS. However the lanes slice it, the net figure must equal
//      the sum of the campers' own account balances. That is "the report disagrees with the
//      folio", pinned.

const ctx = { electricLineItemIds: new Set(['elec-1']) }

// ── segments ─────────────────────────────────────────────────────────────────────────────────

test('a guest flagged BOTH seasonal and monthly is counted ONCE, as seasonal', () => {
  // The double-count the old reports page had: the same charges appeared in Seasonal Revenue and
  // in Monthly Revenue. Seasonal wins because that is the folio the Seasonal report reconciles
  // against — filing them as long-term instead would just move the disagreement.
  assert.equal(segmentOf({ is_seasonal: true, is_monthly: true }), 'seasonal')
  assert.equal(segmentOf({ is_seasonal: true }), 'seasonal')
})

test('a monthly-only guest is LONG-TERM, not seasonal and not nothing', () => {
  assert.equal(segmentOf({ is_monthly: true }), 'long_term')
  assert.equal(segmentOf({ is_seasonal: false, is_monthly: true }), 'long_term')
})

test('a plain guest with a house tab still gets a bucket', () => {
  // Previously this money was in no figure at all: excluded from store revenue (which drops every
  // guest_account folio) and matched by neither the seasonal nor the monthly query.
  assert.equal(segmentOf({}), 'other')
  assert.equal(segmentOf({ is_seasonal: null, is_monthly: null }), 'other')
})

// ── the partition ────────────────────────────────────────────────────────────────────────────

const segments = new Map([
  ['f-seasonal', 'seasonal' as const],
  ['f-monthly', 'long_term' as const],
  ['f-house', 'other' as const],
])

const items = [
  { id: 'elec-1', folio_id: 'f-seasonal', line_total: 4200 },                    // electric
  { id: 'pos-1', folio_id: 'f-seasonal', line_total: 900, product_id: 'p1' },    // store
  { id: 'fee-1', folio_id: 'f-seasonal', line_total: 120000, lane: 'seasonal' }, // seasonal fee
  { id: 'misc-1', folio_id: 'f-seasonal', line_total: 500 },                     // other
  { id: 'rent-1', folio_id: 'f-monthly', line_total: 65000 },                    // long-term
  { id: 'tab-1', folio_id: 'f-house', line_total: 1500, product_id: 'p2' },      // house tab
]

test('EVERY DOLLAR LANDS IN EXACTLY ONE SEGMENT', () => {
  const b = bucketGuestAccountCharges(items, segments, ctx)
  const summed = SEGMENTS.reduce((s, seg) => s + b.bySegment[seg], 0)
  assert.equal(summed, b.total, 'the segments must add up to the independently-summed total')
  assert.equal(b.total, 4200 + 900 + 120000 + 500 + 65000 + 1500)
  assert.equal(b.bySegment.seasonal, 4200 + 900 + 120000 + 500)
  assert.equal(b.bySegment.long_term, 65000, 'long-term money is counted, not dropped')
  assert.equal(b.bySegment.other, 1500)
})

test('the seasonal segment splits into lanes that sum back to it', () => {
  const b = bucketGuestAccountCharges(items, segments, ctx)
  const laneSum = LANES.reduce((s, l) => s + b.seasonalByLane[l], 0)
  assert.equal(laneSum, b.bySegment.seasonal, 'lanes must not lose or invent seasonal money')
  assert.equal(b.seasonalByLane.electric, 4200)
  assert.equal(b.seasonalByLane.store, 900)
  assert.equal(b.seasonalByLane.seasonal, 120000)
  assert.equal(b.seasonalByLane.other, 500)
})

test('A VOIDED CHARGE COUNTS NOWHERE — the reconcile fix', () => {
  // The bug this PR exists to fix: a camper with a canceled packet read too high on the reports
  // page and disagreed with their own folio, which has excluded voided charges since PR 3c.
  const withVoid = [...items, { id: 'void-1', folio_id: 'f-seasonal', line_total: 120000, voided: true }]
  const before = bucketGuestAccountCharges(items, segments, ctx)
  const after = bucketGuestAccountCharges(withVoid, segments, ctx)
  assert.deepEqual(after, before, 'a voided charge must change no figure anywhere')
})

test('a folio with no known segment is counted, and flagged', () => {
  // Money is never dropped for want of a label — but the caller can tell "house tab" from
  // "I failed to look this folio up".
  const b = bucketGuestAccountCharges([{ id: 'x', folio_id: 'f-unknown', line_total: 700 }], segments, ctx)
  assert.equal(b.total, 700)
  assert.equal(b.bySegment.other, 700)
  assert.equal(b.unattributed, 700)
})

test('no items at all is zero, not a crash', () => {
  for (const empty of [null, undefined, []]) {
    const b = bucketGuestAccountCharges(empty, segments, ctx)
    assert.equal(b.total, 0)
    assert.equal(SEGMENTS.reduce((s, seg) => s + b.bySegment[seg], 0), 0)
  }
})

// ── the lane roll-up ─────────────────────────────────────────────────────────────────────────

test('THE ROLL-UP EQUALS THE SUM OF THE FOLIOS — the property the report is built on', () => {
  // Two campers with deliberately awkward money: one pays into lanes, one pays untagged (every
  // pre-Phase-4 payment does), and one holds a credit. If the roll-up can disagree with the
  // folios anywhere, it is here.
  const camperA = laneBalances(
    [
      { id: 'elec-1', line_total: 4200 },
      { id: 'a-fee', line_total: 120000, lane: 'seasonal' },
      { id: 'a-void', line_total: 50000, voided: true },
    ],
    [{ amount: 120000, lane: 'seasonal' }, { amount: 4200, lane: 'electric' }],
    ctx,
  )
  const camperB = laneBalances(
    [{ id: 'b-fee', line_total: 90000, lane: 'seasonal' }, { id: 'b-pos', line_total: 2500, product_id: 'p1' }],
    [{ amount: 100000 }], // untagged, and MORE than the seasonal fee — B is in credit
    ctx,
  )

  const rolled = rollUpLanes([camperA, camperB])
  const folioSum = camperA.accountBalance + camperB.accountBalance
  assert.equal(rolled.netBalance, folioSum, 'the report must equal the folios it is built from')

  // And the arithmetic the Seasonal view prints to the owner as its reconciliation line:
  //     lanes − payments applied to the whole account = what campers owe
  const laneBalanceSum = LANES.reduce((s, l) => s + rolled.byLane[l].balance, 0)
  assert.equal(laneBalanceSum - rolled.untaggedPayments, rolled.netBalance)
  assert.equal(rolled.untaggedPayments, 100000, "B's untagged payment must not be guessed into a lane")
})

test('a card surcharge is netted out of the roll-up, exactly as the folio nets it', () => {
  const c = laneBalances(
    [{ id: 'fee', line_total: 10000, lane: 'seasonal' }],
    [{ amount: 10300, surcharge_amount: 300, lane: 'seasonal' }],
    ctx,
  )
  const rolled = rollUpLanes([c])
  assert.equal(rolled.totalPayments, 10000, 'the surcharge is not money paid against the account')
  assert.equal(rolled.netBalance, 0)
  assert.equal(rolled.byLane.seasonal.balance, 0)
})

test('no campers rolls up to zero', () => {
  for (const empty of [null, undefined, []]) {
    const rolled = rollUpLanes(empty)
    assert.equal(rolled.netBalance, 0)
    for (const l of LANES) assert.deepEqual(rolled.byLane[l], { charges: 0, payments: 0, balance: 0 })
  }
})

// ── display constants ────────────────────────────────────────────────────────────────────────

test('every lane has a label and a colour — colour is never the only signal', () => {
  for (const lane of LANES) {
    assert.ok(LANE_LABEL[lane], `${lane} needs a label to print beside its swatch`)
    assert.match(LANE_COLOR[lane], /^#[0-9A-Fa-f]{6}$/, `${lane} needs a colour`)
  }
  const hues = new Set(LANES.map(l => LANE_COLOR[l]))
  assert.equal(hues.size, LANES.length, 'two lanes sharing a colour would be unreadable')
})

test("the seasonal camper's lanes are the three she is billed for", () => {
  assert.deepEqual([...SEASONAL_CAMPER_LANES], ['seasonal', 'electric', 'store'])
  assert.ok(!SEASONAL_CAMPER_LANES.includes('other'), "'other' is the catch-all, not a lane to report against")
})
