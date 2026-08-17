// Whether a set of dates may be booked at all — the one place that decides it.
//
// Rules currently here: the booking horizon, the season gate, blocked dates, double-booking and
// min-stay. NOT here, and still browser-only: the same-day cutoff, which needs a park timezone
// `settings` does not have. The horizon works around the same missing column with a day of
// deliberate slack rather than staying in the browser — see HORIZON_SERVER_SLACK_DAYS.
//
// The season gate, the blocked-date check and the double-booking check all used to live
// inside app/api/availability/route.ts, which is the SEARCH path. /api/payment, which is the
// CREATE path and the one that charges a card, re-checked only double-booking. Everything
// else was enforced by the search simply not offering the date.
//
// That is not enforcement. /book reads its dates from URL params, so the search can be
// skipped entirely: a hand-edited request could book a park-wide blocked date, or a date
// months outside the season, and be charged for it. The park would have a confirmed
// reservation, a real Square charge and a guest arriving at a closed campground.
//
// So the checks move here and both routes call them. Same discipline as
// lib/cancellation-policy.ts: one function, two callers, and no way for search and create to
// drift apart — if the search would reject a date, create rejects it too, because it is
// literally the same code.
//
// Deliberately free of any Supabase import and of any module-scope service-role client. The
// pure date arithmetic is unit-testable on its own (lib/bookability.test.ts), and the parts
// that touch the database take the caller's client as an argument.

// Structural, so this file imports nothing. Both callers pass a real SupabaseClient.
type SupabaseLike = { from: (table: string) => any }

export type BookabilityReason =
  | 'ok'
  | 'missing-dates'
  | 'invalid-range'
  | 'beyond-horizon'
  | 'out-of-season'
  | 'blocked'
  | 'double-booked'
  | 'min-stay'

export type BookabilityResult = {
  bookable: boolean
  reason: BookabilityReason
  // Guest-facing. The season and blocked messages are the park's own configured wording where
  // there is one, so a rejection at create reads like the rejection at search.
  message: string
}

const OK: BookabilityResult = { bookable: true, reason: 'ok', message: '' }

export const DEFAULT_CLOSED_MESSAGE =
  'We are closed for the season. We look forward to welcoming you back next year!'

// ---------------------------------------------------------------------------
// Pure date arithmetic
// ---------------------------------------------------------------------------

// settings.season_start / season_end are free text like "May 1" — a month name and a day, no
// year, because a season repeats annually.
//
// ── WHY THE OLD PARSER WAS REPLACED ──────────────────────────────────────────────────────────
//
// It did `months[parts[0]] || '01'` and `parseInt(parts[1])`, which failed in two opposite
// directions and neither of them loudly:
//
//   "Oct 31"     -> January 31   an abbreviation silently became a DIFFERENT MONTH, so a park
//                                that typed "Oct 1"/"Oct 31" got a Jan 1 - Jan 31 season and
//                                refused bookings for eleven months
//   "february 3" -> January 3    the month map was case-sensitive
//   "banana"     -> "01-NaN"     an Invalid Date, and every comparison against NaN is false, so
//                                the closed season silently vanished entirely
//
// A wrong-but-plausible value is worse than a rejected one. This returns null for anything it
// cannot read, so "unparseable" is a state callers must handle rather than a January date they
// cannot distinguish from a real one.
//
// It is also where the fail-open decision is made safe: enforcement treats null as "no season"
// (see checkSeasonSpan), which is only defensible because the Settings page validates with THIS
// function on save and refuses to store text it cannot read. A park finds out it mistyped its
// season when it saves, not silently months later.

const MONTHS = [
  'january', 'february', 'march', 'april', 'may', 'june',
  'july', 'august', 'september', 'october', 'november', 'december',
]

// Days per month, 1-indexed. February is 29 because a season carries no year — "February 29" is
// a real closing date in leap years and must not be rejected out of hand.
const DAYS_IN_MONTH = [0, 31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]

export type MonthDay = { month: number; day: number }

