import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  sourceOfPayment, sumBySource, rankSources, barWidthPct,
  SOURCES, SOURCE_LABEL, SOURCE_COLOR, SOURCE_DESTINATION,
  type SourceFolio,
} from './report-sources.ts'
import { LANE_COLOR } from './lane-display.ts'
import { LANES } from './ledger-lanes.ts'

// Revenue by source.
//
// Two properties carry this file:
//   1. NO DOLLAR IS DROPPED OR DOUBLE-COUNTED — the sources partition the window's payments and
//      add back up to a total summed independently of them.
//   2. AN UNTAGGED SEASONAL PAYMENT IS NEVER GUESSED INTO A SOURCE. Guessing would silently
//      inflate whichever source got the guess, and no figure on screen would look wrong.

const W = { startISO: '2026-08-01T00:00:00.000Z', endISO: '2026-08-31T23:59:59.999Z' }
const at = (d: string) => `2026-08-${d}T12:00:00.000Z`

const folios = new Map<string, SourceFolio>([
  ['f-res', { folio_type: 'reservation', reservation_id: 'r1' }],
  ['f-walkin', { folio_type: 'walkin' }],
  ['f-walkup', { folio_type: 'walkup' }],
  ['f-seasonal', { folio_type: 'guest_account', segment: 'seasonal' }],
  ['f-monthly', { folio_type: 'guest_account', segment: 'long_term' }],
  ['f-house', { folio_type: 'guest_account', segment: 'other' }],
])

// ── classification ───────────────────────────────────────────────────────────────────────────

test('a reservation folio is nightly money, whatever else is on it', () => {
  assert.equal(sourceOfPayment(folios.get('f-res'), { amount: 1000 }), 'nightly')
  // Even carrying a lane tag: the folio decides, not a string on the row.
  assert.equal(sourceOfPayment(folios.get('f-res'), { amount: 1000, lane: 'store' }), 'nightly')
  // A folio typed anything but linked to a reservation still counts as nightly.
  assert.equal(sourceOfPayment({ folio_type: 'other', reservation_id: 'r9' }, { amount: 500 }), 'nightly')
})

test('walk-in and walk-up folios ARE the camp store', () => {
  assert.equal(sourceOfPayment(folios.get('f-walkin'), { amount: 500 }), 'store')
  assert.equal(sourceOfPayment(folios.get('f-walkup'), { amount: 500 }), 'store')
})

test("a long-term guest's rent is NOT a seasonal fee, whatever the lane says", () => {
  // The lane column was never designed to describe a monthly arrangement, and on the sandbox
  // these payments carry no lane at all. Sourcing by WHOSE account it is comes first.
  assert.equal(sourceOfPayment(folios.get('f-monthly'), { amount: 65000 }), 'long_term')
  assert.equal(sourceOfPayment(folios.get('f-monthly'), { amount: 65000, lane: 'seasonal' }), 'long_term')
})

test("a seasonal camper's payment is split by the lane their FOLIO shows", () => {
  const f = folios.get('f-seasonal')
  assert.equal(sourceOfPayment(f, { amount: 1, lane: 'seasonal' }), 'seasonal')
  assert.equal(sourceOfPayment(f, { amount: 1, lane: 'electric' }), 'electric')
  assert.equal(sourceOfPayment(f, { amount: 1, lane: 'store' }), 'store')
  assert.equal(sourceOfPayment(f, { amount: 1, lane: 'other' }), 'other')
  assert.equal(sourceOfPayment(f, { amount: 1, lane: ' Electric ' }), 'electric', 'trimmed, case-insensitive')
})

test('AN UNTAGGED SEASONAL PAYMENT IS ADMITTED, NOT GUESSED', () => {
  const f = folios.get('f-seasonal')
  for (const lane of [null, undefined, '', '   ', 'bogus', 'SEASONALish']) {
    assert.equal(sourceOfPayment(f, { amount: 1, lane }), 'unassigned',
      `${JSON.stringify(lane)} must not be guessed into a source`)
  }
})

test('an unknown folio is `other`, not a crash and not nightly', () => {
  assert.equal(sourceOfPayment(undefined, { amount: 100 }), 'other')
  assert.equal(sourceOfPayment(null, { amount: 100 }), 'other')
  assert.equal(sourceOfPayment({}, { amount: 100 }), 'other')
})

// ── the partition ────────────────────────────────────────────────────────────────────────────

const payments = [
  { folio_id: 'f-seasonal', amount: 945000, lane: 'seasonal', paid_at: at('10') },
  { folio_id: 'f-seasonal', amount: 14500, lane: 'electric', paid_at: at('11') },
  { folio_id: 'f-seasonal', amount: 4799, lane: 'store', paid_at: at('12') },
  { folio_id: 'f-monthly', amount: 65300, paid_at: at('13') },
  { folio_id: 'f-walkin', amount: 3100, paid_at: at('14') },
  { folio_id: 'f-house', amount: 900, paid_at: at('15') },
]
const bookings = [
  { amount_paid: 69000, surcharge_amount: 500, created_at: at('16') },
]

test('EVERY DOLLAR LANDS IN EXACTLY ONE SOURCE', () => {
  const t = sumBySource(payments, folios, bookings, W)
  const summed = SOURCES.reduce((s, k) => s + t.bySource[k], 0)
  assert.equal(summed, t.total, 'the sources must add up to the independently-summed total')
  assert.equal(t.total, 945000 + 14500 + 4799 + 65300 + 3100 + 900 + 69500)
  assert.equal(t.bySource.seasonal, 945000)
  assert.equal(t.bySource.electric, 14500)
  assert.equal(t.bySource.store, 4799 + 3100, "a camper's store tab and a walk-up sale are one source")
  assert.equal(t.bySource.long_term, 65300, 'long-term money is counted, not dropped')
  assert.equal(t.bySource.nightly, 69500, 'booking payments are gross — amount_paid plus surcharge')
  assert.equal(t.bySource.other, 900)
})

