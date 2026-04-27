'use client'
import { useEffect, useState } from 'react'
import { supabase } from '@/lib/supabase'
import Image from 'next/image'
import Link from 'next/link'

export default function AdminDashboard() {
  const [settings, setSettings] = useState<any>(null)
  const [stats, setStats] = useState({
    totalThisMonth: 0,
    arrivalsToday: 0,
    departuresToday: 0,
    revenueThisMonth: 0,
  })
  const [recentReservations, setRecentReservations] = useState<any[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    fetchAll()
  }, [])

  async function fetchAll() {
    const today = new Date().toISOString().split('T')[0]
    const firstOfMonth = new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString().split('T')[0]
    const lastOfMonth = new Date(new Date().getFullYear(), new Date().getMonth() + 1, 0).toISOString().split('T')[0]

    const [{ data: settingsData }, { data: resData }] = await Promise.all([
      supabase.from('settings').select('*').limit(1).single(),
      supabase.from('reservations')
        .select('*, sites(site_number, site_type)')
        .neq('status', 'cancelled')
        .order('created_at', { ascending: false })
        .limit(50),
    ])

    if (settingsData) setSettings(settingsData)

    if (resData) {
      const thisMonth = resData.filter((r: any) =>
        r.arrival_date >= firstOfMonth && r.arrival_date <= lastOfMonth
      )
      const arrivalsToday = resData.filter((r: any) => r.arrival_date === today)
      const departuresToday = resData.filter((r: any) => r.departure_date === today)
      const revenue = thisMonth.reduce((sum: number, r: any) => sum + (r.amount_paid || 0), 0)

      setStats({
        totalThisMonth: thisMonth.length,
        arrivalsToday: arrivalsToday.length,
        departuresToday: departuresToday.length,
        revenueThisMonth: revenue,
      })
      setRecentReservations(resData.slice(0, 8))
    }

    setLoading(false)
  }

  const logoShapeClass =
    settings?.logo_shape === 'circle' ? 'rounded-full' :
    settings?.logo_shape === 'rounded' ? 'rounded-xl' :
    settings?.logo_shape === 'square' ? 'rounded-none' :
    'rounded-none'

  const siteTypeLabel = (type: string) =>
    ({ rv_site: 'RV Site', cabin: 'Cabin', tent: 'Tent Site' }[type] || type)

  const statusColor = (status: string) =>
    ({ confirmed: 'bg-green-100 text-green-800', manual: 'bg-purple-100 text-purple-800', pending: 'bg-yellow-100 text-yellow-800' }[status] || 'bg-gray-100 text-gray-800')

  if (loading) return (
    <div className="flex items-center justify-center h-64">
      <p className="text-gray-500">Loading dashboard...</p>
    </div>
  )

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
