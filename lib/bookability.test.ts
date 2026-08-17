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
  addDays,
  checkSeason,
  checkDateFacts,
  resolveMinNights,
  ruleAppliesToSite,
  resolveMaxAdvanceDays,
  horizonLastArrival,
  checkHorizon,
  checkBookability,
  HORIZON_SERVER_SLACK_DAYS,
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

// --- date arithmetic ---------------------------------------------------------

test('addDays: rolls over months and years', () => {
  assert.equal(addDays('2026-08-17', 1), '2026-08-18')
  assert.equal(addDays('2026-08-17', 0), '2026-08-17')
  assert.equal(addDays('2026-08-31', 1), '2026-09-01', 'month rollover')
  assert.equal(addDays('2026-12-31', 1), '2027-01-01', 'year rollover')
  assert.equal(addDays('2026-08-17', 365), '2027-08-17')
  assert.equal(addDays('2026-08-17', -1), '2026-08-16', 'negative days go backwards')
})

test('addDays: leap day is real', () => {
  assert.equal(addDays('2028-02-28', 1), '2028-02-29', '2028 is a leap year')
  assert.equal(addDays('2026-02-28', 1), '2026-03-01', '2026 is not')
})

test('addDays: crossing a DST boundary does not shift the date', () => {
  // The reason for UTC-noon parsing. US DST springs forward on 2027-03-14 and falls back on
  // 2027-11-07; adding whole days across either must land on the calendar day, not 23:00 the
  // day before, whatever timezone the machine running this is in.
  assert.equal(addDays('2027-03-13', 1), '2027-03-14', 'spring forward')
  assert.equal(addDays('2027-03-13', 2), '2027-03-15')
  assert.equal(addDays('2027-11-06', 1), '2027-11-07', 'fall back')
  assert.equal(addDays('2027-11-06', 2), '2027-11-08')
  // And over a long horizon spanning both, the count must not drift by an hour-induced day.
  assert.equal(addDays('2027-01-01', 365), '2028-01-01')
})

test('addDays: an unparseable date is returned unchanged', () => {
  // So a malformed arrival cannot fabricate a huge window inside checkHorizon.
  assert.equal(addDays('not-a-date', 400), 'not-a-date')
  assert.equal(addDays('', 400), '')
})

// --- horizon: what counts as a horizon at all --------------------------------

test('resolveMaxAdvanceDays: unset means no limit', () => {
  // The provisioned value and the steady state. This is the assertion that makes the migration
  // safe to run on a live tenant mid-season: NULL behaves exactly as the column not existing did.
  assert.equal(resolveMaxAdvanceDays(null), null)
  assert.equal(resolveMaxAdvanceDays(undefined), null)
  assert.equal(resolveMaxAdvanceDays(''), null)
})

test('resolveMaxAdvanceDays: a real horizon is kept', () => {
  assert.equal(resolveMaxAdvanceDays(365), 365)
  assert.equal(resolveMaxAdvanceDays(1), 1, 'one day is the smallest usable window')
  assert.equal(resolveMaxAdvanceDays(1095), 1095)
  assert.equal(resolveMaxAdvanceDays('180'), 180, 'a numeric string is accepted')
})

test('resolveMaxAdvanceDays: garbage FAILS OPEN, never closed', () => {
  // A park whose horizon value is nonsense keeps taking bookings. The alternative — treating an
  // unreadable value as a limit — takes a campground offline over a bad settings row, which is a
  // far worse failure than accepting a booking further out than the owner wanted.
  assert.equal(resolveMaxAdvanceDays(0), null, 'zero is a cleared field, not "today only"')
  assert.equal(resolveMaxAdvanceDays(-30), null)
  assert.equal(resolveMaxAdvanceDays(30.5), null, 'fractions are not days')
  assert.equal(resolveMaxAdvanceDays(NaN), null)
  assert.equal(resolveMaxAdvanceDays('soon'), null)
  assert.equal(resolveMaxAdvanceDays({}), null)
  assert.equal(resolveMaxAdvanceDays(true), null)
})