// A month name (full or any unambiguous prefix, any case) and a day number, in either order.
// Returns null on anything else — never a silent default.
export function parseMonthDay(text: string | null | undefined): MonthDay | null {
  if (typeof text !== 'string') return null
  const tokens = text.trim().toLowerCase().split(/[\s,]+/).filter(Boolean)
  if (tokens.length !== 2) return null

  // Either order: "October 31" and "31 October" are the same date written two ways, and rejecting
  // the second would be user-hostile rather than safe. Both tokens are still required, so a bare
  // "May" — which has no day and cannot name a boundary — is still null.
  const [a, b] = tokens
  const monthToken = /^\d+$/.test(a) ? b : a
  const dayToken = /^\d+$/.test(a) ? a : b

  // Prefix match, so "oct", "octo" and "october" all resolve — but only when exactly one month
  // starts with it. "ma" is ambiguous between March and May and is rejected rather than guessed.
  const matches = MONTHS.filter(m => m.startsWith(monthToken))
  if (matches.length !== 1) return null
  const month = MONTHS.indexOf(matches[0]) + 1

  // parseInt would accept "31st" and also "31nonsense"; this requires the token to BE a number.
  // A trailing ordinal suffix is allowed because people type "May 1st".
  const dayMatch = dayToken.match(/^(\d{1,2})(?:st|nd|rd|th)?$/)
  if (!dayMatch) return null
  const day = Number(dayMatch[1])
  if (day < 1 || day > DAYS_IN_MONTH[month]) return null

  return { month, day }
}

// Month/day as a single comparable integer: October 31 -> 1031. Ordering these needs no Date, no
// year and no timezone at all, which is why this module can decide the season without any of the
// noon-anchoring the old implementation relied on.
export function monthDayKey(md: MonthDay): number {
  return md.month * 100 + md.day
}

export type SeasonSettings = {
  season_start?: string | null
  season_end?: string | null
  closed_season_message?: string | null
}

// Whole nights between two YYYY-MM-DD dates. Parsed at UTC noon so a DST boundary inside the
// stay cannot round 3 nights to 2.96 and trip the min-stay comparison by an off-by-one.
export function nightsBetween(arrival: string, departure: string): number {
  const a = Date.parse(`${arrival}T12:00:00Z`)
  const d = Date.parse(`${departure}T12:00:00Z`)
  if (!Number.isFinite(a) || !Number.isFinite(d)) return 0
  return Math.round((d - a) / 86400000)
}

// YYYY-MM-DD, `days` later. UTC noon again, for the same reason: adding 30 * 86400000ms to a
// local midnight lands on 23:00 the previous day across a DST boundary, which would silently
// move the horizon by one day twice a year.
export function addDays(date: string, days: number): string {
  const t = Date.parse(`${date}T12:00:00Z`)
  if (!Number.isFinite(t)) return date
  return new Date(t + days * 86400000).toISOString().split('T')[0]
}

// ---------------------------------------------------------------------------
// The booking horizon
// ---------------------------------------------------------------------------

export type HorizonSettings = {
  max_advance_days?: number | string | null
}

// How far past the true horizon the SERVER lets an arrival through.
//
// There is no park timezone in `settings` — the same gap that keeps the same-day cutoff out of
// this module and in the browser. So the server's idea of "today" is UTC, and a park in
// US/Pacific is up to a day behind it: at 17:00 Pacific the server already believes it is
// tomorrow, and an arrival the date picker legitimately offered as the last bookable day would
// be one day past the server's computed horizon.
//
// The server therefore allows one day of slack, and the client allows none. The client shows the
// true horizon; the server refuses only what is unambiguously beyond it.
//
// This direction is deliberate. A horizon is a business preference, not a safety gate: nothing
// is overbooked, no money is misdirected and nobody arrives at a closed campground because a
// booking came in one day further out than the owner would have liked. Failing the other way —
// strict UTC, no slack — would silently reject real bookings for a few hours every evening,
// which is exactly the false-rejection problem that kept the same-day cutoff off the server in
// the first place. Fail open by a day, visibly, with a comment saying so.
//
// A `settings.park_timezone` column would remove the need for this; it would also let the
// same-day cutoff move server-side, and the two should be done together, not here.
export const HORIZON_SERVER_SLACK_DAYS = 1

