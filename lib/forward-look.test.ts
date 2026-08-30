import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  occupiesNight, occupiedOn, fillPercent, isCabin, isLiveStay,
  addDays, mondayOf, weekStartsFrom, daysOfWeek, sameWeekLastYear, toYmd,
} from './occupancy.ts'
import {
  weekFill, priorWeekFillAsOf, choosePaceBasis, verdictFor, buildForwardLook,
  staysTouchingWeeks, madeBy,
  heatColor, HEAT_LEGEND, PACE_BASIS_LABEL, PACE_DEADBAND_PCT,
} from './forward-look.ts'

// The forward look.
//
// Three properties carry this file:
//   1. A NIGHT IS COUNTED ONCE, AND THE DEPARTURE DAY IS NOT A NIGHT. This is the number the
//      dashboard's occupancy and the heat calendar must agree on.
//   2. "BEHIND" IS MEASURED AT THE SAME LEAD TIME — comparing an in-progress week against last
//      year's finished week would mark everything behind and make the view worthless.
//   3. WITH NO PRIOR YEAR AND NO GOAL, NO JUDGMENT IS OFFERED AT ALL. A park in its first season
//      must not be nagged.

const stay = (a: string, d: string, type = 'rv_site', created = '2026-01-01T00:00:00Z', status = 'confirmed') =>
  ({ arrival_date: a, departure_date: d, sites: { site_type: type }, created_at: created, status })

// ── counting a night ─────────────────────────────────────────────────────────────────────────

test('THE DEPARTURE DAY IS NOT A NIGHT STAYED', () => {
  // Arrive the 28th, leave the 31st: three nights. The site is sellable again on the 31st, and a
  // calendar that shades the 31st is telling the owner they cannot sell something they can.
  const r = stay('2026-08-28', '2026-08-31')
  assert.equal(occupiesNight(r, '2026-08-27'), false, 'the night before arrival')
  assert.equal(occupiesNight(r, '2026-08-28'), true)
  assert.equal(occupiesNight(r, '2026-08-30'), true, 'the last night stayed')
  assert.equal(occupiesNight(r, '2026-08-31'), false, 'CHECKOUT DAY — gone by morning')
})

test('a one-night stay occupies exactly one night', () => {
  const r = stay('2026-09-05', '2026-09-06')
  assert.equal(occupiesNight(r, '2026-09-05'), true)
  assert.equal(occupiesNight(r, '2026-09-06'), false)
})

test('a cancelled stay occupies nothing', () => {
  assert.equal(isLiveStay(stay('2026-09-01', '2026-09-03', 'tent', '2026-01-01T00:00:00Z', 'cancelled')), false)
  const rows = [stay('2026-09-01', '2026-09-03', 'tent', '2026-01-01T00:00:00Z', 'cancelled')]
  assert.deepEqual(occupiedOn(rows, '2026-09-01'), { sites: 0, cabins: 0 })
})

test('cabins are counted apart from sites', () => {
  const rows = [stay('2026-09-01', '2026-09-03', 'cabin'), stay('2026-09-01', '2026-09-03', 'tent')]
  assert.deepEqual(occupiedOn(rows, '2026-09-02'), { sites: 1, cabins: 1 })
  assert.equal(isCabin(rows[0]), true)
  assert.equal(isCabin({ arrival_date: 'x', departure_date: 'y' }), false, 'no join, no cabin')
})

test('missing or malformed dates occupy nothing rather than throwing', () => {
  assert.equal(occupiesNight({ arrival_date: null, departure_date: '2026-09-03' }, '2026-09-01'), false)
  assert.equal(occupiesNight({ arrival_date: '2026-09-01', departure_date: null }, '2026-09-01'), false)
  assert.equal(occupiesNight(stay('2026-09-01', '2026-09-03'), ''), false)
})

// ── fill ─────────────────────────────────────────────────────────────────────────────────────

test('SEASONAL CAMPERS COUNT TOWARD FILL, exactly as the dashboard has always counted them', () => {
  assert.equal(fillPercent(2, 6, 12), 67, '8 of 12 sites')
  assert.equal(fillPercent(0, 6, 12), 50, 'six seasonals alone are half the park')
})

test('fill is capped and floored, never negative and never over 100', () => {
  assert.equal(fillPercent(20, 6, 12), 100, 'an over-booked night reads FULL, not 217%')
  assert.equal(fillPercent(0, 0, 12), 0)
  assert.equal(fillPercent(1, 0, 0), 0, 'a park with no sites configured does not divide by zero')
})

