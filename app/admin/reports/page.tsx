'use client'

import { useEffect, useState } from 'react'
import { supabase } from '@/lib/supabase'

type Reservation = {
  id: string
  arrival_date: string
  departure_date: string
  total_price: number
  status: string
  site_id: string
  sites: { site_number: string; site_type: string }
}

type AddonRevenue = {
  quantity: number
  price: number
  addons: { name: string }
}

const COLORS = ['#12c9e5', '#C4873C', '#2D6A4F', '#9B59B6', '#E74C3C']

export default function ReportsPage() {
  const [reservations, setReservations] = useState<Reservation[]>([])
  const [addonRevenue, setAddonRevenue] = useState<AddonRevenue[]>([])
  const [loading, setLoading] = useState(true)
  const [dateRange, setDateRange] = useState('this_year')
  const [customStart, setCustomStart] = useState('')
  const [customEnd, setCustomEnd] = useState('')

  useEffect(() => { fetchData() }, [dateRange])

  async function fetchData() {
    setLoading(true)
    const now = new Date()
    let startDate = ''
    if (dateRange === 'custom' && customStart && customEnd) {
      startDate = customStart
    } else if (dateRange === 'this_month') {
      startDate = new Date(now.getFullYear(), now.getMonth(), 1).toISOString().split('T')[0]
    } else if (dateRange === 'last_month') {
      startDate = new Date(now.getFullYear(), now.getMonth() - 1, 1).toISOString().split('T')[0]
    } else if (dateRange === 'this_year') {
      startDate = new Date(now.getFullYear(), 0, 1).toISOString().split('T')[0]
    } else {
      startDate = new Date(now.getFullYear() - 1, 0, 1).toISOString().split('T')[0]
    }

    const { data: resData } = await supabase
      .from('reservations')
      .select('id, arrival_date, departure_date, total_price, status, site_id, sites(site_number, site_type)')
      .neq('status', 'cancelled')
      .gte('arrival_date', startDate)
      .order('arrival_date')

    const { data: addonData } = await supabase
      .from('reservation_addons')
      .select('quantity, price, addons(name)')

    if (resData) setReservations(resData as any)
    if (addonData) setAddonRevenue(addonData as any)
    setLoading(false)
  }

  const totalRevenue = reservations.reduce((sum, r) => sum + ((r.total_price || 0) / 100), 0)
  const totalAddons = addonRevenue.reduce((sum, a) => sum + (a.price * a.quantity || 0), 0)
  const totalBookings = reservations.length
  const avgStay = reservations.length > 0
    ? reservations.reduce((sum, r) => {
        const nights = Math.round((new Date(r.departure_date).getTime() - new Date(r.arrival_date).getTime()) / (1000 * 60 * 60 * 24))
        return sum + nights
      }, 0) / reservations.length
    : 0

  // Monthly revenue
  const monthlyMap: { [key: string]: { label: string; value: number } } = {}
  reservations.forEach(r => {
    const key = r.arrival_date.substring(0, 7)
    const label = new Date(r.arrival_date + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', year: '2-digit' })
    if (!monthlyMap[key]) monthlyMap[key] = { label, value: 0 }
    monthlyMap[key].value += (r.total_price || 0) / 100
  })
  const monthlyData = Object.values(monthlyMap)

  // Revenue by site type
  const siteTypeMap: { [key: string]: number } = {}
  reservations.forEach(r => {
    const type = (r.sites as any)?.site_type || 'unknown'
    const label = ({ rv_site: 'RV Sites', cabin: 'Cabins', tent: 'Tent Sites' } as any)[type] || type
    siteTypeMap[label] = (siteTypeMap[label] || 0) + ((r.total_price || 0) / 100)
  })
  const siteTypeData = Object.entries(siteTypeMap).map(([name, value]) => ({ name, value }))

  // Top sites
  const siteMap: { [key: string]: { name: string; revenue: number; bookings: number } } = {}
  reservations.forEach(r => {
    const n = (r.sites as any)?.site_number || 'Unknown'
    if (!siteMap[n]) siteMap[n] = { name: n, revenue: 0, bookings: 0 }
    siteMap[n].revenue += (r.total_price || 0) / 100
    siteMap[n].bookings += 1
  })
  const topSites = Object.values(siteMap).sort((a, b) => b.revenue - a.revenue).slice(0, 5)

  // Native SVG Bar Chart — no external library
  function BarChart({ data }: { data: { label: string; value: number }[] }) {
    if (data.length === 0) return <p className="text-gray-400 text-center py-8">No data for selected period</p>
    const max = Math.max(...data.map(d => d.value), 1)
    const chartH = 180
    const barW = 32
    const gap = 8
    const leftPad = 48
    const totalW = leftPad + data.length * (barW + gap) + 16

    return (
      <div style={{ width: '100%', overflowX: 'auto' }}>
        <svg width={totalW} height={chartH + 40} style={{ display: 'block' }}>
          {[0, 0.5, 1].map((pct, i) => {
            const y = 8 + (1 - pct) * chartH
            const val = max * pct
            return (
              <g key={i}>
                <line x1={leftPad - 4} y1={y} x2={totalW - 8} y2={y} stroke="#e5e7eb" strokeWidth={1} />
                <text x={leftPad - 6} y={y + 4} textAnchor="end" fontSize={10} fill="#9CA3AF">
                  ${val >= 1000 ? (val / 1000).toFixed(1) + 'k' : val.toFixed(0)}
                </text>
              </g>
            )
          })}
          {data.map((d, i) => {
            const barH = Math.max(3, (d.value / max) * chartH)
            const x = leftPad + i * (barW + gap)
            const y = 8 + chartH - barH
            return (
              <g key={i}>
                <rect x={x} y={y} width={barW} height={barH} fill="var(--accent-color)" rx={4} />
                <text x={x + barW / 2} y={chartH + 22} textAnchor="middle" fontSize={10} fill="#6B7280">{d.label}</text>
                <text x={x + barW / 2} y={y - 4} textAnchor="middle" fontSize={9} fill="#374151">
                  ${d.value >= 1000 ? (d.value / 1000).toFixed(1) + 'k' : d.value.toFixed(0)}
                </text>
              </g>
            )
          })}
        </svg>
      </div>
    )
  }

  // Native SVG Donut Chart
  function DonutChart({ data }: { data: { name: string; value: number }[] }) {
    if (data.length === 0) return <p className="text-gray-400 text-center py-8">No data</p>
    const total = data.reduce((s, d) => s + d.value, 0)
    const cx = 80, cy = 80, r = 65, inner = 38
    let angle = -Math.PI / 2

    const slices = data.map((d, i) => {
      const sweep = (d.value / total) * 2 * Math.PI
      const x1 = cx + r * Math.cos(angle)
      const y1 = cy + r * Math.sin(angle)
      angle += sweep
      const x2 = cx + r * Math.cos(angle)
      const y2 = cy + r * Math.sin(angle)
      const ix1 = cx + inner * Math.cos(angle - sweep)
      const iy1 = cy + inner * Math.sin(angle - sweep)
      const ix2 = cx + inner * Math.cos(angle)
      const iy2 = cy + inner * Math.sin(angle)
      const large = sweep > Math.PI ? 1 : 0
      return {
        path: `M ${x1} ${y1} A ${r} ${r} 0 ${large} 1 ${x2} ${y2} L ${ix2} ${iy2} A ${inner} ${inner} 0 ${large} 0 ${ix1} ${iy1} Z`,
        color: COLORS[i % COLORS.length],
        ...d,
      }
    })

    return (
      <div className="flex flex-col sm:flex-row items-center gap-6">
        <svg width={160} height={160} style={{ flexShrink: 0 }}>
          {slices.map((s, i) => <path key={i} d={s.path} fill={s.color} />)}
          <text x={cx} y={cy - 4} textAnchor="middle" fontSize={11} fill="#374151" fontWeight="bold">Total</text>
          <text x={cx} y={cy + 12} textAnchor="middle" fontSize={11} fill="#6B7280">
            ${total >= 1000 ? (total / 1000).toFixed(1) + 'k' : total.toFixed(0)}
          </text>
        </svg>
        <div className="space-y-2 flex-1 w-full">
          {slices.map((s, i) => (
            <div key={i} className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2 min-w-0">
                <div className="w-3 h-3 rounded-sm shrink-0" style={{ backgroundColor: s.color }} />
                <span className="text-sm text-gray-700 truncate">{s.name}</span>
              </div>
              <span className="text-sm font-medium text-gray-900 shrink-0">
                ${s.value.toFixed(0)} ({((s.value / total) * 100).toFixed(0)}%)
              </span>
            </div>
          ))}
        </div>
      </div>
    )
  }

  if (loading) return <div className="p-6 text-gray-500">Loading reports...</div>

  return (
    <div className="p-4 md:p-6 max-w-6xl mx-auto">

      {/* Header */}
      <div className="flex flex-col gap-3 mb-6 md:flex-row md:items-center md:justify-between">
        <h1 className="text-2xl font-bold text-gray-900">Reports</h1>
        <div className="flex flex-wrap gap-2 items-center">
          <select className="border border-gray-200 rounded-lg px-3 py-2 text-sm" value={dateRange} onChange={e => setDateRange(e.target.value)}>
            <option value="this_month">This Month</option>
            <option value="last_month">Last Month</option>
            <option value="this_year">This Year</option>
            <option value="last_year">Last Year</option>
            <option value="custom">Custom Range</option>
          </select>
          {dateRange === 'custom' && (
            <>
              <input type="date" className="border border-gray-200 rounded-lg px-3 py-2 text-sm" value={customStart} onChange={e => setCustomStart(e.target.value)} />
              <span className="text-gray-400">to</span>
              <input type="date" className="border border-gray-200 rounded-lg px-3 py-2 text-sm" value={customEnd} onChange={e => setCustomEnd(e.target.value)} />
              <button onClick={fetchData} className="px-3 py-2 rounded-lg text-white text-sm" style={{ backgroundColor: 'var(--accent-color)' }}>Go</button>
            </>
          )}
        </div>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-3 mb-8">
        {[
          { label: 'Total Revenue', value: '$' + (totalRevenue + totalAddons).toFixed(2), sub: 'incl. add-ons' },
          { label: 'Accommodation', value: '$' + totalRevenue.toFixed(2), sub: 'excl. add-ons' },
          { label: 'Add-on Revenue', value: '$' + totalAddons.toFixed(2), sub: 'from add-ons' },
          { label: 'Total Bookings', value: totalBookings.toString(), sub: 'reservations' },
          { label: 'Avg Stay', value: avgStay.toFixed(1) + ' nights', sub: 'per booking' },
        ].map((stat, i) => (
          <div key={i} className="bg-white rounded-2xl border border-gray-200 p-4">
            <p className="text-xs text-gray-500">{stat.label}</p>
            <p className="text-xl font-bold text-gray-900 mt-1">{stat.value}</p>
            <p className="text-xs text-gray-400 mt-1">{stat.sub}</p>
          </div>
        ))}
      </div>

      {/* Monthly Revenue */}
      <div className="bg-white rounded-2xl border border-gray-200 p-4 md:p-6 mb-6">
        <h2 className="text-lg font-semibold text-gray-900 mb-4">Monthly Revenue</h2>
        <BarChart data={monthlyData} />
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6 mb-6">
        {/* Donut */}
        <div className="bg-white rounded-2xl border border-gray-200 p-4 md:p-6">
          <h2 className="text-lg font-semibold text-gray-900 mb-4">Revenue by Site Type</h2>
          <DonutChart data={siteTypeData} />
        </div>

        {/* Top Sites */}
        <div className="bg-white rounded-2xl border border-gray-200 p-4 md:p-6">
          <h2 className="text-lg font-semibold text-gray-900 mb-4">Top Earning Sites</h2>
          {topSites.length === 0 ? (
            <p className="text-gray-400 text-center py-8">No data</p>
          ) : (
            <div className="space-y-3">
              {topSites.map((site, i) => (
                <div key={i} className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <span className="w-6 h-6 rounded-full bg-gray-100 text-gray-600 text-xs flex items-center justify-center font-medium">{i + 1}</span>
                    <span className="text-sm font-medium text-gray-900">{site.name}</span>
                  </div>
                  <div className="text-right">
                    <p className="text-sm font-semibold text-gray-900">${site.revenue.toFixed(2)}</p>
                    <p className="text-xs text-gray-400">{site.bookings} booking{site.bookings !== 1 ? 's' : ''}</p>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Table */}
      <div className="bg-white rounded-2xl border border-gray-200 p-4 md:p-6">
        <h2 className="text-lg font-semibold text-gray-900 mb-4">Reservations</h2>
        <div className="overflow-x-auto">
          <table className="w-full text-sm" style={{ minWidth: '480px' }}>
            <thead>
              <tr className="border-b border-gray-100">
                <th className="text-left py-2 text-gray-500 font-medium">Site</th>
                <th className="text-left py-2 text-gray-500 font-medium">Arrival</th>
                <th className="text-left py-2 text-gray-500 font-medium">Departure</th>
                <th className="text-left py-2 text-gray-500 font-medium">Nights</th>
                <th className="text-right py-2 text-gray-500 font-medium">Revenue</th>
              </tr>
            </thead>
            <tbody>
              {reservations.slice(0, 10).map(r => {
                const nights = Math.round((new Date(r.departure_date).getTime() - new Date(r.arrival_date).getTime()) / (1000 * 60 * 60 * 24))
                return (
                  <tr key={r.id} className="border-b border-gray-50">
                    <td className="py-2 text-gray-900">{(r.sites as any)?.site_number || '—'}</td>
                    <td className="py-2 text-gray-600">{r.arrival_date}</td>
                    <td className="py-2 text-gray-600">{r.departure_date}</td>
                    <td className="py-2 text-gray-600">{nights}</td>
                    <td className="py-2 text-gray-900 text-right font-medium">${((r.total_price || 0) / 100).toFixed(2)}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}
