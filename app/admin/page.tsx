'use client'
import { useEffect, useState } from 'react'
import { supabase } from '@/lib/supabase'
import Image from 'next/image'
import Link from 'next/link'

type ArrivalGuest = {
  id: string
  guest_name: string
  site_number: string
  site_type: string
  total_price: number
  amount_paid: number
  total_paid: number
  num_adults: number
  num_children: number
  addons: { name: string; quantity: number }[]
  checkedIn: boolean
}

export default function AdminDashboard() {
  const [settings, setSettings] = useState<any>(null)
  const [stats, setStats] = useState({
    totalThisMonth: 0,
    arrivalsToday: 0,
    departuresToday: 0,
    revenueThisMonth: 0,
  })
  const [recentReservations, setRecentReservations] = useState<any[]>([])
  const [upcomingReservations, setUpcomingReservations] = useState<any[]>([])
  const [totalActiveSites, setTotalActiveSites] = useState(0)
  const [occupancyTonight, setOccupancyTonight] = useState({ arriving: 0, occupied: 0, departing: 0 })
  const [plan, setPlan] = useState<string>('summit')
  const [arrivalsToday, setArrivalsToday] = useState<ArrivalGuest[]>([])
  const [loading, setLoading] = useState(true)
  const [dashboardView, setDashboardView] = useState<'owner'|'staff'>('staff')
  const [slideOut, setSlideOut] = useState<'arrivals'|'departures'|null>(null)
  const [walkinCountToday, setWalkinCountToday] = useState(0)
  const [sitesAvailableTonight, setSitesAvailableTonight] = useState(0)

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

  async function fetchAll() {
    const today = new Date().toISOString().split('T')[0]
    const firstOfMonth = new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString().split('T')[0]
    const lastOfMonth = new Date(new Date().getFullYear(), new Date().getMonth() + 1, 0).toISOString().split('T')[0]

    const [{ data: settingsData }, { data: resData }, { data: todayArrivals }] = await Promise.all([
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
    ])

    if (settingsData) {
      setSettings(settingsData)
      if (settingsData.plan) setPlan(settingsData.plan)
    }

    if (resData) {
      // Fold folio-collected payments into dashboard figures so removing the
      // webhook amount_paid mirror doesn't drop folio money. Single source of
      // truth: amount_paid (booking) + folio_payments (folio/walk-in/POS),
      // counted net of card surcharge to match the arrivals bridge.
      const resIds = resData.map((r: any) => r.id)
      const folioPaidByRes: Record<string, number> = {}
      if (resIds.length > 0) {
        const { data: dashFolios } = await supabase
          .from('folios')
          .select('id, reservation_id')
          .in('reservation_id', resIds)
        const dashFolioList = dashFolios || []
        const dashFolioIds = dashFolioList.map((f: any) => f.id)
        if (dashFolioIds.length > 0) {
          const { data: dashPmts } = await supabase
            .from('folio_payments')
            .select('folio_id, amount, surcharge_amount, status')
            .in('folio_id', dashFolioIds)
            .eq('status', 'completed')
          const paidByFolio: Record<string, number> = {}
          for (const pm of (dashPmts || [])) {
            paidByFolio[pm.folio_id] = (paidByFolio[pm.folio_id] || 0) + (pm.amount - (pm.surcharge_amount || 0))
          }
          for (const f of dashFolioList) {
            if (f.reservation_id) folioPaidByRes[f.reservation_id] = (folioPaidByRes[f.reservation_id] || 0) + (paidByFolio[f.id] || 0)
          }
        }
      }
      const thisMonth = resData.filter((r: any) =>
        r.arrival_date >= firstOfMonth && r.arrival_date <= lastOfMonth
      )
      const arrivals = resData.filter((r: any) => r.arrival_date === today)
      const departures = resData.filter((r: any) => r.departure_date === today)
      const revenue = thisMonth.reduce((sum: number, r: any) => sum + (r.amount_paid || 0) + (folioPaidByRes[r.id] || 0), 0)

      setStats({
        totalThisMonth: thisMonth.length,
        arrivalsToday: arrivals.length,
        departuresToday: departures.length,
        revenueThisMonth: revenue,
      })
      setRecentReservations(resData.slice(0, 8))
      const upcoming = resData
        .filter((r: any) => r.arrival_date >= today)
        .sort((a: any, b: any) => a.arrival_date.localeCompare(b.arrival_date))
        .slice(0, 5)
        .map((r: any) => ({ ...r, total_paid: (r.amount_paid || 0) + (folioPaidByRes[r.id] || 0) }))
      setUpcomingReservations(upcoming)
      const occupiedTonight = resData.filter((r: any) =>
        r.arrival_date < today && r.departure_date > today
      ).length
      const arrivingTonight = resData.filter((r: any) => r.arrival_date === today).length
      const departingTonight = resData.filter((r: any) => r.departure_date === today).length
      setOccupancyTonight({ arriving: arrivingTonight, occupied: occupiedTonight, departing: departingTonight })
    }
    const { count } = await supabase
      .from('sites')
      .select('*', { count: 'exact', head: true })
      .eq('is_available', true)
    setTotalActiveSites(count || 0)

    if (todayArrivals && todayArrivals.length > 0) {
      const ids = todayArrivals.map((r: any) => r.id)
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

      // Fold in folio-collected payments so "Paid" reflects BOTH sources
      // (reservations.amount_paid for booking-flow + folio_payments for walk-in/POS).
      // Display-only: we never write folio money into amount_paid (would double-count in reports).
      const arrivalResIds = todayArrivals.map((r: any) => r.id)
      const arrFolioPaidByRes: Record<string, number> = {}
      if (arrivalResIds.length > 0) {
        const { data: arrFolios } = await supabase
          .from('folios')
          .select('id, reservation_id')
          .in('reservation_id', arrivalResIds)
        const arrFolioList = arrFolios || []
        const arrFolioIds = arrFolioList.map((f: any) => f.id)
        if (arrFolioIds.length > 0) {
          const { data: arrPmts } = await supabase
            .from('folio_payments')
            .select('folio_id, amount, surcharge_amount, status')
            .in('folio_id', arrFolioIds)
            .eq('status', 'completed')
          const arrPaidByFolio: Record<string, number> = {}
          for (const pm of (arrPmts || [])) {
            arrPaidByFolio[pm.folio_id] = (arrPaidByFolio[pm.folio_id] || 0) + (pm.amount - (pm.surcharge_amount || 0))
          }
          for (const f of arrFolioList) {
            if (f.reservation_id) arrFolioPaidByRes[f.reservation_id] = (arrFolioPaidByRes[f.reservation_id] || 0) + (arrPaidByFolio[f.id] || 0)
          }
        }
      }
      setArrivalsToday(todayArrivals.map((r: any) => ({
        id: r.id,
        guest_name: r.guest_name,
        site_number: r.sites?.site_number || '—',
        site_type: r.sites?.site_type || '',
        total_price: r.total_price,
        amount_paid: r.amount_paid,
        total_paid: (r.amount_paid || 0) + (arrFolioPaidByRes[r.id] || 0),
        num_adults: r.num_adults,
        num_children: r.num_children,
        addons: addonMap[r.id] || [],
        checkedIn: r.checked_in || false,
      })))
    }

    // Walk-in sales count today
    const { count: walkinCount } = await supabase
      .from('folio_payments')
      .select('id', { count: 'exact', head: true })
      .eq('status', 'completed')
      .gte('paid_at', today + 'T00:00:00')
      .lte('paid_at', today + 'T23:59:59')
    setWalkinCountToday(walkinCount || 0)

    // Sites available tonight
    const { count: totalSitesCount } = await supabase
      .from('sites')
      .select('id', { count: 'exact', head: true })
      .eq('is_available', true)
    const { count: occupiedCount } = await supabase
      .from('reservations')
      .select('id', { count: 'exact', head: true })
      .neq('status', 'cancelled')
      .lte('arrival_date', today)
      .gte('departure_date', today)
    setSitesAvailableTonight(Math.max(0, (totalSitesCount || 0) - (occupiedCount || 0)))

    setLoading(false)
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
          </div>
        ) : (
          <div className="rounded-xl border p-4 shadow-sm" style={{background:'#faf5ff',borderColor:'#e9d5ff'}}>
            <p className="text-xs font-semibold mb-1" style={{color:'#581c87'}}>Walk-In Sales Today</p>
            <p className="text-3xl font-bold" style={{color:'#581c87'}}>{walkinCountToday}</p>
          </div>
        )}
      </div>

      {/* Quick links */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-8">
        {[
          { label: 'New Booking', href: '/admin/manual-booking', icon: '➕' },
          ...(settings?.pos_enabled ? [{ label: 'Walk-Up Sale', href: '/admin/folio/new', icon: '🛒' }] : []),
          { label: 'Walk-In Booking', href: '/admin/walkin-booking', icon: '🏕️' },
          { label: 'Guest Directory', href: '/admin/guests', icon: '👥' },
          { label: 'Calendar', href: '/admin/calendar', icon: '📅' },
          ...(plan === 'ridgeline' || plan === 'summit' ? [{ label: 'Park Map', href: '/admin/map', icon: '🗺️' }] : []),
          { label: 'Reservations', href: '/admin/reservations', icon: '📋' },
          { label: 'Settings', href: '/admin/settings', icon: '⚙️' },
        ].map(link => (
          <Link key={link.href} href={link.href}
            className="bg-white rounded-xl border border-gray-100 p-4 shadow-sm text-center hover:border-gray-300 transition-colors">
            <div className="text-2xl mb-1">{link.icon}</div>
            <p className="text-sm font-medium text-gray-700">{link.label}</p>
          </Link>
        ))}
      </div>

      {/* Today's Check-In List */}
      <div className="bg-white rounded-xl border border-gray-100 shadow-sm mb-8">
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100">
          <div>
            <h2 className="text-base font-semibold text-gray-900">Today's Arrivals</h2>
            <p className="text-xs text-gray-500 mt-0.5">
              {arrivalsToday.length === 0
                ? 'No arrivals today'
                : `${checkedInCount} of ${arrivalsToday.length} checked in`}
            </p>
          </div>
          {arrivalsToday.length > 0 && (
            <div className="text-sm text-gray-500">
              {checkedInCount === arrivalsToday.length
                ? <span className="text-green-600 font-medium">✓ All checked in!</span>
                : <span>{arrivalsToday.length - checkedInCount} remaining</span>}
            </div>
          )}
        </div>

        {arrivalsToday.length === 0 ? (
          <p className="text-gray-400 text-sm text-center py-8">No arrivals scheduled for today.</p>
        ) : (
          <div className="divide-y divide-gray-50">
            {arrivalsToday.map(guest => {
              const balance = guest.total_price - (guest.total_paid ?? guest.amount_paid)
              const paidInFull = balance <= 0
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
                        {guest.num_adults} adult{guest.num_adults !== 1 ? 's' : ''}
                        {guest.num_children > 0 ? `, ${guest.num_children} child${guest.num_children !== 1 ? 'ren' : ''}` : ''}
                      </p>

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
              const isToday = r.arrival_date === new Date().toISOString().split('T')[0]
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
                recentReservations.filter(r=>r.departure_date===new Date().toISOString().split('T')[0]).length===0 ? (
                  <p className="text-gray-400 text-sm text-center py-12">No departures today</p>
                ) : recentReservations.filter(r=>r.departure_date===new Date().toISOString().split('T')[0]).map((r:any)=>(
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