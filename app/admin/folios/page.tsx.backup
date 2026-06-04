'use client'
import { useEffect, useState } from 'react'
import { createClient } from '@supabase/supabase-js'
import { useRouter } from 'next/navigation'

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
)

type FolioSummary = {
  id: string
  guest_name: string
  guest_email: string
  folio_type: string
  status: string
  opened_at: string
  reservation_id: string | null
  reservation?: {
    site_number: string
    site_type: string
    arrival_date: string
    departure_date: string
    total_price: number
    amount_paid: number
  }
  items_total: number
  payments_total: number
}

export default function FoliosPage() {
  const router = useRouter()
  const [folios, setFolios] = useState<FolioSummary[]>([])
  const [loading, setLoading] = useState(true)
  const [filter, setFilter] = useState<'open' | 'all'>('open')

  useEffect(() => { fetchFolios() }, [filter])

  async function fetchFolios() {
    setLoading(true)
    let query = supabase
      .from('folios')
      .select('id, guest_name, guest_email, folio_type, status, opened_at, reservation_id, folio_line_items(line_total), folio_payments(amount, surcharge_amount, status)')
      .order('opened_at', { ascending: false })

    if (filter === 'open') query = query.eq('status', 'open')

    const { data } = await query

    if (data) {
      const summaries: FolioSummary[] = await Promise.all(data.map(async (f: any) => {
        const itemsTotal = (f.folio_line_items || []).reduce((sum: number, i: any) => sum + i.line_total, 0)
        const paymentsTotal = (f.folio_payments || [])
          .filter((p: any) => p.status === 'completed')
          .reduce((sum: number, p: any) => sum + p.amount - (p.surcharge_amount || 0), 0)

        let reservation = undefined
        if (f.reservation_id) {
          const { data: res } = await supabase
            .from('reservations')
            .select('site_number, site_type, arrival_date, departure_date, total_price, amount_paid')
            .eq('id', f.reservation_id)
            .single()
          if (res) reservation = res
        }

        return { ...f, items_total: itemsTotal, payments_total: paymentsTotal, reservation }
      }))
      setFolios(summaries)
    }
    setLoading(false)
  }

  function getBalance(f: FolioSummary) {
    const resBal = f.reservation ? Math.max(0, f.reservation.total_price - f.reservation.amount_paid) : 0
    return Math.max(0, resBal + f.items_total - f.payments_total)
  }

  function getFolioLabel(f: FolioSummary) {
    if (f.folio_type === 'walkin') return 'Walk-up'
    if (f.reservation) return 'Site ' + f.reservation.site_number
    return 'Reservation'
  }

  function getFolioHref(f: FolioSummary) {
    if (f.reservation_id) return '/admin/folio/' + f.reservation_id
    return '/admin/folio/walkin/' + f.id
  }

  const openCount = folios.filter(f => f.status === 'open').length
  const totalBalance = folios.reduce((sum, f) => sum + getBalance(f), 0)

  return (
    <div style={{ padding: '2rem', maxWidth: 900, margin: '0 auto', fontFamily: 'sans-serif' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1.5rem' }}>
        <div>
          <h1 style={{ fontSize: 24, fontWeight: 700, margin: 0 }}>Guest Folios</h1>
          <p style={{ color: '#6b7280', margin: '4px 0 0', fontSize: 14 }}>Open tabs and payment history</p>
        </div>
        <button
          onClick={() => router.push('/admin/folio/new')}
          style={{ background: '#15803d', color: '#fff', border: 'none', borderRadius: 8, padding: '10px 20px', fontWeight: 600, cursor: 'pointer', fontSize: 14 }}
        >
          + New Walk-Up Sale
        </button>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 24 }}>
        <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 10, padding: '1rem 1.25rem' }}>
          <div style={{ fontSize: 12, color: '#6b7280', marginBottom: 4 }}>Open folios</div>
          <div style={{ fontSize: 28, fontWeight: 800, color: '#111827' }}>{openCount}</div>
        </div>
        <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 10, padding: '1rem 1.25rem' }}>
          <div style={{ fontSize: 12, color: '#6b7280', marginBottom: 4 }}>Total outstanding</div>
          <div style={{ fontSize: 28, fontWeight: 800, color: totalBalance > 0 ? '#dc2626' : '#15803d' }}>
            ${(totalBalance / 100).toFixed(2)}
          </div>
        </div>
      </div>

      <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
        {(['open', 'all'] as const).map(f => (
          <button
            key={f}
            onClick={() => setFilter(f)}
            style={{ padding: '7px 16px', fontSize: 13, fontWeight: 600, border: '1px solid', borderColor: filter === f ? '#15803d' : '#e5e7eb', borderRadius: 7, background: filter === f ? '#f0fdf4' : '#fff', color: filter === f ? '#15803d' : '#6b7280', cursor: 'pointer', textTransform: 'capitalize' }}
          >
            {f === 'open' ? 'Open' : 'All folios'}
          </button>
        ))}
      </div>

      {loading ? (
        <p style={{ color: '#6b7280' }}>Loading folios...</p>
      ) : folios.length === 0 ? (
        <div style={{ textAlign: 'center', color: '#9ca3af', padding: '3rem 0', fontSize: 14 }}>
          {filter === 'open' ? 'No open folios right now.' : 'No folios yet.'}
        </div>
      ) : (
        <div style={{ border: '1px solid #e5e7eb', borderRadius: 10, overflow: 'hidden', background: '#fff' }}>
          {folios.map((f, i) => {
            const balance = getBalance(f)
            const isPaid = balance === 0
            return (
              <div
                key={f.id}
                onClick={() => router.push(getFolioHref(f))}
                style={{ display: 'flex', alignItems: 'center', gap: 16, padding: '14px 20px', borderBottom: i < folios.length - 1 ? '1px solid #f3f4f6' : 'none', cursor: 'pointer', background: '#fff' }}
                onMouseEnter={e => (e.currentTarget.style.background = '#f9fafb')}
                onMouseLeave={e => (e.currentTarget.style.background = '#fff')}
              >
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 2 }}>
                    <span style={{ fontWeight: 600, fontSize: 15 }}>{f.guest_name}</span>
                    <span style={{ fontSize: 11, background: f.folio_type === 'walkin' ? '#eff6ff' : '#f0fdf4', color: f.folio_type === 'walkin' ? '#3b82f6' : '#15803d', borderRadius: 4, padding: '2px 6px', fontWeight: 600 }}>
                      {getFolioLabel(f)}
                    </span>
                    {f.status !== 'open' && (
                      <span style={{ fontSize: 11, background: '#f3f4f6', color: '#6b7280', borderRadius: 4, padding: '2px 6px' }}>
                        Closed
                      </span>
                    )}
                  </div>
                  <div style={{ fontSize: 12, color: '#6b7280' }}>
                    {f.reservation ? f.reservation.arrival_date + ' -> ' + f.reservation.departure_date : new Date(f.opened_at).toLocaleDateString()}
                    {f.items_total > 0 ? ' · $' + (f.items_total/100).toFixed(2) + ' in charges' : ''}
                  </div>
                </div>
                <div style={{ textAlign: 'right', flexShrink: 0 }}>
                  <div style={{ fontSize: 17, fontWeight: 800, color: isPaid ? '#15803d' : '#dc2626' }}>
                    {isPaid ? '✓ Paid' : '$' + (balance/100).toFixed(2)}
                  </div>
                  {!isPaid && <div style={{ fontSize: 11, color: '#9ca3af' }}>due</div>}
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}