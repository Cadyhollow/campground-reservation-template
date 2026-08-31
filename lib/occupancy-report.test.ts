import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  siteTypesFrom, typeLabel, isRentable, resolveSiteType, siteTypeByNumber,
  nightsBetween, isWeekendNight, isMidweekNight, seasonRange, buildOccupants,
  buildOccupancyReport, buildSeasonalProgram, isSeasonalSite, UNRESOLVED_TYPE,
  splitSiteNumbers, resolveSiteTypes,
  type RentableSite, type Occupant,
} from './occupancy-report.ts'

// Occupancy by site type.
//
// Four properties carry this file:
//   1. TYPES ARE DISCOVERED FROM THE DATA. A park with yurts gets yurts, with nothing configured.
//   2. NOBODY IS SILENTLY DROPPED. A camper on a site number that does not exist is bucketed and
//      named; a camper with no season dates is reported rather than evaporating.
//   3. THE BLENDED NIGHTLY RATE IS THE ACTUAL CONTRACTS, so several fee levels average correctly.
//   4. THE DEPARTURE DAY IS STILL NOT A NIGHT — R3's one definition, reused rather than restated.

const SITES: RentableSite[] = [
  { id: 's1', site_number: '1', site_type: 'rv_site', is_available: true },
  { id: 's2', site_number: '2', site_type: 'rv_site', is_available: true },
  { id: 'c1', site_number: 'C1', site_type: 'cabin', is_available: true },
  { id: 't1', site_number: 'T1', site_type: 'tent', is_available: true },
]
const byId = new Map(SITES.map(s => [s.id as string, s.site_type as string]))
const byNumber = siteTypeByNumber(SITES)

// ── types are discovered ─────────────────────────────────────────────────────────────────────

test('SITE TYPES COME OUT OF THE DATA, so a park with yurts needs no configuration', () => {
  const exotic = [...SITES, { id: 'y1', site_number: 'Y1', site_type: 'glamping_dome', is_available: true }]
  assert.deepEqual(siteTypesFrom(exotic), ['cabin', 'glamping_dome', 'rv_site', 'tent'])
  assert.equal(typeLabel('glamping_dome'), 'Glamping Dome', 'and it gets a readable label for free')
  assert.equal(typeLabel('rv_site'), 'RV Sites')
  assert.equal(typeLabel('cabin'), 'Cabins')
})

test('a site with no type is still inventory somebody can sleep on', () => {
  assert.deepEqual(siteTypesFrom([{ id: 'x', site_number: '9', site_type: null, is_available: true }]),
    [UNRESOLVED_TYPE])
})

test('only rentable sites widen the denominator', () => {
  const withClosed = [...SITES, { id: 'z', site_number: '99', site_type: 'yurt', is_available: false }]
  assert.ok(!siteTypesFrom(withClosed).includes('yurt'), 'a site the park cannot sell is not capacity')
  assert.equal(isRentable({ is_available: undefined }), true, 'unset means rentable, as the booking screens read it')
})

// ── resolving a camper to a type ─────────────────────────────────────────────────────────────

test('A SITE NUMBER THAT MATCHES NOTHING IS BUCKETED, NOT LOST', () => {
  // Seasonal campers carry site_number as free text, not a foreign key. A typo or a bad import
  // leaves a real camper pointing at a site that does not exist. Dropping them would understate
  // occupancy AND quietly change the average nightly rate.
  assert.equal(resolveSiteType('7', byNumber), UNRESOLVED_TYPE)
  assert.equal(resolveSiteType('', byNumber), UNRESOLVED_TYPE)
  assert.equal(resolveSiteType(null, byNumber), UNRESOLVED_TYPE)
})

test('matching is trimmed and case-insensitive', () => {
  assert.equal(resolveSiteType(' c1 ', byNumber), 'cabin')
  assert.equal(resolveSiteType('C1', byNumber), 'cabin')
  assert.equal(resolveSiteType('1', byNumber), 'rv_site')
})

// ── the window ───────────────────────────────────────────────────────────────────────────────

test('a window is every night inclusive, and crosses months', () => {
  assert.deepEqual(nightsBetween('2026-08-30', '2026-09-01'), ['2026-08-30', '2026-08-31', '2026-09-01'])
  assert.equal(nightsBetween('2026-01-01', '2026-12-31').length, 365)
  assert.deepEqual(nightsBetween('2026-09-02', '2026-09-01'), [], 'a backwards window is empty, not infinite')
})