// ── calendar arithmetic ──────────────────────────────────────────────────────────────────────

test('date maths crosses months, years and leap days', () => {
  assert.equal(addDays('2026-08-31', 1), '2026-09-01')
  assert.equal(addDays('2026-01-01', -1), '2025-12-31')
  assert.equal(addDays('2028-02-28', 1), '2028-02-29', 'leap year')
  assert.equal(addDays('2026-08-30', 0), '2026-08-30')
  assert.equal(addDays('nonsense', 1), 'nonsense', 'garbage in, unchanged out — no crash')
})

test('weeks are Monday-aligned', () => {
  assert.equal(mondayOf('2026-08-30'), '2026-08-24', 'a Sunday belongs to the week that started Monday')
  assert.equal(mondayOf('2026-08-24'), '2026-08-24', 'a Monday is its own week start')
  assert.deepEqual(weekStartsFrom('2026-08-30', 3), ['2026-08-24', '2026-08-31', '2026-09-07'])
  assert.deepEqual(daysOfWeek('2026-08-31').slice(0, 2), ['2026-08-31', '2026-09-01'])
  assert.equal(daysOfWeek('2026-08-31').length, 7)
})

test('LAST YEAR IS 364 DAYS BACK, so a Saturday lands on a Saturday', () => {
  // 365 would compare a Saturday against a Friday. For a campground — where the weekend fills and
  // the midweek does not — that compares two different businesses.
  const d = '2026-08-29'                              // a Saturday
  const prior = sameWeekLastYear(d)
  assert.equal(prior, '2025-08-30')
  const dow = (s: string) => new Date(Number(s.slice(0,4)), Number(s.slice(5,7))-1, Number(s.slice(8,10))).getDay()
  assert.equal(dow(prior), dow(d), 'same weekday')
  assert.equal(toYmd(new Date(2026, 7, 30)), '2026-08-30')
})

// ── week fill ────────────────────────────────────────────────────────────────────────────────

const WEEK = '2026-08-31'   // Mon 31 Aug 2026
const rows = [
  stay('2026-09-04', '2026-09-06'),   // Fri + Sat nights
  stay('2026-09-05', '2026-09-06'),   // Sat night
]

test('a week reports each night and its own mean', () => {
  const w = weekFill(rows, WEEK, 0, 10, '2026-08-31')
  assert.equal(w.days.length, 7)
  assert.deepEqual(w.days.map(d => d.fill), [0, 0, 0, 0, 10, 20, 0], 'Mon..Sun')
  assert.equal(w.fill, Math.round((10 + 20) / 7))
  assert.equal(w.days[0].isToday, true, 'today is marked so the view can anchor on it')
})

// ── the lead-time comparison ─────────────────────────────────────────────────────────────────

test('LAST YEAR IS MEASURED AT THE SAME LEAD TIME, not at its finished number', () => {
  // Last year this week finished 100% full, but six weeks out only one booking existed. Judging
  // this year's in-progress week against the finished 100% would mark it catastrophically behind
  // when it is in fact ahead of where last year stood at the same point.
  const priorStart = sameWeekLastYear(WEEK)
  const priorRows = [
    { ...stay(priorStart, addDays(priorStart, 7)), created_at: '2025-01-15T00:00:00Z' },   // booked early
    { ...stay(priorStart, addDays(priorStart, 7)), created_at: '2025-08-20T00:00:00Z' },   // booked late
  ]
  const asOf = priorWeekFillAsOf(priorRows, WEEK, 0, 10, '2025-06-01')
  const final = priorWeekFillAsOf(priorRows, WEEK, 0, 10, null)
  assert.equal(asOf, 10, 'only the early booking existed at that point')
  assert.equal(final, 20, 'both existed by the time the week arrived')
  assert.ok(asOf < final, 'which is exactly why the two must not be confused')
})

test('no as-of date means no lead-time filter', () => {
  const priorStart = sameWeekLastYear(WEEK)
  const priorRows = [{ ...stay(priorStart, addDays(priorStart, 7)), created_at: '2025-08-20T00:00:00Z' }]
  assert.equal(priorWeekFillAsOf(priorRows, WEEK, 0, 10, null), 10)
})

// ── choosing what to measure against ─────────────────────────────────────────────────────────