// --- horizon: the gate -------------------------------------------------------

const TODAY = '2026-08-17'

test('horizon: no horizon set means every date is bookable', () => {
  assert.equal(checkHorizon('2031-07-04', null, TODAY).bookable, true, 'null settings')
  assert.equal(checkHorizon('2031-07-04', {}, TODAY).bookable, true, 'no column')
  assert.equal(checkHorizon('2031-07-04', { max_advance_days: null }, TODAY).bookable, true)
})

test('horizon: the boundary day itself is bookable', () => {
  // today + 180 must be ACCEPTED. This is the off-by-one that would make the date picker offer a
  // day the server refuses, and it is the single most likely bug in this feature.
  const h = { max_advance_days: 180 }
  assert.equal(horizonLastArrival(180, TODAY), '2027-02-13')
  assert.equal(checkHorizon('2027-02-13', h, TODAY).bookable, true, 'the last bookable day')
  assert.equal(checkHorizon('2027-02-12', h, TODAY).bookable, true, 'the day before')
  assert.equal(checkHorizon(TODAY, h, TODAY).bookable, true, 'today')
})

test('horizon: past the boundary is refused, with the client applying no slack', () => {
  const h = { max_advance_days: 180 }
  const r = checkHorizon('2027-02-14', h, TODAY)
  assert.equal(r.bookable, false)
  assert.equal(r.reason, 'beyond-horizon')
  assert.match(r.message, /180 days in advance/)
  assert.match(r.message, /2027-02-13/, 'the message quotes the TRUE last bookable date')
})

test('horizon: the server allows exactly one day of slack, and no more', () => {
  // The timezone concession. `settings` has no park timezone, so the server's UTC "today" can be
  // a day ahead of the park's — and must not reject an arrival the picker legitimately offered.
  // One day open, two days closed.
  const h = { max_advance_days: 30 }
  const slack = HORIZON_SERVER_SLACK_DAYS
  assert.equal(slack, 1, 'if this changes, the reasoning in bookability.ts needs rereading')
  assert.equal(horizonLastArrival(30, TODAY), '2026-09-16')
  assert.equal(checkHorizon('2026-09-16', h, TODAY, slack).bookable, true, 'the true boundary')
  assert.equal(checkHorizon('2026-09-17', h, TODAY, slack).bookable, true, 'one day of slack')
  assert.equal(checkHorizon('2026-09-18', h, TODAY, slack).bookable, false, 'two days is beyond')
  // The client, with no slack, stops a day earlier — so anything the client offers, the server
  // takes. That is the direction the asymmetry must run.
  assert.equal(checkHorizon('2026-09-17', h, TODAY, 0).bookable, false, 'client is stricter')
})

test('horizon: the slack date is never advertised to the guest', () => {
  // A rejected guest must be told the owner's window, not the internal tolerance, or the park
  // appears to accept a date its own calendar refuses.
  const r = checkHorizon('2027-01-01', { max_advance_days: 30 }, TODAY, HORIZON_SERVER_SLACK_DAYS)
  assert.equal(r.bookable, false)
  assert.match(r.message, /2026-09-16/, 'the true horizon')
  assert.doesNotMatch(r.message, /2026-09-17/, 'not the slack-extended one')
})

test('horizon: ARRIVAL only — a stay that ends beyond the window is fine', () => {
  // The D2 decision, pinned. With a 30-day horizon a guest arriving on day 29 for two weeks is
  // booking a departure ~43 days out, and that must be accepted: the horizon is about how far
  // ahead you may plan, not when your trip ends. Checking the departure too would silently
  // shorten every park's window by the length of the stay.
  const h = { max_advance_days: 30 }
  assert.equal(checkHorizon('2026-09-15', h, TODAY, 0).bookable, true, 'arrival inside')
  // Sanity: the departure this implies really is outside the window, so the test is meaningful.
  assert.ok('2026-09-29' > horizonLastArrival(30, TODAY), 'the departure is genuinely beyond')
})

