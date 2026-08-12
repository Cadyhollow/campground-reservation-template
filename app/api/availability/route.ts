import { createClient } from '@supabase/supabase-js'
import { NextRequest, NextResponse } from 'next/server'
import {
  checkSeason,
  fetchDateFacts,
  checkDateFacts,
  resolveMinNights,
  ruleAppliesToSite,
  DEFAULT_CLOSED_MESSAGE,
} from '@/lib/bookability'

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
    .select('season_start, season_end, closed_season_message')
    .limit(1)
    .single()

  // The season gate now lives in lib/bookability, so /api/payment applies the same one before
  // charging. The closed payload below is unchanged — search still answers with the park's
  // message and season dates rather than a bare error.
  if (!checkSeason(arrival, settings).bookable) {
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

    const applicableFees = (fees || []).filter(fee =>
      fee.applies_to === 'all' || fee.applies_to === site.site_type
    )

    const feeBreakdown = applicableFees.map(fee => ({
      name: fee.name,
      type: fee.type,
      amount: fee.type === 'percentage'
        ? parseFloat((basePrice * fee.amount / 100).toFixed(2))
        : parseFloat(fee.amount.toFixed(2)),
    }))

    const feesTotal = feeBreakdown.reduce((sum, f) => sum + f.amount, 0)

    return {
      ...site,
      nightly_rate: nightlyRate,
      base_price: basePrice,
      fees_breakdown: feeBreakdown,
      fees_total: feesTotal,
      total_price: parseFloat((basePrice + feesTotal).toFixed(2)),
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
