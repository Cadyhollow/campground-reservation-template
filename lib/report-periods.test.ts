import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  shiftMonths, windowDays, previousPeriodLabel, previousWindow, isWholeCalendarMonth, monthKey, pickComparison,
  computeDelta, headlineRead, isRecordPeriod, type Window, type MonthTotal,
} from './report-periods.ts'

// Period comparison, and the tone it carries.
//
// The tone tests are not cosmetic. "Celebrate the wins" is a stated requirement: a good month
// must read as good, a slow month must be a nudge rather than an alarm, and RED must stay
// reserved for money that should be there and is not. A regression here would be invisible to a
// type checker and obvious to an owner.

// Windows are built the way the app builds them: from a LOCAL calendar day, exactly as
// dayStartUTC()/dayEndUTC() in lib/transactions.ts do. Asserting on local calendar fields rather
// than on UTC string slices is what makes these tests true in every timezone rather than only in
// the one this machine happens to sit in.
const dayStart = (y: number, m: number, d: number) => new Date(y, m - 1, d, 0, 0, 0, 0).toISOString()
const dayEnd = (y: number, m: number, d: number) => new Date(y, m - 1, d, 23, 59, 59, 999).toISOString()
const range = (y1: number, m1: number, d1: number, y2: number, m2: number, d2: number): Window =>
  ({ startISO: dayStart(y1, m1, d1), endISO: dayEnd(y2, m2, d2) })
/** [year, month(1-12), day] of an instant, in local terms. */
const parts = (iso: string) => { const d = new Date(iso); return [d.getFullYear(), d.getMonth() + 1, d.getDate()] }

const AUG = range(2026, 8, 1, 2026, 8, 31)            // a whole calendar month
const AUG_TO_DATE = range(2026, 8, 1, 2026, 8, 30)    // "this month", as the page actually builds it
const YTD = range(2026, 1, 1, 2026, 8, 30)            // the page's DEFAULT range

// ── window arithmetic ────────────────────────────────────────────────────────────────────────

test('shifting months clamps the day instead of rolling over', () => {
  // The trap: JS Date rolls 31 March back to 3 March, which would compare a month-end report
  // against a window overlapping the wrong month.
  assert.deepEqual(parts(shiftMonths(dayStart(2026, 3, 31), -1)), [2026, 2, 28])
  assert.deepEqual(parts(shiftMonths(dayStart(2028, 3, 31), -1)), [2028, 2, 29], 'leap year')
  assert.deepEqual(parts(shiftMonths(dayStart(2026, 8, 31), -1)), [2026, 7, 31], 'no clamp needed')
  assert.deepEqual(parts(shiftMonths(dayStart(2026, 1, 15), -1)), [2025, 12, 15], 'crosses the year')
  assert.deepEqual(parts(shiftMonths(dayStart(2026, 8, 15), -12)), [2025, 8, 15])
})

test('A SHIFTED WINDOW KEEPS ITS LOCAL WALL-CLOCK BOUNDARY, DST AND ALL', () => {
  // The boundaries come from a local calendar day, so they must land back on local midnight and
  // local 23:59:59.999 — not drift an hour because the shift crossed a daylight-saving change.
  const start = new Date(shiftMonths(dayStart(2026, 8, 1), -5))   // August -> March, across DST
  assert.equal(start.getHours(), 0)
  assert.equal(start.getMinutes(), 0)
  const end = new Date(shiftMonths(dayEnd(2026, 8, 31), -5))
  assert.equal(end.getHours(), 23)
  assert.equal(end.getMilliseconds(), 999)
})

test('a whole calendar month is recognised as one', () => {
  assert.equal(isWholeCalendarMonth(AUG), true)
  assert.equal(isWholeCalendarMonth(range(2028, 2, 1, 2028, 2, 29)), true, 'leap February')
  assert.equal(isWholeCalendarMonth(AUG_TO_DATE), false, 'month-to-date is not a whole month')
  assert.equal(isWholeCalendarMonth(range(2026, 8, 2, 2026, 8, 31)), false, 'does not start on the 1st')
  assert.equal(isWholeCalendarMonth(YTD), false)
})

test('THE FALLBACK WINDOW MUST NOT OVERLAP THE WINDOW IT IS COMPARED WITH', () => {
  // The bug this pins: shifting back one month is right for a month and badly wrong for anything
  // longer. The page's DEFAULT range is year-to-date — 242 days — and a one-month shift would
  // overlap it by 211 of them, so the "comparison" would be mostly the same money and every park
  // would look permanently flat.
  const prev = previousWindow(YTD)
  assert.ok(prev.endISO < YTD.startISO, 'the previous period must END before this one begins')
  assert.equal(windowDays(prev), windowDays(YTD), 'and be the same length, so the comparison is fair')
  assert.deepEqual(parts(prev.endISO), [2025, 12, 31])
})