test('horizon: one day reads as singular', () => {
  const r = checkHorizon('2026-08-25', { max_advance_days: 1 }, TODAY, 0)
  assert.equal(r.bookable, false)
  assert.match(r.message, /up to 1 day in advance/, 'not "1 days"')
})

test('horizon: garbage settings let every date through', () => {
  // Same fail-open property as resolveMaxAdvanceDays, at the gate rather than the parser.
  for (const bad of [0, -1, 'soon', 12.5, NaN]) {
    assert.equal(
      checkHorizon('2031-07-04', { max_advance_days: bad as any }, TODAY, 0).bookable,
      true,
      `max_advance_days=${String(bad)} must not close the park`
    )
  }
})

test('horizon: a long window still lands on the right calendar day', () => {
  // 365 across a leap year, and 1095 across two, are the values an owner is most likely to type.
  assert.equal(horizonLastArrival(365, '2027-06-01'), '2028-05-31', 'through 2028-02-29')
  assert.equal(horizonLastArrival(1095, '2026-01-01'), '2028-12-31')
  assert.equal(checkHorizon('2028-05-31', { max_advance_days: 365 }, '2027-06-01', 0).bookable, true)
  assert.equal(checkHorizon('2028-06-01', { max_advance_days: 365 }, '2027-06-01', 0).bookable, false)
})

// --- the chokepoint: ordering and the staff override -------------------------

// A stand-in for the Supabase client, good enough for checkBookability's five reads. Every
// builder method returns the chain; the chain is awaitable (for the range queries) and has
// .single() (for settings and sites). Deliberately dumb: it does not filter, so the caller states
// exactly which rows each table should appear to hold.
function fakeSupabase(rows: Record<string, any[]>) {
  return {
    from(table: string) {
      const data = rows[table] ?? []
      const chain: any = {
        then: (resolve: (v: any) => void) => resolve({ data }),
        single: async () => ({ data: data[0] ?? null }),
      }
      for (const m of ['select', 'eq', 'neq', 'lt', 'lte', 'gt', 'gte', 'limit', 'order']) {
        chain[m] = () => chain
      }
      return chain
    },
  }
}

const SITE = { id: 'site-a', site_type: 'rv_site' }
const OPEN_ALL_YEAR = { season_start: null, season_end: null, closed_season_message: null }

test('chokepoint: the horizon refuses a date the season would have allowed', () => {
  return (async () => {
    const r = await checkBookability(fakeSupabase({}), {
      arrival: '2031-07-04',
      departure: '2031-07-07',
      siteId: SITE.id,
      site: SITE,
      settings: { ...OPEN_ALL_YEAR, max_advance_days: 30 },
      today: TODAY,
    })
    assert.equal(r.bookable, false)
    assert.equal(r.reason, 'beyond-horizon')
  })()
})

test('chokepoint: inside the horizon, everything else still applies', () => {
  return (async () => {
    // The horizon must not become a way past the other gates. Same date, inside the window, but
    // the site is already taken.
    const r = await checkBookability(fakeSupabase({ reservations: [{ site_id: 'site-a' }] }), {
      arrival: '2026-08-20',
      departure: '2026-08-22',
      siteId: SITE.id,
      site: SITE,
      settings: { ...OPEN_ALL_YEAR, max_advance_days: 30 },
      today: TODAY,
    })
    assert.equal(r.bookable, false)
    assert.equal(r.reason, 'double-booked')
  })()
})

