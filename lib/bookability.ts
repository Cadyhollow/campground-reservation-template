// Whether a set of dates may be booked at all — the one place that decides it.
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
// year, because a season repeats annually. Lifted verbatim from the availability route so the
// parsing cannot drift; unchanged in behaviour, including the fallbacks.
export function monthDayToISO(monthDay: string): string {
  const months: Record<string, string> = {
    'January': '01', 'February': '02', 'March': '03', 'April': '04',
    'May': '05', 'June': '06', 'July': '07', 'August': '08',
    'September': '09', 'October': '10', 'November': '11', 'December': '12'
  }
  const parts = monthDay.trim().split(' ')
  const month = months[parts[0]] || '01'
  const day = String(parseInt(parts[1])).padStart(2, '0')
  return `${month}-${day}`
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

// The season gate, exactly as the availability route has always applied it.
//
// KNOWN LIMITATION, deliberately preserved: the season is built from the ARRIVAL's own
// calendar year, so a season that spans New Year (say November 1 → March 31) resolves to a
// start that is after its end and rejects every date in it. That bug predates this file and is
// not fixed here — PR 0 reuses the existing season semantics unchanged so that the search and
// the new create-side check agree on every date, right or wrong. Fixing the wrap here would
// make create ACCEPT dates search still rejects, which is the exact drift this module exists
// to prevent. The wrap fix rides with the seasonal-release PR, in this function, for both
// callers at once.
export function checkSeason(arrival: string, settings: SeasonSettings | null | undefined): BookabilityResult {
  // A park that has not configured a season has no closed period. Both bounds required, same
  // as the availability route: half a season is not a season.
  if (!settings?.season_start || !settings?.season_end) return OK

  // An unparseable arrival yields NaN, and every comparison below is then false, so it falls
  // through as "in season". Preserved rather than tightened: this is a faithful extraction of
  // the search-path gate, and checkBookability already rejects a malformed range outright
  // before it reaches here.
  const arrivalDate = new Date(arrival + 'T12:00:00')
  const year = arrivalDate.getFullYear()
  const seasonStart = new Date(`${year}-${monthDayToISO(settings.season_start)}T00:00:00`)
  const seasonEnd = new Date(`${year}-${monthDayToISO(settings.season_end)}T23:59:59`)

  if (arrivalDate < seasonStart || arrivalDate > seasonEnd) {
    return {
      bookable: false,
      reason: 'out-of-season',
      message: settings.closed_season_message || DEFAULT_CLOSED_MESSAGE,
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

export type BookabilityInput = {
  arrival: string
  departure: string
  siteId: string
  // Supplied by callers that already have them, fetched here otherwise. /api/payment passes
  // the site row it looks up anyway; nothing else currently has the settings to hand.
  settings?: SeasonSettings | null
  site?: RuleTarget | null
}

// Everything a set of dates must satisfy before a card may be charged for them: a real date
// range, inside the season, not blocked, not already taken, and long enough for the site's
// minimum stay. Called by /api/payment BEFORE any Square request, so a rejection here means
// no charge was ever attempted.
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
      .select('season_start, season_end, closed_season_message')
      .limit(1)
      .single()
    settings = data
  }

  const season = checkSeason(arrival, settings)
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