test('WEEKEND MEANS FRIDAY AND SATURDAY NIGHTS — Sunday is not the weekend', () => {
  // A guest arriving Friday and leaving Sunday stayed the Friday and Saturday NIGHTS. Counting
  // Sunday night as weekend would drag every park's weekend number down with its quietest night.
  assert.equal(isWeekendNight('2026-09-04'), true, 'Friday')
  assert.equal(isWeekendNight('2026-09-05'), true, 'Saturday')
  assert.equal(isWeekendNight('2026-09-06'), false, 'Sunday')
  assert.equal(isMidweekNight('2026-09-06'), false, 'and Sunday is not midweek either')
  assert.equal(isMidweekNight('2026-09-07'), true, 'Monday')
  assert.equal(isMidweekNight('2026-09-10'), true, 'Thursday')
})

// ── season ranges ────────────────────────────────────────────────────────────────────────────

test('the season range prefers the contract, then the season, then the guest', () => {
  const camper = { season_start: '2026-01-01', season_end: '2026-01-31' }
  assert.deepEqual(seasonRange({ season_opens: '2026-05-01', season_closes: '2026-09-30' }, { opens: '2026-06-01', closes: '2026-08-31' }, camper),
    { from: '2026-05-01', to: '2026-10-01' }, 'the contract overrides for one camper')
  assert.deepEqual(seasonRange({}, { opens: '2026-06-01', closes: '2026-08-31' }, camper),
    { from: '2026-06-01', to: '2026-09-01' }, 'then the park-wide season')
  assert.deepEqual(seasonRange({}, null, camper),
    { from: '2026-01-01', to: '2026-02-01' }, 'then the guest as a last resort')
  assert.equal(seasonRange({}, null, {}), null, 'and nothing at all is honestly nothing')
})

test('CLOSES IS INCLUSIVE, so the last night of the season is counted', () => {
  // Off by one here would drop a night from every seasonal site and nudge every blended rate up.
  const r = seasonRange({ season_opens: '2026-05-01', season_closes: '2026-09-30' }, null, null)!
  assert.equal(r.to, '2026-10-01', 'exclusive end = the morning they leave')
})

// ── building occupants ───────────────────────────────────────────────────────────────────────

const campers = [
  { id: 'g1', name: 'Thompson', site_number: '1', is_seasonal: true, season_start: '2026-05-01', season_end: '2026-09-30' },
  { id: 'g2', name: 'Whitmore', site_number: '7', is_seasonal: true, season_start: '2026-05-01', season_end: '2026-09-30' },
  { id: 'g3', name: 'Reyes', site_number: '2', is_monthly: true },
  { id: 'g4', name: 'Just a guest', site_number: '2' },
]
const contracts = [
  { guest_id: 'g1', site_number: '1', total_due_cents: 200000, season_year: 2026, status: 'signed' },
  { guest_id: 'g2', site_number: '7', total_due_cents: 200000, season_year: 2026, status: 'signed' },
  { guest_id: 'g1', site_number: '1', total_due_cents: 999999, season_year: 2026, status: 'cancelled' },
]

test('every camper is accounted for — placed, bucketed, or named as undated', () => {
  const { occupants, undated } = buildOccupants(contracts, new Map(), campers, byNumber)
  assert.equal(occupants.length, 2, 'two contracts; the cancelled one holds no site')
  assert.equal(occupants.find(o => o.key.startsWith('Thompson'))!.type, 'rv_site')
  assert.equal(occupants.find(o => o.key.startsWith('Whitmore'))!.type, UNRESOLVED_TYPE,
    'site 7 does not exist — bucketed, not dropped')
  assert.deepEqual(undated, ['Reyes'], 'the monthly camper has no dates and is REPORTED, not hidden')
  assert.ok(!occupants.some(o => o.key === 'Just a guest'), 'an ordinary guest holds no site')
})

test('A WITHDRAWN CONTRACT ATTRIBUTES NO MONEY', () => {
  // The camper may still be on the site — their guest row says so — but a contract that was
  // voided is not revenue, and letting its amount through would inflate the blended rate for the
  // whole site type.
  const { occupants } = buildOccupants(
    [{ guest_id: 'g1', site_number: '1', total_due_cents: 500000, status: 'void' }], new Map(), campers, byNumber)
  const thompson = occupants.find(o => o.key === 'Thompson')!
  assert.ok(thompson, 'the camper still holds their site, from the guest row')
  assert.equal(thompson.totalCents, 0, 'but the voided amount is NOT attributed')
  assert.equal(thompson.revenueUnknown, true, 'and the gap is flagged rather than read as cheap')
  assert.ok(!occupants.some(o => o.key.includes('(')), 'no contract-derived occupant survived')
})