test('booking payments are ADDED, never de-duplicated against folio rows', () => {
  // They are disjoint by construction: a reservation deposit has no folio_payments row.
  const withoutBookings = sumBySource(payments, folios, [], W)
  const withBookings = sumBySource(payments, folios, bookings, W)
  assert.equal(withBookings.total - withoutBookings.total, 69500)
})

test('the window is respected on BOTH date columns', () => {
  const outside = [{ folio_id: 'f-seasonal', amount: 999999, lane: 'seasonal', paid_at: '2026-07-15T12:00:00.000Z' }]
  const outsideBooking = [{ amount_paid: 888888, created_at: '2026-07-15T12:00:00.000Z' }]
  const t = sumBySource(outside, folios, outsideBooking, W)
  assert.equal(t.total, 0, 'July money must not land in an August window')
  // A row with no timestamp cannot be placed in a window, so it is not counted in one.
  assert.equal(sumBySource([{ folio_id: 'f-seasonal', amount: 500, lane: 'seasonal' }], folios, [], W).total, 0)
})

test('A REFUND NETS ITSELF OUT — it does not need special handling', () => {
  const withRefund = [
    ...payments,
    { folio_id: 'f-seasonal', amount: -14500, lane: 'electric', paid_at: at('20') },
  ]
  const t = sumBySource(withRefund, folios, bookings, W)
  assert.equal(t.bySource.electric, 0, 'the negative row cancels the original')
  assert.equal(SOURCES.reduce((s, k) => s + t.bySource[k], 0), t.total, 'and the partition still holds')
})

test('nothing at all is zero, not a crash', () => {
  for (const empty of [null, undefined, []]) {
    const t = sumBySource(empty, folios, empty, W)
    assert.equal(t.total, 0)
    assert.equal(SOURCES.reduce((s, k) => s + t.bySource[k], 0), 0)
  }
})

// ── ranking and legibility (Part D) ──────────────────────────────────────────────────────────

test('sources rank biggest-first and empty ones are dropped', () => {
  const t = sumBySource(payments, folios, bookings, W)
  const ranked = rankSources(t, null)
  assert.deepEqual(ranked.map(r => r.source), ['seasonal', 'nightly', 'long_term', 'electric', 'store', 'other'])
  assert.ok(!ranked.some(r => r.source === 'unassigned'), 'a source with no money gets no row')
  assert.equal(ranked.reduce((s, r) => s + r.amount, 0), t.total, 'ranking loses nothing')
})

test('shares are truthful even when one source dominates', () => {
  const t = sumBySource(payments, folios, bookings, W)
  const ranked = rankSources(t, null)
  const store = ranked.find(r => r.source === 'store')!
  assert.ok(store.share < 0.01, 'store really is under one percent of this month')
  assert.equal(Math.round(ranked.reduce((s, r) => s + r.share, 0) * 1e6) / 1e6, 1)
})

test('A SMALL SOURCE IS NEVER DRAWN AS NOTHING — but zero stays zero', () => {
  // $47.99 against an $11k month is ~0.4%: a bar under half a pixel wide on a phone.
  assert.equal(barWidthPct(0.004), 2, 'floored so it is visibly non-zero')
  assert.equal(barWidthPct(0.5), 50, 'a normal share is untouched')
  assert.equal(barWidthPct(0), 0, 'money that does not exist gets no bar at all')
  assert.equal(barWidthPct(1.4), 100, 'and nothing overflows its track')
})

test('the prior period rides along on each row, for the per-source delta', () => {
  const cur = sumBySource(payments, folios, bookings, W)
  const prior = sumBySource([{ folio_id: 'f-seasonal', amount: 500000, lane: 'seasonal', paid_at: at('05') }], folios, [], W)
  const ranked = rankSources(cur, prior)
  assert.equal(ranked.find(r => r.source === 'seasonal')!.priorAmount, 500000)
  assert.equal(ranked.find(r => r.source === 'store')!.priorAmount, 0, 'a source that is new reads as up from zero')
  assert.equal(rankSources(cur, null)[0].priorAmount, null, 'and null when there is nothing to compare')
})

// ── display constants ────────────────────────────────────────────────────────────────────────

test('every source has a label, a colour and a destination to drill into', () => {
  for (const s of SOURCES) {
    assert.ok(SOURCE_LABEL[s], `${s} needs a label to print beside its swatch`)
    assert.match(SOURCE_COLOR[s], /^#[0-9A-Fa-f]{6}$/)
    assert.ok(SOURCE_DESTINATION[s], `${s} needs somewhere to click through to`)
  }
  assert.equal(new Set(SOURCES.map(s => SOURCE_COLOR[s])).size, SOURCES.length,
    'two sources sharing a colour would be unreadable')
})

test('THE SHARED SOURCES REUSE R1 LANE COLOURS RATHER THAN RESTATING THEM', () => {
  // The whole point: a park that learns "orange is electric" on the folio sees the same orange
  // on the dashboard, and an edit to one cannot silently desynchronise the other.
  for (const lane of LANES) {
    assert.equal(SOURCE_COLOR[lane], LANE_COLOR[lane], `${lane} must be the same colour in both vocabularies`)
  }
})
