// Unit tests for the pure half of the bookability chokepoint. Framework-free — runs on Node's
// built-in runner:
//
//   node --test lib/bookability.test.ts
//
// These exist because these checks used to run only on the availability SEARCH path, while
// /api/payment — the route that charges the card — re-checked nothing but double-booking. The
// dates on /book come from URL params, so search is skippable and an out-of-season or blocked
// date could be booked and charged. The tests below pin the season arithmetic and the
// blocked/overlap filter so the search and the create-side gate cannot answer differently.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  monthDayToISO,
  nightsBetween,
  checkSeason,
  checkDateFacts,
  resolveMinNights,
  ruleAppliesToSite,
  DEFAULT_CLOSED_MESSAGE,
  type DateFacts,
} from './bookability.ts'

// A conventional summer season, the shape nearly every park configures.
const SEASON = { season_start: 'May 1', season_end: 'October 15', closed_season_message: 'Closed for winter.' }

// --- month/day parsing -------------------------------------------------------

test('monthDayToISO: parses the free-text month/day the settings form stores', () => {
  assert.equal(monthDayToISO('May 1'), '05-01')
  assert.equal(monthDayToISO('October 15'), '10-15')
  assert.equal(monthDayToISO('  December 31  '), '12-31', 'surrounding whitespace is tolerated')
  assert.equal(monthDayToISO('January 5'), '01-05', 'single digits are zero-padded')
})

// --- season gate -------------------------------------------------------------

test('season: a date inside the season is bookable', () => {
  assert.equal(checkSeason('2026-07-04', SEASON).bookable, true)
})

test('season: boundaries are inclusive on both ends', () => {
  // The park is open ON its first and last day. An off-by-one here silently closes the two
  // busiest changeover days of the year.
  assert.equal(checkSeason('2026-05-01', SEASON).bookable, true, 'opening day')
  assert.equal(checkSeason('2026-10-15', SEASON).bookable, true, 'closing day')
})

test('season: the days just outside the boundaries are rejected', () => {
  const before = checkSeason('2026-04-30', SEASON)
  assert.equal(before.bookable, false)
  assert.equal(before.reason, 'out-of-season')

  const after = checkSeason('2026-10-16', SEASON)
  assert.equal(after.bookable, false)
  assert.equal(after.reason, 'out-of-season')
})

test('season: a deep-winter date is rejected and carries the park\'s own message', () => {
  const r = checkSeason('2027-01-20', SEASON)
  assert.equal(r.bookable, false)
  assert.equal(r.message, 'Closed for winter.', 'the configured wording, not a generic error')
})

test('season: an unconfigured season closes nothing', () => {
  // A park that has not set a season must not have every date rejected — half a season is not
  // a season, matching what the availability route has always done.
  assert.equal(checkSeason('2026-01-20', null).bookable, true)
  assert.equal(checkSeason('2026-01-20', {}).bookable, true)
  assert.equal(checkSeason('2026-01-20', { season_start: 'May 1' }).bookable, true, 'start only')
  assert.equal(checkSeason('2026-01-20', { season_end: 'October 15' }).bookable, true, 'end only')
})

test('season: falls back to the default closed message when the park configured none', () => {
  const r = checkSeason('2026-02-01', { season_start: 'May 1', season_end: 'October 15' })
  assert.equal(r.bookable, false)
  assert.equal(r.message, DEFAULT_CLOSED_MESSAGE)
})

test('season: the same rule applies in every calendar year', () => {
  for (const year of ['2026', '2027', '2030']) {
    assert.equal(checkSeason(`${year}-07-04`, SEASON).bookable, true, `July ${year}`)
    assert.equal(checkSeason(`${year}-12-25`, SEASON).bookable, false, `December ${year}`)
  }
})

test('season: KNOWN BUG, a season spanning New Year rejects everything — unchanged by PR 0', () => {
  // The season is built from the ARRIVAL's own calendar year, so a November→March season
  // resolves to a start (Nov 1) later than its end (Mar 31) and nothing is ever inside it.
  //
  // This is pre-existing behaviour on the search path, pinned here deliberately rather than
  // fixed: PR 0's job is to make create agree with search on every date. Fixing the wrap here
  // alone would make create ACCEPT dates search still rejects — the exact drift this module
  // exists to prevent. The fix rides with the seasonal-release PR, in checkSeason, for both
  // callers at once. This test documents the bug and will be inverted then.
  const WRAPPING = { season_start: 'November 1', season_end: 'March 31' }
  assert.equal(checkSeason('2026-12-20', WRAPPING).bookable, false, 'mid-season, still rejected')
  assert.equal(checkSeason('2026-02-10', WRAPPING).bookable, false, 'mid-season, still rejected')
  assert.equal(checkSeason('2026-07-04', WRAPPING).bookable, false, 'genuinely out of season')
  // The point that matters for PR 0: the gate is not newly WRONG in either direction — it
  // rejects, and search rejected the same dates before this extraction. No date became
  // bookable at create that was not bookable at search.
})

// --- nights ------------------------------------------------------------------