test('a season row is used when the contract has no dates of its own', () => {
  const seasons = new Map([['sea1', { id: 'sea1', opens: '2026-06-01', closes: '2026-08-31' }]])
  const { occupants } = buildOccupants(
    [{ guest_id: 'g1', site_number: '1', total_due_cents: 100000, season_id: 'sea1', status: 'signed' }],
    seasons, campers, byNumber)
  assert.equal(occupants[0].from, '2026-06-01')
  assert.equal(occupants[0].to, '2026-09-01')
})

// ── the report ───────────────────────────────────────────────────────────────────────────────

const WINDOW = { start: '2026-09-01', end: '2026-09-30' }   // 30 nights

test('THE DEPARTURE DAY IS NOT A NIGHT — R3s rule, reused', () => {
  const nightly = [{ id: 'r1', site_id: 'c1', arrival_date: '2026-09-04', departure_date: '2026-09-06',
                     total_price: 24000, status: 'confirmed' }]
  const rep = buildOccupancyReport(SITES, nightly, byId, [], WINDOW)
  const cabin = rep.byType.find(t => t.type === 'cabin')!
  assert.equal(cabin.occupiedNights, 2, 'the 4th and the 5th; not the 6th')
  assert.equal(cabin.avgNightlyCents, 12000, '$240 over two nights')
})

test('a cancelled reservation occupies nothing', () => {
  const nightly = [{ id: 'r1', site_id: 'c1', arrival_date: '2026-09-04', departure_date: '2026-09-08',
                     total_price: 48000, status: 'cancelled' }]
  assert.equal(buildOccupancyReport(SITES, nightly, byId, [], WINDOW).total.occupiedNights, 0)
})

test('the denominator is the RENTABLE SITES, per type, over the window', () => {
  const rep = buildOccupancyReport(SITES, [], byId, [], WINDOW)
  assert.equal(rep.byType.find(t => t.type === 'rv_site')!.units, 2)
  assert.equal(rep.byType.find(t => t.type === 'rv_site')!.availableNights, 2 * 30)
  assert.equal(rep.total.units, 4, 'ALL types count, not just one')
  assert.equal(rep.total.availableNights, 4 * 30)
})

test('THE ALL-TYPES ROW IS SUMMED FROM THE PARTS, so it cannot disagree with them', () => {
  const nightly = [
    { id: 'a', site_id: 'c1', arrival_date: '2026-09-04', departure_date: '2026-09-06', total_price: 24000, status: 'confirmed' },
    { id: 'b', site_id: 't1', arrival_date: '2026-09-10', departure_date: '2026-09-13', total_price: 9000, status: 'confirmed' },
  ]
  const rep = buildOccupancyReport(SITES, nightly, byId, [], WINDOW)
  assert.equal(rep.total.occupiedNights, rep.byType.reduce((s, t) => s + t.occupiedNights, 0))
  assert.equal(rep.total.revenueCents, rep.byType.reduce((s, t) => s + t.revenueCents, 0))
  assert.equal(rep.total.availableNights, rep.byType.reduce((s, t) => s + t.availableNights, 0))
})

test('WEEKEND AND MIDWEEK ARE MEASURED AGAINST THEIR OWN NIGHTS', () => {
  // Fri 4th + Sat 5th September 2026, on the one cabin.
  const nightly = [{ id: 'a', site_id: 'c1', arrival_date: '2026-09-04', departure_date: '2026-09-06',
                     total_price: 24000, status: 'confirmed' }]
  const cabin = buildOccupancyReport(SITES, nightly, byId, [], WINDOW).byType.find(t => t.type === 'cabin')!
  // September 2026 has 4 Fridays and 4 Saturdays = 8 weekend nights for one cabin.
  assert.equal(cabin.weekendPct, 25, '2 of 8 weekend nights')
  assert.equal(cabin.midweekPct, 0, 'and nothing midweek')
  assert.equal(cabin.byDow[4], 25, 'Friday: 1 of 4')
  assert.equal(cabin.byDow[5], 25, 'Saturday: 1 of 4')
  assert.equal(cabin.byDow[0], 0, 'Monday')
})

