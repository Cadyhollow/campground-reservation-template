// The To-Do board's phase-2 reminder arithmetic, as plain functions.
//
// Everything here is pure — no React, no Supabase, no clock of its own. `today` is always passed
// in. That is what lets `node --test` exercise the date logic (which is the part most likely to be
// subtly wrong) without a database, and it is the same shape lib/booking-quote.ts uses for the
// same reason.
//
// The route that actually writes rows is app/api/tasks/generate/route.ts; it calls into here for
// every decision about WHICH dates are due and WHAT a task should say.
//
// ── THE TIMEZONE PROBLEM, AND WHY IT IS SOLVED THIS WAY ───────────────────────────────────────
//
// There is no `settings.park_timezone` in this application. lib/bookability.ts says so at length
// and carries HORIZON_SERVER_SLACK_DAYS as its workaround; lib/transactions.ts flags the same gap
// for reports. The app's ONLY notion of "today" is `ymd(new Date())` evaluated in the BROWSER —
// which is the park's own machine, sitting at the park, in the park's timezone.
//
// A reminder must fire on the correct local day. "Bank deposit every Wednesday" appearing on
// Tuesday evening is the whole failure mode. But a server-side pass on Vercel thinks in UTC, and
// from 17:00 Pacific onwards UTC is already tomorrow.
//
// So the browser tells the server what day it is, and the server BOUNDS what it will accept:
// `clampToday()` below refuses anything more than one day either side of the server's own UTC
// date. Every real timezone on earth is within that window, so no honest park is ever refused;
// and a tampered-with value cannot make the engine manufacture months of future tasks. This is
// deliberately the same reasoning, and the same one-day tolerance, that HORIZON_SERVER_SLACK_DAYS
// already uses for exactly the same missing column.
//
// A `settings.park_timezone` column would let this move fully server-side. That is the real fix,
// it is already recommended in lib/bookability.ts, and it should be done together with moving the
// same-day cutoff — not piecemeal here.

/** A recurring rule, exactly as `public.task_rules` stores it. */
export type TaskRule = {
  id: string
  title: string
  notes: string | null
  priority: 'high' | 'medium' | 'low' | null
  assigned_to: string | null
  freq: 'daily' | 'weekly' | 'monthly'
  /** 0–6, Sunday..Saturday — matching JavaScript's Date.getDay(). */
  byweekday: number[] | null
  bymonthday: number | null
  /** 'HH:MM:SS' or 'HH:MM' — a wall-clock time, not an instant. */
  at_time: string
  active: boolean
  created_by: string | null
  created_at: string
  last_generated_on: string | null
}

/** How far the engine will trust a client-supplied date. See the timezone note above. */
export const GENERATION_CLAMP_DAYS = 1

/** How many past days a rule will ever be caught up over in one pass. See catchUpFrom(). */
export const MAX_CATCHUP_DAYS = 30

// ── date helpers ─────────────────────────────────────────────────────────────────────────────
//
// All of these work on 'YYYY-MM-DD' strings and construct dates with the LOCAL constructor
// (new Date(y, m, d)), never Date.parse of a bare date string. `new Date('2026-08-19')` is parsed
// as UTC midnight, which in any negative-offset timezone is the 18th — the exact off-by-one this
// module exists to avoid.

