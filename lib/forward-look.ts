// WHERE TO POINT YOUR ATTENTION — Reports R3. Pure; no DB, no I/O.
//
// R2 answered "how did the park do?". This answers "what do I do next?": which of the coming
// weeks are filling nicely and which are soft enough to be worth a nudge.
//
// ⚠ THE HARD PART IS NOT THE ARITHMETIC, IT IS DECIDING WHAT "BEHIND" MEANS — and refusing to
// decide when there is nothing honest to decide against. A park in its first season has no prior
// year, and an owner who has not asked for a target should not be given one. Both cases render a
// view with no judgment in it at all, which is a deliberate feature and is pinned by tests.
import {
  occupiedOn, fillPercent, daysOfWeek, sameWeekLastYear, occupiesNight, isLiveStay, type StayRow,
} from './occupancy.ts'

/** What "behind" is measured against, in the priority order the owner asked for. */
export type PaceBasis =
  | 'goal'              // the owner set a target — it wins, because they chose it
  | 'as_of_lead_time'   // vs the same week last year, AT THE SAME NUMBER OF DAYS OUT
  | 'final_fill'        // vs how the same week last year ENDED UP (see below)
  | 'none'              // nothing honest to compare against — no judgment offered

export type DayFill = { date: string; fill: number; sites: number; cabins: number; isToday: boolean }

export type WeekPace = {
  weekStart: string
  days: DayFill[]
  /** The week's fill: the mean of its seven nights, rounded. */
  fill: number
  /** The comparison figure, or null when there is none. */
  priorFill: number | null
  verdict: 'ahead' | 'level' | 'behind' | 'unknown'
}

/**
 * A week is "behind" or "ahead" only outside a DEADBAND.
 *
 * Without one, a week sitting one point under last year is flagged as a problem, and an owner who
 * is flagged for noise stops reading the flags. Three points is roughly one site on a
 * thirty-site park — below that, the two weeks are the same week.
 */
export const PACE_DEADBAND_PCT = 3

export function verdictFor(fill: number, prior: number | null): WeekPace['verdict'] {
  if (prior === null) return 'unknown'
  if (fill > prior + PACE_DEADBAND_PCT) return 'ahead'
  if (fill < prior - PACE_DEADBAND_PCT) return 'behind'
  return 'level'
}

/** Fill for every night of one week, plus the week's mean. */
export function weekFill(
  rows: StayRow[] | null | undefined,
  weekStart: string,
  seasonalSites: number,
  totalSites: number,
  today: string,
): { days: DayFill[]; fill: number } {
  const days = daysOfWeek(weekStart).map(date => {
    const { sites, cabins } = occupiedOn(rows, date)
    return { date, sites, cabins, fill: fillPercent(sites, seasonalSites, totalSites), isToday: date === today }
  })
  return { days, fill: Math.round(days.reduce((s, d) => s + d.fill, 0) / days.length) }
}

/**
 * Fill for the equivalent week last year, counting ONLY the bookings that existed at the same
 * lead time — i.e. answering "how booked was this week, this far out, last year?".
 *
 * ⚠ WHY LEAD TIME AND NOT LAST YEAR'S FINAL NUMBER.
 *
 * A week six weeks out being 40% full is not a problem if last year it was 25% full six weeks out
 * and finished at 90%. Comparing today's in-progress week against last year's FINISHED week makes
 * every future week look like a disaster, which is the single easiest way to make this view
 * useless — an owner who is told everything is behind will correctly ignore it.
 *
 * The as-of date is the same for every week on the board: a week `L` days out is compared against
 * last year's equivalent week as it stood `L` days before ITS start, and since both the week and
 * the observation slide back by the same 364 days, that date is simply `today − 364`.
 *
 * Seasonal campers are passed in as last year's count where a caller knows it, but in practice a
 * park rarely has that history; passing today's count is the honest approximation and the caller
 * documents which it used.
 */
export function priorWeekFillAsOf(
  rows: StayRow[] | null | undefined,
  weekStart: string,
  seasonalSites: number,
  totalSites: number,
  createdOnOrBefore: string | null,
): number {
  return weekFill(madeBy(rows, createdOnOrBefore), sameWeekLastYear(weekStart), seasonalSites, totalSites, '').fill
}

/**
 * Decide whether the lead-time comparison can be trusted, ONCE, for the whole board.
 *
 * ⚠ THE FAILURE THIS GUARDS AGAINST IS SILENT AND FLATTERING. If a park's history arrived by
 * import, every reservation carries a `created_at` of the import day rather than the day it was
 * booked. Last year then looks like it had NOTHING booked at any lead time, every week this year
 * reads "ahead", and the owner is congratulated on a fiction.
 *
 * The tell is unambiguous: weeks that demonstrably had bookings, none of which existed at the
 * as-of date. One such week could be real; ALL of them cannot. So the test is made across the
 * whole board rather than per week, which also stops the basis flickering between weeks and
 * keeps one label honest for the whole view.
 */
export function choosePaceBasis(
  goalPct: number | null,
  priorStayCount: number,
  priorStayCountAsOf: number,
): PaceBasis {
  if (goalPct !== null && goalPct > 0) return 'goal'
  // ⚠ COUNTED IN STAYS, NOT IN FILL PERCENTAGES — and getting this wrong is silent.
  //
  // Fill includes the seasonal baseline, so a park with six seasonals reads 67% for a week in
  // which nothing whatsoever was booked. Asking "was last year's fill above zero?" therefore
  // answers YES for a park that has no prior year at all, and a first-season park gets judged
  // against a year that never happened. The only honest question is whether any last-year
  // BOOKINGS exist.
  if (priorStayCount === 0) return 'none'
  return priorStayCountAsOf === 0 ? 'final_fill' : 'as_of_lead_time'
}