test('A BLENDED NIGHTLY RATE AVERAGES SEVERAL REAL FEE LEVELS', () => {
  // Charissa's ask: three fee levels must average correctly, never a flat assumption. Two RV
  // sites held all September at $180,000 and $220,000 for a 153-night season.
  const season = { from: '2026-05-01', to: '2026-10-01' }        // 153 nights
  const occupants: Occupant[] = [
    { key: 'A', type: 'rv_site', ...season, totalCents: 180000 },
    { key: 'B', type: 'rv_site', ...season, totalCents: 220000 },
  ]
  const rv = buildOccupancyReport(SITES, [], byId, occupants, WINDOW).byType.find(t => t.type === 'rv_site')!
  assert.equal(rv.occupiedNights, 60, 'two sites x 30 nights')
  assert.equal(rv.occupancyPct, 100)
  // Each fee prorates over 153 nights: 180000/153 = 1176, 220000/153 = 1438 (rounded per night).
  const expected = Math.round((1176 * 30 + 1438 * 30) / 60)
  assert.equal(rv.avgNightlyCents, expected)
  assert.ok(rv.avgNightlyCents! > 1176 && rv.avgNightlyCents! < 1438, 'strictly between the two levels')
})

test('A SEASON FEE IS PRORATED, so only the window s share is counted', () => {
  const occupants: Occupant[] = [
    { key: 'A', type: 'rv_site', from: '2026-05-01', to: '2026-10-01', totalCents: 153000 },  // $10/night
  ]
  const rep = buildOccupancyReport(SITES, [], byId, occupants, WINDOW)
  const rv = rep.byType.find(t => t.type === 'rv_site')!
  assert.equal(rv.revenueCents, 1000 * 30, 'thirty of the season s nights, not the whole fee')
  assert.equal(rv.avgNightlyCents, 1000)
})

test('a seasonal camper outside the window holds none of its nights', () => {
  const occupants: Occupant[] = [
    { key: 'Future', type: 'rv_site', from: '2028-05-01', to: '2028-10-01', totalCents: 200000 },
  ]
  const rep = buildOccupancyReport(SITES, [], byId, occupants, WINDOW)
  assert.equal(rep.total.occupiedNights, 0, 'a 2028 season is not occupancy in September 2026')
  assert.equal(rep.total.avgNightlyCents, null, 'and an empty window has NO rate, rather than $0')
})

test('AN UNRESOLVED CAMPER IS COUNTED AND NAMED', () => {
  const occupants: Occupant[] = [
    { key: 'Whitmore (2026)', type: UNRESOLVED_TYPE, from: '2026-09-01', to: '2026-09-11', totalCents: 100000 },
  ]
  const rep = buildOccupancyReport(SITES, [], byId, occupants, WINDOW, ['Reyes'])
  assert.deepEqual(rep.unresolvedOccupants, ['Whitmore (2026)'])
  assert.deepEqual(rep.undatedOccupants, ['Reyes'])
  const bucket = rep.byType.find(t => t.type === UNRESOLVED_TYPE)!
  assert.equal(bucket.occupiedNights, 10, 'their nights are real and still counted')
  assert.equal(bucket.units, 0, 'but they widen no denominator — the park has no such site')
})

test('NIGHTS WITH NO ATTRIBUTABLE REVENUE ARE FLAGGED, not silently averaged in', () => {
  // A monthly camper has no contract amount anywhere in the schema. Their nights are real; the
  // missing money must not read as a genuinely low nightly rate.
  const occupants: Occupant[] = [
    { key: 'Paid', type: 'rv_site', from: '2026-09-01', to: '2026-09-11', totalCents: 10000 },
    { key: 'Unknown', type: 'rv_site', from: '2026-09-01', to: '2026-09-11', totalCents: 0, revenueUnknown: true },
  ]
  const rv = buildOccupancyReport(SITES, [], byId, occupants, WINDOW).byType.find(t => t.type === 'rv_site')!
  assert.equal(rv.nightsWithoutRevenue, 10)
  assert.equal(rv.occupiedNights, 20)
})

test('by-month gives the season its shape', () => {
  const nightly = [{ id: 'a', site_id: 'c1', arrival_date: '2026-09-04', departure_date: '2026-09-06',
                     total_price: 24000, status: 'confirmed' }]
  const rep = buildOccupancyReport(SITES, nightly, byId, [], { start: '2026-08-01', end: '2026-09-30' })
  const cabin = rep.byType.find(t => t.type === 'cabin')!
  assert.deepEqual(cabin.byMonth.map(m => m.key), ['2026-08', '2026-09'])
  assert.equal(cabin.byMonth[0].pct, 0, 'nothing in August')
  assert.ok(cabin.byMonth[1].pct > 0, 'and something in September')
})

test('an empty park does not crash or divide by zero', () => {
  const rep = buildOccupancyReport([], [], new Map(), [], WINDOW)
  assert.equal(rep.total.occupancyPct, 0)
  assert.equal(rep.total.avgNightlyCents, null)
  assert.deepEqual(rep.byType, [])
})