// What a usable horizon is, and what everything else means.
//
// Returns the number of days, or null for "no horizon". NULL is the provisioned value and the
// steady state for a park that has not set a window, so null has to mean unlimited — that is
// the behaviour every tenant had before the column existed.
//
// Everything unusable ALSO resolves to null: '', 0, negatives, fractions, NaN, a string that is
// not a number. This fails OPEN, matching checkSeason, which treats missing season bounds as
// "no closed period" rather than "closed". A park whose horizon row is garbage keeps taking
// bookings; it does not go dark until someone notices.
//
// 0 resolving to "no limit" rather than "today only" is the one judgement call here. A literal
// reading of 0 is "no advance booking at all", which would refuse every reservation on the site
// — an outcome so severe that it should require typing something that says so, not a zero that
// is far more likely a cleared field or an integer default. The Settings page enforces a
// minimum of 1 so 0 cannot be saved deliberately.
// The type gate is not decoration. Number() is far too permissive to hand an arbitrary settings
// value to: Number(true) is 1, so a boolean landing in this column — a mis-wired toggle, a JSON
// body with `max_advance_days: true` — would resolve to a ONE DAY horizon and shut the park's
// online booking down to same-day only. That is the single worst outcome this function can
// produce, and it would arrive looking like a valid configuration. Only a number, or a string
// that is genuinely a number, is considered at all; everything else is "no horizon".
export function resolveMaxAdvanceDays(raw: unknown): number | null {
  if (typeof raw !== 'number' && typeof raw !== 'string') return null
  if (typeof raw === 'string' && raw.trim() === '') return null
  const n = Number(raw)
  if (!Number.isInteger(n) || n < 1) return null
  return n
}

// The last arrival date a guest may pick, given a horizon and what day it is. Exported because
// the date picker needs exactly this value for its `max` attribute — the client must derive the
// bound from the same arithmetic that enforces it, or the two drift and guests get rejected on a
// date the calendar offered them.
export function horizonLastArrival(maxDays: number, today: string): string {
  return addDays(today, maxDays)
}

// The gate. ARRIVAL ONLY — the departure date is deliberately not checked.
//
// Every other rule in this module that keys on one end of the stay keys on the arrival
// (checkSeason does), and a horizon is a statement about how far ahead someone may PLAN, not
// about when their trip ends. Checking the departure too would quietly shorten the window by the
// length of the stay: with a 180-day horizon a two-week trip could only be booked 166 days out,
// which is not what an owner who typed 180 meant, and is impossible to explain to a guest whose
// arrival is inside the window but whose booking is refused.
//
// `today` is passed in, never read from a clock in here, so the whole thing stays pure and the
// boundary cases are testable without mocking time.
export function checkHorizon(
  arrival: string,
  settings: HorizonSettings | null | undefined,
  today: string,
  slackDays: number = 0
): BookabilityResult {
  const maxDays = resolveMaxAdvanceDays(settings?.max_advance_days)
  if (maxDays === null) return OK

  // The date the guest is actually held to, and the one the message quotes: the true horizon,
  // not the slack-extended one. Quoting today+maxDays+1 would advertise a window the owner did
  // not set and the client does not offer.
  const lastArrival = horizonLastArrival(maxDays, today)
  const lastAccepted = addDays(lastArrival, slackDays)

  // String comparison is correct for YYYY-MM-DD and avoids re-parsing. An unparseable arrival
  // makes addDays return its input unchanged, so a malformed date cannot fabricate a huge
  // window here — and checkBookability has already rejected a malformed range before this runs.
  if (arrival > lastAccepted) {
    return {
      bookable: false,
      reason: 'beyond-horizon',
      message: `We accept reservations up to ${maxDays} day${maxDays === 1 ? '' : 's'} in advance. Please choose an arrival date on or before ${lastArrival}.`,
    }
  }

  return OK
}

