'use client'

import { useEffect, useState } from 'react'
import { supabase } from '@/lib/supabase'
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer, PieChart, Pie, Cell } from 'recharts'

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

const COLORS = ['#4A90D9', '#C4873C', '#2D5A27', '#9B59B6', '#E74C3C']

export default function ReportsPage() {
  const [reservations, setReservations] = useState<Reservation[]>([])
  const [addonRevenue, setAddonRevenue] = useState<AddonRevenue[]>([])
  const [loading, setLoading] = useState(true)
  const [dateRange, setDateRange] = useState('this_year')
  const [customStart, setCustomStart] = useState('')
  const [customEnd, setCustomEnd] = useState('')

  useEffect(() => {
    fetchData()
  }, [dateRange])

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

  // Monthly revenue chart data
  const monthlyData: { [key: string]: { month: string; accommodation: number; addons: number } } = {}
  reservations.forEach(r => {
    const month = r.arrival_date.substring(0, 7)
    const label = new Date(r.arrival_date + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', year: '2-digit' })
    if (!monthlyData[month]) monthlyData[month] = { month: label, accommodation: 0, addons: 0 }
    monthlyData[month].accommodation += (r.total_price || 0) / 100
  })
  const chartData = Object.values(monthlyData)

  // Revenue by site type
  const siteTypeRevenue: { [key: string]: number } = {}
  reservations.forEach(r => {
    const type = (r.sites as any)?.site_type || 'unknown'
    const typeMap: {[key: string]: string} = { rv_site: 'RV Sites', cabin: 'Cabins', tent: 'Tent Sites' }
    const label = typeMap[type] || type
    siteTypeRevenue[label] = (siteTypeRevenue[label] || 0) + ((r.total_price || 0) / 100)
  })
  const pieData = Object.entries(siteTypeRevenue).map(([name, value]) => ({ name, value }))

  // Top sites
  const siteRevenue: { [key: string]: { name: string; revenue: number; bookings: number } } = {}
  reservations.forEach(r => {
    const siteNum = (r.sites as any)?.site_number || 'Unknown'
    if (!siteRevenue[siteNum]) siteRevenue[siteNum] = { name: siteNum, revenue: 0, bookings: 0 }
    siteRevenue[siteNum].revenue += (r.total_price || 0) / 100
    siteRevenue[siteNum].bookings += 1
  })
  const topSites = Object.values(siteRevenue).sort((a, b) => b.revenue - a.revenue).slice(0, 5)

  if (loading) return <div className="p-6 text-gray-500">Loading reports...</div>

  return (
    <div className="p-6 max-w-6xl mx-auto">
      <div className="flex justify-between items-center mb-6">
        <h1 className="text-2xl font-bold text-gray-900">Reports</h1>
        <select
          className="border border-gray-200 rounded-lg px-3 py-2 text-sm"
          value={dateRange}
          onChange={e => setDateRange(e.target.value)}>
          <option value="this_month">This Month</option>
          <option value="last_month">Last Month</option>
          <option value="this_year">This Year</option>
          <option value="last_year">Last Year</option>
          <option value="custom">Custom Range</option>
        </select>
        {dateRange === 'custom' && (
          <div className="flex gap-2 items-center">
            <input type="date" className="border border-gray-200 rounded-lg px-3 py-2 text-sm" value={customStart} onChange={e => setCustomStart(e.target.value)} />
            <span className="text-gray-400">to</span>
            <input type="date" className="border border-gray-200 rounded-lg px-3 py-2 text-sm" value={customEnd} onChange={e => setCustomEnd(e.target.value)} />
            <button onClick={fetchData} className="px-3 py-2 rounded-lg text-white text-sm" style={{backgroundColor: 'var(--accent-color)'}}>Go</button>
          </div>
        )}
      </div>

      {/* Quick Stats */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-8">
        {[
          { label: 'Total Revenue', value: '$' + (totalRevenue + totalAddons).toFixed(2), sub: 'incl. add-ons' },
          { label: 'Accommodation', value: '$' + totalRevenue.toFixed(2), sub: 'excl. add-ons' },
          { label: 'Add-on Revenue', value: '$' + totalAddons.toFixed(2), sub: 'from add-ons' },
          { label: 'Total Bookings', value: totalBookings.toString(), sub: 'reservations' },
          { label: 'Avg Stay', value: avgStay.toFixed(1) + ' nights', sub: 'per booking' },
        ].map((stat, i) => (
          <div key={i} className="bg-white rounded-2xl border border-gray-200 p-4">
            <p className="text-sm text-gray-500">{stat.label}</p>
            <p className="text-2xl font-bold text-gray-900 mt-1">{stat.value}</p>
            <p className="text-xs text-gray-400 mt-1">{stat.sub}</p>
          </div>
        ))}
      </div>

      {/* Monthly Revenue Chart */}
      <div className="bg-white rounded-2xl border border-gray-200 p-6 mb-6">
        <h2 className="text-lg font-semibold text-gray-900 mb-4">Monthly Revenue</h2>
        {chartData.length === 0 ? (
          <p className="text-gray-400 text-center py-8">No data for selected period</p>
        ) : (
          <ResponsiveContainer width="100%" height={300}>
            <BarChart data={chartData}>
              <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
              <XAxis dataKey="month" tick={{ fontSize: 12 }} />
              <YAxis tickFormatter={v => '$' + v.toFixed(0)} tick={{ fontSize: 12 }} />
              <Tooltip formatter={(value: any) => '$' + Number(value).toFixed(2)} />
              <Legend />
              <Bar dataKey="accommodation" name="Accommodation" fill="var(--accent-color)" radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        )}
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6 mb-6">
        {/* Revenue by Site Type */}
        <div className="bg-white rounded-2xl border border-gray-200 p-6">
          <h2 className="text-lg font-semibold text-gray-900 mb-4">Revenue by Site Type</h2>
          {pieData.length === 0 ? (
            <p className="text-gray-400 text-center py-8">No data</p>
          ) : (
            <ResponsiveContainer width="100%" height={250}>
              <PieChart>
                <Pie data={pieData} dataKey="value" nameKey="name" cx="50%" cy="50%" outerRadius={80} label={({ name, percent }) => `${name} ${((percent || 0) * 100).toFixed(0)}%`}>
                  {pieData.map((_, i) => <Cell key={i} fill={COLORS[i % COLORS.length]} />)}
                </Pie>
                <Tooltip formatter={(value: any) => '$' + Number(value).toFixed(2)} />
              </PieChart>
            </ResponsiveContainer>
          )}
        </div>

        {/* Top Sites */}
        <div className="bg-white rounded-2xl border border-gray-200 p-6">
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

      {/* Recent Reservations */}
      <div className="bg-white rounded-2xl border border-gray-200 p-6">
        <h2 className="text-lg font-semibold text-gray-900 mb-4">Reservations</h2>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
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