// ═══ R4b: SEASONAL vs TRANSIENT ══════════════════════════════════════════════════════════════
//
// The property that carries this section: SEASONAL FILL IS A ROSTER RATIO, NOT A CALENDAR ONE.
// A seasonal site that is empty must stay visible as an OPEN SITE — it is a site to go and sell,
// and it is exactly the number that would disappear if occupancy were inferred from campers.

const R4B_SITES: RentableSite[] = [
  { id: 's1', site_number: '1', site_type: 'rv_site', is_available: true, is_seasonal_site: true },
  { id: 's2', site_number: '2', site_type: 'rv_site', is_available: true, is_seasonal_site: true },
  { id: 's3', site_number: '3', site_type: 'rv_site', is_available: true, is_seasonal_site: true },
  { id: 's4', site_number: '4', site_type: 'rv_site', is_available: true, is_seasonal_site: false },
  { id: 'c1', site_number: 'C1', site_type: 'cabin', is_available: true, is_seasonal_site: false },
]
const SEASON = { from: '2026-05-01', to: '2026-10-01' }        // 153 nights
const seasonalOcc = (key: string, siteNumber: string, type: string, totalCents: number): Occupant =>
  ({ key, type, siteNumber, seasonal: true, ...SEASON, totalCents, revenueUnknown: !totalCents })

test('AN UNFLAGGED PARK IS ENTIRELY TRANSIENT — the pre-migration behaviour, exactly', () => {
  // A park whose database has not had the R4b migration returns rows with no such key at all.
  // Every one of them must keep behaving as it did before the column existed.
  assert.equal(isSeasonalSite({ site_number: '1' }), false, 'undefined means transient')
  assert.equal(isSeasonalSite({ site_number: '1', is_seasonal_site: null }), false, 'and so does null')
  const prog = buildSeasonalProgram([{ id: 'x', site_number: '1', site_type: 'rv_site' }], [], WINDOW)
  assert.equal(prog.totalSites, 0, 'no seasonal program at all until sites are flagged')
  assert.equal(prog.fillPct, 0)
})

test('SEASONAL FILL IS filled ÷ TOTAL SEASONAL SITES, and the empty one stays visible', () => {
  const occupants = [
    seasonalOcc('Thompson', '1', 'rv_site', 200000),
    seasonalOcc('Nguyen', '2', 'rv_site', 220000),
  ]
  const prog = buildSeasonalProgram(R4B_SITES, occupants, WINDOW)
  assert.equal(prog.totalSites, 3, 'three sites are FLAGGED seasonal')
  assert.equal(prog.filled, 2)
  assert.equal(prog.open, 1)
  assert.equal(prog.fillPct, 67)
  assert.deepEqual(prog.openSites.map(s => s.siteNumber), ['3'],
    'the empty seasonal site is named — it is a site to go and sell, not an absence')
})

test('A CAMPER LEAVING OPENS A SITE, it does not shrink the park', () => {
  // The exact regression an inferred designation would cause: the denominator would quietly drop
  // from 3 to 2 and the park would read 100% sold with a site standing empty.
  const before = buildSeasonalProgram(R4B_SITES, [
    seasonalOcc('Thompson', '1', 'rv_site', 200000),
    seasonalOcc('Nguyen', '2', 'rv_site', 220000),
    seasonalOcc('Delgado', '3', 'rv_site', 180000),
  ], WINDOW)
  assert.equal(before.fillPct, 100)
  assert.equal(before.open, 0)

  const after = buildSeasonalProgram(R4B_SITES, [
    seasonalOcc('Thompson', '1', 'rv_site', 200000),
    seasonalOcc('Nguyen', '2', 'rv_site', 220000),
  ], WINDOW)
  assert.equal(after.totalSites, 3, 'THE PARK IS STILL THE SAME SIZE')
  assert.equal(after.open, 1)
  assert.equal(after.fillPct, 67)
})

test('FLIPPING A TRANSIENT SITE TO SEASONAL GROWS THE PROGRAM', () => {
  const flipped = R4B_SITES.map(s => s.site_number === '4' ? { ...s, is_seasonal_site: true } : s)
  const occupants = [seasonalOcc('Thompson', '1', 'rv_site', 200000)]
  assert.equal(buildSeasonalProgram(R4B_SITES, occupants, WINDOW).totalSites, 3)
  const after = buildSeasonalProgram(flipped, occupants, WINDOW)
  assert.equal(after.totalSites, 4, 'the flag alone changed the total — nothing else to do')
  assert.equal(after.open, 3)
})