// Whether one calendar date falls inside the park's open season.
//
// WRAP-AROUND IS HANDLED HERE, and it is the whole reason this is a month/day comparison rather
// than a Date one. The previous implementation built both bounds from the ARRIVAL's own calendar
// year, so a winter park (November 1 → March 31) got a start LATER than its end and every date
// failed both comparisons — including its own opening day. A winter park could not take a single
// booking. That bug was pinned by a test asserting the broken behaviour; this fixes it and the
// test is inverted.
//
// A season is a recurring annual window, so it is decided entirely by month and day:
//
//   normal (Apr 1 → Oct 31)   in season when  start <= date <= end
//   wrapped (Nov 1 → Mar 31)  in season when  date >= start OR date <= end
//
// Both bounds are inclusive: a park is open ON its first and last day.
//
// Returns null — NOT false — when the season cannot be read at all, so the caller can tell
// "definitely closed" apart from "no usable season configured".
export function isNightInSeason(
  date: string,
  settings: SeasonSettings | null | undefined
): boolean | null {
  // Half a season is not a season: a park with only one bound configured has no closed period,
  // which is how the availability route has always treated it.
  if (!settings?.season_start || !settings?.season_end) return null

  const start = parseMonthDay(settings.season_start)
  const end = parseMonthDay(settings.season_end)
  if (!start || !end) return null

  const m = Number(date.slice(5, 7))
  const d = Number(date.slice(8, 10))
  if (!m || !d) return null

  const x = m * 100 + d
  const s = monthDayKey(start)
  const e = monthDayKey(end)

  return s <= e
    ? x >= s && x <= e
    : x >= s || x <= e
}

// THE SEASON GATE. Every NIGHT of the stay must fall inside the open season.
//
// ── WHY THE WHOLE STAY, AND WHY NIGHTS RATHER THAN DAYS ─────────────────────────────────────
//
// This used to check the ARRIVAL only, which left a live hole on the PUBLIC path: a stay that
// began in season and ran past closing was accepted and charged, so a guest could occupy a site
// for weeks after the park shut. Arriving October 20 and leaving December 31, against a season
// ending October 31, was a booking the site would take money for.
//
// The unit is the NIGHT, not the calendar day, and the difference is load-bearing at the
// boundary. A stay occupies the nights arrival … departure-1; the departure day is a checkout,
// not an occupancy. So with a season ending October 31, arriving October 31 and leaving
// November 1 is exactly one night — October 31 — and must be ACCEPTED. Validating "through
// departure" instead would reject a guest checking out on the morning after the last open day,
// which is a normal booking every park takes.
//
// Pure: no database, no clock, no Date arithmetic beyond stepping a day at a time.
export function checkSeasonSpan(
  arrival: string,
  departure: string,
  settings: SeasonSettings | null | undefined
): BookabilityResult {
  // FAILS OPEN on an unreadable or unconfigured season, matching how a missing season has always
  // behaved and how checkHorizon treats an unusable window. A park whose season text is garbage
  // keeps taking bookings rather than going dark on every date.
  //
  // That is only a safe default because the Settings page validates this text with
  // parseMonthDay on save and refuses to store what it cannot read — so unparseable season text
  // is caught when an owner types it, not silently months later. If that validation is ever
  // removed, this default becomes dangerous and must be revisited.
  if (isNightInSeason(arrival, settings) === null) return OK

  const nights = nightsBetween(arrival, departure)
  if (nights < 1) return OK // not a stay; checkBookability rejects the range on its own terms

  // After 366 nights every calendar day has been visited, so anything still unchecked can only
  // repeat a day already cleared. Bounds the loop against an absurd span without changing the
  // answer for any real one.
  const limit = Math.min(nights, 366)

  for (let i = 0; i < limit; i++) {
    const night = addDays(arrival, i)
    if (isNightInSeason(night, settings) === false) {
      return {
        bookable: false,
        reason: 'out-of-season',
        message: settings?.closed_season_message || DEFAULT_CLOSED_MESSAGE,
      }
    }
  }

  return OK
}

// ---------------------------------------------------------------------------
// Rule matching (shared with the availability route's min-stay resolution)
// ---------------------------------------------------------------------------

export type RuleTarget = { id: string; site_type?: string | null }

