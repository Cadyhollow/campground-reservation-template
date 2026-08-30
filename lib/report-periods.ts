// COMPARING ONE PERIOD TO ANOTHER — Reports R2. Pure; no DB, no I/O; integer cents throughout.
//
// Two jobs: work out WHICH earlier window to compare against, and decide HOW a change should be
// read. The second one is not styling. An owner who has had a great month should be able to feel
// it from across the room, and an owner who has had a slow one should be nudged rather than
// scolded — so the tone is computed here, next to the arithmetic that justifies it, instead of
// being left to whichever colour a component happened to reach for.

/** A closed date window, as the ISO instants the queries already use. */
export type Window = { startISO: string; endISO: string }

/** Which earlier window we ended up comparing against, and what to call it on screen. */
export type Comparison = {
  window: Window
  basis: 'last_year' | 'previous'
  /** Reads naturally after "vs" and after "more than". */
  label: string
}

const DAY_MS = 86_400_000

/**
 * Shift a date back or forward by whole months, clamping the day-of-month.
 *
 * ⚠ LOCAL CALENDAR ARITHMETIC, NOT UTC — and that is not a detail.
 *
 * The window boundaries these operate on come from dayStartUTC()/dayEndUTC(), which map a LOCAL
 * calendar day to the UTC instants that bound it. For a park in New York, "1 August" starts at
 * 04:00Z, and for a park in Sydney it starts at 14:00Z on 31 JULY. Reading `.getUTCDate()` off
 * those instants therefore answers a question about the wrong day for most of the world, and
 * shifting them by a fixed number of UTC months drifts by an hour across a daylight-saving
 * boundary — which silently moves a payment made near midnight into or out of the comparison.
 *
 * Using the local getters and the local Date constructor keeps every window pinned to the same
 * local wall-clock instants the query used, and lets the runtime re-resolve the offset so DST
 * takes care of itself.
 *
 * Clamping matters too: 31 March minus one month is 28 February (or the 29th), not 3 March.
 * JavaScript's Date rolls over instead of clamping, so this does it by hand.
 */
export function shiftMonths(iso: string, months: number): string {
  const d = new Date(iso)
  // ⚠ RETURNED UNCHANGED WHEN UNPARSEABLE, RATHER THAN THROWN.
  //
  // A React page computes its derived values on EVERY render, including the first one — before
  // any fetch has resolved and while the window is still empty. `new Date('')` is an Invalid
  // Date, and `.toISOString()` on one throws a RangeError, which would take the whole reports
  // page down with a blank screen before it ever showed a number. An empty window in, an empty
  // window out: the caller then sums nothing over it, which is the correct answer for "we do not
  // know the dates yet".
  if (Number.isNaN(d.getTime())) return iso
  const lastDayOfTarget = new Date(d.getFullYear(), d.getMonth() + months + 1, 0).getDate()
  return new Date(
    d.getFullYear(), d.getMonth() + months, Math.min(d.getDate(), lastDayOfTarget),
    d.getHours(), d.getMinutes(), d.getSeconds(), d.getMilliseconds(),
  ).toISOString()
}

const valid = (w: Window) =>
  !Number.isNaN(new Date(w.startISO).getTime()) && !Number.isNaN(new Date(w.endISO).getTime())

/** Does this window cover exactly one whole calendar month, 1st to last day? */
export function isWholeCalendarMonth(w: Window): boolean {
  if (!valid(w)) return false
  const s = new Date(w.startISO), e = new Date(w.endISO)
  if (s.getDate() !== 1) return false
  if (s.getFullYear() !== e.getFullYear() || s.getMonth() !== e.getMonth()) return false
  return e.getDate() === new Date(e.getFullYear(), e.getMonth() + 1, 0).getDate()
}

/** How many days a window spans, inclusive. Used to size and name the fallback period. */
export function windowDays(w: Window): number {
  if (!valid(w)) return 1
  return Math.max(1, Math.round((new Date(w.endISO).getTime() - new Date(w.startISO).getTime()) / DAY_MS))
}