/** Stays that occupy at least one night of the given weeks. */
export function staysTouchingWeeks(rows: StayRow[] | null | undefined, weekStarts: string[]): StayRow[] {
  const nights = weekStarts.flatMap(daysOfWeek)
  return (rows || []).filter(r => isLiveStay(r) && nights.some(n => occupiesNight(r, n)))
}

/** Of those, the ones that had already been booked by `createdOnOrBefore`. */
export function madeBy(rows: StayRow[] | null | undefined, createdOnOrBefore: string | null): StayRow[] {
  if (!createdOnOrBefore) return rows || []
  // created_at is a timestamp; its first ten characters are its calendar day.
  return (rows || []).filter(r => {
    const made = (r.created_at || '').slice(0, 10)
    return !!made && made <= createdOnOrBefore
  })
}

/** How the chosen basis should be described to the owner, in their words rather than ours. */
export const PACE_BASIS_LABEL: Record<PaceBasis, string> = {
  goal: 'your goal',
  as_of_lead_time: 'the same week last year, at this same point',
  final_fill: 'how the same week finished last year',
  none: '',
}

export type ForwardLook = {
  weeks: WeekPace[]
  basis: PaceBasis
  basisLabel: string
  /** Weeks doing better than the comparison — the ones to say well done about. */
  ahead: WeekPace[]
  /** Weeks worth a nudge. Never called a failure. */
  behind: WeekPace[]
  /** The single fullest week ahead, for the celebratory line. Null when nothing is booked. */
  best: WeekPace | null
}

/**
 * Build the whole forward view.
 *
 * @param goalPct  the owner's fill target, or NULL when they have not set one. ⚠ NULL IS THE
 *                 DEFAULT AND MEANS NO GOAL LINE AND NO GOAL JUDGMENT — some owners find a
 *                 target motivating and others find it a stick, so it is theirs to opt into.
 */
export function buildForwardLook(
  weekStarts: string[],
  rows: StayRow[] | null | undefined,
  priorRows: StayRow[] | null | undefined,
  opts: {
    seasonalSites: number
    totalSites: number
    today: string
    goalPct: number | null
    /** `today − 364`; null disables the lead-time filter entirely. */
    priorAsOfDate: string | null
  },
): ForwardLook {
  const { seasonalSites, totalSites, today, goalPct, priorAsOfDate } = opts

  const filled = weekStarts.map(ws => ({ weekStart: ws, ...weekFill(rows, ws, seasonalSites, totalSites, today) }))
  const priorAsOf = weekStarts.map(ws => priorWeekFillAsOf(priorRows, ws, seasonalSites, totalSites, priorAsOfDate))
  const priorFinal = weekStarts.map(ws => priorWeekFillAsOf(priorRows, ws, seasonalSites, totalSites, null))

  // Whether a last-year comparison is possible at all is decided from the BOOKINGS, not from the
  // fill percentages above — see choosePaceBasis().
  const priorWeekStarts = weekStarts.map(sameWeekLastYear)
  const priorInWindow = staysTouchingWeeks(priorRows, priorWeekStarts)
  const basis = choosePaceBasis(goalPct, priorInWindow.length, madeBy(priorInWindow, priorAsOfDate).length)
  const priorFor = (i: number): number | null =>
    basis === 'goal' ? (goalPct as number)
    : basis === 'as_of_lead_time' ? priorAsOf[i]
    : basis === 'final_fill' ? priorFinal[i]
    : null

  const weeks: WeekPace[] = filled.map((w, i) => {
    const prior = priorFor(i)
    return { ...w, priorFill: prior, verdict: verdictFor(w.fill, prior) }
  })

  const booked = weeks.filter(w => w.fill > 0)
  return {
    weeks,
    basis,
    basisLabel: PACE_BASIS_LABEL[basis],
    ahead: weeks.filter(w => w.verdict === 'ahead'),
    behind: weeks.filter(w => w.verdict === 'behind'),
    best: booked.length ? booked.reduce((a, b) => (b.fill > a.fill ? b : a)) : null,
  }
}

// ── THE HEAT RAMP ────────────────────────────────────────────────────────────────────────────
//
// A SINGLE-HUE SEQUENTIAL ramp: pale green for empty through to deep green for full. One hue is
// what makes a sequential scale readable — a rainbow ramp implies categories that are not there,
// and reads as noise to anyone with a colour vision deficiency. The hue is the same bluish green
// R1 uses for the Store lane and R2 for the Store source, so nothing new was invented.
//
// ⚠ THE PERCENTAGE IS PRINTED IN EVERY CELL. The shade is the at-a-glance pattern; the number is
// the answer. Nothing on this calendar is communicated by colour alone.
const RAMP: { min: number; bg: string; fg: string }[] = [
  { min: 100, bg: '#00543E', fg: '#FFFFFF' },
  { min: 80,  bg: '#00785A', fg: '#FFFFFF' },
  { min: 60,  bg: '#009E73', fg: '#FFFFFF' },
  { min: 40,  bg: '#5CBFA0', fg: '#0B3B2E' },
  { min: 20,  bg: '#A5DBCA', fg: '#0B3B2E' },
  { min: 1,   bg: '#DCEFE8', fg: '#0B3B2E' },
  { min: 0,   bg: '#F4F7F6', fg: '#9CA3AF' },
]

export function heatColor(fill: number): { bg: string; fg: string } {
  const step = RAMP.find(s => fill >= s.min) || RAMP[RAMP.length - 1]
  return { bg: step.bg, fg: step.fg }
}

/** The legend's swatches, palest first — Empty → Full. */
export const HEAT_LEGEND = [...RAMP].reverse().map(s => ({ min: s.min, bg: s.bg }))