test('A GOAL WINS, because the owner chose it', () => {
  assert.equal(choosePaceBasis(70, 12, 5), 'goal')
})

test('NO GOAL AND NO PRIOR YEAR MEANS NO JUDGMENT AT ALL', () => {
  // A park in its first season must be useful and non-nagging on day one.
  assert.equal(choosePaceBasis(null, 0, 0), 'none')
  assert.equal(PACE_BASIS_LABEL.none, '', 'and nothing to print about it')
})

test('A GOAL OF ZERO OR NULL IS NOT A GOAL', () => {
  // Off by default has to mean off. A stray 0 must not become a target every week clears, which
  // would silently mark the whole board "ahead" against a goal nobody set.
  for (const notAGoal of [null, 0]) {
    const basis = choosePaceBasis(notAGoal, 12, 5)
    assert.notEqual(basis, 'goal', `${notAGoal} must not be treated as a target`)
    assert.equal(basis, 'as_of_lead_time', 'it falls through to the prior year instead')
  }
  assert.equal(choosePaceBasis(0, 0, 0), 'none', 'and with no prior year, all the way to no judgment')
})

test('IMPORTED HISTORY FALLS BACK INSTEAD OF SILENTLY FLATTERING THE OWNER', () => {
  // If every reservation carries the import day as its created_at, last year looks like it had
  // nothing booked at any lead time — every week reads "ahead" and the owner is congratulated on
  // a fiction. Bookings that demonstrably existed, none of which had been made by the as-of date,
  // is the tell.
  assert.equal(choosePaceBasis(null, 30, 0), 'final_fill')
  assert.equal(choosePaceBasis(null, 30, 4), 'as_of_lead_time', 'some early bookings means the signal is alive')
})

test('THE BASIS IS COUNTED IN BOOKINGS, NOT IN FILL PERCENTAGES', () => {
  // The bug this pins, found by running the real sandbox data through the module: fill INCLUDES
  // the seasonal baseline, so a park with six seasonals reads ~67% for a week in which nothing
  // was booked. Deciding "does last year have data?" from fill therefore answered YES for a park
  // whose first season is this one, and judged it against a year that never happened.
  const priorStart = sameWeekLastYear(WEEK)
  const empty = buildForwardLook([WEEK], [], [], {
    seasonalSites: 6, totalSites: 9, today: '2026-08-31', goalPct: null, priorAsOfDate: '2025-09-01',
  })
  assert.ok(empty.weeks[0].fill > 0, 'the week still reads ~67% because of the seasonals')
  assert.equal(empty.basis, 'none', 'but there were no bookings last year, so nothing is judged')
  assert.equal(empty.weeks[0].verdict, 'unknown')

  // One real prior booking is enough to switch the comparison on.
  const withOne = buildForwardLook([WEEK], [], [{ ...stay(priorStart, addDays(priorStart, 2)), created_at: '2025-01-01T00:00:00Z' }], {
    seasonalSites: 6, totalSites: 9, today: '2026-08-31', goalPct: null, priorAsOfDate: '2025-09-01',
  })
  assert.equal(withOne.basis, 'as_of_lead_time')
})

test('the helpers behind the basis do what they say', () => {
  const priorStart = sameWeekLastYear(WEEK)
  const inWeek = stay(priorStart, addDays(priorStart, 2), 'tent', '2025-01-01T00:00:00Z')
  const wayOff = stay('2020-01-01', '2020-01-03', 'tent', '2019-01-01T00:00:00Z')
  const cancelled = stay(priorStart, addDays(priorStart, 2), 'tent', '2025-01-01T00:00:00Z', 'cancelled')
  const touching = staysTouchingWeeks([inWeek, wayOff, cancelled], [priorStart])
  assert.equal(touching.length, 1, 'only the live stay that actually occupies a night in range')
  assert.equal(madeBy([inWeek], '2025-06-01').length, 1)
  assert.equal(madeBy([{ ...inWeek, created_at: '2025-09-09T00:00:00Z' }], '2025-06-01').length, 0)
  assert.equal(madeBy([inWeek], null).length, 1, 'no cutoff means no filtering')
  assert.equal(madeBy([{ ...inWeek, created_at: null }], '2025-06-01').length, 0, 'an unknown booking date cannot be proved early')
})

// ── verdicts and tone ────────────────────────────────────────────────────────────────────────

