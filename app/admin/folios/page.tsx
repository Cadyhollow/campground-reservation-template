'use client'
import { useEffect, useState } from 'react'
import { createClient } from '@supabase/supabase-js'
import { useRouter } from 'next/navigation'

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
)

type FolioRow = {
  id: string
  guest_name: string
  guest_email: string
  folio_type: string
  status: string
  opened_at: string
  reservation_id: string | null
  folio_line_items: { line_total: number }[]
  folio_payments: { amount: number; surcharge_amount: number; status: string; method: string; paid_at: string }[]
  reservations: { site_number: string; arrival_date: string; departure_date: string; total_price: number; amount_paid: number } | null
}

type FolioSummary = FolioRow & {
  items_total: number
  payments_total: number
  balance: number
  last_payment_method: string
  last_paid_at: string
  display_date: string
}

export default function FoliosPage() {
  const router = useRouter()

  // ── Plan/feature gate — redirect if not authorized ──────────────────────
  useEffect(() => {
    supabase.from('settings').select('plan, pos_enabled').single().then(({ data }) => {
      if (data?.plan !== 'summit') router.replace('/admin')
    })
  }, [])

  const [folios, setFolios] = useState<FolioSummary[]>([])
  const [loading, setLoading] = useState(true)
  const [filter, setFilter] = useState<'open' | 'all' | 'walkin' | 'reservation'>('all')
  const [search, setSearch] = useState('')

  useEffect(() => { fetchFolios() }, [filter])

  async function fetchFolios() {
    setLoading(true)

    // Step 1: fetch folios with line items and payments
    let query = supabase
      .from('folios')
      .select(`
        id, guest_name, guest_email, folio_type, status, opened_at, reservation_id,
        folio_line_items ( line_total ),
        folio_payments ( amount, surcharge_amount, status, method, paid_at )
      `)
      .order('opened_at', { ascending: false })

    if (filter === 'open') query = query.eq('status', 'open')
    if (filter === 'walkin') query = query.eq('folio_type', 'walkin')
    if (filter === 'reservation') query = query.eq('folio_type', 'reservation')

    const { data } = await query
    if (!data) { setLoading(false); return }

    // Step 2: batch fetch reservations for folios that have a reservation_id
    const resIds = [...new Set((data as any[]).map(f => f.reservation_id).filter(Boolean))]
    let resMap: { [id: string]: any } = {}
    if (resIds.length > 0) {
      const { data: resData } = await supabase
        .from('reservations')
        .select('id, site_number:site_name, arrival_date, departure_date, total_price, amount_paid')
        .in('id', resIds)
      if (resData) resData.forEach((r: any) => { resMap[r.id] = r })
    }

    const summaries: FolioSummary[] = (data as any[]).map(f => {
      const reservation = f.reservation_id ? resMap[f.reservation_id] || null : null
      const itemsTotal = (f.folio_line_items || []).reduce((s: number, i: any) => s + i.line_total, 0)
      const completedPayments = (f.folio_payments || []).filter((p: any) => p.status === 'completed')
      const paymentsTotal = completedPayments.reduce((s: number, p: any) => s + p.amount - (p.surcharge_amount || 0), 0)
      const resBal = reservation ? Math.max(0, reservation.total_price - reservation.amount_paid) : 0
      const balance = Math.max(0, resBal + itemsTotal - paymentsTotal)

      const sorted = [...completedPayments].sort((a: any, b: any) =>
        new Date(b.paid_at).getTime() - new Date(a.paid_at).getTime()
      )
      const lastPmt = sorted[0]
      const last_payment_method = lastPmt?.method || ''
      const last_paid_at = lastPmt?.paid_at || f.opened_at
      const display_date = last_paid_at || f.opened_at

      return { ...f, reservations: reservation, items_total: itemsTotal, payments_total: paymentsTotal, balance, last_payment_method, last_paid_at, display_date }
    })
    setFolios(summaries)
    setLoading(false)
  }

  // Search filter — also hide empty folios (no payments, no items, no reservation balance)
  const filtered = folios.filter(f => {
    const hasActivity = f.payments_total > 0 || f.items_total > 0 || (f.reservations && f.reservations.total_price > 0)
    if (!hasActivity) return false
    if (!search.trim()) return true
    const q = search.toLowerCase()
    const nameMatch = (f.guest_name || '').toLowerCase().includes(q)
    const amountMatch = ((f.payments_total) / 100).toFixed(2).includes(q)
    const siteMatch = f.reservations?.site_number?.toLowerCase().includes(q) || false
    const methodMatch = f.last_payment_method.toLowerCase().includes(q)
    return nameMatch || amountMatch || siteMatch || methodMatch
  })

  // Group by calendar day
  const byDay: { [day: string]: FolioSummary[] } = {}
  filtered.forEach(f => {
    const d = new Date(f.display_date)
    const day = d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' })
    if (!byDay[day]) byDay[day] = []
    byDay[day].push(f)
  })

  const openCount = folios.filter(f => f.status === 'open').length
  const totalOutstanding = folios.filter(f => f.status === 'open').reduce((s, f) => s + f.balance, 0)

  function getFolioHref(f: FolioSummary) {
    if (f.reservation_id) return '/admin/folio/' + f.reservation_id
    return '/admin/folio/' + f.id
  }

  function methodColor(method: string) {
    if (method === 'cash') return { dot: '#f59e0b', bg: '#fffbeb', text: '#92400e' }
    if (method === 'card') return { dot: '#8b5cf6', bg: '#f5f3ff', text: '#5b21b6' }
    if (method === 'check') return { dot: '#6b7280', bg: '#f3f4f6', text: '#374151' }
    return { dot: '#d1d5db', bg: '#f9fafb', text: '#6b7280' }
  }

  return (
    <div style={{ padding: '1.5rem', maxWidth: 860, margin: '0 auto', fontFamily: 'sans-serif' }}>

      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '1.25rem', flexWrap: 'wrap', gap: 12 }}>
        <div>
          <h1 style={{ fontSize: 24, fontWeight: 700, margin: 0 }}>Guest Folios</h1>
          <p style={{ color: '#6b7280', margin: '4px 0 0', fontSize: 14 }}>Open tabs and payment history</p>
        </div>
        <button
          onClick={() => router.push('/admin/folio/new')}
          style={{ background: '#15803d', color: '#fff', border: 'none', borderRadius: 8, padding: '10px 20px', fontWeight: 600, cursor: 'pointer', fontSize: 14, whiteSpace: 'nowrap' }}
        >
          + New Walk-Up Sale
        </button>
      </div>

      {/* Stats */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 20 }}>
        <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 10, padding: '1rem 1.25rem' }}>
          <div style={{ fontSize: 12, color: '#6b7280', marginBottom: 4 }}>Open folios</div>
          <div style={{ fontSize: 28, fontWeight: 800 }}>{openCount}</div>
        </div>
        <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 10, padding: '1rem 1.25rem' }}>
          <div style={{ fontSize: 12, color: '#6b7280', marginBottom: 4 }}>Total outstanding</div>
          <div style={{ fontSize: 28, fontWeight: 800, color: totalOutstanding > 0 ? '#dc2626' : '#15803d' }}>
            ${(totalOutstanding / 100).toFixed(2)}
          </div>
        </div>
      </div>

      {/* Search */}
      <div style={{ position: 'relative', marginBottom: 14 }}>
        <span style={{ position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)', color: '#9ca3af', fontSize: 16 }}>🔍</span>
        <input
          type="text"
          placeholder="Search by name, site, amount, or payment method..."
          value={search}
          onChange={e => setSearch(e.target.value)}
          style={{ width: '100%', border: '1px solid #e5e7eb', borderRadius: 9, padding: '10px 12px 10px 36px', fontSize: 14, boxSizing: 'border-box', outline: 'none' }}
        />
        {search && (
          <button onClick={() => setSearch('')} style={{ position: 'absolute', right: 12, top: '50%', transform: 'translateY(-50%)', background: 'none', border: 'none', color: '#9ca3af', cursor: 'pointer', fontSize: 18, lineHeight: 1 }}>×</button>
        )}
      </div>

      {/* Filter tabs */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 20, flexWrap: 'wrap' }}>
        {([
          { key: 'open', label: 'Open' },
          { key: 'all', label: 'All Folios' },
          { key: 'walkin', label: 'Walk-Up' },
          { key: 'reservation', label: 'Reservation' },
        ] as const).map(({ key, label }) => (
          <button
            key={key}
            onClick={() => setFilter(key)}
            style={{
              padding: '7px 16px', fontSize: 13, fontWeight: 600,
              border: '1px solid', borderColor: filter === key ? '#15803d' : '#e5e7eb',
              borderRadius: 7, background: filter === key ? '#f0fdf4' : '#fff',
              color: filter === key ? '#15803d' : '#6b7280', cursor: 'pointer'
            }}
          >
            {label}
          </button>
        ))}
        {search && (
          <span style={{ fontSize: 13, color: '#6b7280', alignSelf: 'center', marginLeft: 4 }}>
            {filtered.length} result{filtered.length !== 1 ? 's' : ''}
          </span>
        )}
      </div>

      {/* List */}
      {loading ? (
        <p style={{ color: '#6b7280' }}>Loading folios...</p>
      ) : filtered.length === 0 ? (
        <div style={{ textAlign: 'center', color: '#9ca3af', padding: '3rem 0', fontSize: 14 }}>
          {search ? 'No results for "' + search + '"' : filter === 'open' ? 'No open folios right now.' : 'No folios yet.'}
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
          {Object.entries(byDay).map(([day, dayFolios]) => {
            const dayTotal = dayFolios.reduce((s, f) => s + f.payments_total, 0)
            return (
              <div key={day}>
                {/* Day header */}
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8, paddingBottom: 6, borderBottom: '1px solid #e5e7eb' }}>
                  <span style={{ fontSize: 12, fontWeight: 700, color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.06em' }}>{day}</span>
                  <span style={{ fontSize: 12, fontWeight: 600, color: '#374151' }}>${(dayTotal / 100).toFixed(2)}</span>
                </div>

                {/* Folios for this day */}
                <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 10, overflow: 'hidden' }}>
                  {dayFolios.map((f, i) => {
                    const isPaid = f.balance === 0
                    const colors = methodColor(f.last_payment_method)
                    const timeStr = f.last_paid_at
                      ? new Date(f.last_paid_at).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
                      : ''
                    const siteLabel = f.reservations ? 'Site ' + f.reservations.site_number : null
                    const isWalkup = f.folio_type === 'walkin'

                    return (
                      <div
                        key={f.id}
                        onClick={() => router.push(getFolioHref(f))}
                        style={{
                          display: 'flex', alignItems: 'center', gap: 14, padding: '13px 18px',
                          borderBottom: i < dayFolios.length - 1 ? '1px solid #f3f4f6' : 'none',
                          cursor: 'pointer', background: '#fff'
                        }}
                        onMouseEnter={e => (e.currentTarget.style.background = '#f9fafb')}
                        onMouseLeave={e => (e.currentTarget.style.background = '#fff')}
                      >
                        {/* Method dot */}
                        <div style={{ width: 10, height: 10, borderRadius: '50%', background: colors.dot, flexShrink: 0 }} />

                        {/* Main info */}
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 7, flexWrap: 'wrap' }}>
                            <span style={{ fontWeight: 600, fontSize: 14, color: '#111827' }}>
                              {f.guest_name || 'Walk-up Guest'}
                            </span>
                            {siteLabel && (
                              <span style={{ fontSize: 11, background: '#f0fdf4', color: '#15803d', borderRadius: 4, padding: '2px 6px', fontWeight: 600 }}>
                                {siteLabel}
                              </span>
                            )}
                            {isWalkup && (
                              <span style={{ fontSize: 11, background: '#eff6ff', color: '#3b82f6', borderRadius: 4, padding: '2px 6px', fontWeight: 600 }}>
                                Walk-up
                              </span>
                            )}
                            {f.status !== 'open' && (
                              <span style={{ fontSize: 11, background: '#f3f4f6', color: '#6b7280', borderRadius: 4, padding: '2px 6px' }}>
                                Closed
                              </span>
                            )}
                          </div>
                          <div style={{ fontSize: 12, color: '#9ca3af', marginTop: 2 }}>
                            {timeStr}
                            {f.last_payment_method && (
                              <span style={{ marginLeft: 6, background: colors.bg, color: colors.text, borderRadius: 4, padding: '1px 6px', fontWeight: 600, fontSize: 11 }}>
                                {f.last_payment_method}
                              </span>
                            )}
                            {f.items_total > 0 && (
                              <span style={{ marginLeft: 6, color: '#9ca3af' }}>
                                · {(f.folio_line_items || []).length} item{(f.folio_line_items || []).length !== 1 ? 's' : ''}
                              </span>
                            )}
                          </div>
                        </div>

                        {/* Amount */}
                        <div style={{ textAlign: 'right', flexShrink: 0 }}>
                          <div style={{ fontSize: 16, fontWeight: 800, color: isPaid ? '#15803d' : '#dc2626' }}>
                            {f.payments_total > 0 ? '$' + (f.payments_total / 100).toFixed(2) : '—'}
                          </div>
                          <div style={{ fontSize: 11, color: '#9ca3af' }}>
                            {isPaid ? '✓ paid' : '$' + (f.balance / 100).toFixed(2) + ' due'}
                          </div>
                        </div>
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
