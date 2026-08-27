import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  currentSeasonYear,
  sortSeasonsForPicker, seasonContains, pickCurrentSeason, todayISO, seasonLabel,
} from './season.ts'

// Which season year the seasonals screen OPENS on.
//
// This is a default, not a rule — the screen's year picker overrides it freely. But the default
// is the one that decides what a member of staff is looking at when they are not paying attention,
// and the failure it prevents is sending LAST season's agreement for NEXT season's stay. So the
// boundary is pinned here rather than left to a comment.
//
// `now` is a parameter on the function precisely so this can be tested without touching the clock.

test('January to July default to the CURRENT calendar year', () => {
  for (const month of [0, 1, 2, 3, 4, 5, 6]) {
    assert.equal(
      currentSeasonYear(new Date(2026, month, 15)), 2026,
      `month index ${month} should still be the current season`,
    )
  }
})

test('August to December roll forward to NEXT year', () => {
  // The whole point: renewals go out in late summer for the following season. In September you
  // are working on 2027, not on the 2026 season that has just ended.
  for (const month of [7, 8, 9, 10, 11]) {
    assert.equal(
      currentSeasonYear(new Date(2026, month, 15)), 2027,
      `month index ${month} should have rolled to the next season`,
    )
  }
})

test('the boundary is 1 August, exactly', () => {
  assert.equal(currentSeasonYear(new Date(2026, 6, 31)), 2026, '31 July is still this season')
  assert.equal(currentSeasonYear(new Date(2026, 7, 1)), 2027, '1 August rolls over')
})

test('the rollover crosses the calendar year correctly', () => {
  // 31 December 2026 is working on the 2027 season; 1 January 2027 is still the 2027 season.
  assert.equal(currentSeasonYear(new Date(2026, 11, 31)), 2027)
  assert.equal(currentSeasonYear(new Date(2027, 0, 1)), 2027)
})

test('the cutoff month can be overridden per call', () => {
  // The escape hatch, for a park that renews on a different cycle. October cutoff: September is
  // still the current season, October rolls forward.
  assert.equal(currentSeasonYear(new Date(2026, 8, 15), 9), 2026)
  assert.equal(currentSeasonYear(new Date(2026, 9, 1), 9), 2027)
})

test('a cutoff of 0 rolls forward all year, and 12 never rolls forward', () => {
  // The degenerate ends, pinned so a future "make it configurable" change cannot quietly
  // reinterpret them.
  assert.equal(currentSeasonYear(new Date(2026, 0, 1), 0), 2027, 'cutoff 0 = always next season')
  assert.equal(currentSeasonYear(new Date(2026, 11, 31), 12), 2026, 'cutoff 12 = never rolls')
})

// ── Named seasons: picker order, and "which season is current" (Phase 2c) ────────────────────
//
// These rules are shared by the screens' season picker AND by the dashboard's unsigned-count
// route. If they disagreed, the badge would count a different season than the list shows — which
// is the exact bug having one implementation is meant to make impossible.

const S = (id: string, name: string, year: number, opens?: string | null, closes?: string | null) =>
  ({ id, name, year, opens: opens ?? null, closes: closes ?? null })

const spring27 = S('sp', '2027 Spring', 2027, '2027-05-01', '2027-06-30')
const fall27 = S('fa', '2027 Fall', 2027, '2027-09-01', '2027-10-31')
const undated27 = S('un', '2027 Extra', 2027)
const season28 = S('s28', '2028 Season', 2028, '2028-05-01', '2028-09-30')

test('picker order: newest year first, then chronological within the year', () => {
  const out = sortSeasonsForPicker([fall27, season28, spring27]).map(s => s.id)
  assert.deepEqual(out, ['s28', 'sp', 'fa'])
})

test('an undated season sorts AFTER dated ones in its year, not to the top', () => {
  // '' would sort before any real date if compared naively — this is the rank that prevents a
  // half-configured season becoming the default the screens open on.
  const out = sortSeasonsForPicker([undated27, fall27, spring27]).map(s => s.id)
  assert.deepEqual(out, ['sp', 'fa', 'un'])
})

test('the order is TOTAL, so it never flickers between renders', () => {
  const twin = S('zz', '2027 Spring', 2027, '2027-05-01', '2027-06-30')
  const a = sortSeasonsForPicker([spring27, twin]).map(s => s.id)
  const b = sortSeasonsForPicker([twin, spring27]).map(s => s.id)
  assert.deepEqual(a, b, 'same set, same order, regardless of input order')
})

test('sortSeasonsForPicker does not mutate its input', () => {
  const input = [fall27, spring27]
  sortSeasonsForPicker(input)
  assert.deepEqual(input.map(s => s.id), ['fa', 'sp'])
})

test('seasonContains is inclusive at both ends and needs BOTH dates', () => {
  assert.equal(seasonContains(spring27, '2027-05-01'), true, 'opening day counts')
  assert.equal(seasonContains(spring27, '2027-06-30'), true, 'closing day counts')
  assert.equal(seasonContains(spring27, '2027-04-30'), false)
  assert.equal(seasonContains(spring27, '2027-07-01'), false)
  // A half-dated season has no window to be inside of.
  assert.equal(seasonContains(S('h', 'Half', 2027, '2027-05-01', null), '2027-05-15'), false)
  assert.equal(seasonContains(undated27, '2027-05-15'), false)
})

test('the current season is the one containing today', () => {
  const all = [spring27, fall27, season28]
  assert.equal(pickCurrentSeason(all, '2027-05-15')?.id, 'sp')
  assert.equal(pickCurrentSeason(all, '2027-10-01')?.id, 'fa', 'the OTHER season in the same year')
})

test('with today outside every window, it falls back to the newest by picker order', () => {
  const all = [spring27, fall27, season28]
  assert.equal(pickCurrentSeason(all, '2027-07-15')?.id, 's28')
  assert.equal(pickCurrentSeason(all, '2020-01-01')?.id, 's28')
})

test('no seasons at all is null, not a crash', () => {
  assert.equal(pickCurrentSeason([], '2027-05-15'), null)
})

test('todayISO is the LOCAL calendar day, not a UTC-shifted one', () => {
  // The bug this guards: toISOString() would report tomorrow late in the evening in a
  // positive-offset zone, and yesterday's season could be picked in a negative one.
  assert.equal(todayISO(new Date(2027, 4, 1, 23, 30)), '2027-05-01')
  assert.equal(todayISO(new Date(2027, 0, 9, 0, 5)), '2027-01-09')
})

test('the season label drops the date half when a season has no dates', () => {
  assert.equal(seasonLabel(spring27), '2027 Spring · May 1 – Jun 30')
  assert.equal(seasonLabel(undated27), '2027 Extra')
  assert.equal(seasonLabel(S('h', 'Half', 2027, '2027-05-01', null)), 'Half · May 1')
})
