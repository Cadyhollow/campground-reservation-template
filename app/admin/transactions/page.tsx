'use client'

import { useEffect, useState } from 'react'
import { createClient } from '@supabase/supabase-js'
import { useRouter } from 'next/navigation'

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
)

type Payment = {
  id: string
  paid_at: string
  method: string
  amount: number
  surcharge_amount: number
  status: string
  note: string
  folio_id: string
  folio_type: string
  guest_name: string
  reservation_id: string | null
  guest_id: string | null
  is_reservation_payment?: boolean // true for direct reservation payments (no folio)
}

type LineItem = {
  id: string
  description: string
  quantity: number
  unit_price: number
  line_total: number
  category: string
  charged_at: string
  notes: string | null
}

export default function TransactionsPage() {
  const router = useRouter()
  const [payments, setPayments] = useState<Payment[]>([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [methodFilter, setMethodFilter] = useState('all')
  const [typeFilter, setTypeFilter] = useState('all')
  const [dateRange, setDateRange] = useState('this_month')
  const [customStart, setCustomStart] = useState('')
  const [customEnd, setCustomEnd] = useState('')
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [lineItems, setLineItems] = useState<{ [folioId: string]: LineItem[] }>({})
  const [loadingItems, setLoadingItems] = useState<string | null>(null)
  const [folioIdsByItem, setFolioIdsByItem] = useState<Set<string>>(new Set())
  const [searchingItems, setSearchingItems] = useState(false)

  useEffect(() => { fetchPayments() }, [dateRange])

  useEffect(() => {
    const timer = setTimeout(() => { searchLineItems(search) }, 300)
    return () => clearTimeout(timer)
  }, [search])

  function getDateBounds() {
    const now = new Date()
    if (dateRange === 'custom' && customStart && customEnd) return { start: customStart, end: customEnd }
    if (dateRange === 'today') {
      const d = now.toISOString().split('T')[0]
      return { start: d, end: d }
    }
    if (dateRange === 'this_week') {
      const day = now.getDay()
      const mon = new Date(now)
      mon.setDate(now.getDate() - day + (day === 0 ? -6 : 1))
      return { start: mon.toISOString().split('T')[0], end: now.toISOString().split('T')[0] }
    }
    if (dateRange === 'this_month') return {
      start: new Date(now.getFullYear(), now.getMonth(), 1).toISOString().split('T')[0],
      end: now.toISOString().split('T')[0],
    }
    if (dateRange === 'last_month') {
      const first = new Date(now.getFullYear(), now.getMonth() - 1, 1)
      const last = new Date(now.getFullYear(), now.getMonth(), 0)
      return { start: first.toISOString().split('T')[0], end: last.toISOString().split('T')[0] }
    }
    if (dateRange === 'this_year') return {
      start: new Date(now.getFullYear(), 0, 1).toISOString().split('T')[0],
      end: now.toISOString().split('T')[0],
    }
    if (dateRange === 'last_year') return {
      start: new Date(now.getFullYear() - 1, 0, 1).toISOString().split('T')[0],
      end: new Date(now.getFullYear() - 1, 11, 31).toISOString().split('T')[0],
    }
    return {
      start: new Date(now.getFullYear(), now.getMonth(), 1).toISOString().split('T')[0],
      end: now.toISOString().split('T')[0],
    }
  }

  async function fetchPayments() {
    setLoading(true)
    const { start, end } = getDateBounds()
    const startISO = start + 'T00:00:00'
    const endISO = end + 'T23:59:59'

    // Fetch all completed payments with folio info
    const { data: pmtData } = await supabase
      .from('folio_payments')
      .select(`
        id, paid_at, method, amount, surcharge_amount, status, note, folio_id,
        folios ( id, folio_type, guest_name, reservation_id, guest_id )
      `)
      .eq('status', 'completed')
      .gte('paid_at', startISO)
      .lte('paid_at', endISO)
      .order('paid_at', { ascending: false })

    // Also fetch online reservation payments (stored directly on reservations, no folio)
    const { data: resData } = await supabase
      .from('reservations')
      .select('id, guest_name, amount_paid, payment_type, created_at, square_payment_id')
      .gt('amount_paid', 0)
      .gte('created_at', startISO)
      .lte('created_at', endISO)
      .neq('status', 'cancelled')
      .is('id', null) // placeholder — will be replaced below

    // Get reservation IDs that already have folios (to avoid double counting)
    const { data: folioResIds } = await supabase
      .from('folios')
      .select('reservation_id')
      .not('reservation_id', 'is', null)
    const folioResIdSet = new Set((folioResIds || []).map((f: any) => f.reservation_id))

    // Fetch online reservations WITHOUT folios
    const { data: onlineResData } = await supabase
      .from('reservations')
      .select('id, guest_name, amount_paid, payment_type, payment_method, created_at, square_payment_id')
      .gt('amount_paid', 0)
      .gte('created_at', startISO)
      .lte('created_at', endISO)
      .neq('status', 'cancelled')

    const onlinePayments: Payment[] = (onlineResData || [])
      .filter((r: any) => !folioResIdSet.has(r.id))
      .map((r: any) => ({
        id: 'res-' + r.id,
        paid_at: r.created_at,
        method: r.payment_method || (r.square_payment_id ? 'card' : 'cash'),
        amount: r.amount_paid,
        surcharge_amount: 0,
        status: 'completed',
        note: r.payment_type === 'deposit' ? 'Deposit' : r.payment_type === 'unpaid' ? 'Pay on arrival' : 'Full payment',
        folio_id: '',
        folio_type: 'reservation',
        guest_name: r.guest_name,
        reservation_id: r.id,
        guest_id: null,
        is_reservation_payment: true,
      }))

    if (pmtData) {
      const folioPayments: Payment[] = (pmtData as any[]).map(p => ({
        id: p.id,
        paid_at: p.paid_at,
        method: p.method,
        amount: p.amount,
        surcharge_amount: p.surcharge_amount || 0,
        status: p.status,
        note: p.note || '',
        folio_id: p.folio_id,
        folio_type: p.folios?.folio_type || '',
        guest_name: p.folios?.guest_name || 'Unknown',
        reservation_id: p.folios?.reservation_id || null,
        guest_id: p.folios?.guest_id || null,
        is_reservation_payment: false,
      }))
      // Merge and sort by date descending
      const all = [...folioPayments, ...onlinePayments]
        .sort((a, b) => new Date(b.paid_at).getTime() - new Date(a.paid_at).getTime())
      setPayments(all)
    }
    setLoading(false)
  }

  // Search line items by description when query doesn't match payment fields
  async function searchLineItems(q: string) {
    if (!q.trim()) { setFolioIdsByItem(new Set()); return }
    setSearchingItems(true)
    const { data } = await supabase
      .from('folio_line_items')
      .select('folio_id')
      .ilike('description', '%' + q + '%')
    setFolioIdsByItem(new Set((data || []).map((r: any) => r.folio_id)))
    setSearchingItems(false)
  }

  async function loadLineItems(folioId: string) {
    if (lineItems[folioId]) return // already loaded
    setLoadingItems(folioId)
    const { data } = await supabase
      .from('folio_line_items')
      .select('id, description, quantity, unit_price, line_total, category, charged_at, notes')
      .eq('folio_id', folioId)
      .order('charged_at')
    if (data) setLineItems(prev => ({ ...prev, [folioId]: data as LineItem[] }))
    setLoadingItems(null)
  }

  async function toggleExpand(payment: Payment) {
    if (expandedId === payment.id) {
      setExpandedId(null)
      return
    }
    setExpandedId(payment.id)
    await loadLineItems(payment.folio_id)
  }

  function getFolioHref(p: Payment) {
    // Seasonal guest account — goes to guest folio page
    if (p.folio_type === 'guest_account' && p.guest_id) return '/admin/folio/guest/' + p.guest_id
    // Online reservation payment (no folio) — go to reservation detail
    if (p.is_reservation_payment && p.reservation_id) return '/admin/reservations?id=' + p.reservation_id
    // Folio linked to a reservation — use reservation ID as the folio route param
    if (p.reservation_id) return '/admin/folio/' + p.reservation_id
    // Walk-up folio — use folio ID directly
    if (p.folio_id) return '/admin/folio/' + p.folio_id
    return '/admin/reservations'
  }

  function getTypeLabel(p: Payment) {
    if (p.folio_type === 'guest_account') return { label: 'Seasonal', color: '#15803d', bg: '#f0fdf4' }
    if (p.folio_type === 'reservation') return { label: 'Reservation', color: '#1d4ed8', bg: '#eff6ff' }
    if (p.folio_type === 'walkin' || p.folio_type === 'walkup') return { label: 'Walk-Up', color: '#9333ea', bg: '#faf5ff' }
    return { label: p.folio_type, color: '#6b7280', bg: '#f3f4f6' }
  }

  function methodDot(method: string) {
    if (method === 'cash') return '#f59e0b'
    if (method === 'card') return '#8b5cf6'
    if (method === 'check') return '#6b7280'
    return '#d1d5db'
  }

  // Filtered payments
  const filtered = payments.filter(p => {
    const q = search.toLowerCase()
    const matchSearch = !q ||
      p.guest_name.toLowerCase().includes(q) ||
      (p.amount / 100).toFixed(2).includes(q) ||
      p.method.toLowerCase().includes(q) ||
      p.note.toLowerCase().includes(q) ||
      p.folio_type.toLowerCase().includes(q) ||
      (p.folio_id && folioIdsByItem.has(p.folio_id)) // match by line item description
    const matchMethod = methodFilter === 'all' || p.method === methodFilter
    const matchType = typeFilter === 'all' ||
      (typeFilter === 'reservation' && p.folio_type === 'reservation') ||
      (typeFilter === 'walkin' && (p.folio_type === 'walkin' || p.folio_type === 'walkup')) ||
      (typeFilter === 'seasonal' && p.folio_type === 'guest_account')
    return matchSearch && matchMethod && matchType
  })

  // Group by day
  const byDay: { [day: string]: Payment[] } = {}
  filtered.forEach(p => {
    const day = new Date(p.paid_at).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' })
    if (!byDay[day]) byDay[day] = []
    byDay[day].push(p)
  })

  // Summary totals
  const totalCollected = filtered.reduce((s, p) => s + p.amount, 0) / 100
  const totalCash = filtered.filter(p => p.method === 'cash').reduce((s, p) => s + p.amount, 0) / 100
  const totalCard = filtered.filter(p => p.method === 'card').reduce((s, p) => s + p.amount, 0) / 100
  const totalCheck = filtered.filter(p => p.method === 'check').reduce((s, p) => s + p.amount, 0) / 100

  return (
    <div className="p-4 md:p-6 max-w-5xl mx-auto">

      {/* Header */}
      <div className="flex flex-col gap-3 mb-6 md:flex-row md:items-center md:justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Transactions</h1>
          <p className="text-sm text-gray-500 mt-1">All payments across reservations, walk-up sales, and seasonal accounts</p>
        </div>
        {/* Date range */}
        <div className="flex flex-wrap gap-2 items-center">
          <select
            className="border border-gray-200 rounded-lg px-3 py-2 text-sm"
            value={dateRange}
            onChange={e => setDateRange(e.target.value)}
          >
            <option value="today">Today</option>
            <option value="this_week">This Week</option>
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
              <button onClick={fetchPayments} className="px-3 py-2 rounded-lg text-white text-sm font-medium" style={{ backgroundColor: 'var(--accent-color)' }}>Go</button>
            </>
          )}
        </div>
      </div>

      {/* Summary stats */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6">
        {[
          { label: 'Total Collected', value: '$' + totalCollected.toFixed(2), sub: filtered.length + ' payments' },
          { label: 'Cash', value: '$' + totalCash.toFixed(2), sub: filtered.filter(p => p.method === 'cash').length + ' payments' },
          { label: 'Card', value: '$' + totalCard.toFixed(2), sub: filtered.filter(p => p.method === 'card').length + ' payments' },
          { label: 'Check', value: '$' + totalCheck.toFixed(2), sub: filtered.filter(p => p.method === 'check').length + ' payments' },
        ].map((stat, i) => (
          <div key={i} className="bg-white rounded-2xl border border-gray-200 p-4">
            <p className="text-xs text-gray-500">{stat.label}</p>
            <p className="text-xl font-bold text-gray-900 mt-1">{stat.value}</p>
            <p className="text-xs text-gray-400 mt-1">{stat.sub}</p>
          </div>
        ))}
      </div>

      {/* Filters */}
      <div className="flex flex-wrap gap-2 items-center mb-4">
        <div className="relative flex-1" style={{ minWidth: 200 }}>
          <span className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 text-sm">
            {searchingItems ? '⏳' : '🔍'}
          </span>
          <input
            type="text"
            placeholder="Search by name, amount, method, note, or item (e.g. firewood)..."
            className="w-full border border-gray-200 rounded-lg pl-8 pr-3 py-2 text-sm"
            value={search}
            onChange={e => setSearch(e.target.value)}
          />
          {search && (
            <button onClick={() => setSearch('')} className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600 text-lg leading-none">×</button>
          )}
        </div>
        <select className="border border-gray-200 rounded-lg px-3 py-2 text-sm" value={methodFilter} onChange={e => setMethodFilter(e.target.value)}>
          <option value="all">All Methods</option>
          <option value="cash">Cash</option>
          <option value="card">Card</option>
          <option value="check">Check</option>
        </select>
        <select className="border border-gray-200 rounded-lg px-3 py-2 text-sm" value={typeFilter} onChange={e => setTypeFilter(e.target.value)}>
          <option value="all">All Types</option>
          <option value="reservation">Reservation</option>
          <option value="walkin">Walk-Up</option>
          <option value="seasonal">Seasonal</option>
        </select>
        <span className="text-sm text-gray-400">{filtered.length} result{filtered.length !== 1 ? 's' : ''}</span>
      </div>

      {/* Transaction list */}
      {loading ? (
        <div className="text-center py-12 text-gray-400">Loading transactions...</div>
      ) : filtered.length === 0 ? (
        <div className="text-center py-12 text-gray-400">No transactions found for this period.</div>
      ) : (
        <div className="space-y-6">
          {Object.entries(byDay).map(([day, dayPayments]) => {
            const dayTotal = dayPayments.reduce((s, p) => s + p.amount, 0) / 100
            return (
              <div key={day}>
                {/* Day header */}
                <div className="flex items-center justify-between mb-2 pb-1 border-b border-gray-200">
                  <span className="text-xs font-bold text-gray-500 uppercase tracking-wide">{day}</span>
                  <span className="text-xs font-semibold text-gray-700">${dayTotal.toFixed(2)}</span>
                </div>

                <div className="bg-white border border-gray-200 rounded-xl overflow-hidden">
                  {dayPayments.map((p, i) => {
                    const typeInfo = getTypeLabel(p)
                    const timeStr = new Date(p.paid_at).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
                    const isExpanded = expandedId === p.id
                    const folioLineItems = lineItems[p.folio_id] || []
                    const netAmount = (p.amount - p.surcharge_amount) / 100

                    return (
                      <div key={p.id} style={{ borderBottom: i < dayPayments.length - 1 ? '1px solid #f3f4f6' : 'none' }}>
                        {/* Payment row */}
                        <div
                          className="flex items-center gap-3 px-4 py-3 cursor-pointer hover:bg-gray-50 transition-colors"
                          onClick={() => toggleExpand(p)}
                        >
                          {/* Method dot */}
                          <div style={{ width: 10, height: 10, borderRadius: '50%', background: methodDot(p.method), flexShrink: 0 }} />

                          {/* Main info */}
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2 flex-wrap">
                              <span className="font-semibold text-sm text-gray-900">{p.guest_name}</span>
                              <span className="text-xs px-2 py-0.5 rounded-full font-medium" style={{ background: typeInfo.bg, color: typeInfo.color }}>
                                {typeInfo.label}
                              </span>
                              <span className="text-xs px-2 py-0.5 rounded-full font-medium capitalize" style={{ background: '#f3f4f6', color: '#374151' }}>
                                {p.method}
                              </span>
                            </div>
                            <div className="text-xs text-gray-400 mt-0.5">
                              {timeStr}
                              {p.note && <span className="ml-2 italic">· {p.note}</span>}
                            </div>
                          </div>

                          {/* Amount + expand */}
                          <div className="flex items-center gap-3 flex-shrink-0">
                            <div className="text-right">
                              <div className="font-bold text-sm text-gray-900">${(p.amount / 100).toFixed(2)}</div>
                              {p.surcharge_amount > 0 && (
                                <div className="text-xs text-gray-400">incl. ${(p.surcharge_amount / 100).toFixed(2)} fee</div>
                              )}
                            </div>
                            <svg
                              className="w-4 h-4 text-gray-400 transition-transform duration-200"
                              style={{ transform: isExpanded ? 'rotate(180deg)' : 'rotate(0deg)' }}
                              fill="none" stroke="currentColor" viewBox="0 0 24 24"
                            >
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                            </svg>
                          </div>
                        </div>

                        {/* Expanded detail */}
                        {isExpanded && (
                          <div className="px-4 pb-4 bg-gray-50 border-t border-gray-100">
                            {loadingItems === p.folio_id ? (
                              <p className="text-xs text-gray-400 py-3">Loading details...</p>
                            ) : (
                              <>
                                {/* Online reservation payments have no line items */}
                                {p.is_reservation_payment ? (
                                  <div className="mt-3 bg-white rounded-lg border border-gray-200 px-3 py-3">
                                    <p className="text-sm text-gray-600">Online reservation payment via Square.</p>
                                    <p className="text-xs text-gray-400 mt-1">Full itemized details are on the reservation record.</p>
                                  </div>
                                ) : folioLineItems.length > 0 ? (
                                  <div className="mt-3">
                                    <p className="text-xs font-700 text-gray-500 uppercase tracking-wide mb-2">Items Charged</p>
                                    <div className="bg-white rounded-lg border border-gray-200 overflow-hidden">
                                      {folioLineItems.map((item, li) => (
                                        <div key={item.id} className="flex items-center justify-between px-3 py-2" style={{ borderBottom: li < folioLineItems.length - 1 ? '1px solid #f9fafb' : 'none' }}>
                                          <div>
                                            <div className="text-sm text-gray-900 font-medium">
                                              {item.description}
                                              {item.quantity > 1 && <span className="text-gray-400 font-normal"> ×{item.quantity}</span>}
                                            </div>
                                            <div className="flex items-center gap-2 mt-0.5">
                                              <span className="text-xs text-gray-400">{item.category}</span>
                                              {item.charged_at && (
                                                <span className="text-xs text-gray-400">
                                                  · {new Date(item.charged_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                                                </span>
                                              )}
                                              {item.notes && <span className="text-xs text-gray-500 italic">· {item.notes}</span>}
                                            </div>
                                          </div>
                                          <span className="text-sm font-semibold text-gray-900">${(item.line_total / 100).toFixed(2)}</span>
                                        </div>
                                      ))}
                                    </div>
                                  </div>
                                ) : (
                                  <p className="text-xs text-gray-400 mt-3">No itemized charges on record.</p>
                                )}

                                {/* Payment summary */}
                                <div className="mt-3 flex items-center justify-between">
                                  <div className="text-xs text-gray-500">
                                    Payment ID: <span className="font-mono text-gray-400">{p.id.slice(0, 8).toUpperCase()}</span>
                                  </div>
                                  <button
                                    onClick={() => router.push(getFolioHref(p))}
                                    className="text-xs font-semibold px-3 py-1.5 rounded-lg text-white transition-colors"
                                    style={{ backgroundColor: 'var(--accent-color)' }}
                                  >
                                    Open Folio →
                                  </button>
                                </div>
                              </>
                            )}
                          </div>
                        )}
                      </div>
                    )
                  })}
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
