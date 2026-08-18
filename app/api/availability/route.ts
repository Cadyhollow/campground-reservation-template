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
import { summarizeSiteFees } from '@/lib/search-pricing'

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url)
  const arrival = searchParams.get('arrival')
  const departure = searchParams.get('departure')
  const siteType = searchParams.get('siteType')

  if (!arrival || !departure) {
    return NextResponse.json({ error: 'Missing dates' }, { status: 400 })
  }

  const { data: settings } = await supabase
    .from('settings')
    .select('season_start, season_end, closed_season_message, max_advance_days')
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
    const { breakdown: feeBreakdown, feesTotal } = summarizeSiteFees(fees, site.site_type, basePrice)

    return {
      ...site,
      nightly_rate: nightlyRate,
      // THE STAY ALONE — nightly × nights, no fees. This is the figure the booking quote treats
      // as the base it computes fees ON (see lib/booking-quote.ts:189), so anything else here
      // gets fees applied to fees. /api/payment derives exactly this, as
      // `serverNightlyRate * serverNights`.
      base_price: basePrice,
      fees_breakdown: feeBreakdown,
      fees_total: feesTotal,
      // DISPLAY ONLY — what the search card shows as "$X total" so the guest sees a number that
      // includes fees rather than a stay price that grows at checkout. Deliberately NOT the
      // quote's base: /book derives that from nightly_rate × nights for itself.
      total_price: basePrice + feesTotal,
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

  return NextResponse.json({ sites: sitesWithPricing, closed: false, siteCategories })
}