test('a whole month steps back to the whole month before it', () => {
  const prev = previousWindow(AUG)
  assert.deepEqual(parts(prev.startISO), [2026, 7, 1])
  assert.deepEqual(parts(prev.endISO), [2026, 7, 31])
  assert.ok(prev.endISO < AUG.startISO, 'still no overlap')
})

test('month-to-date steps back by its own length, not to a full month', () => {
  // Comparing 30 days of August against all 31 days of July would flatter July.
  const prev = previousWindow(AUG_TO_DATE)
  assert.equal(windowDays(prev), windowDays(AUG_TO_DATE))
  assert.ok(prev.endISO < AUG_TO_DATE.startISO)
})

test('the previous period is named by what it ACTUALLY is', () => {
  assert.equal(previousPeriodLabel(AUG), 'last month')
  // ⚠ "last month" is claimed only for a real calendar month. Month-to-date is not one.
  assert.equal(previousPeriodLabel(AUG_TO_DATE), 'the previous 30 days')
  assert.equal(previousPeriodLabel(range(2026, 8, 30, 2026, 8, 30)), 'the day before')
  assert.equal(previousPeriodLabel(range(2026, 8, 24, 2026, 8, 30)), 'the week before')
  assert.equal(previousPeriodLabel(YTD), 'the previous 242 days')
  assert.equal(windowDays(AUG), 31)
})

// ── choosing the comparison ──────────────────────────────────────────────────────────────────

test('an ESTABLISHED park is compared against the same period last year', () => {
  const c = pickComparison(AUG, dayStart(2024, 5, 1))
  assert.equal(c.basis, 'last_year')
  assert.deepEqual(parts(c.window.startISO), [2025, 8, 1])
  assert.equal(c.label, 'the same period last year')
})

test('A YOUNG PARK FALLS BACK TO LAST MONTH, AND SAYS SO', () => {
  // The sandbox's own case: first revenue in July 2026, so August 2025 predates the park.
  // Comparing against it would read as a total collapse from nothing.
  const c = pickComparison(AUG, dayStart(2026, 7, 7))
  assert.equal(c.basis, 'previous')
  assert.deepEqual(parts(c.window.startISO), [2026, 7, 1])
  assert.equal(c.label, 'last month')
})

test('A REAL ZERO LAST YEAR IS NOT HIDDEN BY THE FALLBACK', () => {
  // The distinction that makes the fallback safe: this park existed last August and simply took
  // nothing. Swapping in last month would bury a genuine year-over-year story.
  const c = pickComparison(AUG, dayStart(2025, 1, 1))
  assert.equal(c.basis, 'last_year', 'the test is whether data COULD exist, not whether it does')
})

test('the boundary is exact: first revenue inside the last-year window still counts', () => {
  assert.equal(pickComparison(AUG, dayStart(2025, 8, 31)).basis, 'last_year')
  assert.equal(pickComparison(AUG, dayStart(2025, 9, 2)).basis, 'previous')
})

test('a park with no revenue at all does not crash', () => {
  assert.equal(pickComparison(AUG, null).basis, 'previous')
})

// ── tone ─────────────────────────────────────────────────────────────────────────────────────

test('MORE MONEY IS A WIN', () => {
  const d = computeDelta(1_099_099, 24_000)
  assert.equal(d.tone, 'win')
  assert.equal(d.changeCents, 1_075_099)
  assert.ok(d.changeFraction! > 40)
})

test('LESS MONEY IS `watch`, NEVER AN ALARM', () => {
  const d = computeDelta(80_000, 100_000)
  assert.equal(d.tone, 'watch')
  assert.equal(d.changeCents, -20_000)
  assert.equal(d.changeFraction, -0.2)
})

test('RED IS NOT A TONE THIS FUNCTION CAN PRODUCE', () => {
  // Pinned deliberately. Red belongs to money that should be there and is not — an overdue
  // balance — and an owner shown alarm red for ordinary seasonality learns to ignore red.
  for (const [cur, prior] of [[0, 500000], [1, 999999999], [-5000, 100000], [0, 0]]) {
    assert.ok(['win', 'flat', 'watch'].includes(computeDelta(cur, prior).tone))
  }
})

test('level is level', () => {
  const d = computeDelta(50_000, 50_000)
  assert.equal(d.tone, 'flat')
  assert.equal(d.changeFraction, 0)
})

