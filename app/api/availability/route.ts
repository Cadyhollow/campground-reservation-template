import { createClient } from '@supabase/supabase-js'
import { NextRequest, NextResponse } from 'next/server'
import {
  checkSeasonSpan,
  checkHorizon,
  resolveMaxAdvanceDays,
  horizonLastArrival,
  fetchDateFacts,
  checkDateFacts,
  resolveMinNights,
  ruleAppliesToSite,
  HORIZON_SERVER_SLACK_DAYS,
  DEFAULT_CLOSED_MESSAGE,
} from '@/lib/bookability'
import { summarizeSiteFees, extraGuestFeeCents } from '@/lib/search-pricing'

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url)
  const arrival = searchParams.get('arrival')
  const departure = searchParams.get('departure')
  const siteType = searchParams.get('siteType')

  // The party the search form already collected. Used ONLY to price the card — the guest counts
  // that actually get charged are re-read from the request by /api/payment, which recomputes the
  // whole quote server-side. A crafted `?adults=99` therefore shows a bigger number to whoever
  // crafted it and changes nothing else.
  //
  // `null` when absent or unparseable, and resolved to the park's OWN base occupancy once settings
  // are in hand (below) so that a caller which omits them — an older client, a hand-typed URL —
  // gets the same "no extra guests" card it got before this existed. Defaulting to a hardcoded 2
  // would be wrong for any park whose base occupancy is not 2.
  const parseGuests = (raw: string | null): number | null => {
    if (raw === null || raw.trim() === '') return null
    const n = parseInt(raw, 10)
    return Number.isFinite(n) && n >= 0 ? n : null
  }
  const requestedAdults = parseGuests(searchParams.get('adults'))
  const requestedChildren = parseGuests(searchParams.get('children'))
  // Pets the guest says they are bringing, and whether it is a service animal. Display and
  // filtering only — /api/payment re-decides both before charging anything.
  const requestedPets = parseGuests(searchParams.get('pets')) ?? 0
  const isServiceAnimal = searchParams.get('serviceAnimal') === '1'

  if (!arrival || !departure) {
    return NextResponse.json({ error: 'Missing dates' }, { status: 400 })
  }

  // select('*'), NOT a named column list — and the reason changed with the pet feature.
  //
  // Naming columns was fine while every column named was in every tenant's table. The pet columns
  // are not: they are deliberately absent from live tenants, and PostgREST errors on a column it
  // cannot find, which would take the whole search down on every un-migrated park. With '*' a
  // missing column is simply absent from the row and the readers fall back to their defaults —
  // the same reasoning lib/settings-server.ts already records.
  //
  // Safe to widen here specifically because this row is used only inside this route. It is never
  // forwarded to the browser; only the derived figures below are.
  const { data: settings } = await supabase
    .from('settings')
    .select('*')
    .limit(1)
    .single()

  // The booking horizon, checked before the season for the same reason checkBookability does it
  // in that order: a guest searching 2031 needs to hear about the park's booking window, not
  // about next February's closure.
  //
  // Slack matches the create path exactly (HORIZON_SERVER_SLACK_DAYS). Search must never be
  // STRICTER than create — a date /api/payment would honour has to be findable, or the site
  // shows nothing available and then charges for it if the guest reaches /book by URL.
  const today = new Date().toISOString().split('T')[0]
  const horizon = checkHorizon(arrival, settings, today, HORIZON_SERVER_SLACK_DAYS)
  if (!horizon.bookable) {
    const maxDays = resolveMaxAdvanceDays(settings?.max_advance_days)
    return NextResponse.json({
      sites: [],
      closed: false,
      // A distinct flag, deliberately not reusing `closed`. "We are closed for the season" and
      // "that is further ahead than we take bookings" are different facts, and a guest told the
      // wrong one will either wait for a season that is already open or give up on a park that
      // would happily take them for a nearer date.
      outOfWindow: true,
      horizonMessage: horizon.message,
      // The TRUE last bookable date, not the slack-extended one — this is what the date picker
      // shows and what the guest is told.
      horizonMaxDate: maxDays === null ? null : horizonLastArrival(maxDays, today),
      horizonMaxDays: maxDays,
    })
  }

  // The season gate now lives in lib/bookability, so /api/payment applies the same one before
  // charging. The closed payload below is unchanged — search still answers with the park's
  // message and season dates rather than a bare error.
  // The SAME span rule the create path enforces, so a stay the search calls bookable is one
  // /api/payment will honour. Arrival-only here would advertise availability for a stay that runs
  // past closing and then refuse it at the charge.
  if (!checkSeasonSpan(arrival, departure, settings).bookable) {
    return NextResponse.json({
      sites: [],
      closed: true,
      closedMessage: settings?.closed_season_message || DEFAULT_CLOSED_MESSAGE,
      seasonStart: settings?.season_start,
      seasonEnd: settings?.season_end,
    })
  }

  let query = supabase
    .from('sites')
    .select('*')
    .eq('is_available', true)
    .order('display_order')

  if (siteType && siteType !== 'all') {
    query = query.eq('site_type', siteType)
  }

  // ── THE ONE-DIRECTIONAL PET FILTER ──────────────────────────────────────────────────────────
  //
  // A guest bringing pets sees ONLY pet-friendly sites. A guest bringing none sees everything —
  // the filter never runs in that direction, so marking a site pet-friendly never costs it a
  // booking from someone without a dog.
  //
  // A service animal is not a pet and is exempt: it may book any site, so no filter is applied.
  //
  // Guarded on pets_enabled, which is absent (falsy) on an un-migrated tenant — so `pet_friendly`
  // is never named in a query against a table that has no such column.
  const petFilterActive = !!settings?.pets_enabled && requestedPets > 0 && !isServiceAnimal
  if (petFilterActive) {
    query = query.eq('pet_friendly', true)
  }

  const { data: sites, error } = await query

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  // Same two range queries as before, and the same filter — now shared with /api/payment, so a
  // site the search hides as blocked or already booked is a site create refuses to charge for.
  const dateFacts = await fetchDateFacts(supabase, arrival, departure)

  const availableSites = sites?.filter(site => checkDateFacts(site.id, dateFacts).bookable) || []

  const { data: pricingRules } = await supabase
    .from('pricing_rules')
    .select('*')
    .eq('is_active', true)
    .lte('start_date', departure)
    .gte('end_date', arrival)

  const { data: minStayRules } = await supabase
    .from('min_stay_rules')
    .select('*')
    .eq('is_active', true)
    .lte('start_date', departure)
    .gte('end_date', arrival)

  const nights = Math.round(
    (new Date(departure).getTime() - new Date(arrival).getTime()) / (1000 * 60 * 60 * 24)
  )

  const { data: fees } = await supabase
    .from('fees')
    .select('*')
    .eq('is_active', true)

  // The extra-guest fee, once — it depends on the party and the nights, not on the site, so every
  // card carries the same figure. Omitted counts resolve to the park's base occupancy, which makes
  // this exactly 0.
  const adults = requestedAdults ?? (settings?.base_occupancy_adults ?? 2)
  const children = requestedChildren ?? (settings?.base_occupancy_children ?? 2)
  const extraGuestFee = extraGuestFeeCents(settings, adults, children, nights)

  const sitesWithPricing = availableSites.map(site => {
    const applicableRules = pricingRules?.filter(rule => ruleAppliesToSite(rule, site)) || []

    const bestRule = applicableRules.sort((a, b) => b.priority - a.priority)[0]
    const nightlyRate = bestRule ? bestRule.nightly_rate : site.base_rate

    // The minimum the guest is shown, resolved by the same function /api/payment enforces with.
    const minStay = resolveMinNights(minStayRules, site)

    const basePrice = nightlyRate * nights

    // Fee lines for the card, in INTEGER CENTS, with the same CSV `applies_to` matching the
    // booking quote uses. Both used to be wrong here and both were invisible until an owner added
    // a fee row — see lib/search-pricing.ts, which is where they are now unit-tested.
    //
    // The extra-guest fee is passed in because it belongs in the percentage fee BASE, not just in
    // the total — lib/booking-quote.ts:189 taxes `site.total_price + extraGuestFee`.
    const { breakdown: feeBreakdown, feesTotal, totalPrice } =
      summarizeSiteFees(fees, site.site_type, basePrice, extraGuestFee)

    return {
      ...site,
      nightly_rate: nightlyRate,
      // THE STAY ALONE — nightly × nights, no fees, no guests. This is the figure the booking
      // quote treats as the base it computes fees ON (see lib/booking-quote.ts:189), so anything
      // else here gets fees applied to fees. /api/payment derives exactly this, as
      // `serverNightlyRate * serverNights`.
      base_price: basePrice,
      fees_breakdown: feeBreakdown,
      fees_total: feesTotal,
      // What the party above base occupancy adds. Same for every card; surfaced per-site so the
      // results list can name it rather than letting the total silently jump.
      extra_guest_fee: extraGuestFee,
      // DISPLAY ONLY — stay + extra guests + fees, so the card shows the number the guest will
      // actually see at checkout. Deliberately NOT the quote's base: /book derives that from
      // nightly_rate × nights for itself.
      total_price: totalPrice,
      nights,
      min_stay: minStay,
      meets_min_stay: nights >= minStay,
    }
  })


  // Which categories each available site belongs to, for the results accordion.
  //
  // Security PR 7-1. The home page used to read `site_categories` itself with the publishable
  // key, right after this route answered — a second round trip, from the browser, keyed by the
  // ids this route had just handed it. It is the same read either way, so it belongs here, where
  // the sites came from, and under the locked-down schema the browser can no longer do it at all.
  // Named columns, and scoped to the sites actually being returned.
  const siteCategories: Record<string, number[]> = {}
  if (sitesWithPricing.length > 0) {
    const { data: links } = await supabase
      .from('site_categories')
      .select('site_id, category_id')
      .in('site_id', sitesWithPricing.map(s => s.id))
    for (const row of links || []) {
      if (!siteCategories[row.site_id]) siteCategories[row.site_id] = []
      siteCategories[row.site_id].push(row.category_id)
    }
  }

  // The park's pet policy, so the search page and /book can render the question, the limit and
  // the rules without a second round trip — and so a guest who filtered themselves down to
  // nothing is told WHY rather than seeing an empty list that reads as "we are full".
  const pets = settings?.pets_enabled
    ? {
        enabled: true,
        max: settings.pet_max || 0,
        rulesText: settings.pet_rules_text || '',
        requireAffirmation: !!settings.pet_rules_require_affirmation,
        serviceAnimalAllowed: settings.service_animal_allowed !== false,
        // True when the pet filter is the reason the list is empty. Distinct from `closed` and
        // from a genuinely full park.
        filteredToNothing: petFilterActive && sitesWithPricing.length === 0,
      }
    : { enabled: false }

  return NextResponse.json({ sites: sitesWithPricing, closed: false, siteCategories, pets })
}