/** 'YYYY-MM-DD' for a Date, read in its own local calendar. Mirrors lib/transactions.ts ymd(). */
export function ymdOf(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/** A local Date at midnight for a 'YYYY-MM-DD' string. Never Date.parse — see above. */
export function dateFromYmd(s: string): Date {
  const [y, m, d] = s.split('-').map(Number)
  return new Date(y, m - 1, d)
}

/** Whole days from `a` to `b`, both 'YYYY-MM-DD'. Negative when b is before a. */
export function daysBetween(a: string, b: string): number {
  return Math.round((dateFromYmd(b).getTime() - dateFromYmd(a).getTime()) / 86_400_000)
}

/** 'YYYY-MM-DD' n days after `s`. */
export function addDays(s: string, n: number): string {
  const d = dateFromYmd(s)
  d.setDate(d.getDate() + n)
  return ymdOf(d)
}

/** Is `s` a real calendar date in 'YYYY-MM-DD' form? Rejects '2026-02-31' and friends. */
export function isValidYmd(s: unknown): s is string {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false
  return ymdOf(dateFromYmd(s)) === s
}

/**
 * The date the engine will actually use.
 *
 * Accepts the browser's local date only within GENERATION_CLAMP_DAYS of the server's own date;
 * anything else (absent, malformed, or out of range) falls back to the server's. Returns the
 * server date rather than throwing, so a bad clock degrades to "generate on the UTC day" instead
 * of the board silently having no reminders at all.
 */
export function clampToday(supplied: unknown, serverToday: string): string {
  if (!isValidYmd(supplied)) return serverToday
  const drift = daysBetween(serverToday, supplied)
  return Math.abs(drift) <= GENERATION_CLAMP_DAYS ? supplied : serverToday
}

/**
 * Does this rule fall on this date?
 *
 * `daily` is every day. `weekly` matches the day of the week — and a weekly rule with no days
 * selected matches NOTHING rather than everything, because "weekly, no days" is an unfinished
 * rule and firing daily would be the worst possible reading of it. `monthly` matches the day of
 * the month, and CLAMPS to the last day: a rule for the 31st fires on 30 June and 28 February,
 * rather than skipping those months entirely, which is what a person means by "the last day-ish".
 */
export function ruleFallsOn(rule: TaskRule, date: string): boolean {
  const d = dateFromYmd(date)
  if (rule.freq === 'daily') return true
  if (rule.freq === 'weekly') {
    const days = rule.byweekday ?? []
    return days.length > 0 && days.includes(d.getDay())
  }
  // monthly
  const wanted = rule.bymonthday
  if (!wanted) return false
  const lastOfMonth = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate()
  return d.getDate() === Math.min(wanted, lastOfMonth)
}

/**
 * The first date a pass should consider for this rule.
 *
 * From the watermark's day AFTER (already-generated days are done), or from the day the rule was
 * created if it has never run. Then floored to MAX_CATCHUP_DAYS before today.
 *
 * THE FLOOR IS NOT AN OPTIMISATION. A rule paused in March and resumed in August would otherwise
 * manufacture five months of missed bank runs in one go — a board with 150 identical overdue
 * tasks on it, which is worse than useless. Nobody wants to do February's deposit in August.
 */
export function catchUpFrom(rule: TaskRule, today: string): string {
  const raw = rule.last_generated_on
    ? addDays(rule.last_generated_on, 1)
    : ymdOf(new Date(rule.created_at))
  const floor = addDays(today, -MAX_CATCHUP_DAYS)
  return daysBetween(floor, raw) < 0 ? floor : raw
}

/**
 * Every date this rule is due for, from its watermark up to and including today.
 *
 * NEVER PAST TODAY: the future is not pre-created. That is what makes editing a rule take effect
 * — an occurrence that does not exist yet cannot be wrong — and it is what keeps a dismissed
 * occurrence dismissed, since the dedup index only has to remember the past.
 *
 * An inactive rule yields nothing. Its existing instances are untouched; they are real work
 * somebody may still owe.
 */
export function occurrencesDue(rule: TaskRule, today: string): string[] {
  if (!rule.active) return []
  const out: string[] = []
  let cursor = catchUpFrom(rule, today)
  // Guard the loop on the span rather than trusting the cursor to converge.
  for (let i = 0; i <= MAX_CATCHUP_DAYS + 1 && daysBetween(cursor, today) >= 0; i++) {
    if (ruleFallsOn(rule, cursor)) out.push(cursor)
    cursor = addDays(cursor, 1)
  }
  return out
}

/** 'HH:MM:SS' | 'HH:MM' → [hours, minutes]. Anything unreadable becomes midnight. */
export function parseAtTime(at: string): [number, number] {
  const m = /^(\d{1,2}):(\d{2})/.exec(at ?? '')
  if (!m) return [0, 0]
  const h = Math.min(23, Number(m[1]))
  const min = Math.min(59, Number(m[2]))
  return [h, min]
}

/**
 * The instant a recurring instance is due, as an ISO string.
 *
 * Built with the LOCAL Date constructor so that `at_time` means the wall-clock time in whatever
 * zone this code runs in. On the server that is UTC — which is exactly why the due CHIP on the
 * board is rendered from due_at in the viewer's zone, and why at_time is stored separately on the
 * rule as the authoritative wall-clock intent. See the note on the route.
 */
export function dueAtFor(occurrenceDate: string, atTime: string): string {
  const [h, m] = parseAtTime(atTime)
  const d = dateFromYmd(occurrenceDate)
  d.setHours(h, m, 0, 0)
  return d.toISOString()
}

/**
 * "Weekly · Wednesdays · 10:00 AM" — the human sentence under a rule in Manage reminders.
 *
 * This is the only place a schedule is put into words, so the board and the manage view cannot
 * describe the same rule differently.
 */
const DAY_NAMES = ['Sundays', 'Mondays', 'Tuesdays', 'Wednesdays', 'Thursdays', 'Fridays', 'Saturdays']
const DAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

export function formatTime(atTime: string): string {
  const [h, m] = parseAtTime(atTime)
  const suffix = h >= 12 ? 'PM' : 'AM'
  const hour12 = h % 12 === 0 ? 12 : h % 12
  return `${hour12}:${String(m).padStart(2, '0')} ${suffix}`
}

/** 1 → "1st", 2 → "2nd", 23 → "23rd". */
export function ordinal(n: number): string {
  const rem100 = n % 100
  if (rem100 >= 11 && rem100 <= 13) return `${n}th`
  const suffix = { 1: 'st', 2: 'nd', 3: 'rd' }[n % 10] ?? 'th'
  return `${n}${suffix}`
}

export function describeRule(rule: TaskRule): string {
  const time = formatTime(rule.at_time)
  if (rule.freq === 'daily') return `Daily · ${time}`
  if (rule.freq === 'weekly') {
    const days = (rule.byweekday ?? []).slice().sort((a, b) => a - b)
    if (days.length === 0) return `Weekly · no days chosen · ${time}`
    if (days.length === 7) return `Every day · ${time}`
    return `Weekly · ${days.map(d => DAY_NAMES[d] ?? '?').join(', ')} · ${time}`
  }
  return `Monthly · ${rule.bymonthday ? ordinal(rule.bymonthday) : '?'} · ${time}`
}

/** The short form on the board's badge: "every Wed 10:00 AM". */
export function describeRuleShort(rule: TaskRule): string {
  const time = formatTime(rule.at_time)
  if (rule.freq === 'daily') return `every day ${time}`
  if (rule.freq === 'weekly') {
    const days = (rule.byweekday ?? []).slice().sort((a, b) => a - b)
    if (days.length === 0) return `weekly ${time}`
    return `every ${days.map(d => DAY_SHORT[d] ?? '?').join('/')} ${time}`
  }
  return `monthly ${rule.bymonthday ? ordinal(rule.bymonthday) : ''} ${time}`.replace(/\s+/g, ' ')
}

/**
 * The title of a check-in prep task: "Prep Cabin 3 — check-in tomorrow (Ortiz family)".
 *
 * The relative day is baked into the TITLE rather than computed at render time, on purpose: the
 * row is generated once and never rewritten, so a task raised two days out must not start
 * claiming "check-in today" when read the following morning. It says what was true when it was
 * raised, and the due chip carries the live date.
 */
export function checkinTaskTitle(siteLabel: string, arrivalDate: string, guestName: string, today: string): string {
  const days = daysBetween(today, arrivalDate)
  const when = days <= 0 ? 'today' : days === 1 ? 'tomorrow' : `in ${days} days`
  const site = siteLabel?.trim() || 'site'
  const guest = guestName?.trim()
  return `Prep ${site} — check-in ${when}${guest ? ` (${guest})` : ''}`
}