test('a prior of zero has NO percentage — "+∞%" is not a number to show an owner', () => {
  const d = computeDelta(500_000, 0)
  assert.equal(d.tone, 'win')
  assert.equal(d.changeFraction, null)
  assert.equal(d.multiple, null)
})

test('BIG GROWTH READS AS A MULTIPLE, because +4,479% looks like a bug', () => {
  const d = computeDelta(1_099_099, 24_000)
  assert.ok(d.multiple !== null && d.multiple > 45)
  // Ordinary growth stays a percentage.
  assert.equal(computeDelta(120_000, 100_000).multiple, null)
  assert.equal(computeDelta(999_000, 100_000).multiple, null, 'just under 10× is still a percentage')
  assert.ok(computeDelta(1_000_000, 100_000).multiple !== null, 'and 10× flips over')
})

test('the wording never contradicts the colour', () => {
  const win = computeDelta(120_000, 100_000)
  const watch = computeDelta(80_000, 100_000)
  assert.match(headlineRead(win, 'last month', false), /ahead/i)
  assert.match(headlineRead(watch, 'last month', false), /behind|quieter/i)
  assert.match(headlineRead(computeDelta(50_000, 50_000), 'last month', false), /level/i)
  assert.match(headlineRead(computeDelta(5000, 0), 'last month', false), /none/i)
  // A record outranks everything else it could have said.
  assert.match(headlineRead(watch, 'last month', true), /strongest/i)
})

test('a gentle dip and a steep one are worded differently', () => {
  assert.match(headlineRead(computeDelta(95_000, 100_000), 'last month', false), /a little behind/i)
  assert.match(headlineRead(computeDelta(50_000, 100_000), 'last month', false), /worth a look/i)
})

// ── the record ribbon ────────────────────────────────────────────────────────────────────────

const months: MonthTotal[] = [
  { key: '2026-07', label: 'Jul 26', cents: 24_000 },
  { key: '2026-08', label: 'Aug 26', cents: 1_099_099 },
]

test('the best month yet earns the ribbon', () => {
  assert.equal(isRecordPeriod(AUG, months), true)
})

test('BEST OF ONE IS NOT AN ACHIEVEMENT', () => {
  // Otherwise a park would be congratulated on a record on its very first day.
  assert.equal(isRecordPeriod(AUG, [{ key: '2026-08', label: 'Aug 26', cents: 500 }]), false)
})

test('a tie gets no trophy', () => {
  const tied: MonthTotal[] = [
    { key: '2026-07', label: 'Jul 26', cents: 500_000 },
    { key: '2026-08', label: 'Aug 26', cents: 500_000 },
  ]
  assert.equal(isRecordPeriod(AUG, tied), false)
})

test('a window spanning two months makes no record claim', () => {
  // "Best month yet" is the only record the data supports; a 242-day window is not a month.
  assert.equal(isRecordPeriod(YTD, months), false)
})

test('a month that beat nothing, or has no revenue, gets no ribbon', () => {
  assert.equal(isRecordPeriod(range(2026, 7, 1, 2026, 7, 31), months), false)
  assert.equal(isRecordPeriod(range(2026, 9, 1, 2026, 9, 30), months), false)
  assert.equal(isRecordPeriod(AUG, []), false)
})

test('AN EMPTY OR JUNK DATE DOES NOT TAKE THE PAGE DOWN', () => {
  // The reports page computes its comparison on every render, including the first one — before
  // any fetch has resolved and while the window is still empty. `new Date('').toISOString()`
  // throws, which would blank the whole page before it showed a single number.
  assert.equal(shiftMonths('', -12), '')
  assert.equal(shiftMonths('not a date', -1), 'not a date')
  const c = pickComparison({ startISO: '', endISO: '' }, null)
  assert.equal(c.window.startISO, '')
  assert.ok(c.label, 'and it still has something to print')
  assert.equal(isRecordPeriod({ startISO: '', endISO: '' }, months), false)
})

test('MONTH KEYS ARE LOCAL, so a late-evening payment stays in its own month', () => {
  // 10pm on 31 August is already 1 September in UTC for any park west of Greenwich. Filing it
  // under September while the window says August is how the record check silently finds nothing.
  const lateOnTheLast = new Date(2026, 7, 31, 22, 0, 0).toISOString()
  assert.equal(monthKey(lateOnTheLast), '2026-08')
  assert.equal(monthKey(new Date(2026, 7, 1, 0, 0, 0).toISOString()), '2026-08')
  assert.equal(monthKey(''), '', 'and an unset date has no month rather than crashing')
})