/**
 * The window immediately BEFORE this one — the fallback comparison.
 *
 * ⚠ IT MUST NOT OVERLAP THE WINDOW IT IS COMPARED AGAINST, which is the trap an earlier version
 * of this fell into. Shifting back by one month is right for a month, and badly wrong for
 * anything longer: the default report range is year-to-date, and a 242-day window shifted back
 * one month overlaps itself by 211 days. The "comparison" would then be mostly the same money,
 * and every park would look flat forever.
 *
 * So: a whole calendar month steps back to the whole calendar month before it, and everything
 * else steps back by its own exact length, ending the instant before this window opens.
 */
export function previousWindow(w: Window): Window {
  if (!valid(w)) return w
  if (isWholeCalendarMonth(w)) {
    return { startISO: shiftMonths(w.startISO, -1), endISO: shiftMonths(w.endISO, -1) }
  }
  const span = new Date(w.endISO).getTime() - new Date(w.startISO).getTime()
  const end = new Date(new Date(w.startISO).getTime() - 1)
  return { startISO: new Date(end.getTime() - span).toISOString(), endISO: end.toISOString() }
}

/**
 * A human name for that window, sized to what it actually is.
 *
 * Saying "last month" about a 242-day window would be false, and saying "the previous 242 days"
 * about August would be needlessly cold. So it is named by its shape, and only where the name is
 * honest — "last month" is claimed ONLY for a window that really is a whole calendar month.
 */
export function previousPeriodLabel(w: Window): string {
  if (isWholeCalendarMonth(w)) return 'last month'
  const d = windowDays(w)
  if (d <= 1) return 'the day before'
  if (d <= 8) return 'the week before'
  if (d >= 360 && d <= 370) return 'the year before'
  return `the previous ${d} days`
}

/**
 * Pick the comparison window: the same period LAST YEAR by default, falling back to the period
 * immediately before when the park has no last-year data yet.
 *
 * ⚠ THE FALLBACK IS DECIDED BY WHETHER DATA COULD EXIST, NOT BY WHETHER IT HAPPENS TO BE ZERO.
 * A young park has no last-year figures at all, and comparing against a year that predates the
 * park reads as a catastrophic decline from nothing. But an ESTABLISHED park that genuinely took
 * nothing last August has a real zero, and quietly swapping that for last month would hide a
 * meaningful year-over-year story. So the test is `firstRevenueISO`: only if the park's very
 * first dollar landed AFTER the last-year window had already closed do we fall back.
 *
 * `firstRevenueISO` null means no revenue has ever been recorded — nothing to compare either
 * way, so the caller gets the previous period and a total of zero.
 */
export function pickComparison(current: Window, firstRevenueISO: string | null): Comparison {
  const lastYear: Window = { startISO: shiftMonths(current.startISO, -12), endISO: shiftMonths(current.endISO, -12) }
  const parkExistedLastYear = !!firstRevenueISO && firstRevenueISO <= lastYear.endISO
  if (parkExistedLastYear) {
    return { window: lastYear, basis: 'last_year', label: 'the same period last year' }
  }
  return { window: previousWindow(current), basis: 'previous', label: previousPeriodLabel(current) }
}

/**
 * How a change should READ.
 *
 * - `win`   — more money than before. Celebrated: green, an up arrow, warm wording.
 * - `flat`  — no change worth remarking on. Neutral.
 * - `watch` — less money than before. ⚠ AMBER, NOT RED, and worded matter-of-factly. A slow
 *             month is information, not a failure, and an owner who is shown alarm red for
 *             ordinary seasonality learns to ignore the colour — which is exactly what must not
 *             happen when something is genuinely wrong.
 *
 * RED IS DELIBERATELY NOT A VALUE THIS FUNCTION CAN RETURN. It is reserved, elsewhere on the
 * page, for money that should be there and is not — an overdue balance. Nothing about a period
 * being smaller than another period qualifies.
 */