test('chokepoint: the horizon is reported before the season', () => {
  return (async () => {
    // Both violated. The guest looking at 2031 needs to hear about the booking window; telling
    // them the park is closed next February answers a question they did not ask.
    const r = await checkBookability(fakeSupabase({}), {
      arrival: '2031-01-20',
      departure: '2031-01-22',
      siteId: SITE.id,
      site: SITE,
      settings: { season_start: 'May 1', season_end: 'October 15', closed_season_message: 'Closed for winter.', max_advance_days: 30 },
      today: TODAY,
    })
    assert.equal(r.reason, 'beyond-horizon')
  })()
})

test('chokepoint: an invalid range is still caught before the horizon', () => {
  return (async () => {
    const r = await checkBookability(fakeSupabase({}), {
      arrival: '2031-07-07',
      departure: '2031-07-04',
      siteId: SITE.id,
      site: SITE,
      settings: { ...OPEN_ALL_YEAR, max_advance_days: 30 },
      today: TODAY,
    })
    assert.equal(r.reason, 'invalid-range', 'a backwards range is not a horizon problem')
  })()
})

test('chokepoint: allowBeyondHorizon lets staff book past the window', () => {
  return (async () => {
    const r = await checkBookability(fakeSupabase({}), {
      arrival: '2031-07-04',
      departure: '2031-07-07',
      siteId: SITE.id,
      site: SITE,
      settings: { ...OPEN_ALL_YEAR, max_advance_days: 30 },
      today: TODAY,
      allowBeyondHorizon: true,
    })
    assert.equal(r.bookable, true, 'the phone call that starts "can I get a site for next August?"')
  })()
})

test('chokepoint: allowBeyondHorizon overrides the horizon and NOTHING else', () => {
  return (async () => {
    // The property that keeps the override safe. An operator waiving the park's booking window
    // must not thereby waive double-booking, blocked dates, the season or min-stay — those are
    // not preferences, and an override there puts a guest in an occupied site.
    const base = {
      arrival: '2031-07-04',
      departure: '2031-07-07',
      siteId: SITE.id,
      site: SITE,
      today: TODAY,
      allowBeyondHorizon: true,
    }

    const booked = await checkBookability(fakeSupabase({ reservations: [{ site_id: 'site-a' }] }), {
      ...base,
      settings: { ...OPEN_ALL_YEAR, max_advance_days: 30 },
    })
    assert.equal(booked.reason, 'double-booked', 'override does not permit a double-booking')

    const blocked = await checkBookability(fakeSupabase({ blocked_dates: [{ site_id: null, date: '2031-07-05' }] }), {
      ...base,
      settings: { ...OPEN_ALL_YEAR, max_advance_days: 30 },
    })
    assert.equal(blocked.reason, 'blocked', 'override does not permit a park-wide blocked date')

    const closed = await checkBookability(fakeSupabase({}), {
      ...base,
      arrival: '2031-01-20',
      departure: '2031-01-22',
      settings: { season_start: 'May 1', season_end: 'October 15', closed_season_message: 'Closed.', max_advance_days: 30 },
    })
    assert.equal(closed.reason, 'out-of-season', 'override does not permit an out-of-season date')

    const short = await checkBookability(fakeSupabase({ min_stay_rules: [{ site_id: 'site-a', min_nights: 5 }] }), {
      ...base,
      departure: '2031-07-05',
      settings: { ...OPEN_ALL_YEAR, max_advance_days: 30 },
    })
    assert.equal(short.reason, 'min-stay', 'override does not permit an under-minimum stay')
  })()
})

test('chokepoint: with no horizon set, the override changes nothing', () => {
  return (async () => {
    for (const allow of [false, true, undefined]) {
      const r = await checkBookability(fakeSupabase({}), {
        arrival: '2031-07-04',
        departure: '2031-07-07',
        siteId: SITE.id,
        site: SITE,
        settings: { ...OPEN_ALL_YEAR, max_advance_days: null },
        today: TODAY,
        allowBeyondHorizon: allow,
      })
      assert.equal(r.bookable, true, `allowBeyondHorizon=${String(allow)}`)
    }
  })()
})