test('a deadband stops noise reading as a problem', () => {
  assert.equal(verdictFor(50, 50), 'level')
  assert.equal(verdictFor(52, 50), 'level', 'two points is the same week')
  assert.equal(verdictFor(50, 52), 'level')
  assert.equal(verdictFor(60, 50), 'ahead')
  assert.equal(verdictFor(40, 50), 'behind')
  assert.equal(PACE_DEADBAND_PCT, 3)
})

test('NO COMPARISON MEANS `unknown`, NEVER `behind`', () => {
  // The distinction that keeps a first-season park from being told it is failing.
  assert.equal(verdictFor(0, null), 'unknown')
  assert.equal(verdictFor(95, null), 'unknown')
})

// ── the whole board ──────────────────────────────────────────────────────────────────────────

const starts = weekStartsFrom('2026-08-31', 4)

test('a young park gets fill levels and NO judgment', () => {
  const look = buildForwardLook(starts, rows, [], {
    seasonalSites: 6, totalSites: 10, today: '2026-08-31', goalPct: null, priorAsOfDate: '2025-09-01',
  })
  assert.equal(look.basis, 'none')
  assert.equal(look.behind.length, 0, 'nothing is called behind')
  assert.equal(look.ahead.length, 0, 'and nothing is falsely celebrated either')
  assert.ok(look.weeks.every(w => w.verdict === 'unknown' && w.priorFill === null))
  assert.ok(look.best, 'but the fullest week is still identified, to celebrate')
})

test('with a goal, every week is measured against it', () => {
  const look = buildForwardLook(starts, rows, [], {
    seasonalSites: 5, totalSites: 10, today: '2026-08-31', goalPct: 80, priorAsOfDate: null,
  })
  assert.equal(look.basis, 'goal')
  assert.ok(look.weeks.every(w => w.priorFill === 80))
  assert.equal(look.basisLabel, 'your goal')
})

test('with a prior year, the board splits into ahead and behind', () => {
  const priorRows = starts.flatMap((ws, i) => {
    const ps = sameWeekLastYear(ws)
    // Week 0 was busy last year at this lead time; the rest were empty.
    return i === 0 ? [{ ...stay(ps, addDays(ps, 7)), created_at: '2025-01-01T00:00:00Z' },
                      { ...stay(ps, addDays(ps, 7)), created_at: '2025-01-01T00:00:00Z' },
                      { ...stay(ps, addDays(ps, 7)), created_at: '2025-01-01T00:00:00Z' }] : []
  })
  const look = buildForwardLook(starts, rows, priorRows, {
    seasonalSites: 0, totalSites: 10, today: '2026-08-31', goalPct: null, priorAsOfDate: '2026-01-01',
  })
  assert.equal(look.basis, 'as_of_lead_time')
  assert.equal(look.weeks[0].verdict, 'behind', 'this week is quieter than last year was at this point')
  assert.ok(look.behind.length >= 1)
})

test('an empty board does not crash', () => {
  const look = buildForwardLook([], null, null, {
    seasonalSites: 0, totalSites: 10, today: '2026-08-31', goalPct: null, priorAsOfDate: null,
  })
  assert.deepEqual(look.weeks, [])
  assert.equal(look.best, null)
  assert.equal(look.basis, 'none')
})

// ── the heat ramp ────────────────────────────────────────────────────────────────────────────

test('the ramp is single-hue, ordered, and readable at both ends', () => {
  assert.equal(heatColor(0).bg, '#F4F7F6')
  assert.equal(heatColor(100).bg, '#00543E')
  assert.notEqual(heatColor(0).bg, heatColor(1).bg, 'empty is distinguishable from barely booked')
  // Dark shades take light text and pale shades take dark text, so the printed percentage — which
  // is the actual answer in every cell — is legible at every level.
  assert.equal(heatColor(90).fg, '#FFFFFF')
  assert.equal(heatColor(10).fg, '#0B3B2E')
  assert.equal(HEAT_LEGEND[0].bg, '#F4F7F6', 'the legend runs Empty -> Full')
  assert.equal(HEAT_LEGEND[HEAT_LEGEND.length - 1].bg, '#00543E')
})

test('every fill from 0 to 100 gets a colour', () => {
  for (let i = 0; i <= 100; i++) {
    assert.match(heatColor(i).bg, /^#[0-9A-F]{6}$/i, `fill ${i} needs a shade`)
  }
})