test('nights: counted between plain dates, DST notwithstanding', () => {
  assert.equal(nightsBetween('2026-07-01', '2026-07-04'), 3)
  assert.equal(nightsBetween('2026-07-01', '2026-07-02'), 1)
  // US DST changeover falls inside this range; parsing at UTC noon keeps it a whole number.
  assert.equal(nightsBetween('2026-03-07', '2026-03-09'), 2, 'spring forward')
  assert.equal(nightsBetween('2026-10-31', '2026-11-02'), 2, 'fall back')
})

test('nights: a non-range yields zero or less, which the chokepoint rejects', () => {
  assert.equal(nightsBetween('2026-07-04', '2026-07-04'), 0, 'same day is not a stay')
  assert.ok(nightsBetween('2026-07-04', '2026-07-01') < 0, 'reversed range')
  assert.equal(nightsBetween('nonsense', '2026-07-04'), 0, 'unparseable')
})

// --- blocked dates and double-booking ----------------------------------------

const facts = (over: Partial<DateFacts> = {}): DateFacts => ({
  blockedAllSites: false,
  blockedSiteIds: new Set<string>(),
  bookedSiteIds: new Set<string>(),
  ...over,
})

test('dates: an unblocked, unbooked site is bookable', () => {
  assert.equal(checkDateFacts('site-a', facts()).bookable, true)
})

test('dates: a park-wide block closes every site', () => {
  // blocked_dates rows with site_id NULL are the park closing a date for everyone — the case
  // /api/payment did not check at all, so a guest could be charged for a date the park had
  // deliberately closed.
  const r = checkDateFacts('site-a', facts({ blockedAllSites: true }))
  assert.equal(r.bookable, false)
  assert.equal(r.reason, 'blocked')
})

test('dates: a per-site block closes only that site', () => {
  const f = facts({ blockedSiteIds: new Set(['site-a']) })
  assert.equal(checkDateFacts('site-a', f).bookable, false)
  assert.equal(checkDateFacts('site-b', f).bookable, true, 'the neighbouring site is unaffected')
})

test('dates: an overlapping reservation is a double-booking', () => {
  const r = checkDateFacts('site-a', facts({ bookedSiteIds: new Set(['site-a']) }))
  assert.equal(r.bookable, false)
  assert.equal(r.reason, 'double-booked')
})

test('dates: a block outranks a double-booking in the reported reason', () => {
  // Both true at once; the guest should be told the dates are unavailable rather than be sent
  // off to pick another site that is also blocked.
  const r = checkDateFacts('site-a', facts({ blockedAllSites: true, bookedSiteIds: new Set(['site-a']) }))
  assert.equal(r.reason, 'blocked')
})

// --- min stay ----------------------------------------------------------------

test('min-stay: no rule means no minimum', () => {
  assert.equal(resolveMinNights([], { id: 'site-a', site_type: 'rv_site' }), 1)
  assert.equal(resolveMinNights(null, { id: 'site-a', site_type: 'rv_site' }), 1)
})

test('min-stay: rules match by site id, site-id list, or site type', () => {
  const site = { id: 'site-a', site_type: 'rv_site' }
  assert.equal(ruleAppliesToSite({ site_id: 'site-a' }, site), true)
  assert.equal(ruleAppliesToSite({ site_id: 'site-b' }, site), false)
  assert.equal(ruleAppliesToSite({ site_ids: 'site-x,site-a,site-y' }, site), true)
  assert.equal(ruleAppliesToSite({ site_ids: 'site-x,site-y' }, site), false)
  assert.equal(ruleAppliesToSite({ site_type: 'rv_site' }, site), true)
  assert.equal(ruleAppliesToSite({ site_type: 'cabin' }, site), false)
  assert.equal(ruleAppliesToSite({}, site), false, 'a rule targeting nothing applies to nothing')
})

test('min-stay: the strictest applicable rule wins', () => {
  const site = { id: 'site-a', site_type: 'rv_site' }
  const rules = [
    { site_type: 'rv_site', min_nights: 2 },
    { site_id: 'site-a', min_nights: 3 },
    { site_id: 'site-b', min_nights: 7 }, // a different site — must not apply
  ]
  assert.equal(resolveMinNights(rules, site), 3)
  assert.equal(resolveMinNights(rules, { id: 'site-b', site_type: 'cabin' }), 7)
})

test('min-stay: search and create resolve the same number for the same site', () => {
  // The property that matters. Both routes call resolveMinNights, so the minimum a guest is
  // shown at search is arithmetically the minimum enforced before the charge — a 3-night
  // minimum cannot be dodged by going straight to /book with a 1-night URL.
  const site = { id: 'site-a', site_type: 'rv_site' }
  const rules = [{ site_ids: 'site-a', min_nights: 3 }]
  const shownAtSearch = resolveMinNights(rules, site)
  const enforcedAtCreate = resolveMinNights(rules, site)
  assert.equal(shownAtSearch, enforcedAtCreate)
  assert.ok(nightsBetween('2026-07-01', '2026-07-02') < enforcedAtCreate, 'a 1-night URL is rejected')
  assert.ok(nightsBetween('2026-07-01', '2026-07-04') >= enforcedAtCreate, 'a 3-night stay passes')
})
