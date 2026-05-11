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
  const [arrivalsToday, setArrivalsToday] = useState<ArrivalGuest[]>([])
  const [loading, setLoading] = useState(true)

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

    if (settingsData) setSettings(settingsData)

    if (resData) {
      const thisMonth = resData.filter((r: any) =>
        r.arrival_date >= firstOfMonth && r.arrival_date <= lastOfMonth
      )
      const arrivals = resData.filter((r: any) => r.arrival_date === today)
      const departures = resData.filter((r: any) => r.departure_date === today)
      const revenue = thisMonth.reduce((sum: number, r: any) => sum + (r.amount_paid || 0), 0)

      setStats({
        totalThisMonth: thisMonth.length,
        arrivalsToday: arrivals.length,
        departuresToday: departures.length,
        revenueThisMonth: revenue,
      })
      setRecentReservations(resData.slice(0, 8))
    }

    // Fetch add-ons for today's arrivals
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

      setArrivalsToday(todayArrivals.map((r: any) => ({
        id: r.id,
        guest_name: r.guest_name,
        site_number: r.sites?.site_number || '—',
        site_type: r.sites?.site_type || '',
        total_price: r.total_price,
        amount_paid: r.amount_paid,
        num_adults: r.num_adults,
        num_children: r.num_children,
        addons: addonMap[r.id] || [],
        checkedIn: r.checked_in || false,
      })))

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
        <div className="bg-white rounded-xl border border-gray-100 p-4 shadow-sm">
          <p className="text-xs text-gray-500 mb-1">Arrivals Today</p>
          <p className="text-3xl font-bold text-gray-900">{stats.arrivalsToday}</p>
        </div>
        <div className="bg-white rounded-xl border border-gray-100 p-4 shadow-sm">
          <p className="text-xs text-gray-500 mb-1">Departures Today</p>
          <p className="text-3xl font-bold text-gray-900">{stats.departuresToday}</p>
        </div>
        <div className="bg-white rounded-xl border border-gray-100 p-4 shadow-sm">
          <p className="text-xs text-gray-500 mb-1">Reservations This Month</p>
          <p className="text-3xl font-bold text-gray-900">{stats.totalThisMonth}</p>
        </div>
        <div className="bg-white rounded-xl border border-gray-100 p-4 shadow-sm">
          <p className="text-xs text-gray-500 mb-1">Revenue This Month</p>
          <p className="text-3xl font-bold text-gray-900">${(stats.revenueThisMonth / 100).toLocaleString('en-US', { minimumFractionDigits: 0 })}</p>
        </div>
      </div>

      {/* Quick links */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-8">
        {[
          { label: 'New Booking', href: '/admin/manual-booking', icon: '➕' },
          { label: 'Calendar', href: '/admin/calendar', icon: '📅' },
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
              const balance = guest.total_price - guest.amount_paid
              const paidInFull = balance <= 0
              return (
                <div
                  key={guest.id}
                  className={`px-6 py-4 transition-colors ${guest.checkedIn ? 'bg-green-50' : 'bg-white'}`}
                >
                  <div className="flex items-start gap-4">
                    {/* Checkbox */}
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

                    {/* Guest info */}
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center justify-between gap-2">
                        <p className={`font-semibold text-gray-900 ${guest.checkedIn ? 'line-through text-gray-400' : ''}`}>
                          {guest.guest_name}
                        </p>
                        <span className="text-sm font-medium text-gray-700 shrink-0">
                          {siteTypeLabel(guest.site_type)} {guest.site_number}
                        </span>
                      </div>

                      <p className="text-xs text-gray-500 mt-0.5">
                        {guest.num_adults} adult{guest.num_adults !== 1 ? 's' : ''}
                        {guest.num_children > 0 ? `, ${guest.num_children} child${guest.num_children !== 1 ? 'ren' : ''}` : ''}
                      </p>

                      {/* Payment row */}
                      <div className="flex items-center gap-3 mt-2">
                        {paidInFull ? (
                          <span className="inline-flex items-center gap-1 text-xs bg-green-100 text-green-700 px-2 py-0.5 rounded-full font-medium">
                            ✓ Paid in full
                          </span>
                        ) : (
                          <div className="text-xs text-gray-600 bg-yellow-50 border border-yellow-100 rounded-lg px-2 py-1">
                            Total: <span className="font-medium">${(guest.total_price / 100).toFixed(2)}</span>
                            {' · '}Pd: <span className="font-medium">${(guest.amount_paid / 100).toFixed(2)}</span>
                            {' · '}
                            <span className="text-yellow-700 font-semibold">Due: ${(balance / 100).toFixed(2)}</span>
                          </div>
                        )}
                      </div>

                      {/* Add-ons */}
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

      {/* Recent reservations */}
      <div className="bg-white rounded-xl border border-gray-100 shadow-sm">
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100">
          <h2 className="text-base font-semibold text-gray-900">Recent Reservations</h2>
          <Link href="/admin/reservations" className="text-sm text-green-700 hover:underline">View all →</Link>
        </div>
        <div className="divide-y divide-gray-50">
          {recentReservations.length === 0 ? (
            <p className="text-gray-400 text-sm text-center py-8">No reservations yet.</p>
          ) : recentReservations.map(r => (
            <Link key={r.id} href={`/admin/reservations?id=${r.id}`}
              className="flex items-center justify-between px-6 py-3 hover:bg-gray-50 transition-colors">
              <div>
                <p className="text-sm font-medium text-gray-900">{r.guest_name}</p>
                <p className="text-xs text-gray-500">{siteTypeLabel(r.sites?.site_type)} {r.sites?.site_number} · {r.arrival_date} → {r.departure_date}</p>
              </div>
              <div className="flex items-center gap-3">
                <span className={`text-xs px-2 py-1 rounded-full font-medium ${statusColor(r.status)}`}>
                  {r.status.charAt(0).toUpperCase() + r.status.slice(1)}
                </span>
                <span className="text-sm font-medium text-gray-700">${(r.amount_paid / 100).toFixed(0)}</span>
              </div>
            </Link>
          ))}
        </div>
      </div>

    </div>
  )
}