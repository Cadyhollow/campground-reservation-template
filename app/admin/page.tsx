'use client'
import { useEffect, useState } from 'react'
import { createBrowserSupabase } from '@/lib/supabase-browser'

// Security PR 7-1: the admin browser talks to Supabase as the LOGGED-IN USER, not as `anon`.
// Same publishable key, but it travels with the session cookie, so PostgREST runs these queries
// as `authenticated` and the role-gated RLS policies apply. Safe at module scope:
// createBrowserClient returns a singleton in the browser and a no-op cookie store during
// prerender.
const supabase = createBrowserSupabase()
import { ymd } from '@/lib/transactions'
import { planAtLeast, normalizePlan } from '@/lib/plan'
// The seasonal tracker keys off the caller's ROLE, not off the owner/staff view toggle — see the
// note at the banner. useRole fails closed (null until known, and null on error), so the banner
// stays hidden rather than flashing for someone who should not see it.
import { useRole } from '@/lib/use-role'
import { atLeast } from '@/lib/roles'
import Image from 'next/image'
import Link from 'next/link'
import {
  PlusCircleIcon, ShoppingBagIcon, CreditCardIcon,
  CalendarIcon, ClipboardDocumentListIcon, UsersIcon, BoltIcon, MapIcon,
  Cog6ToothIcon,
} from '@heroicons/react/24/outline'

type ArrivalGuest = {
  id: string
  guest_name: string
  arrival_date: string
  departure_date: string
  site_number: string
  site_type: string
  total_price: number
  amount_paid: number
  total_paid: number
  num_adults: number
  num_children: number
  addons: { name: string; quantity: number }[]
  checkedIn: boolean
  waiver_signed: boolean
  guest_email: string
  early_checkin: boolean
  late_checkout: boolean
}

import WaiverActions from './reservations/WaiverActions'
import TodoPanel from './TodoPanel'