// How a min_stay_rules / pricing_rules row selects the sites it applies to: an explicit CSV of
// site ids, a single site id, or a whole site type — checked in that order of specificity. A
// rule that names none of them applies to nothing. Lifted from the availability route so the
// min-stay a guest was shown at search is resolved by the same code that enforces it at create.
export function ruleAppliesToSite(rule: any, site: RuleTarget): boolean {
  if (rule?.site_ids) return String(rule.site_ids).split(',').includes(site.id)
  if (rule?.site_id) return rule.site_id === site.id
  if (rule?.site_type) return rule.site_type === site.site_type
  return false
}

// The strictest minimum that applies. No rule means no minimum, expressed as 1 night.
export function resolveMinNights(rules: any[] | null | undefined, site: RuleTarget): number {
  const applicable = (rules || []).filter(r => ruleAppliesToSite(r, site))
  return applicable.length > 0 ? Math.max(...applicable.map(r => Number(r.min_nights) || 1)) : 1
}

// ---------------------------------------------------------------------------
// Date facts from the database, and the pure filter over them
// ---------------------------------------------------------------------------

export type DateFacts = {
  // A blocked_dates row with site_id NULL closes the whole park for that date.
  blockedAllSites: boolean
  blockedSiteIds: Set<string>
  bookedSiteIds: Set<string>
}

// The two range queries the availability route has always run, in one place. Intentionally NOT
// narrowed to a single site even when the caller only cares about one: a park-wide block is a
// row with site_id IS NULL, so a site-scoped query would have to be an OR against caller-
// supplied input, and the unscoped query is already bounded by the stay's own date range —
// at most one row per site. Keeping it as one query shape means the search and the create
// check read exactly the same rows.
export async function fetchDateFacts(
  supabase: SupabaseLike,
  arrival: string,
  departure: string
): Promise<DateFacts> {
  const [{ data: reservations }, { data: blockedDates }] = await Promise.all([
    supabase
      .from('reservations')
      .select('site_id')
      .neq('status', 'cancelled')
      .lt('arrival_date', departure)
      .gt('departure_date', arrival),
    supabase
      .from('blocked_dates')
      .select('site_id, date')
      .gte('date', arrival)
      .lt('date', departure),
  ])

  return {
    bookedSiteIds: new Set((reservations || []).map((r: any) => r.site_id)),
    blockedAllSites: (blockedDates || []).some((b: any) => !b.site_id),
    blockedSiteIds: new Set((blockedDates || []).filter((b: any) => b.site_id).map((b: any) => b.site_id)),
  }
}

// Pure. Whether one site is free of blocks and overlapping reservations, given the facts.
// The availability route runs this over every candidate site; /api/payment runs it over the
// one site being booked.
export function checkDateFacts(siteId: string, facts: DateFacts): BookabilityResult {
  if (facts.blockedAllSites || facts.blockedSiteIds.has(siteId)) {
    return {
      bookable: false,
      reason: 'blocked',
      message: 'Those dates are not available for booking. Please choose different dates or contact us.',
    }
  }

  if (facts.bookedSiteIds.has(siteId)) {
    return {
      bookable: false,
      reason: 'double-booked',
      message: 'Sorry, this site was just booked by someone else. Please select a different site.',
    }
  }

  return OK
}

// ---------------------------------------------------------------------------
// The chokepoint
// ---------------------------------------------------------------------------

// Everything this module reads out of the settings row: the season gate's three columns and the
// horizon's one. Callers that pass `settings` in must have selected all of them.
export type BookabilitySettings = SeasonSettings & HorizonSettings

export type BookabilityInput = {
  arrival: string
  departure: string
  siteId: string
  // Supplied by callers that already have them, fetched here otherwise. /api/payment passes
  // the site row it looks up anyway; nothing else currently has the settings to hand.
  settings?: BookabilitySettings | null
  site?: RuleTarget | null
  // YYYY-MM-DD. Only the horizon uses it. Defaulted below rather than required so every existing
  // caller keeps working unchanged; passed explicitly by the tests, which need to pin a date.
  today?: string
  // Staff override for the horizon, and ONLY the horizon.
  //
  // The public flow never sets it. /api/manual-booking sets it when an operator has explicitly
  // confirmed booking beyond the park's window — the phone call that starts "can I get a site
  // for next August?". The horizon is the park's own online-booking preference, so the park's own
  // staff being able to set it aside is the point of it being a preference rather than a rule.
  //
  // It does NOT and must not extend to anything else in this function. Season, blocked dates,
  // double-booking and min-stay are not preferences — an override there books a guest into an
  // occupied site or a closed campground.
  allowBeyondHorizon?: boolean
}

