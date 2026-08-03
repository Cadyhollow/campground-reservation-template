'use client'

import { useEffect, useState, Suspense } from 'react'
import { useSearchParams } from 'next/navigation'
import LogoBadge from '@/app/components/LogoBadge'
import { supabase } from '@/lib/supabase'
import Link from 'next/link'

type Reservation = {
  id: string
  guest_name: string
  guest_email: string
  guest_phone: string
  arrival_date: string
  departure_date: string
  num_adults: number
  num_children: number
  total_price: number
  amount_paid: number
  payment_type: string
  status: string
  sites: { site_number: string; site_type: string } | null
}

function ConfirmationContent() {
  const searchParams = useSearchParams()
  const reservationId = searchParams.get('reservationId')
  const [reservation, setReservation] = useState<Reservation | null>(null)
  const [loading, setLoading] = useState(true)
  const [settings, setSettings] = useState<any>(null)
  const [folioPaid, setFolioPaid] = useState(0)
  const [folioCharges, setFolioCharges] = useState(0)

  useEffect(() => {
    if (reservationId) fetchReservation()
    fetchSettings()
  }, [reservationId])

  async function fetchSettings() {
    const { data } = await supabase.from('settings').select('check_in_time, check_out_time, park_name, logo_url, logo_shape, accent_color').limit(1).single()
    setSettings(data || null)
  }

  async function fetchReservation() {
    const { data } = await supabase
      .from('reservations')
      .select('*, sites(site_number, site_type)')
      .eq('id', reservationId)
      .single()
    setReservation(data)
    await fetchFolioTotals()
    setLoading(false)
  }

  // Money for a booking taken by staff — the wizard, an owner booking, a walk-in — is
  // recorded on the reservation's folio, not in reservations.amount_paid. Reading only
  // amount_paid told those campers they had paid $0.00 and owed the full stay at check-in
  // when they had in fact already paid.
  //
  // Deliberately the same arithmetic as app/api/receipt/route.ts, so this page and the
  // receipt that lands in the camper's inbox cannot disagree: payments are summed NET of
  // the card surcharge (the surcharge is a processing pass-through, not money toward the
  // stay), and folio line items count as charges alongside the stay itself.
  //
  // Aggregated across every folio on the reservation rather than a single one — the receipt
  // route is invoked per folio, but this page only knows the reservation.
  async function fetchFolioTotals() {
    const { data: folios } = await supabase.from('folios').select('id').eq('reservation_id', reservationId)
    const ids = (folios || []).map((f: any) => f.id)
    if (ids.length === 0) return
    const [{ data: pmts }, { data: items }] = await Promise.all([
      // Includes refund rows: a booking refund is now a negative folio row and
      // reservations.amount_paid no longer shrinks, so excluding them would show the guest as
      // having paid money that was handed back.
      supabase.from('folio_payments').select('amount, surcharge_amount').in('status', ['completed', 'refunded', 'partially_refunded']).in('folio_id', ids),
      supabase.from('folio_line_items').select('line_total, voided').in('folio_id', ids),
    ])
    setFolioPaid((pmts || []).reduce((sum: number, p: any) => sum + p.amount - (p.surcharge_amount || 0), 0))
    setFolioCharges((items || []).reduce((sum: number, i: any) => sum + (i.voided ? 0 : (i.line_total || 0)), 0))
  }

  // The receipt route's three figures, by the same formula. With no folio both addends are
  // zero, so an ordinary online card booking renders exactly as it did before.
  const totalPaid = (reservation?.amount_paid || 0) + folioPaid
  const chargesTotal = (reservation?.total_price || 0) + folioCharges
  const balanceRemaining = chargesTotal - totalPaid

  const siteTypeLabel = (type: string) =>
    ({ rv_site: 'RV Site', cabin: 'Cabin', tent: 'Tent Site' }[type] || type)

  const nights = reservation
    ? Math.round(
        (new Date(reservation.departure_date).getTime() -
          new Date(reservation.arrival_date).getTime()) /
          (1000 * 60 * 60 * 24)
      )
    : 0

  if (loading) return (
    <div className="min-h-screen flex items-center justify-center" style={{ backgroundColor: 'var(--surface-bg)' }}>
      <p className="text-[var(--text-muted)]">Loading your confirmation...</p>
    </div>
  )

  if (!reservation) return (
    <div className="min-h-screen flex items-center justify-center" style={{ backgroundColor: 'var(--surface-bg)' }}>
      <p className="text-[var(--text-muted)]">Reservation not found.</p>
    </div>
  )

  return (
    <main className="min-h-screen" style={{ backgroundColor: 'var(--surface-bg)' }}>
      {/* Header */}
      <div className="px-4 py-4 flex items-center gap-4" style={{ backgroundColor: 'var(--surface-card)' }}>
        <LogoBadge
          logoUrl={settings?.logo_url}
          parkName={settings?.park_name}
          shape={settings?.logo_shape}
          accentColor={settings?.accent_color}
          size={48}
        />
        <div>
          <h1 className="text-[var(--text-primary)] font-bold">{settings?.park_name || 'Campground'}</h1>
          <p className="text-sm" style={{ color: 'var(--accent-color)' }}>Reservation Confirmed</p>
        </div>
      </div>

      <div className="max-w-2xl mx-auto px-4 py-12">
        {/* Success Banner */}
        <div className="rounded-2xl p-8 text-center mb-8" style={{ backgroundColor: 'var(--surface-card)' }}>
          <div className="text-6xl mb-4">🎉</div>
          <h2 className="text-3xl font-bold text-[var(--text-primary)] mb-2">You're all set!</h2>
          <p className="text-[var(--text-muted)] mb-2">
            Your reservation is confirmed. A confirmation email has been sent to{' '}
            <span style={{ color: 'var(--accent-color)' }}>{reservation.guest_email}</span>
          </p>
          <p className="text-[var(--text-muted)] text-sm">
            Confirmation #{reservation.id.slice(0, 8).toUpperCase()}
          </p>
        </div>

        {/* Reservation Details */}
        <div className="rounded-2xl p-6 mb-6" style={{ backgroundColor: 'var(--surface-card)' }}>
          <h3 className="text-[var(--text-primary)] font-bold text-lg mb-4">Reservation Details</h3>
          <div className="grid grid-cols-2 gap-4 text-sm">
            <div>
              <p className="text-[var(--text-muted)]">Guest</p>
              <p className="text-[var(--text-primary)] font-medium">{reservation.guest_name}</p>
            </div>
            <div>
              <p className="text-[var(--text-muted)]">Site</p>
              <p className="text-[var(--text-primary)] font-medium">
                {siteTypeLabel(reservation.sites?.site_type || '')} {reservation.sites?.site_number}
              </p>
            </div>
            <div>
              <p className="text-[var(--text-muted)]">Arrival</p>
              <p className="text-[var(--text-primary)] font-medium">{reservation.arrival_date}</p>
              <p className="text-[var(--text-muted)] text-xs">Check-in: {settings?.check_in_time || '2:00 PM'}</p>
            </div>
            <div>
              <p className="text-[var(--text-muted)]">Departure</p>
              <p className="text-[var(--text-primary)] font-medium">{reservation.departure_date}</p>
              <p className="text-[var(--text-muted)] text-xs">Check-out: {settings?.check_out_time || '12:00 PM'}</p>
            </div>
            <div>
              <p className="text-[var(--text-muted)]">Guests</p>
              <p className="text-[var(--text-primary)] font-medium">
                {reservation.num_adults} adult{reservation.num_adults !== 1 ? 's' : ''}
                {reservation.num_children > 0 ? `, ${reservation.num_children} child${reservation.num_children !== 1 ? 'ren' : ''}` : ''}
              </p>
            </div>
            <div>
              <p className="text-[var(--text-muted)]">Duration</p>
              <p className="text-[var(--text-primary)] font-medium">{nights} night{nights !== 1 ? 's' : ''}</p>
            </div>
          </div>
        </div>

        {/* Payment Summary */}
        <div className="rounded-2xl p-6 mb-6" style={{ backgroundColor: 'var(--surface-card)' }}>
          <h3 className="text-[var(--text-primary)] font-bold text-lg mb-4">Payment Summary</h3>
          <div className="space-y-2 text-sm">
            <div className="flex justify-between text-[var(--text-muted)]">
              <span>Total reservation cost</span>
              <span>${(chargesTotal / 100).toFixed(2)}</span>
            </div>
            <div className="flex justify-between text-green-400">
              <span>Amount paid</span>
              <span>${(totalPaid / 100).toFixed(2)}</span>
            </div>
            {balanceRemaining > 0 && (
              <div className="flex justify-between text-yellow-400 border-t border-[var(--border)] pt-2 mt-2">
                <span>Balance due at check-in</span>
                <span>${(balanceRemaining / 100).toFixed(2)}</span>
              </div>
            )}
          </div>
        </div>

        {/* Important Info */}
        <div className="rounded-2xl p-6 mb-8" style={{ backgroundColor: 'var(--surface-card)' }}>
          <h3 className="text-[var(--text-primary)] font-bold text-lg mb-4">Important Information</h3>
          <div className="space-y-3 text-sm text-[var(--text-muted)]">
            <div className="flex gap-3">
              <span style={{ color: 'var(--accent-color)' }}>✓</span>
              <p>Check-in is at <span className="text-[var(--text-primary)] font-medium">{settings?.check_in_time || '2:00 PM'}</span>. Please check in at the office upon arrival.</p>
            </div>
            <div className="flex gap-3">
              <span style={{ color: 'var(--accent-color)' }}>✓</span>
              <p>Check-out is at <span className="text-[var(--text-primary)] font-medium">{settings?.check_out_time || '12:00 PM'}</span>.</p>
            </div>
            <div className="flex gap-3">
              <span style={{ color: 'var(--accent-color)' }}>✓</span>
              <p>All pets must be on a leash at all times.</p>
            </div>
            <div className="flex gap-3">
              <span style={{ color: 'var(--accent-color)' }}>✓</span>
              <p>Cancellations must be made at least <span className="text-[var(--text-primary)] font-medium">7 days before arrival</span> by contacting us directly.</p>
            </div>
            {balanceRemaining > 0 && (
              <div className="flex gap-3">
                <span className="text-yellow-400">!</span>
                <p>Your remaining balance of <span className="text-[var(--text-primary)] font-medium">${(balanceRemaining / 100).toFixed(2)}</span> is due at check-in.</p>
              </div>
            )}
          </div>
        </div>

        {/* Actions */}
        <div className="text-center space-y-4">
          <p className="text-[var(--text-muted)] text-sm">
            Questions? Contact us at{' '}
            <a href="mailto:info@example.com" style={{ color: 'var(--accent-color)' }}>
              info@example.com
            </a>
          </p>
          <Link
            href="/"
            className="inline-block px-8 py-3 rounded-xl text-white font-semibold"
            style={{ backgroundColor: 'var(--accent-color)' }}
          >
            Make Another Reservation
          </Link>
        </div>
      </div>
    </main>
  )
}

export default function ConfirmationPage() {
  return (
    <Suspense fallback={
      <div className="min-h-screen flex items-center justify-center" style={{ backgroundColor: 'var(--surface-bg)' }}>
        <p className="text-[var(--text-muted)]">Loading...</p>
      </div>
    }>
      <ConfirmationContent />
    </Suspense>
  )
}