export default function AdminDashboard() {
  const [settings, setSettings] = useState<any>(null)
  const [stats, setStats] = useState({
    totalThisMonth: 0,
    arrivalsToday: 0,
    departuresToday: 0,
    revenueThisMonth: 0,
    surchargeThisMonth: 0,
  })
  const [recentReservations, setRecentReservations] = useState<any[]>([])
  const [upcomingReservations, setUpcomingReservations] = useState<any[]>([])
  const [totalActiveSites, setTotalActiveSites] = useState(0)
  const [occupancyTonight, setOccupancyTonight] = useState({ arriving: 0, occupied: 0, departing: 0 })
  const [plan, setPlan] = useState<string>('trailhead') // fail closed — lowest tier until settings load
  const [arrivalsToday, setArrivalsToday] = useState<ArrivalGuest[]>([])
  const [arrivalsDate, setArrivalsDate] = useState<string>(() => ymd(new Date()))
  const [loading, setLoading] = useState(true)
  const [dashboardView, setDashboardView] = useState<'owner'|'staff'>('staff')
  const { role } = useRole()
  const [slideOut, setSlideOut] = useState<'arrivals'|'departures'|null>(null)
  const [departuresToday, setDeparturesToday] = useState<any[]>([])
  const [walkinCountToday, setWalkinCountToday] = useState(0)
  const [sitesAvailableTonight, setSitesAvailableTonight] = useState(0)
  const [seasonalStats, setSeasonalStats] = useState<{ season_year: number; total: number; signed: number; unsigned: number } | null>(null)
  // Whether this tenant has the `tasks` table, as reported by TodoPanel once it knows. Drives the
  // LAYOUT only: on a tenant that never ran the To-Do migration the panel renders nothing, and the
  // quick-action buttons below must take the full width back rather than sit in two-thirds of a
  // row with an empty column beside them.
  const [todoAvailable, setTodoAvailable] = useState(false)

  useEffect(() => {
    const stored = localStorage.getItem('resonation_dashboard_view')
    if (stored === 'owner' || stored === 'staff') setDashboardView(stored as 'owner'|'staff')
    const handler = () => {
      const v = localStorage.getItem('resonation_dashboard_view')
      if (v === 'owner' || v === 'staff') setDashboardView(v as 'owner'|'staff')
    }
    window.addEventListener('dashboardViewChanged', handler)
    return () => window.removeEventListener('dashboardViewChanged', handler)
  }, [])

  useEffect(() => { fetchAll() }, [])
  useEffect(() => { fetchArrivalsFor(arrivalsDate) }, [arrivalsDate])

  async function fetchAll() {
    // Owner seasonal-contracts card (summit only). Fired here so it runs in PARALLEL
    // with the main dashboard load below and never blocks it — no await. 403s cheaply
    // on non-summit; the card renders only for owner + summit once this resolves.
    fetch('/api/seasonals/unsigned-count')
      .then(r => (r.ok ? r.json() : null))
      .then(d => { if (d) setSeasonalStats(d) })
      .catch(() => {})

    const ymd = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
    const now = new Date()
    const today = ymd(now)
    const firstOfMonth = ymd(new Date(now.getFullYear(), now.getMonth(), 1))
    const lastOfMonth = ymd(new Date(now.getFullYear(), now.getMonth() + 1, 0))

    const [
      { data: settingsData },
      { data: resData },
      { data: todayArrivals },
      { data: todayDepartures },
      { data: monthData },
      { data: upcomingData },
      { count: occupiedTonightCount },
    ] = await Promise.all([
      supabase.from('settings').select('*').limit(1).single(),
      supabase.from('reservations')
        .select('*, sites(site_number, site_type)')
        .neq('status', 'cancelled')
        .order('created_at', { ascending: false })
        .limit(50),
      supabase.from('reservations')
        .select('*, sites(site_number, site_type)')
        .eq('arrival_date', today)
        .neq('status', 'cancelled'),
      supabase.from('reservations')
        .select('*, sites(site_number, site_type)')
        .eq('departure_date', today)
        .neq('status', 'cancelled'),
      supabase.from('reservations')
        .select('id, amount_paid, arrival_date')
        .gte('arrival_date', firstOfMonth)
        .lte('arrival_date', lastOfMonth)
        .neq('status', 'cancelled'),
      supabase.from('reservations')
        .select('*, sites(site_number, site_type)')
        .gte('arrival_date', today)
        .neq('status', 'cancelled')
        .order('arrival_date', { ascending: true })
        .limit(5),
      supabase.from('reservations')
        .select('id', { count: 'exact', head: true })
        .lt('arrival_date', today)
        .gt('departure_date', today)
        .neq('status', 'cancelled'),
    ])

    setDeparturesToday(todayDepartures || [])
    if (settingsData) {
      setSettings(settingsData)
      setPlan(normalizePlan(settingsData.plan))
    }

    if (resData) {
      // Fold folio-collected payments into dashboard figures so removing the
      // webhook amount_paid mirror doesn't drop folio money. Single source of
      // truth: amount_paid (booking) + folio_payments (folio/walk-in/POS),
      // counted net of card surcharge to match the arrivals bridge.
      const foldIds = Array.from(new Set((upcomingData || []).map((r: any) => r.id)))
      const folioPaidByRes: Record<string, number> = {}
      if (foldIds.length > 0) {
        const { data: dashFolios } = await supabase
          .from('folios')
          .select('id, reservation_id')
          .in('reservation_id', foldIds)
        const dashFolioList = dashFolios || []
        const dashFolioIds = dashFolioList.map((f: any) => f.id)
        if (dashFolioIds.length > 0) {
          const { data: dashPmts } = await supabase
            .from('folio_payments')
            // Includes refund rows: a booking refund is now a negative folio row and
            // reservations.amount_paid no longer shrinks, so excluding them would show the guest as
            // having paid money that was handed back.
            .select('folio_id, amount, surcharge_amount, status')
            .in('folio_id', dashFolioIds)
            .in('status', ['completed', 'refunded', 'partially_refunded'])
          const paidByFolio: Record<string, number> = {}
          for (const pm of (dashPmts || [])) {
            paidByFolio[pm.folio_id] = (paidByFolio[pm.folio_id] || 0) + (pm.amount - (pm.surcharge_amount || 0))
          }
          for (const f of dashFolioList) {
            if (f.reservation_id) folioPaidByRes[f.reservation_id] = (folioPaidByRes[f.reservation_id] || 0) + (paidByFolio[f.id] || 0)
          }
        }
      }
      const thisMonth = monthData || []
      // Revenue This Month = money received this month to date, across everything:
      // booking payments + folio payments (walk-in / POS / seasonal / electric).
      //
      // The two legs are dated differently, which is worth being precise about because
      // the earlier wording ("money actually RECEIVED") implied a payment timestamp the
      // booking leg does not have. Folio payments carry a real paid_at. Reservations do
      // not: there is no paid_at on the row, so the booking leg is dated by created_at.
      //
      // That is a proxy, but a close one — every path that writes amount_paid does so in
      // the request that creates the reservation (/api/payment when the camper pays
      // online, /api/manual-booking at the desk), and the owner wizard writes
      // amount_paid: 0 and puts its money on the folio, where paid_at is real. So
      // created_at IS the payment moment for effectively the whole booking leg.
      //
      // Known exception, currently unexercised: editing amount_paid on an existing
      // reservation. A reservation-leg refund is NOT an exception any more — since 146ce86
      // /api/reservation-refund leaves amount_paid untouched and records a dated negative
      // row on the folio, so the reduction lands in the month the money went back.
      //
      // GROSS of the card surcharge, by decision: the surcharge is money in, and the Square
      // processing fee that offsets it is an expense reconciled outside this system. It used
      // to be netted out of both legs, which understated revenue.
      //
      // The surcharge lives in two places and both count, or the figure would be gross for
      // desk payments and net for online ones: folio_payments.surcharge_amount for money
      // taken on a folio, and reservations.surcharge_amount for money taken by /api/payment
      // at booking (amount_paid there is cash-canonical, i.e. already surcharge-free).
      const monthStartISO = firstOfMonth + 'T00:00:00'
      const [{ data: monthBookingPmts }, { data: monthFolioPmts }] = await Promise.all([
        // Cancelled bookings are NOT filtered out — the negative refund row nets against
        // them, exactly as it does for the folio payments below. Excluding them
        // double-counted the reduction: a cancelled $500 booking refunded $450 lost the
        // +$500 here AND still landed the −$450 refund row, reading as −$450 revenue
        // instead of the +$50 retained fee. Cancelled without a refund correctly stays as
        // revenue, because the business kept the money.
        supabase.from('reservations')
          .select('amount_paid, surcharge_amount')
          .gt('amount_paid', 0)
          .gte('created_at', monthStartISO),
        // Refund rows are counted, not filtered out. /api/refund leaves the original payment in
        // place, flips its status to 'refunded' or 'partially_refunded', and inserts a negative
        // row. Counting only 'completed' therefore dropped BOTH rows, so a partial refund erased
        // the whole original payment from revenue instead of just the part handed back — the kept
        // portion vanished. Counting all three lets them net: an untouched payment stands alone, a
        // full refund cancels to zero, a partial refund leaves exactly what was kept.
        // Listed explicitly rather than 'not voided' so any future status is excluded until
        // someone decides it counts. 'voided' stays out — a voided payment never happened.
        supabase.from('folio_payments')
          .select('amount, surcharge_amount')
          .in('status', ['completed', 'refunded', 'partially_refunded'])
          .gte('paid_at', monthStartISO),
      ])
      const monthSurcharge =
        (monthBookingPmts || []).reduce((s: number, r: any) => s + (r.surcharge_amount || 0), 0)
        + (monthFolioPmts || []).reduce((s: number, p: any) => s + (p.surcharge_amount || 0), 0)
      const revenue = (monthBookingPmts || []).reduce((s: number, r: any) => s + (r.amount_paid || 0), 0)
        + (monthFolioPmts || []).reduce((s: number, p: any) => s + (p.amount || 0), 0)
        + (monthBookingPmts || []).reduce((s: number, r: any) => s + (r.surcharge_amount || 0), 0)

      setStats({
        totalThisMonth: thisMonth.length,
        arrivalsToday: (todayArrivals || []).length,
        departuresToday: (todayDepartures || []).length,
        revenueThisMonth: revenue,
        surchargeThisMonth: monthSurcharge,
      })
      setRecentReservations(resData.slice(0, 8))
      const upcoming = (upcomingData || [])
        .map((r: any) => ({ ...r, total_paid: (r.amount_paid || 0) + (folioPaidByRes[r.id] || 0) }))
      setUpcomingReservations(upcoming)
      setOccupancyTonight({
        arriving: (todayArrivals || []).length,
        occupied: occupiedTonightCount || 0,
        departing: (todayDepartures || []).length,
      })
    }
    // ── NIGHTLY INVENTORY, WHICH IS NOT THE SAME AS "EVERY ACTIVE SITE" ───────────────────
    //
    // ⚠ SEASONAL SITES ARE NOT NIGHTLY INVENTORY. A site sold for the season is occupied by that
    // camper all season; it is not a room that can be let tonight. Counting it made both the
    // occupancy denominator and "Sites Available Tonight" overstate what the park has to sell.
    //
    // ⚠ FILTERED IN JS, NOT IN THE QUERY, AND DELIBERATELY. PostgREST fails a query that NAMES a
    // column the table does not have — so `.not('is_seasonal_site','is',true)`, or even selecting
    // that column, would break the dashboard outright on a park that has not run
    // db/migrations/2026-08-30-seasonal-site-flag.sql. `select('*')` plus a property read is safe
    // on every park: the field is simply `undefined` there, and `!== true` leaves it counted,
    // which is exactly today's behaviour for a park with no seasonal sites to exclude.
    // This is the same reasoning app/admin/sites/page.tsx uses to detect the column.
    //
    // `!== true` also covers `false` and `null` alike.
    const { data: activeSitesRaw } = await supabase
      .from('sites')
      .select('*')
      .eq('is_available', true)
    // Typed narrowly rather than `any`: the flag is optional precisely because a park that has
    // not run the migration does not have it.
    const nightlySites = ((activeSitesRaw || []) as { is_seasonal_site?: boolean | null }[])
      .filter(x => x.is_seasonal_site !== true)
    setTotalActiveSites(nightlySites.length)

    // ── WALK-IN SALES TODAY: THE PARK'S DAY, NOT THE UTC DAY ──────────────────────────────
    //
    // WHAT IS COUNTED IS UNCHANGED — every completed folio payment for the day, bill payments
    // included. Only the WINDOW was wrong.
    //
    // ⚠ A TIMESTAMP STRING WITH NO OFFSET IS READ AS UTC. `today` is the correct LOCAL date, but
    // `today + 'T00:00:00'` has no zone, so Postgres compared against a UTC day. A payment taken
    // at 8:40 PM local is stored as the next day in UTC, so it counted as "today" the evening
    // before — the phantom +1 an owner sees on a quiet morning.
    //
    // Fixed by building the local day and converting to real UTC instants, so the boundary is the
    // park's midnight rather than Greenwich's. `.toISOString()` carries the offset.
    //
    // This uses the VIEWER'S timezone — the same convention ymd() already uses on this page and
    // the transactions list uses — so on-site staff get the right day with no new setting and no
    // migration. A park whose staff view from another timezone would need a per-park timezone
    // setting; that is a larger change and deliberately not made here.
    const dayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0)
    const dayEnd = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999)
    const { count: walkinCount } = await supabase
      .from('folio_payments')
      .select('id', { count: 'exact', head: true })
      .eq('status', 'completed')
      .gte('paid_at', dayStart.toISOString())
      .lte('paid_at', dayEnd.toISOString())
    setWalkinCountToday(walkinCount || 0)

    // Sites available tonight — the same nightly inventory counted above, so the two figures
    // cannot disagree, and one query rather than two.
    const { count: occupiedCount } = await supabase
      .from('reservations')
      .select('id', { count: 'exact', head: true })
      .neq('status', 'cancelled')
      .lte('arrival_date', today)
      .gte('departure_date', today)
    // Seasonal campers hold CONTRACTS, not nightly reservations, so nothing here double-counts
    // them: they are out of `nightlySites` and were never in `occupiedCount`.
    setSitesAvailableTonight(Math.max(0, nightlySites.length - (occupiedCount || 0)))

    setLoading(false)
  }

  async function fetchArrivalsFor(dateStr: string) {
    const { data: dayArrivals } = await supabase
      .from('reservations')
      .select('*, sites(site_number, site_type)')
      .eq('arrival_date', dateStr)
      .neq('status', 'cancelled')

    if (!dayArrivals || dayArrivals.length === 0) { setArrivalsToday([]); return }

    const ids = dayArrivals.map((r: any) => r.id)
    const { data: addonData } = await supabase
      .from('reservation_addons')
      .select('reservation_id, addon_id, quantity')
      .in('reservation_id', ids)

    const addonIds = [...new Set(addonData?.map(r => r.addon_id) || [])]
    const { data: addonNames } = addonIds.length > 0
      ? await supabase.from('addons').select('id, name').in('id', addonIds)
      : { data: [] }

    const nameMap: Record<string, string> = {}
    addonNames?.forEach((a: any) => { nameMap[a.id] = a.name })

    const addonMap: Record<string, { name: string; quantity: number }[]> = {}
    addonData?.forEach((row: any) => {
      if (!addonMap[row.reservation_id]) addonMap[row.reservation_id] = []
      addonMap[row.reservation_id].push({ name: nameMap[row.addon_id] || 'Add-on', quantity: row.quantity })
    })

    // Fold in folio-collected payments so "Paid" reflects BOTH sources.
    // Display-only: never written back to amount_paid (would double-count in reports).
    const arrFolioPaidByRes: Record<string, number> = {}
    const { data: arrFolios } = await supabase
      .from('folios')
      .select('id, reservation_id')
      .in('reservation_id', ids)
    const arrFolioList = arrFolios || []
    const arrFolioIds = arrFolioList.map((f: any) => f.id)
    if (arrFolioIds.length > 0) {
      const { data: arrPmts } = await supabase
        .from('folio_payments')
        // Includes refund rows: a booking refund is now a negative folio row and
        // reservations.amount_paid no longer shrinks, so excluding them would show the guest as
        // having paid money that was handed back.
        .select('folio_id, amount, surcharge_amount, status')
        .in('folio_id', arrFolioIds)
        .in('status', ['completed', 'refunded', 'partially_refunded'])
      const arrPaidByFolio: Record<string, number> = {}
      for (const pm of (arrPmts || [])) {
        arrPaidByFolio[pm.folio_id] = (arrPaidByFolio[pm.folio_id] || 0) + (pm.amount - (pm.surcharge_amount || 0))
      }
      for (const f of arrFolioList) {
        if (f.reservation_id) arrFolioPaidByRes[f.reservation_id] = (arrFolioPaidByRes[f.reservation_id] || 0) + (arrPaidByFolio[f.id] || 0)
      }
    }
    setArrivalsToday(dayArrivals.map((r: any) => ({
      id: r.id,
      guest_name: r.guest_name,
      arrival_date: r.arrival_date,
      departure_date: r.departure_date,
      site_number: r.sites?.site_number || '—',
      site_type: r.sites?.site_type || '',
      total_price: r.total_price,
      amount_paid: r.amount_paid,
      total_paid: (r.amount_paid || 0) + (arrFolioPaidByRes[r.id] || 0),
      num_adults: r.num_adults,
      num_children: r.num_children,
      addons: addonMap[r.id] || [],
      checkedIn: r.checked_in || false,
      waiver_signed: r.waiver_signed || false,
      guest_email: r.guest_email || '',
      early_checkin: r.early_checkin || false,
      late_checkout: r.late_checkout || false,
    })))
  }

  async function toggleCheckIn(id: string) {
    const guest = arrivalsToday.find(g => g.id === id)
    if (!guest) return
    const newValue = !guest.checkedIn
    setArrivalsToday(prev => prev.map(g => g.id === id ? { ...g, checkedIn: newValue } : g))
    await supabase.from('reservations').update({ checked_in: newValue }).eq('id', id)
  }

  const logoShapeClass =
    settings?.logo_shape === 'circle' ? 'rounded-full' :
    settings?.logo_shape === 'rounded' ? 'rounded-xl' :
    settings?.logo_shape === 'square' ? 'rounded-none' :
    'rounded-none'

  const siteTypeLabel = (type: string) =>
    ({ rv_site: 'RV Site', cabin: 'Cabin', tent: 'Tent Site', yurt: 'Yurt', tiny_home: 'Tiny Home', lodge: 'Lodge', glamping: 'Glamping', treehouse: 'Treehouse' }[type] || type)

  const statusColor = (status: string) =>
    ({ confirmed: 'bg-green-100 text-green-800', manual: 'bg-purple-100 text-purple-800', pending: 'bg-yellow-100 text-yellow-800' }[status] || 'bg-gray-100 text-gray-800')

  if (loading) return (
    <div className="flex items-center justify-center h-64">
      <p className="text-gray-500">Loading dashboard...</p>
    </div>
  )

  const checkedInCount = arrivalsToday.filter(g => g.checkedIn).length
  const todayYmd = ymd(new Date())

  return (
    <div className="p-6 max-w-5xl mx-auto">

      {/* Park header */}
      <div className="flex items-center gap-4 mb-8">
        {settings?.logo_url && (
          <div className={`w-16 h-16 overflow-hidden flex items-center justify-center shrink-0 ${logoShapeClass}`}>
            <Image
              src={settings.logo_url}
              alt={settings?.park_name || 'Campground'}
              width={64}
              height={64}
              className="object-contain w-full h-full"
              priority
            />
          </div>
        )}
        <div>
          <h1 className="text-2xl font-bold text-gray-900">{settings?.park_name || 'Campground'}</h1>
          <p className="text-sm text-gray-500">{settings?.park_location || ''} · Admin Dashboard</p>
          <p className="text-sm font-semibold text-gray-700 mt-0.5">{new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })}</p>
        </div>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-8">
        {/* Arrivals — always shown, clickable */}
        <div onClick={()=>setSlideOut('arrivals')}
          className="rounded-xl border p-4 shadow-sm cursor-pointer hover:shadow-md transition-all"
          style={{background:'#f0fdfa',borderColor:'#99f6e4'}}>
          <p className="text-xs font-semibold mb-1" style={{color:'#0f766e'}}>Arrivals Today</p>
          <p className="text-3xl font-bold" style={{color:'#0f766e'}}>{stats.arrivalsToday}</p>
          <p className="text-xs mt-1" style={{color:'#5eead4'}}>Tap to view list →</p>
        </div>
        {/* Departures — always shown, clickable */}
        <div onClick={()=>setSlideOut('departures')}
          className="rounded-xl border p-4 shadow-sm cursor-pointer hover:shadow-md transition-all"
          style={{background:'#fffbeb',borderColor:'#fde68a'}}>
          <p className="text-xs font-semibold mb-1" style={{color:'#92400e'}}>Departures Today</p>
          <p className="text-3xl font-bold" style={{color:'#92400e'}}>{stats.departuresToday}</p>
          <p className="text-xs mt-1" style={{color:'#fbbf24'}}>Tap to view list →</p>
        </div>
        {/* Card 3 — owner vs staff */}
        {dashboardView === 'owner' ? (
          <div className="rounded-xl border p-4 shadow-sm" style={{background:'#eef2ff',borderColor:'#c7d2fe'}}>
            <p className="text-xs font-semibold mb-1" style={{color:'#3730a3'}}>Reservations This Month</p>
            <p className="text-3xl font-bold" style={{color:'#3730a3'}}>{stats.totalThisMonth}</p>
          </div>
        ) : (
          <div className="rounded-xl border p-4 shadow-sm" style={{background:'#eff6ff',borderColor:'#bfdbfe'}}>
            <p className="text-xs font-semibold mb-1" style={{color:'#1e40af'}}>Sites Available Tonight</p>
            <p className="text-3xl font-bold" style={{color:'#1e40af'}}>{sitesAvailableTonight}</p>
          </div>
        )}
        {/* Card 4 — owner vs staff */}
        {dashboardView === 'owner' ? (
          <div className="rounded-xl border p-4 shadow-sm" style={{background:'#f0fdf4',borderColor:'#bbf7d0'}}>
            <p className="text-xs font-semibold mb-1" style={{color:'#14532d'}}>Revenue This Month</p>
            <p className="text-3xl font-bold" style={{color:'#14532d'}}>${(stats.revenueThisMonth / 100).toLocaleString('en-US', { minimumFractionDigits: 0 })}</p>
            {/* Said "net of card fees" while the figure was surcharge-net. The figure is now
                gross, so the surcharge is called out as a component of it — not an addition. */}
            <p className="text-xs mt-1" style={{color:'#16a34a'}}>
              collected this month
              {stats.surchargeThisMonth > 0 && ` · includes $${(stats.surchargeThisMonth / 100).toFixed(2)} in transaction fees`}
            </p>
          </div>
        ) : (
          <div className="rounded-xl border p-4 shadow-sm" style={{background:'#faf5ff',borderColor:'#e9d5ff'}}>
            <p className="text-xs font-semibold mb-1" style={{color:'#581c87'}}>Walk-In Sales Today</p>
            <p className="text-3xl font-bold" style={{color:'#581c87'}}>{walkinCountToday}</p>
          </div>
        )}
      </div>

      {/* Two-column row: everything that was here before on the LEFT, the shared To-Do board on
          the RIGHT. Nothing below is restyled or removed — the seasonal banner and the quick-link
          grid are exactly as they were, only nested one level deeper.

          `items-start` so the two columns size independently: the To-Do panel scrolls inside its
          own fixed height and must not stretch the left column, and the left column must not
          stretch the panel. On narrow screens (below `lg`) this collapses to one column and the
          board stacks underneath the buttons, which is the right priority order on a phone. */}
      <div className={`grid gap-6 items-start mb-8 ${todoAvailable ? 'grid-cols-1 lg:grid-cols-12' : 'grid-cols-1'}`}>
        <div className={todoAvailable ? 'lg:col-span-7' : ''}>

      {/* Owner-only seasonal contracts card — summit-gated. Hidden for staff view,
          non-summit plans, and when there are no seasonal campers. */}
      {/* Shown to MANAGERS as well as owners (decided 2026-08-19). Managers can now do everything
          with a seasonal contract — create, send, chase, sign — so they are the people who would
          act on "12 of 49 unsigned"; an owner-only banner told the one person who mostly would
          not. `atLeast` rather than an equality check, so owners keep seeing it.

          `dashboardView` is a display toggle, not a permission — it is how an owner chooses to
          look at the staff view — so the ROLE is what this keys off. The screen it links to is
          manager-gated, and a staff member seeing a link they cannot open would be worse than not
          seeing the banner. */}
      {atLeast(role, 'manager') && planAtLeast(plan, 'summit') && seasonalStats && seasonalStats.total > 0 && (
        <Link href="/admin/seasonals" className="block mb-8">
          <div className="rounded-xl border p-4 shadow-sm hover:shadow-md transition-all flex items-center justify-between"
            style={{ background: seasonalStats.unsigned > 0 ? '#fffbeb' : '#f0fdf4', borderColor: seasonalStats.unsigned > 0 ? '#fde68a' : '#bbf7d0' }}>
            <div>
              <p className="text-xs font-semibold mb-1" style={{ color: seasonalStats.unsigned > 0 ? '#92400e' : '#14532d' }}>
                Seasonal Contracts · {seasonalStats.season_year}
              </p>
              {seasonalStats.unsigned > 0 ? (
                <p className="text-2xl font-bold" style={{ color: '#92400e' }}>
                  {seasonalStats.unsigned} <span className="text-base font-semibold">of {seasonalStats.total} unsigned</span>
                </p>
              ) : (
                <p className="text-2xl font-bold" style={{ color: '#14532d' }}>All {seasonalStats.total} signed 🎉</p>
              )}
            </div>
            <span className="text-sm font-semibold" style={{ color: seasonalStats.unsigned > 0 ? '#b45309' : '#15803d' }}>Review →</span>
          </div>
        </Link>
      )}

      {/* Quick links — color-coded by task type (money → lookup → admin), one soft
          family extended from the info tiles, heroicons, fixed placement so staff
          learn color + position. */}
      <div className={`grid grid-cols-2 md:grid-cols-4 gap-4 md:gap-5 mb-8 ${todoAvailable ? 'lg:grid-cols-3' : ''}`}>
        {[
          // Everyday money — warm hues, most prominent (first)
          { label: 'New Reservation', href: '/admin/new-reservation', Icon: PlusCircleIcon, bg: '#dcfce7', border: '#86efac', text: '#15803d' },
          ...(settings?.pos_enabled ? [{ label: 'Walk-Up Sale', href: '/admin/folio/new', Icon: ShoppingBagIcon, bg: '#ffedd5', border: '#fdba74', text: '#c2410c' }] : []),
          { label: 'Take a Payment', href: '/admin/guests?mode=payment', Icon: CreditCardIcon, bg: '#ffe4e6', border: '#fda4af', text: '#be123c' },
          // Lookup — cooler hues
          { label: 'Calendar', href: '/admin/calendar', Icon: CalendarIcon, bg: '#e0f2fe', border: '#7dd3fc', text: '#0369a1' },
          { label: 'Reservations', href: '/admin/reservations', Icon: ClipboardDocumentListIcon, bg: '#e0e7ff', border: '#a5b4fc', text: '#4338ca' },
          { label: 'Guest Directory', href: '/admin/guests', Icon: UsersIcon, bg: '#ccfbf1', border: '#5eead4', text: '#0f766e' },
          ...(planAtLeast(plan, 'summit') ? [{ label: 'Electric Bills', href: '/admin/electric-billing', Icon: BoltIcon, bg: '#fef9c3', border: '#fde047', text: '#a16207' }] : []),
          ...(settings && planAtLeast(plan, 'ridgeline') ? [{ label: 'Park Map', href: '/admin/map', Icon: MapIcon, bg: '#f3e8ff', border: '#d8b4fe', text: '#7e22ce' }] : []),
          // Admin — muted, tucked last
          { label: 'Settings', href: '/admin/settings', Icon: Cog6ToothIcon, bg: '#f1f5f9', border: '#cbd5e1', text: '#475569' },
        ].map(link => (
          <Link key={link.href} href={link.href}
            className="rounded-2xl border p-5 shadow-sm hover:shadow-md transition-shadow flex flex-col gap-2.5"
            style={{ background: link.bg, borderColor: link.border, color: link.text }}>
            <link.Icon className="w-8 h-8" aria-hidden="true" />
            <p className="text-base font-bold" style={{ color: link.text }}>{link.label}</p>
          </Link>
        ))}
      </div>

        </div>

        {/* RIGHT: the shared To-Do board. Renders null — and reports so — on any tenant that has
            not run the tasks migration, which is every tenant until its owner asks for the
            feature. Admin only; there is no guest-facing counterpart. */}
        <div className={todoAvailable ? 'lg:col-span-5' : ''}>
          <TodoPanel onAvailability={setTodoAvailable} />
        </div>
      </div>

      {/* Today's Check-In List */}
      <div className="bg-white rounded-xl border border-gray-100 shadow-sm mb-8">
        <div className="flex flex-wrap items-center justify-between gap-3 px-6 py-4 border-b border-gray-100">
          <div>
            <h2 className="text-base font-semibold text-gray-900">
              {arrivalsDate === todayYmd
                ? "Today's Arrivals"
                : `Arrivals — ${new Date(arrivalsDate + 'T12:00:00').toLocaleDateString('en-US', { month: 'long', day: 'numeric' })}`}
            </h2>
            <p className="text-xs text-gray-500 mt-0.5">
              {arrivalsToday.length === 0
                ? 'No arrivals'
                : checkedInCount === arrivalsToday.length
                ? `✓ All ${arrivalsToday.length} checked in`
                : `${checkedInCount} of ${arrivalsToday.length} checked in · ${arrivalsToday.length - checkedInCount} remaining`}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <input type="date" value={arrivalsDate}
              onChange={e => e.target.value && setArrivalsDate(e.target.value)}
              className="border border-gray-200 rounded-lg px-2 py-1.5 text-sm" />
            {arrivalsDate !== todayYmd && (
              <button onClick={() => setArrivalsDate(todayYmd)}
                className="text-xs font-semibold px-2.5 py-1.5 rounded-lg border transition-colors"
                style={{ background: '#f0fdfa', color: '#0f766e', borderColor: '#99f6e4' }}>
                Today
              </button>
            )}
          </div>
        </div>

        {arrivalsToday.length === 0 ? (
          <p className="text-gray-400 text-sm text-center py-8">No arrivals scheduled for this date.</p>
        ) : (
          <div className="divide-y divide-gray-50">
            {arrivalsToday.map(guest => {
              const balance = guest.total_price - (guest.total_paid ?? guest.amount_paid)
              const paidInFull = balance <= 0
              const nights = Math.round((new Date(guest.departure_date).getTime() - new Date(guest.arrival_date).getTime()) / 86400000)
              return (
                <div
                  key={guest.id}
                  className={`px-6 py-4 transition-colors ${guest.checkedIn ? 'bg-green-50' : 'bg-white'}`}
                >
                  <div className="flex items-start gap-4">
                    <button
                      onClick={() => toggleCheckIn(guest.id)}
                      className={`mt-1 w-6 h-6 rounded-full border-2 flex items-center justify-center shrink-0 transition-colors ${
                        guest.checkedIn
                          ? 'bg-green-600 border-green-600 text-white'
                          : 'border-gray-300 hover:border-green-400'
                      }`}
                    >
                      {guest.checkedIn && <span className="text-xs">✓</span>}
                    </button>

                    <div className="flex-1 min-w-0">
                      <div className="flex items-center justify-between gap-2">
                        <a href={`/admin/folio/${guest.id}`} className={`font-semibold text-gray-900 hover:text-green-700 hover:underline underline-offset-2 ${guest.checkedIn ? 'line-through text-gray-400' : ''}`}>
                          {guest.guest_name}
                        </a>
                        <span className="text-sm font-medium text-gray-700 shrink-0">
                          {siteTypeLabel(guest.site_type)} {guest.site_number}
                        </span>
                      </div>

                      <p className="text-xs text-gray-500 mt-0.5">
                        <span className="font-medium text-gray-600">
                          {new Date(guest.arrival_date + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                          {' → '}
                          {new Date(guest.departure_date + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                        </span>
                        {' · '}{nights} night{nights !== 1 ? 's' : ''}
                        {' · '}{guest.num_adults} adult{guest.num_adults !== 1 ? 's' : ''}
                        {guest.num_children > 0 ? `, ${guest.num_children} child${guest.num_children !== 1 ? 'ren' : ''}` : ''}
                      </p>
                      <WaiverActions reservationId={guest.id} guestEmail={guest.guest_email} signed={guest.waiver_signed} />

                      <div className="flex items-center gap-3 mt-2">
                        {paidInFull ? (
                          <span className="inline-flex items-center gap-1 text-xs bg-green-100 text-green-700 px-2 py-0.5 rounded-full font-medium">
                            ✓ Paid in full
                          </span>
                        ) : (
                          <div className="text-xs text-gray-600 bg-yellow-50 border border-yellow-100 rounded-lg px-2 py-1">
                            Total: <span className="font-medium">${(guest.total_price / 100).toFixed(2)}</span>
                            {' · '}Pd: <span className="font-medium">${((guest.total_paid ?? guest.amount_paid) / 100).toFixed(2)}</span>
                            {' · '}
                            <span className="text-yellow-700 font-semibold">Due: ${(balance / 100).toFixed(2)}</span>
                          </div>
                        )}
                      </div>

                      {guest.addons.length > 0 && (
                        <div className="mt-2 flex flex-wrap gap-1">
                          {guest.addons.map((addon, i) => (
                            <span key={i} className="inline-flex items-center gap-1 text-xs bg-amber-50 border border-amber-200 text-amber-800 px-2 py-0.5 rounded-full">
                              📦 {addon.name}{addon.quantity > 1 ? ` ×${addon.quantity}` : ''}
                            </span>
                          ))}
                        </div>
                      )}
                      {(guest.early_checkin || guest.late_checkout) && (
                        <div className="mt-1.5 flex flex-wrap gap-1">
                          {guest.early_checkin && (
                            <span className="inline-flex items-center gap-1 text-xs font-medium bg-orange-100 border border-orange-300 text-orange-800 px-2 py-0.5 rounded-full">
                              🕐 Early Check-In
                            </span>
                          )}
                          {guest.late_checkout && (
                            <span className="inline-flex items-center gap-1 text-xs font-medium bg-blue-50 border border-blue-200 text-blue-700 px-2 py-0.5 rounded-full">
                              🕒 Late Check-Out
                            </span>
                          )}
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </div>

      {/* Occupancy + Upcoming */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">

        {/* Occupancy Bar */}
        <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-6">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-base font-semibold text-gray-900">Tonight's Occupancy</h2>
            <span className="text-2xl font-bold text-gray-900">
              {occupancyTonight.arriving + occupancyTonight.occupied + occupancyTonight.departing}
              <span className="text-sm font-normal text-gray-400"> / {totalActiveSites}</span>
            </span>
          </div>
          {/* Bar */}
          <div className="w-full h-4 rounded-full overflow-hidden bg-gray-100 flex mb-4">
            {totalActiveSites > 0 && (
              <>
                {occupancyTonight.occupied > 0 && (
                  <div className="h-full transition-all" style={{ width: `${(occupancyTonight.occupied / totalActiveSites) * 100}%`, backgroundColor: '#4ade80' }} />
                )}
                {occupancyTonight.arriving > 0 && (
                  <div className="h-full transition-all" style={{ width: `${(occupancyTonight.arriving / totalActiveSites) * 100}%`, backgroundColor: '#fbbf24' }} />
                )}
                {occupancyTonight.departing > 0 && (
                  <div className="h-full transition-all" style={{ width: `${(occupancyTonight.departing / totalActiveSites) * 100}%`, backgroundColor: '#fb923c' }} />
                )}
              </>
            )}
          </div>
          {/* Legend */}
          <div className="flex flex-wrap gap-4">
            <div className="flex items-center gap-2">
              <div className="w-3 h-3 rounded-full" style={{ backgroundColor: '#4ade80' }} />
              <span className="text-xs text-gray-600">{occupancyTonight.occupied} Occupied</span>
            </div>
            <div className="flex items-center gap-2">
              <div className="w-3 h-3 rounded-full" style={{ backgroundColor: '#fbbf24' }} />
              <span className="text-xs text-gray-600">{occupancyTonight.arriving} Arriving</span>
            </div>
            <div className="flex items-center gap-2">
              <div className="w-3 h-3 rounded-full" style={{ backgroundColor: '#fb923c' }} />
              <span className="text-xs text-gray-600">{occupancyTonight.departing} Departing</span>
            </div>
            <div className="flex items-center gap-2">
              <div className="w-3 h-3 rounded-full bg-gray-200" />
              <span className="text-xs text-gray-600">{Math.max(0, totalActiveSites - occupancyTonight.arriving - occupancyTonight.occupied - occupancyTonight.departing)} Available</span>
            </div>
          </div>
        </div>

        {/* Upcoming Arrivals */}
        <div className="bg-white rounded-2xl border border-gray-100 shadow-sm">
          <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100">
            <h2 className="text-base font-semibold text-gray-900">Upcoming Arrivals</h2>
            <Link href="/admin/reservations" className="text-sm text-green-700 hover:underline">View all →</Link>
          </div>
          <div className="divide-y divide-gray-50">
            {upcomingReservations.length === 0 ? (
              <p className="text-gray-400 text-sm text-center py-8">No upcoming arrivals.</p>
            ) : upcomingReservations.map(r => {
              // ⚠ THE LOCAL DAY, like everything else on this page. toISOString() is UTC, so in
              // the evening this highlighted TOMORROW'S arrivals as "today". `todayYmd` is the
              // local date this page already computes.
              const isToday = r.arrival_date === todayYmd
              const paidInFull = (r.total_paid ?? r.amount_paid) >= r.total_price
              return (
                <Link key={r.id} href={`/admin/reservations?id=${r.id}`}
                  className="flex items-center justify-between px-6 py-3 hover:bg-gray-50 transition-colors">
                  <div className="flex items-center gap-3">
                    <div className="w-10 h-10 rounded-xl flex flex-col items-center justify-center shrink-0"
                      style={{ background: isToday ? '#f0fdf4' : '#f9fafb', border: '1px solid', borderColor: isToday ? '#bbf7d0' : '#e5e7eb' }}>
                      <span className="text-xs font-bold" style={{ color: isToday ? '#15803d' : '#6b7280' }}>
                        {new Date(r.arrival_date + 'T12:00:00').toLocaleDateString('en-US', { month: 'short' })}
                      </span>
                      <span className="text-sm font-extrabold leading-none" style={{ color: isToday ? '#15803d' : '#111827' }}>
                        {new Date(r.arrival_date + 'T12:00:00').getDate()}
                      </span>
                    </div>
                    <div>
                      <p className="text-sm font-semibold text-gray-900">{r.guest_name}</p>
                      <p className="text-xs text-gray-500">{siteTypeLabel(r.sites?.site_type)} {r.sites?.site_number}</p>
                    </div>
                  </div>
                  <div className="flex flex-col items-end gap-1">
                    <span className="text-sm font-medium text-gray-700">${(r.total_price / 100).toFixed(0)}</span>
                    <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${paidInFull ? 'bg-green-100 text-green-700' : 'bg-yellow-100 text-yellow-700'}`}>
                      {paidInFull ? 'Paid' : 'Balance due'}
                    </span>
                  </div>
                </Link>
              )
            })}
          </div>
        </div>

      </div>

      {/* Arrivals/Departures slide-out */}
      {slideOut && (
        <>
          <div className="fixed inset-0 bg-black/40 z-40" onClick={()=>setSlideOut(null)}/>
          <div className="fixed right-0 top-0 h-full w-full max-w-md bg-white z-50 shadow-2xl flex flex-col overflow-hidden">
            <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100">
              <div>
                <h2 className="text-lg font-bold text-gray-900">{slideOut==='arrivals'?'Arrivals Today':'Departures Today'}</h2>
                <p className="text-xs text-gray-400 mt-0.5">{new Date().toLocaleDateString('en-US',{weekday:'long',month:'long',day:'numeric'})}</p>
              </div>
              <button onClick={()=>setSlideOut(null)} className="w-8 h-8 rounded-full bg-gray-100 flex items-center justify-center text-gray-500 hover:bg-gray-200 font-bold text-lg">×</button>
            </div>
            <div className="flex-1 overflow-y-auto">
              {slideOut==='arrivals' && (
                arrivalsToday.length===0 ? (
                  <p className="text-gray-400 text-sm text-center py-12">No arrivals today</p>
                ) : arrivalsToday.map(guest=>{
                  const balance = guest.total_price - (guest.total_paid ?? guest.amount_paid)
                  return (
                    <div key={guest.id} className={`px-6 py-4 border-b border-gray-50 ${guest.checkedIn?'bg-green-50':''}`}>
                      <div className="flex items-center justify-between mb-1">
                        <span className="font-semibold text-gray-900">{guest.guest_name}</span>
                        <span className="text-sm text-gray-500">{siteTypeLabel(guest.site_type)} {guest.site_number}</span>
                      </div>
                      <div className="flex items-center justify-between">
                        <span className="text-xs text-gray-500">{guest.num_adults} adult{guest.num_adults!==1?'s':''}{guest.num_children>0?`, ${guest.num_children} child${guest.num_children!==1?'ren':''}`:''}</span>
                        {balance<=0
                          ? <span className="text-xs bg-green-100 text-green-700 px-2 py-0.5 rounded-full font-semibold">Paid in full</span>
                          : <span className="text-xs bg-yellow-100 text-yellow-700 px-2 py-0.5 rounded-full font-semibold">Due: ${(balance/100).toFixed(2)}</span>
                        }
                      </div>
                    </div>
                  )
                })
              )}
              {slideOut==='departures' && (
                departuresToday.length===0 ? (
                  <p className="text-gray-400 text-sm text-center py-12">No departures today</p>
                ) : departuresToday.map((r:any)=>(
                  <div key={r.id} className="px-6 py-4 border-b border-gray-50">
                    <div className="flex items-center justify-between mb-1">
                      <span className="font-semibold text-gray-900">{r.guest_name}</span>
                      <span className="text-sm text-gray-500">{siteTypeLabel(r.sites?.site_type||'')} {r.sites?.site_number}</span>
                    </div>
                    <span className="text-xs text-gray-400">Checking out today</span>
                  </div>
                ))
              )}
            </div>
          </div>
        </>
      )}
    </div>
  )
}