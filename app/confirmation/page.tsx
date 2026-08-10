// The post-payment confirmation, as a server component.
//
// Security PR 3. This page used to be a client component that assembled itself in the browser
// from five anon-key reads — reservations (select('*')), folios, folio_payments,
// folio_line_items and settings. Those reads are why the anon key still needs SELECT on the
// money tables, and PR 6 cannot revoke it while pages like this one depend on it. They now run
// server-side with the service-role key in lib/confirmation-server.ts, and the camper receives
// finished HTML — no Supabase client, no database access, in the browser for this route.
//
// Nothing about who can see a confirmation changes. reservations.id is a random v4 uuid, so
// the link has always been the credential: whoever holds it sees the booking, and ids cannot
// be walked. Relocating the reads preserves that model exactly rather than adding a gate —
// campers are not logged in and must not be asked to be.
//
// It renders directly rather than handing off to a client half because there is nothing
// interactive here: the useState/useEffect it used to carry existed
// only to fetch. Rendered on the server, the "Loading your confirmation..." flash is gone too —
// the summary is in the first paint.

import Link from 'next/link'
import LogoBadge from '@/app/components/LogoBadge'
import { getConfirmation } from '@/lib/confirmation-server'

// Reading searchParams already opts this route out of prerendering; stated explicitly because
// the reason is local — this page is per-booking and must never be cached as one camper's.
export const dynamic = 'force-dynamic'

export default async function ConfirmationPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>
}) {
  // Next 16: searchParams is a promise and must be awaited.
  const params = await searchParams
  const raw = params.reservationId
  const reservationId = Array.isArray(raw) ? raw[0] : raw

  const reservation = await getConfirmation(reservationId ?? null)

  // Same copy the client version showed for a missing or unknown id.
  if (!reservation) return (
    <div className="min-h-screen flex items-center justify-center" style={{ backgroundColor: 'var(--surface-bg)' }}>
      <p className="text-[var(--text-muted)]">Reservation not found.</p>
    </div>
  )

  const { chargesTotal, totalPaid, balanceRemaining } = reservation

  const siteTypeLabel = (type: string) =>
    ({ rv_site: 'RV Site', cabin: 'Cabin', tent: 'Tent Site' }[type] || type)

  const nights = Math.round(
    (new Date(reservation.departure_date).getTime() -
      new Date(reservation.arrival_date).getTime()) /
      (1000 * 60 * 60 * 24)
  )

  return (
    <main className="min-h-screen" style={{ backgroundColor: 'var(--surface-bg)' }}>
      {/* Header */}
      <div className="px-4 py-4 flex items-center gap-4" style={{ backgroundColor: 'var(--surface-card)' }}>
        <LogoBadge
          logoUrl={reservation.logoUrl || undefined}
          parkName={reservation.parkName}
          shape={reservation.logoShape || undefined}
          accentColor={reservation.accentColor || undefined}
          size={48}
        />
        <div>
          <h1 className="text-[var(--text-primary)] font-bold">{reservation.parkName}</h1>
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
                {siteTypeLabel(reservation.site_type)} {reservation.site_number}
              </p>
            </div>
            <div>
              <p className="text-[var(--text-muted)]">Arrival</p>
              <p className="text-[var(--text-primary)] font-medium">{reservation.arrival_date}</p>
              <p className="text-[var(--text-muted)] text-xs">Check-in: {reservation.checkInTime}</p>
            </div>
            <div>
              <p className="text-[var(--text-muted)]">Departure</p>
              <p className="text-[var(--text-primary)] font-medium">{reservation.departure_date}</p>
              <p className="text-[var(--text-muted)] text-xs">Check-out: {reservation.checkOutTime}</p>
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
              <p>Check-in is at <span className="text-[var(--text-primary)] font-medium">{reservation.checkInTime}</span>. Please check in at the office upon arrival.</p>
            </div>
            <div className="flex gap-3">
              <span style={{ color: 'var(--accent-color)' }}>✓</span>
              <p>Check-out is at <span className="text-[var(--text-primary)] font-medium">{reservation.checkOutTime}</span>.</p>
            </div>
            <div className="flex gap-3">
              <span style={{ color: 'var(--accent-color)' }}>✓</span>
              <p>All pets must be on a leash at all times.</p>
            </div>
            {reservation.policyText && (
              <div className="flex gap-3">
                <span style={{ color: 'var(--accent-color)' }}>✓</span>
                <p>
                  {reservation.policyText} To cancel, please contact us directly.
                  {!reservation.depositRefundable && (
                    <span className="text-[var(--text-primary)] font-medium"> The deposit is non-refundable for these dates.</span>
                  )}
                </p>
              </div>
            )}
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