// Everything a set of dates must satisfy before a card may be charged for them: a real date
// range, inside the park's booking window, inside the season, not blocked, not already taken,
// and long enough for the site's minimum stay. Called by /api/payment BEFORE any Square request,
// so a rejection here means no charge was ever attempted.
//
// Also called by /api/manual-booking for the horizon only — see the note on that route about why
// the staff path is not yet on the full chain.
export async function checkBookability(
  supabase: SupabaseLike,
  input: BookabilityInput
): Promise<BookabilityResult> {
  const { arrival, departure, siteId } = input

  if (!arrival || !departure || !siteId) {
    return { bookable: false, reason: 'missing-dates', message: 'Please choose a site and your dates.' }
  }

  const nights = nightsBetween(arrival, departure)
  if (nights < 1) {
    return {
      bookable: false,
      reason: 'invalid-range',
      message: 'Your departure date must be after your arrival date.',
    }
  }

  let settings = input.settings
  if (settings === undefined) {
    const { data } = await supabase
      .from('settings')
      // NAMED COLUMNS, so max_advance_days must exist on the tenant before this ships. PostgREST
      // errors on a column it cannot find, and this read gates every booking on both routes — on
      // a tenant missing the column, that error stops all reservations, not just the horizon.
      // db/2026-08-17-booking-horizon.sql in resonation-admin runs first, everywhere.
      .select('season_start, season_end, closed_season_message, max_advance_days')
      .limit(1)
      .single()
    settings = data
  }

  // The horizon before the season, and both before any database round trip beyond the settings
  // read above. It is pure arithmetic on a value already in hand, and "we don't take bookings
  // that far out" is a more fundamental refusal than "we are closed that particular week" — a
  // guest looking at 2031 should be told about the window, not about next winter's closure.
  //
  // The server allows HORIZON_SERVER_SLACK_DAYS of slack because it has no park timezone; see the
  // constant. Skipped entirely when an operator has confirmed the override.
  if (!input.allowBeyondHorizon) {
    const today = input.today || new Date().toISOString().split('T')[0]
    const horizon = checkHorizon(arrival, settings, today, HORIZON_SERVER_SLACK_DAYS)
    if (!horizon.bookable) return horizon
  }

  // THE SPAN FIX. This passed `arrival` alone until now, which meant a stay beginning in season
  // and running past closing was accepted and CHARGED on the public path — the live hole this
  // change closes. Every night of the stay is checked; see checkSeasonSpan.
  //
  // No override exists here and none should: the public flow is a hard block. Waiving the season
  // is a staff-only act, handled at /api/manual-booking.
  const season = checkSeasonSpan(arrival, departure, settings)
  if (!season.bookable) return season

  const facts = await fetchDateFacts(supabase, arrival, departure)
  const dates = checkDateFacts(siteId, facts)
  if (!dates.bookable) return dates

  // Min-stay last: it needs the site's type, and there is no point paying for that lookup on a
  // booking already rejected above.
  let site = input.site
  if (site === undefined || site === null) {
    const { data } = await supabase.from('sites').select('id, site_type').eq('id', siteId).single()
    site = data
  }
  if (site) {
    const { data: minStayRules } = await supabase
      .from('min_stay_rules')
      .select('*')
      .eq('is_active', true)
      .lte('start_date', departure)
      .gte('end_date', arrival)

    const minNights = resolveMinNights(minStayRules, site)
    if (nights < minNights) {
      return {
        bookable: false,
        reason: 'min-stay',
        message: `This site requires a minimum stay of ${minNights} night${minNights === 1 ? '' : 's'} for these dates.`,
      }
    }
  }

  return OK
}