test('the blended effective nightly averages the real fee levels', () => {
  const prog = buildSeasonalProgram(R4B_SITES, [
    seasonalOcc('A', '1', 'rv_site', 180000),
    seasonalOcc('B', '2', 'rv_site', 220000),
  ], WINDOW)
  assert.equal(prog.contractedCents, 400000)
  // 400000 / (2 x 153 nights)
  assert.equal(prog.effectiveNightlyCents, Math.round(400000 / 306))
  assert.ok(prog.effectiveNightlyCents! > Math.round(180000/153) && prog.effectiveNightlyCents! < Math.round(220000/153),
    'strictly between the cheapest and the dearest')
})

test('A CAMPER WITH NO FEE ON RECORD IS EXCLUDED FROM THE BLEND, not counted as free', () => {
  // Counting them at $0 would drag the effective nightly below what anybody actually pays.
  const withFee = buildSeasonalProgram(R4B_SITES, [seasonalOcc('A', '1', 'rv_site', 200000)], WINDOW)
  const plusFreeloader = buildSeasonalProgram(R4B_SITES, [
    seasonalOcc('A', '1', 'rv_site', 200000),
    seasonalOcc('B', '2', 'rv_site', 0),
  ], WINDOW)
  assert.equal(plusFreeloader.effectiveNightlyCents, withFee.effectiveNightlyCents, 'the blend is unmoved')
  assert.deepEqual(plusFreeloader.campersWithoutFee, ['B'], 'and the gap is named')
  assert.equal(plusFreeloader.filled, 2, 'but they still fill their site')
})

test('season fees prorate into the window', () => {
  const prog = buildSeasonalProgram(R4B_SITES, [seasonalOcc('A', '1', 'rv_site', 153000)], // $10/night
    { start: '2026-09-01', end: '2026-09-30' })
  assert.equal(prog.windowRevenueCents, 1000 * 30, 'thirty of the season s nights')
  assert.equal(prog.contractedCents, 153000, 'while the contracted total stays the whole fee')
})

test('MISMATCHES ARE SURFACED, NEVER RECLASSIFIED', () => {
  const prog = buildSeasonalProgram(R4B_SITES, [
    seasonalOcc('OnTransient', '4', 'rv_site', 200000),   // site 4 exists but is flagged transient
    seasonalOcc('Nowhere', '99', UNRESOLVED_TYPE, 200000), // site 99 does not exist
    seasonalOcc('Fine', '1', 'rv_site', 200000),
  ], WINDOW)
  assert.deepEqual(prog.onTransientSites, ['OnTransient'], 'one toggle on the Sites screen fixes this')
  assert.deepEqual(prog.unresolved, ['Nowhere'])
  assert.equal(prog.filled, 1, 'only the correctly-designated camper fills a seasonal site')
  assert.equal(prog.open, 2)
})

test('a MONTHLY camper does not fill a seasonal site', () => {
  const monthly: Occupant = { key: 'Reyes', type: 'rv_site', siteNumber: '1', seasonal: false,
                              ...SEASON, totalCents: 0, revenueUnknown: true }
  const prog = buildSeasonalProgram(R4B_SITES, [monthly], WINDOW)
  assert.equal(prog.filled, 0, 'monthly is a different arrangement from seasonal')
  assert.equal(prog.open, 3)
})

test('THE TRANSIENT TABLE NEVER SHOWS A SEASONAL SITE', () => {
  // The split in practice: the caller hands the R4 engine only the transient sites.
  const transient = R4B_SITES.filter(s => !isSeasonalSite(s))
  const rep = buildOccupancyReport(transient, [], new Map(), [], WINDOW)
  assert.equal(rep.total.units, 2, 'site 4 and cabin C1 — not the three seasonal ones')
  assert.deepEqual(rep.byType.map(t => t.type).sort(), ['cabin', 'rv_site'])
  assert.equal(rep.byType.find(t => t.type === 'rv_site')!.units, 1, 'only the transient RV site')
})

test('buildOccupants tags who is seasonal and which site they name', () => {
  const { occupants } = buildOccupants(
    [{ guest_id: 'g1', site_number: ' A1 ', total_due_cents: 100000, status: 'signed' }],
    new Map(),
    [{ id: 'g1', name: 'Trimmed', site_number: 'A1', is_seasonal: true, season_start: '2026-05-01', season_end: '2026-09-30' },
     { id: 'g3', name: 'Reyes', site_number: '2', is_monthly: true, season_start: '2026-05-01', season_end: '2026-09-30' }],
    byNumber)
  const seasonal = occupants.find(o => o.key.startsWith('Trimmed'))!
  assert.equal(seasonal.seasonal, true)
  assert.equal(seasonal.siteNumber, 'a1', 'normalised, so " A1 " and "a1" are one site')
  assert.equal(occupants.find(o => o.key === 'Reyes')!.seasonal, false, 'monthly is not seasonal')
})