export type Tone = 'win' | 'flat' | 'watch'

export type Delta = {
  tone: Tone
  /** current − prior, in cents. Signed. */
  changeCents: number
  /**
   * Fractional change against the prior period, or null when it cannot honestly be expressed —
   * a prior of zero has no percentage, however tempting "+∞%" is.
   */
  changeFraction: number | null
  /**
   * When growth is large, a multiple reads better than a percentage: "45× last month" lands,
   * "+4,479%" looks like a rendering bug. Null unless the multiple is at least 10.
   */
  multiple: number | null
}

export function computeDelta(currentCents: number, priorCents: number): Delta {
  const changeCents = currentCents - priorCents
  const tone: Tone = changeCents > 0 ? 'win' : changeCents < 0 ? 'watch' : 'flat'
  if (priorCents === 0) {
    return { tone, changeCents, changeFraction: null, multiple: null }
  }
  const changeFraction = changeCents / Math.abs(priorCents)
  const ratio = currentCents / priorCents
  const multiple = priorCents > 0 && ratio >= 10 ? ratio : null
  return { tone, changeCents, changeFraction, multiple }
}

/**
 * The warm one-line read under the headline.
 *
 * Written here rather than in the component so the wording and the tone cannot drift apart — a
 * green arrow over discouraging words would be worse than either alone. Deliberately plain
 * English, no jargon, and never congratulatory about a decline or gloomy about a rise.
 */
export function headlineRead(delta: Delta, comparisonLabel: string, isRecord: boolean): string {
  if (isRecord) return 'Your strongest period yet — nothing has topped this.'
  if (delta.tone === 'flat') return `Almost exactly level with ${comparisonLabel}.`
  if (delta.tone === 'win') {
    if (delta.changeFraction === null) return `Money came in this period, where ${comparisonLabel} had none.`
    if (delta.multiple) return `Several times what came in over ${comparisonLabel} — a big step up.`
    if (delta.changeFraction >= 0.25) return `Comfortably ahead of ${comparisonLabel}.`
    return `Tracking ahead of ${comparisonLabel}.`
  }
  if (delta.changeFraction !== null && delta.changeFraction <= -0.25) {
    return `Quieter than ${comparisonLabel} — worth a look at what changed.`
  }
  return `A little behind ${comparisonLabel}.`
}

/**
 * The calendar month an instant falls in, as 'YYYY-MM', IN LOCAL TERMS.
 *
 * ⚠ EXPORTED SO THE CALLER CANNOT DISAGREE WITH THIS FILE ABOUT WHAT MONTH SOMETHING IS IN.
 * Slicing the first seven characters off an ISO string answers in UTC, and for a park west of
 * Greenwich a payment taken at 10pm on 31 August is already 1 September in UTC — so the payment
 * would be filed under September while the window that should contain it says August, and the
 * record check would compare two different months and quietly find no record.
 */
export function monthKey(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
}

/** One calendar month's revenue, for the trend and the record check. */
export type MonthTotal = { key: string; label: string; cents: number }

/**
 * Is this window a record?
 *
 * Only asked of a window that sits inside ONE calendar month, because "best month yet" is the
 * only record claim the data can actually support — comparing a 242-day window against calendar
 * months would be meaningless. Two further guards keep the ribbon meaningful:
 *
 *   • it must be STRICTLY the largest, so a tie never gets a trophy;
 *   • there must be at least two months with revenue, because "best of one" is not an
 *     achievement and a brand-new park would otherwise be congratulated on its first day.
 */
export function isRecordPeriod(current: Window, months: MonthTotal[]): boolean {
  const startKey = monthKey(current.startISO)
  if (!startKey || startKey !== monthKey(current.endISO)) return false
  const withRevenue = months.filter(m => m.cents > 0)
  if (withRevenue.length < 2) return false
  const here = months.find(m => m.key === startKey)
  if (!here || here.cents <= 0) return false
  return withRevenue.every(m => m.key === startKey || m.cents < here.cents)
}
