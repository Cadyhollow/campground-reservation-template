import { createClient } from '@supabase/supabase-js'
import { NextRequest, NextResponse } from 'next/server'

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

function monthDayToISO(monthDay: string): string {
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

  if (settings?.season_start && settings?.season_end) {
    const arrivalDate = new Date(arrival + 'T12:00:00')
    const year = arrivalDate.getFullYear()
    const seasonStart = new Date(`${year}-${monthDayToISO(settings.season_start)}T00:00:00`)
    const seasonEnd = new Date(`${year}-${monthDayToISO(settings.season_end)}T23:59:59`)

    if (arrivalDate < seasonStart || arrivalDate > seasonEnd) {
      return NextResponse.json({
        sites: [],
        closed: true,
        closedMessage: settings.closed_season_message || 'We are closed for the season. We look forward to welcoming you back next year!',
        seasonStart: settings.season_start,
        seasonEnd: settings.season_end,
      })
    }
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

  const { data: reservations } = await supabase
    .from('reservations')
    .select('site_id')
    .neq('status', 'cancelled')
    .lt('arrival_date', departure)
    .gt('departure_date', arrival)

  const { data: blockedDates } = await supabase
    .from('blocked_dates')
    .select('site_id, date')
    .gte('date', arrival)
    .lt('date', departure)

  const bookedSiteIds = new Set(reservations?.map(r => r.site_id) || [])
  const blockedAllSites = blockedDates?.some(b => !b.site_id) || false
  const blockedSpecificSiteIds = new Set(
    blockedDates?.filter(b => b.site_id).map(b => b.site_id) || []
  )

  const availableSites = sites?.filter(site => {
    if (bookedSiteIds.has(site.id)) return false
    if (blockedAllSites) return false
    if (blockedSpecificSiteIds.has(site.id)) return false
    return true
  }) || []

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
    const applicableRules = pricingRules?.filter(rule => {
      if (rule.site_id) return rule.site_id === site.id
      if (rule.site_type) return rule.site_type === site.site_type
      return false
    }) || []

    const bestRule = applicableRules.sort((a, b) => b.priority - a.priority)[0]
    const nightlyRate = bestRule ? bestRule.nightly_rate : site.base_rate

    const applicableMinStay = minStayRules?.filter(rule => {
      if (rule.site_id) return rule.site_id === site.id
      if (rule.site_type) return rule.site_type === site.site_type
      return false
    }) || []

    const minStay = applicableMinStay.length > 0
      ? Math.max(...applicableMinStay.map(r => r.min_nights))
      : 1

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

  return NextResponse.json({ sites: sitesWithPricing, closed: false })
}