test('an empty seasonal program does not divide by zero', () => {
  const prog = buildSeasonalProgram([], [], WINDOW)
  assert.equal(prog.totalSites, 0)
  assert.equal(prog.fillPct, 0)
  assert.equal(prog.effectiveNightlyCents, null)
})

test('THE COMBINED ALL-SITES TOTAL SURVIVES THE SPLIT', () => {
  // The split adds detail BENEATH the whole-park number; it must not replace it. An owner still
  // needs the one "how full is the park" figure, over every rentable site of every kind.
  const nightly = [{ id: 'a', site_id: 'c1', arrival_date: '2026-09-04', departure_date: '2026-09-06',
                     total_price: 24000, status: 'confirmed' }]
  const occupants = [seasonalOcc('Thompson', '1', 'rv_site', 200000)]

  const combined = buildOccupancyReport(R4B_SITES, nightly, new Map([['c1', 'cabin']]), occupants, WINDOW)
  const transientOnly = buildOccupancyReport(
    R4B_SITES.filter(s => !isSeasonalSite(s)), nightly, new Map([['c1', 'cabin']]), [], WINDOW)

  assert.equal(combined.total.units, 5, 'every rentable site, seasonal and transient together')
  assert.equal(transientOnly.total.units, 2, 'while the breakdown below covers only the transient ones')
  assert.ok(combined.total.occupiedNights > transientOnly.total.occupiedNights,
    'the combined figure includes the seasonal nights the transient table deliberately omits')
})

// ═══ ONE CAMPER, TWO SITES ═══════════════════════════════════════════════════════════════════
//
// A seasonal camper who rents a second site has it recorded as one free-text value: "43, 44".
// Read whole it matched nothing and BOTH sites read open; read as one site the second read open
// while somebody was living on it — which sends an owner to sell a site that is taken.

const TWO_SITE_SITES: RentableSite[] = [
  { id: 'a', site_number: '43', site_type: 'rv_site', is_available: true, is_seasonal_site: true },
  { id: 'b', site_number: '44', site_type: 'rv_site', is_available: true, is_seasonal_site: true },
  { id: 'c', site_number: '45', site_type: 'rv_site', is_available: true, is_seasonal_site: true },
]
const twoSiteByNumber = siteTypeByNumber(TWO_SITE_SITES)

test('a SINGLE site value takes exactly the path it always did', () => {
  // The regression that matters most: no comma, no change.
  assert.deepEqual(splitSiteNumbers('43'), ['43'])
  assert.deepEqual(resolveSiteTypes('43', twoSiteByNumber), { siteNumbers: ['43'], types: ['rv_site'] })
  assert.equal(resolveSiteType('43', twoSiteByNumber), 'rv_site', 'and the original resolver is untouched')
})

test('a COMMA value yields every site, however it was typed', () => {
  assert.deepEqual(splitSiteNumbers('43, 44'), ['43', '44'])
  assert.deepEqual(splitSiteNumbers('43,44'), ['43', '44'], 'no space')
  assert.deepEqual(splitSiteNumbers('  43 ,  44  '), ['43', '44'], 'ragged whitespace')
  assert.deepEqual(splitSiteNumbers('C1, c1'), ['c1'], 'case-insensitive, and de-duplicated')
})

test('blank and duplicate tokens cannot inflate occupancy', () => {
  assert.deepEqual(splitSiteNumbers('43,,44,'), ['43', '44'], 'stray commas are typing, not sites')
  assert.deepEqual(splitSiteNumbers('43, 43'), ['43'], 'one site cannot be filled twice')
  assert.deepEqual(splitSiteNumbers(''), [])
  assert.deepEqual(splitSiteNumbers(null), [])
  assert.deepEqual(splitSiteNumbers('   ,  '), [])
})

test('AN UNKNOWN TOKEN IS KEPT, NOT SWALLOWED', () => {
  // "43, 999" must fill 43 AND still report the camper — a site number pointing at nothing is a
  // real thing an owner needs to fix, and hiding it would only make the numbers look tidier.
  const r = resolveSiteTypes('43, 999', twoSiteByNumber)
  assert.deepEqual(r.siteNumbers, ['43', '999'])
  assert.deepEqual(r.types, ['rv_site', UNRESOLVED_TYPE])
})

