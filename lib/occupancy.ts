// HOW FULL IS THE PARK ON A GIVEN NIGHT — Reports R3. Pure; no DB, no I/O.
//
// ⚠ EXTRACTED, NOT INVENTED. The reports page already counted occupancy two different ways: the
// monthly trend walked `arrival <= night < departure`, while "Tonight's Occupancy" queried
// `arrival <= today AND departure >= today`. Those two disagree about the DEPARTURE DAY — the
// second counts a guest who checked out this morning as still occupying a site tonight.
//
// R3 draws a calendar of nights, so it needs one answer, and the forward view has to agree with
// the number on the dashboard or the page contradicts itself. This module is that one answer,
// and both callers now use it.
//
// ── DATES ARE 'YYYY-MM-DD' STRINGS, ON PURPOSE ───────────────────────────────────────────────
//
// arrival_date and departure_date are DATE columns: a calendar day with no time and no zone.
// Comparing them as strings is chronological (ISO dates sort lexicographically) and cannot drift
// by a timezone or a daylight-saving hour, which is exactly the class of bug that turning them
// into Date objects invites. Only the week arithmetic below needs a real calendar, and it uses
// the local Date constructor to get one.

export type StayRow = {
  arrival_date?: string | null
  departure_date?: string | null
  /** The reports page selects this as a joined object; some queries select nothing. */
  sites?: { site_type?: string | null } | null
  /** When the booking was made. Only the pace comparison reads it. */
  created_at?: string | null
  status?: string | null
}

/** A cabin is reported separately from sites, exactly as the dashboard has always split them. */
export const isCabin = (r: StayRow): boolean => r?.sites?.site_type === 'cabin'

/**
 * Does this stay occupy the night of `night`?
 *
 * ⚠ THE DEPARTURE DAY IS NOT A NIGHT STAYED. A guest arriving the 28th and departing the 31st
 * occupies the nights of the 28th, 29th and 30th — three nights, not four. They are gone on the
 * morning of the 31st and that site is available to sell for the 31st.
 *
 * This is the rule the app's own monthly occupancy trend already used. The tonight query used the
 * other one and overstated tonight by every guest checking out today.
 */
export function occupiesNight(r: StayRow, night: string): boolean {
  if (!r?.arrival_date || !r?.departure_date || !night) return false
  return r.arrival_date <= night && night < r.departure_date
}

/** A cancelled stay occupies nothing. Matches every occupancy query on the reports page. */
export const isLiveStay = (r: StayRow): boolean => (r?.status || '') !== 'cancelled'

export type NightCount = { sites: number; cabins: number }

/** How many sites and cabins are occupied on one night. */
export function occupiedOn(rows: StayRow[] | null | undefined, night: string): NightCount {
  let sites = 0, cabins = 0
  for (const r of rows || []) {
    if (!isLiveStay(r) || !occupiesNight(r, night)) continue
    if (isCabin(r)) cabins++
    else sites++
  }
  return { sites, cabins }
}

/**
 * Fill for one night, as a whole percent.
 *
 * SEASONAL CAMPERS ARE ADDED TO THE NUMERATOR because they hold their site for the whole season
 * without a reservation row — the same thing "Tonight's Occupancy" has always done, and the
 * reason a park with six seasonals never reads 0% in the middle of the week.
 *
 * CABINS ARE NOT IN THIS FIGURE, also matching the dashboard: they are a different inventory with
 * a different denominator, and blending them would make a park with three cabins and eighty sites
 * look busier than it is. `occupiedOn` returns them separately for callers that want to say so.
 *
 * Capped at 100 for the same reason the dashboard caps it: an over-booked night (or a seasonal
 * count that exceeds a stale total_sites) should read "full", not "112%".
 */
export function fillPercent(occupiedSites: number, seasonalSites: number, totalSites: number): number {
  if (!totalSites || totalSites <= 0) return 0
  return Math.min(100, Math.max(0, Math.round(((occupiedSites + seasonalSites) / totalSites) * 100)))
}

// ── CALENDAR ARITHMETIC ──────────────────────────────────────────────────────────────────────

const pad = (n: number) => String(n).padStart(2, '0')

/** 'YYYY-MM-DD' for a local Date — the same shape `ymd()` in lib/transactions.ts produces. */
export const toYmd = (d: Date): string => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`

/**
 * Add days to a calendar date.
 *
 * Built through the local Date constructor so month ends, leap years and year rollovers are the
 * runtime's problem rather than ours — and reading back only Y/M/D means a daylight-saving change
 * in the middle of the range cannot shift the answer by a day.
 */
export function addDays(ymd: string, n: number): string {
  const [y, m, d] = ymd.split('-').map(Number)
  if (!y || !m || !d) return ymd
  return toYmd(new Date(y, m - 1, d + n))
}

/** The Monday on or before this date. Weeks are Mon–Sun, as the heat-calendar grid is drawn. */
export function mondayOf(ymd: string): string {
  const [y, m, d] = ymd.split('-').map(Number)
  if (!y || !m || !d) return ymd
  const dow = new Date(y, m - 1, d).getDay()      // 0 = Sunday
  return addDays(ymd, -((dow + 6) % 7))
}

/** `count` consecutive Monday-aligned week starts, beginning with the week containing `from`. */
export function weekStartsFrom(from: string, count: number): string[] {
  const first = mondayOf(from)
  return Array.from({ length: Math.max(0, count) }, (_, i) => addDays(first, i * 7))
}

/** The seven dates of a Mon–Sun week. */
export function daysOfWeek(weekStart: string): string[] {
  return Array.from({ length: 7 }, (_, i) => addDays(weekStart, i))
}

/**
 * The equivalent date one year earlier, aligned by WEEKDAY rather than by calendar date.
 *
 * ⚠ 364 DAYS, NOT 365, AND NOT "minus one year". A campground's week is a weekday shape — the
 * weekend fills and the midweek does not — so comparing a Saturday against last year's Friday
 * would compare two different businesses. 364 is exactly 52 weeks, so the day of the week always
 * lands on itself. The cost is that the date drifts by a day or two against the calendar, which
 * matters far less for a park than the weekday alignment does.
 */
export const SAME_WEEK_LAST_YEAR_OFFSET = -364
export const sameWeekLastYear = (ymd: string): string => addDays(ymd, SAME_WEEK_LAST_YEAR_OFFSET)
