'use client'
import { useEffect, useState, Suspense } from 'react'
import { useRouter } from 'next/navigation'
import { supabase } from '@/lib/supabase'
import CampgroundMap from '@/app/components/CampgroundMap'

type Site = {
  id: string
  site_number: string
  site_type: string
  amp_service: string
  hookups: string
  base_rate: number
  is_available?: boolean
  nightly_rate?: number
  total_price?: number
  nights?: number
  min_stay?: number
  meets_min_stay?: boolean
  description?: string
  max_rv_length?: number | null | undefined
}

type Reservation = {
  id: string
  site_id: string
  arrival_date: string
  departure_date: string
  guest_name: string
  checked_in: boolean
  status: string
}

type SiteStatus = 'arriving' | 'occupied' | 'departing' | 'available' | 'blocked'

function todayLocal() {
  const d = new Date()
  return d.toISOString().split('T')[0]
}

function AdminMapInner() {
  const router = useRouter()
  const [sites, setSites] = useState<Site[]>([])
  const [reservations, setReservations] = useState<Reservation[]>([])
  const [selectedDate, setSelectedDate] = useState(todayLocal())
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    async function fetchData() {
      setLoading(true)
      const { data: siteData } = await supabase
        .from('sites')
        .select('*')
        .order('display_order')
      setSites(siteData || [])

      const { data: resData } = await supabase
        .from('reservations')
        .select('id, site_id, arrival_date, departure_date, guest_name, checked_in, status')
        .neq('status', 'cancelled')
        .lte('arrival_date', selectedDate)
        .gte('departure_date', selectedDate)
      setReservations(resData || [])
      setLoading(false)
    }
    fetchData()
  }, [selectedDate])

  function computeStatuses(): Record<string, SiteStatus> {
    const statuses: Record<string, SiteStatus> = {}
    const siteMap: Record<string, Site> = {}
    sites.forEach(s => { siteMap[s.site_number] = s })

    // Mark all sites as available or blocked based on is_available flag
    sites.forEach(s => { statuses[s.site_number] = (s.is_available !== false) ? 'available' : 'blocked' })

    // Overlay reservation statuses
    reservations.forEach(res => {
      const site = sites.find(s => s.id === res.site_id)
      if (!site) return
      const num = site.site_number
      if (res.arrival_date === selectedDate && res.departure_date === selectedDate) {
        statuses[num] = 'arriving'
      } else if (res.departure_date === selectedDate) {
        statuses[num] = 'departing'
      } else if (res.arrival_date === selectedDate) {
        statuses[num] = res.checked_in ? 'occupied' : 'arriving'
      } else {
        statuses[num] = 'occupied'
      }
    })

    return statuses
  }

  function handleSiteClick(site: Site) {
    const siteStatuses = computeStatuses()
    const status = siteStatuses[site.site_number]

    if (status === 'available') {
      router.push(`/admin/manual-booking?site_id=${site.id}`)
      return
    }

    // Find the reservation for this site on the selected date
    const res = reservations.find(r => r.site_id === site.id)
    if (res) {
      router.push(`/admin/reservations?id=${res.id}`)
    }
  }

  const siteStatuses = computeStatuses()

  const arrivingCount = Object.values(siteStatuses).filter(s => s === 'arriving').length
  const occupiedCount = Object.values(siteStatuses).filter(s => s === 'occupied').length
  const departingCount = Object.values(siteStatuses).filter(s => s === 'departing').length
  const availableCount = Object.values(siteStatuses).filter(s => s === 'available').length

  return (
    <div className="p-4 md:p-6 max-w-6xl mx-auto">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-gray-900">Park Map</h1>
        <p className="text-sm text-gray-500 mt-1">Click any site to view its reservation or start a new booking.</p>
      </div>

      {/* Date picker and legend */}
      <div className="flex flex-wrap items-center gap-4 mb-6">
        <div className="flex items-center gap-2">
          <label className="text-sm font-medium text-gray-700">Date</label>
          <input
            type="date"
            value={selectedDate}
            onChange={e => setSelectedDate(e.target.value)}
            className="border border-gray-200 rounded-lg px-3 py-1.5 text-sm"
          />
        </div>
        <button
          onClick={() => setSelectedDate(todayLocal())}
          className="text-sm px-3 py-1.5 rounded-lg border border-gray-200 text-gray-600 hover:bg-gray-50 transition-colors"
        >
          Today
        </button>
      </div>

      {/* Status counts */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6">
        <div className="bg-white rounded-xl border border-gray-100 px-4 py-3 flex items-center gap-3">
          <div className="w-4 h-4 rounded-sm flex-shrink-0" style={{ backgroundColor: '#fbbf24' }} />
          <div>
            <div className="text-lg font-bold text-gray-900">{arrivingCount}</div>
            <div className="text-xs text-gray-500">Arriving</div>
          </div>
        </div>
        <div className="bg-white rounded-xl border border-gray-100 px-4 py-3 flex items-center gap-3">
          <div className="w-4 h-4 rounded-sm flex-shrink-0" style={{ backgroundColor: '#4ade80' }} />
          <div>
            <div className="text-lg font-bold text-gray-900">{occupiedCount}</div>
            <div className="text-xs text-gray-500">Occupied</div>
          </div>
        </div>
        <div className="bg-white rounded-xl border border-gray-100 px-4 py-3 flex items-center gap-3">
          <div className="w-4 h-4 rounded-sm flex-shrink-0" style={{ backgroundColor: '#fb923c' }} />
          <div>
            <div className="text-lg font-bold text-gray-900">{departingCount}</div>
            <div className="text-xs text-gray-500">Departing</div>
          </div>
        </div>
        <div className="bg-white rounded-xl border border-gray-100 px-4 py-3 flex items-center gap-3">
          <div className="w-4 h-4 rounded-sm flex-shrink-0" style={{ backgroundColor: '#d1d5db' }} />
          <div>
            <div className="text-lg font-bold text-gray-900">{availableCount}</div>
            <div className="text-xs text-gray-500">Available</div>
          </div>
        </div>
      </div>

      {/* Map */}
      {loading ? (
        <div className="flex items-center justify-center h-64 text-gray-400">Loading map...</div>
      ) : (
        <div className="bg-white rounded-2xl border border-gray-100 p-2 md:p-4">
          <CampgroundMap
            sites={sites}
            availableSiteIds={[]}
            siteStatuses={siteStatuses}
            onSelectSite={handleSiteClick}
          />
        </div>
      )}
    </div>
  )
}

export default function AdminMapPage() {
  return (
    <Suspense fallback={<div className="p-6 text-gray-500">Loading...</div>}>
      <AdminMapInner />
    </Suspense>
  )
}