test('BOTH SITES OF A DOUBLE-SITE CAMPER READ AS FILLED', () => {
  const { occupants } = buildOccupants(
    [{ guest_id: 'g1', site_number: '43, 44', total_due_cents: 200000, status: 'signed' }],
    new Map(),
    [{ id: 'g1', name: 'Wilson', site_number: '43, 44', is_seasonal: true,
       season_start: '2027-04-30', season_end: '2027-10-10' }],
    twoSiteByNumber)
  assert.deepEqual(occupants[0].siteNumbers, ['43', '44'])

  const prog = buildSeasonalProgram(TWO_SITE_SITES, occupants, WINDOW)
  assert.equal(prog.totalSites, 3)
  assert.equal(prog.filled, 2, 'ONE camper fills TWO sites')
  assert.equal(prog.open, 1)
  assert.deepEqual(prog.openSites.map(s => s.siteNumber), ['45'],
    'only the genuinely empty site is open — 44 is not')
  assert.deepEqual(prog.unresolved, [], 'and they are no longer unresolved')
})

test('THE FILL RATIO VISIBLY GROWS — the before/after this change exists for', () => {
  const camper = [{ id: 'g1', name: 'Wilson', site_number: '43, 44', is_seasonal: true,
                    season_start: '2027-04-30', season_end: '2027-10-10' }]
  const contract = [{ guest_id: 'g1', site_number: '43, 44', total_due_cents: 200000, status: 'signed' }]
  const { occupants } = buildOccupants(contract, new Map(), camper, twoSiteByNumber)
  const after = buildSeasonalProgram(TWO_SITE_SITES, occupants, WINDOW)

  // BEFORE: the old single-value resolver saw "43, 44" as one unmatchable string.
  const before = buildSeasonalProgram(TWO_SITE_SITES, [{
    key: 'Wilson', type: resolveSiteType('43, 44', twoSiteByNumber), siteNumber: '43, 44',
    seasonal: true, from: '2027-04-30', to: '2027-10-11', totalCents: 200000,
  }], WINDOW)

  assert.equal(before.filled, 0, 'before: the whole string matched nothing')
  assert.equal(before.open, 3)
  assert.deepEqual(before.unresolved, ['Wilson'])
  assert.equal(after.filled, 2, 'after: both sites filled')
  assert.equal(after.open, 1)
  assert.ok(after.fillPct > before.fillPct, `fill grew ${before.fillPct}% -> ${after.fillPct}%`)
})

test('a camper on two sites occupies TWO site-nights and still pays ONE fee', () => {
  // The nights multiply; the money must not. Otherwise the average nightly rate reads double.
  const W = { start: '2027-05-01', end: '2027-05-10' }   // 10 nights
  const one: Occupant = { key: 'Single', type: 'rv_site', siteNumber: '45', siteNumbers: ['45'],
    types: ['rv_site'], seasonal: true, from: '2027-05-01', to: '2027-05-11', totalCents: 100000 }
  const two: Occupant = { key: 'Double', type: 'rv_site', siteNumber: '43', siteNumbers: ['43', '44'],
    types: ['rv_site', 'rv_site'], seasonal: true, from: '2027-05-01', to: '2027-05-11', totalCents: 100000 }

  const rSingle = buildOccupancyReport(TWO_SITE_SITES, [], new Map(), [one], W)
  const rDouble = buildOccupancyReport(TWO_SITE_SITES, [], new Map(), [two], W)
  assert.equal(rSingle.total.occupiedNights, 10)
  assert.equal(rDouble.total.occupiedNights, 20, 'two sites, ten nights each')
  assert.equal(rDouble.total.revenueCents, rSingle.total.revenueCents,
    'THE SAME ONE FEE — split across the sites it bought, never counted twice')
  assert.ok(rDouble.total.avgNightlyCents! < rSingle.total.avgNightlyCents!,
    'and the per-site-night rate is correspondingly lower, which is the truth')
})

test('a park with no double-site campers is byte-identical', () => {
  const plain = [{ id: 'g1', name: 'Solo', site_number: '43', is_seasonal: true,
                   season_start: '2027-04-30', season_end: '2027-10-10' }]
  const { occupants } = buildOccupants([], new Map(), plain, twoSiteByNumber)
  assert.deepEqual(occupants[0].siteNumbers, ['43'])
  assert.equal(occupants[0].siteNumber, '43')
  assert.equal(occupants[0].type, 'rv_site')
  const prog = buildSeasonalProgram(TWO_SITE_SITES, occupants, WINDOW)
  assert.equal(prog.filled, 1)
  assert.equal(prog.open, 2)
})
