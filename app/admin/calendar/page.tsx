'use client'

import { useEffect, useState } from 'react'
import { supabase } from '@/lib/supabase'

type Reservation = {
  id: string
  guest_name: string
  site_id: string
  arrival_date: string
  departure_date: string
  status: string
  payment_type: string
  total_price: number
  amount_paid: number
  guest_email: string
  guest_phone: string
  num_adults: number
  num_children: number
  sites: {
    site_number: string
    site_type: string
  }
}

type Site = {
  id: string
  site_number: string
  site_type: string
  in_rotation: boolean
}

const SITE_TYPE_COLORS: Record<string, { bg: string; text: string; border: string }> = {
  rv_site: { bg: '#dcfce7', text: '#166534', border: '#86efac' },
  cabin: { bg: '#fef9c3', text: '#854d0e', border: '#fde047' },
  tent: { bg: '#dbeafe', text: '#1e40af', border: '#93c5fd' },
  yurt: { bg: '#fce7f3', text: '#9d174d', border: '#f9a8d4' },
  tiny_home: { bg: '#ede9fe', text: '#5b21b6', border: '#c4b5fd' },
  lodge: { bg: '#fee2e2', text: '#991b1b', border: '#fca5a5' },
  glamping: { bg: '#fff7ed', text: '#9a3412', border: '#fdba74' },
  treehouse: { bg: '#f0fdf4', text: '#14532d', border: '#86efac' },
}

const STATUS_COLORS: Record<string, string> = {
  confirmed: '#16a34a',
  pending: '#d97706',
  manual: '#7c3aed',
  cancelled: '#dc2626',
}

export default function CalendarPage() {
  const [reservations, setReservations] = useState<Reservation[]>([])
  const [sites, setSites] = useState<Site[]>([])
  const [loading, setLoading] = useState(true)
  const [currentDate, setCurrentDate] = useState(new Date())
  const [selected, setSelected] = useState<Reservation | null>(null)
  const [expandedDays, setExpandedDays] = useState<Set<number>>(new Set())
  const [activeTab, setActiveTab] = useState<'calendar' | 'sites'>('calendar')

  function toggleDay(day: number) {
    setExpandedDays(prev => {
      const next = new Set(prev)
      next.has(day) ? next.delete(day) : next.add(day)
      return next
    })
  }

  useEffect(() => {
    fetchData()
  }, [currentDate])

  async function fetchData() {
    setLoading(true)
    const year = currentDate.getFullYear()
    const month = currentDate.getMonth()
    const firstDay = new Date(year, month, 1).toISOString().split('T')[0]
    const lastDay = new Date(year, month + 1, 0).toISOString().split('T')[0]

    const [{ data: resData }, { data: siteData }] = await Promise.all([
      supabase
        .from('reservations')
        .select('*, sites(site_number, site_type)')
        .neq('status', 'cancelled')
        .lt('arrival_date', lastDay)
        .gt('departure_date', firstDay)
        .order('arrival_date'),
      supabase
        .from('sites')
        .select('*')
        .eq('in_rotation', true)
        .order('site_number')
    ])

    setReservations(resData || [])
    setSites(siteData || [])
    setLoading(false)
  }

  const year = currentDate.getFullYear()
  const month = currentDate.getMonth()
  const firstDayOfMonth = new Date(year, month, 1).getDay()
  const daysInMonth = new Date(year, month + 1, 0).getDate()
  const monthName = currentDate.toLocaleString('default', { month: 'long', year: 'numeric' })

  function getReservationsForDay(day: number) {
    const dateStr = String(year) + '-' + String(month + 1).padStart(2, '0') + '-' + String(day).padStart(2, '0')
    return reservations.filter(r => r.arrival_date <= dateStr && r.departure_date > dateStr)
  }

  function getReservationForSiteAndDay(siteId: string, day: number) {
    const dateStr = String(year) + '-' + String(month + 1).padStart(2, '0') + '-' + String(day).padStart(2, '0')
    return reservations.find(r => r.site_id === siteId && r.arrival_date <= dateStr && r.departure_date > dateStr) || null
  }

  function prevMonth() {
    setCurrentDate(new Date(year, month - 1, 1))
    setSelected(null)
    setExpandedDays(new Set())
  }

  function nextMonth() {
    setCurrentDate(new Date(year, month + 1, 1))
    setSelected(null)
    setExpandedDays(new Set())
  }

  function goToToday() {
    setCurrentDate(new Date())
    setSelected(null)
    setExpandedDays(new Set())
  }

  function isToday(day: number) {
    const today = new Date()
    return today.getFullYear() === year && today.getMonth() === month && today.getDate() === day
  }

  function isArrivalDay(r: Reservation, day: number) {
    const dateStr = String(year) + '-' + String(month + 1).padStart(2, '0') + '-' + String(day).padStart(2, '0')
    return r.arrival_date === dateStr
  }

  const siteTypeLabel = (type: string) => {
    if (type === 'rv_site') return 'RV'
    if (type === 'yurt') return 'Yurt'
    if (type === 'tiny_home') return 'Tiny Home'
    if (type === 'lodge') return 'Lodge'
    if (type === 'glamping') return 'Glamping'
    if (type === 'treehouse') return 'Treehouse'
    if (type === 'cabin') return 'Cabin'
    if (type === 'tent') return 'Tent'
    return type
  }

  const days = Array.from({ length: daysInMonth }, (_, i) => i + 1)

  return (
    <div className="p-6">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h2 className="text-2xl font-bold text-gray-900">Reservation Calendar</h2>
          <p className="text-sm text-gray-500 mt-1">Monthly overview of all active reservations</p>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={goToToday} className="px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-200 rounded-lg hover:bg-gray-50">
            Today
          </button>
          <button onClick={prevMonth} className="px-3 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-200 rounded-lg hover:bg-gray-50">
            ←
          </button>
          <span className="text-lg font-semibold text-gray-900 min-w-48 text-center">{monthName}</span>
          <button onClick={nextMonth} className="px-3 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-200 rounded-lg hover:bg-gray-50">
            →
          </button>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 mb-6 bg-gray-100 p-1 rounded-lg w-fit">
        <button
          onClick={() => setActiveTab('calendar')}
          className="px-4 py-2 text-sm font-medium rounded-md transition-colors"
          style={{
            backgroundColor: activeTab === 'calendar' ? 'white' : 'transparent',
            color: activeTab === 'calendar' ? '#111827' : '#6b7280',
            boxShadow: activeTab === 'calendar' ? '0 1px 3px rgba(0,0,0,0.1)' : 'none'
          }}
        >
          Calendar View
        </button>
        <button
          onClick={() => setActiveTab('sites')}
          className="px-4 py-2 text-sm font-medium rounded-md transition-colors"
          style={{
            backgroundColor: activeTab === 'sites' ? 'white' : 'transparent',
            color: activeTab === 'sites' ? '#111827' : '#6b7280',
            boxShadow: activeTab === 'sites' ? '0 1px 3px rgba(0,0,0,0.1)' : 'none'
          }}
        >
          Site View
        </button>
      </div>

      {/* Legend */}
      <div className="flex items-center gap-4 mb-4">
        {Object.entries(SITE_TYPE_COLORS).map(([type, colors]) => (
          <div key={type} className="flex items-center gap-1.5">
            <div className="w-3 h-3 rounded-sm" style={{ backgroundColor: colors.bg, border: '1px solid ' + colors.border }}/>
            <span className="text-xs text-gray-500">{siteTypeLabel(type)}</span>
          </div>
        ))}
        <div className="flex items-center gap-1.5 ml-4">
          <div className="w-2 h-2 rounded-full" style={{ backgroundColor: STATUS_COLORS.confirmed }}/>
          <span className="text-xs text-gray-500">Confirmed</span>
        </div>
        <div className="flex items-center gap-1.5">
          <div className="w-2 h-2 rounded-full" style={{ backgroundColor: STATUS_COLORS.manual }}/>
          <span className="text-xs text-gray-500">Manual</span>
        </div>
        <div className="flex items-center gap-1.5">
          <div className="w-2 h-2 rounded-full" style={{ backgroundColor: STATUS_COLORS.pending }}/>
          <span className="text-xs text-gray-500">Pending</span>
        </div>
      </div>

      {activeTab === 'calendar' && (
        <div className="flex gap-6">
          <div className="flex-1">
            <div className="grid grid-cols-7 mb-1">
              {['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map(d => (
                <div key={d} className="text-center text-xs font-semibold text-gray-500 py-2">{d}</div>
              ))}
            </div>

            <div className="grid grid-cols-7 gap-1">
              {Array.from({ length: firstDayOfMonth }).map((_, i) => (
                <div key={'empty-' + i} className="min-h-28 bg-gray-50 rounded-lg opacity-40"/>
              ))}

              {Array.from({ length: daysInMonth }).map((_, i) => {
                const day = i + 1
                const dayReservations = getReservationsForDay(day)
                const todayFlag = isToday(day)

                return (
                  <div
                    key={day}
                    className="min-h-28 bg-white rounded-lg border border-gray-100 p-1.5 hover:border-gray-300 transition-colors"
                    style={{ outline: todayFlag ? '2px solid var(--accent-color)' : 'none' }}
                  >
                    <div className="flex items-center justify-between mb-1">
                      <span
                        className="text-sm font-semibold w-6 h-6 flex items-center justify-center rounded-full"
                        style={{ backgroundColor: todayFlag ? 'var(--accent-color)' : 'transparent', color: todayFlag ? 'white' : '#374151' }}
                      >
                        {day}
                      </span>
                      {dayReservations.length > 0 && (
                        <span className="text-xs text-gray-400">{dayReservations.length}</span>
                      )}
                    </div>

                    <div className="space-y-0.5">
                      {(expandedDays.has(day) ? dayReservations : dayReservations.slice(0, 3)).map(r => {
                        const colors = SITE_TYPE_COLORS[r.sites?.site_type] || SITE_TYPE_COLORS.rv_site
                        const arrival = isArrivalDay(r, day)
                        return (
                          <button
                            key={r.id}
                            onClick={() => setSelected(selected?.id === r.id ? null : r)}
                            className="w-full text-left px-1.5 py-0.5 rounded text-xs font-medium truncate transition-opacity hover:opacity-80"
                            style={{
                              backgroundColor: colors.bg,
                              color: colors.text,
                              border: '1px solid ' + (selected?.id === r.id ? colors.text : colors.border),
                              borderLeftWidth: arrival ? '3px' : '1px',
                            }}
                          >
                            {siteTypeLabel(r.sites?.site_type)} {r.sites?.site_number} · {r.guest_name.split(' ')[0]}
                          </button>
                        )
                      })}
                      {dayReservations.length > 3 && (
                        <button
                          onClick={(e) => { e.stopPropagation(); toggleDay(day) }}
                          className="text-xs text-blue-400 hover:text-blue-600 pl-1 w-full text-left"
                        >
                          {expandedDays.has(day) ? '▲ Show less' : '+' + (dayReservations.length - 3) + ' more'}
                        </button>
                      )}
                    </div>
                  </div>
                )
              })}
            </div>

            <div className="mt-4 p-4 bg-white rounded-xl border border-gray-100">
              <div className="flex items-center gap-8">
                <div>
                  <p className="text-xs text-gray-500">Total reservations</p>
                  <p className="text-xl font-bold text-gray-900">{reservations.length}</p>
                </div>
                <div>
                  <p className="text-xs text-gray-500">RV sites</p>
                  <p className="text-xl font-bold text-gray-900">{reservations.filter(r => r.sites?.site_type === 'rv_site').length}</p>
                </div>
                <div>
                  <p className="text-xs text-gray-500">Cabins</p>
                  <p className="text-xl font-bold text-gray-900">{reservations.filter(r => r.sites?.site_type === 'cabin').length}</p>
                </div>
                <div>
                  <p className="text-xs text-gray-500">Revenue this month</p>
                  <p className="text-xl font-bold text-gray-900">
                    {'$' + (reservations.reduce((sum, r) => sum + (r.amount_paid || 0), 0) / 100).toLocaleString('en-US', { minimumFractionDigits: 2 })}
                  </p>
                </div>
              </div>
            </div>
          </div>

          {selected && (
            <div className="w-80 shrink-0">
              <div className="bg-white rounded-xl border border-gray-100 p-5 sticky top-6">
                <div className="flex items-start justify-between mb-4">
                  <div>
                    <h3 className="font-bold text-gray-900 text-lg">{selected.guest_name}</h3>
                    <p className="text-sm text-gray-500">{'#' + selected.id.slice(0, 8).toUpperCase()}</p>
                  </div>
                  <button onClick={() => setSelected(null)} className="text-gray-400 hover:text-gray-600 text-lg font-medium">
                    ×
                  </button>
                </div>

                <div className="mb-4">
                  <span
                    className="inline-flex items-center px-2.5 py-1 rounded-full text-xs font-medium text-white"
                    style={{ backgroundColor: STATUS_COLORS[selected.status] || '#6b7280' }}
                  >
                    {selected.status.charAt(0).toUpperCase() + selected.status.slice(1)}
                  </span>
                </div>

                <div className="space-y-3 text-sm">
                  <div className="flex justify-between">
                    <span className="text-gray-500">Site</span>
                    <span className="font-medium text-gray-900">{siteTypeLabel(selected.sites?.site_type)} {selected.sites?.site_number}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-gray-500">Arrival</span>
                    <span className="font-medium text-gray-900">{selected.arrival_date}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-gray-500">Departure</span>
                    <span className="font-medium text-gray-900">{selected.departure_date}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-gray-500">Guests</span>
                    <span className="font-medium text-gray-900">{selected.num_adults} adults, {selected.num_children} children</span>
                  </div>
                  <div className="border-t border-gray-100 pt-3">
                    <div className="flex justify-between">
                      <span className="text-gray-500">Total</span>
                      <span className="font-medium text-gray-900">{'$' + (selected.total_price / 100).toFixed(2)}</span>
                    </div>
                    <div className="flex justify-between mt-1">
                      <span className="text-gray-500">Paid</span>
                      <span className="font-medium" style={{ color: selected.amount_paid >= selected.total_price ? '#16a34a' : '#d97706' }}>
                        {'$' + (selected.amount_paid / 100).toFixed(2)}
                      </span>
                    </div>
                  </div>
                  <div className="border-t border-gray-100 pt-3">
                    <div className="flex justify-between">
                      <span className="text-gray-500">Email</span>
                      <span className="font-medium text-gray-900 text-right truncate max-w-40">{selected.guest_email}</span>
                    </div>
                    <div className="flex justify-between mt-1">
                      <span className="text-gray-500">Phone</span>
                      <span className="font-medium text-gray-900">{selected.guest_phone || '—'}</span>
                    </div>
                  </div>
                </div>

                
                  <a href={'/admin/reservations?id=' + selected.id}
                  className="mt-4 w-full block text-center py-2 rounded-lg text-sm font-medium text-white"
                  style={{ backgroundColor: 'var(--accent-color)' }}
                >
                  View Full Reservation
                </a>
              </div>
            </div>
          )}
        </div>
      )}

      {activeTab === 'sites' && (
        <div className="flex gap-6">
          <div className="flex-1 overflow-x-auto">
            <table className="w-full border-collapse" style={{ minWidth: daysInMonth * 36 + 120 + 'px' }}>
              <thead>
                <tr>
                  <th className="sticky left-0 bg-white z-10 text-left text-xs font-semibold text-gray-500 py-2 pr-3 w-28 border-b border-gray-100">
                    Site
                  </th>
                  {days.map(day => (
                    <th
                      key={day}
                      className="text-center text-xs font-semibold py-2 border-b border-gray-100 w-9"
                      style={{ color: isToday(day) ? 'var(--accent-color)' : '#6b7280' }}
                    >
                      {day}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {sites.map(site => (
                  <tr key={site.id} className="hover:bg-gray-50">
                    <td className="sticky left-0 bg-white z-10 text-xs font-medium text-gray-700 py-1 pr-3 border-b border-gray-50 hover:bg-gray-50">
                      <span className="inline-flex items-center gap-1">
                        <span
                          className="w-2 h-2 rounded-full shrink-0"
                          style={{ backgroundColor: SITE_TYPE_COLORS[site.site_type]?.border || '#ccc' }}
                        />
                        {siteTypeLabel(site.site_type)} {site.site_number}
                      </span>
                    </td>
                    {days.map(day => {
                      const res = getReservationForSiteAndDay(site.id, day)
                      const colors = res ? (SITE_TYPE_COLORS[site.site_type] || SITE_TYPE_COLORS.rv_site) : null
                      const arrival = res ? isArrivalDay(res, day) : false
                      return (
                        <td
                          key={day}
                          className="border-b border-gray-50 p-0.5 text-center"
                          style={{ outline: isToday(day) ? '1px solid var(--accent-color)30' : 'none' }}
                        >
                          {res && colors ? (
                            <button
                              onClick={() => setSelected(selected?.id === res.id ? null : res)}
                              className="w-full h-6 rounded text-xs transition-opacity hover:opacity-80"
                              style={{
                                backgroundColor: colors.bg,
                                border: '1px solid ' + (selected?.id === res.id ? colors.text : colors.border),
                                borderLeftWidth: arrival ? '3px' : '1px',
                              }}
                              title={res.guest_name + ' · ' + res.arrival_date + ' to ' + res.departure_date}
                            />
                          ) : (
                            <div className="w-full h-6 rounded" style={{ backgroundColor: '#f9fafb' }} />
                          )}
                        </td>
                      )
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {selected && (
            <div className="w-80 shrink-0">
              <div className="bg-white rounded-xl border border-gray-100 p-5 sticky top-6">
                <div className="flex items-start justify-between mb-4">
                  <div>
                    <h3 className="font-bold text-gray-900 text-lg">{selected.guest_name}</h3>
                    <p className="text-sm text-gray-500">{'#' + selected.id.slice(0, 8).toUpperCase()}</p>
                  </div>
                  <button onClick={() => setSelected(null)} className="text-gray-400 hover:text-gray-600 text-lg font-medium">
                    ×
                  </button>
                </div>

                <div className="mb-4">
                  <span
                    className="inline-flex items-center px-2.5 py-1 rounded-full text-xs font-medium text-white"
                    style={{ backgroundColor: STATUS_COLORS[selected.status] || '#6b7280' }}
                  >
                    {selected.status.charAt(0).toUpperCase() + selected.status.slice(1)}
                  </span>
                </div>

                <div className="space-y-3 text-sm">
                  <div className="flex justify-between">
                    <span className="text-gray-500">Site</span>
                    <span className="font-medium text-gray-900">{siteTypeLabel(selected.sites?.site_type)} {selected.sites?.site_number}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-gray-500">Arrival</span>
                    <span className="font-medium text-gray-900">{selected.arrival_date}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-gray-500">Departure</span>
                    <span className="font-medium text-gray-900">{selected.departure_date}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-gray-500">Guests</span>
                    <span className="font-medium text-gray-900">{selected.num_adults} adults, {selected.num_children} children</span>
                  </div>
                  <div className="border-t border-gray-100 pt-3">
                    <div className="flex justify-between">
                      <span className="text-gray-500">Total</span>
                      <span className="font-medium text-gray-900">{'$' + (selected.total_price / 100).toFixed(2)}</span>
                    </div>
                    <div className="flex justify-between mt-1">
                      <span className="text-gray-500">Paid</span>
                      <span className="font-medium" style={{ color: selected.amount_paid >= selected.total_price ? '#16a34a' : '#d97706' }}>
                        {'$' + (selected.amount_paid / 100).toFixed(2)}
                      </span>
                    </div>
                  </div>
                  <div className="border-t border-gray-100 pt-3">
                    <div className="flex justify-between">
                      <span className="text-gray-500">Email</span>
                      <span className="font-medium text-gray-900 text-right truncate max-w-40">{selected.guest_email}</span>
                    </div>
                    <div className="flex justify-between mt-1">
                      <span className="text-gray-500">Phone</span>
                      <span className="font-medium text-gray-900">{selected.guest_phone || '—'}</span>
                    </div>
                  </div>
                </div>

                
                  <a href={'/admin/reservations?id=' + selected.id}
                  className="mt-4 w-full block text-center py-2 rounded-lg text-sm font-medium text-white"
                  style={{ backgroundColor: 'var(--accent-color)' }}
                >
                  View Full Reservation
                </a>
              </div>
            </div>
          )}
        </div>
      )}

      {loading && (
        <div className="fixed inset-0 bg-white bg-opacity-60 flex items-center justify-center">
          <p className="text-gray-500 text-sm">Loading reservations...</p>
        </div>
      )}
    </div>
  )
}