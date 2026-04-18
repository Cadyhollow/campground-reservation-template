'use client'

import { useEffect, useState, Suspense } from 'react'
import { useSearchParams } from 'next/navigation'
import Image from 'next/image'
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

  useEffect(() => {
    if (reservationId) fetchReservation()
  }, [reservationId])

  async function fetchReservation() {
    const { data } = await supabase
      .from('reservations')
      .select('*, sites(site_number, site_type)')
      .eq('id', reservationId)
      .single()
    setReservation(data)
    setLoading(false)
  }

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
    <div className="min-h-screen flex items-center justify-center" style={{ backgroundColor: '#1C1C1C' }}>
      <p className="text-gray-400">Loading your confirmation...</p>
    </div>
  )

  if (!reservation) return (
    <div className="min-h-screen flex items-center justify-center" style={{ backgroundColor: '#1C1C1C' }}>
      <p className="text-gray-400">Reservation not found.</p>
    </div>
  )

  return (
    <main className="min-h-screen" style={{ backgroundColor: '#1C1C1C' }}>
      {/* Header */}
      <div className="px-4 py-4 flex items-center gap-4" style={{ backgroundColor: '#2B2B2B' }}>
        <Image
          src="/images/logo.png"
          alt="Campground Logo"
          width={48}
          height={48}
          className="rounded-full"
          style={{ filter: 'hue-rotate(20deg) saturate(1.2)' }}
        />
        <div>
          <h1 className="text-white font-bold">Campground</h1>
          <p className="text-sm" style={{ color: 'process.env.NEXT_PUBLIC_COLOR_ACCENT || 'var(--accent-color)'' }}>Reservation Confirmed</p>
        </div>
      </div>

      <div className="max-w-2xl mx-auto px-4 py-12">
        {/* Success Banner */}
        <div className="rounded-2xl p-8 text-center mb-8" style={{ backgroundColor: '#2B2B2B' }}>
          <div className="text-6xl mb-4">🎉</div>
          <h2 className="text-3xl font-bold text-white mb-2">You're all set!</h2>
          <p className="text-gray-400 mb-2">
            Your reservation is confirmed. A confirmation email has been sent to{' '}
            <span style={{ color: 'process.env.NEXT_PUBLIC_COLOR_ACCENT || 'var(--accent-color)'' }}>{reservation.guest_email}</span>
          </p>
          <p className="text-gray-500 text-sm">
            Confirmation #{reservation.id.slice(0, 8).toUpperCase()}
          </p>
        </div>

        {/* Reservation Details */}
        <div className="rounded-2xl p-6 mb-6" style={{ backgroundColor: '#2B2B2B' }}>
          <h3 className="text-white font-bold text-lg mb-4">Reservation Details</h3>
          <div className="grid grid-cols-2 gap-4 text-sm">
            <div>
              <p className="text-gray-400">Guest</p>
              <p className="text-white font-medium">{reservation.guest_name}</p>
            </div>
            <div>
              <p className="text-gray-400">Site</p>
              <p className="text-white font-medium">
                {siteTypeLabel(reservation.sites?.site_type || '')} {reservation.sites?.site_number}
              </p>
            </div>
            <div>
              <p className="text-gray-400">Arrival</p>
              <p className="text-white font-medium">{reservation.arrival_date}</p>
              <p className="text-gray-500 text-xs">Check-in: 2:00 PM</p>
            </div>
            <div>
              <p className="text-gray-400">Departure</p>
              <p className="text-white font-medium">{reservation.departure_date}</p>
              <p className="text-gray-500 text-xs">Check-out: 12:00 PM</p>
            </div>
            <div>
              <p className="text-gray-400">Guests</p>
              <p className="text-white font-medium">
                {reservation.num_adults} adult{reservation.num_adults !== 1 ? 's' : ''}
                {reservation.num_children > 0 ? `, ${reservation.num_children} child${reservation.num_children !== 1 ? 'ren' : ''}` : ''}
              </p>
            </div>
            <div>
              <p className="text-gray-400">Duration</p>
              <p className="text-white font-medium">{nights} night{nights !== 1 ? 's' : ''}</p>
            </div>
          </div>
        </div>

        {/* Payment Summary */}
        <div className="rounded-2xl p-6 mb-6" style={{ backgroundColor: '#2B2B2B' }}>
          <h3 className="text-white font-bold text-lg mb-4">Payment Summary</h3>
          <div className="space-y-2 text-sm">
            <div className="flex justify-between text-gray-300">
              <span>Total reservation cost</span>
              <span>${(reservation.total_price / 100).toFixed(2)}</span>
            </div>
            <div className="flex justify-between text-green-400">
              <span>Amount paid today</span>
              <span>${(reservation.amount_paid / 100).toFixed(2)}</span>
            </div>
            {reservation.amount_paid < reservation.total_price && (
              <div className="flex justify-between text-yellow-400 border-t border-gray-700 pt-2 mt-2">
                <span>Balance due at check-in</span>
                <span>${((reservation.total_price - reservation.amount_paid) / 100).toFixed(2)}</span>
              </div>
            )}
          </div>
        </div>

        {/* Important Info */}
        <div className="rounded-2xl p-6 mb-8" style={{ backgroundColor: '#2B2B2B' }}>
          <h3 className="text-white font-bold text-lg mb-4">Important Information</h3>
          <div className="space-y-3 text-sm text-gray-300">
            <div className="flex gap-3">
              <span style={{ color: 'process.env.NEXT_PUBLIC_COLOR_ACCENT || 'var(--accent-color)'' }}>✓</span>
              <p>Check-in is at <span className="text-white font-medium">2:00 PM</span>. Please check in at the office upon arrival.</p>
            </div>
            <div className="flex gap-3">
              <span style={{ color: 'process.env.NEXT_PUBLIC_COLOR_ACCENT || 'var(--accent-color)'' }}>✓</span>
              <p>Check-out is at <span className="text-white font-medium">12:00 PM (noon)</span>.</p>
            </div>
            <div className="flex gap-3">
              <span style={{ color: 'process.env.NEXT_PUBLIC_COLOR_ACCENT || 'var(--accent-color)'' }}>✓</span>
              <p>All pets must be on a leash at all times.</p>
            </div>
            <div className="flex gap-3">
              <span style={{ color: 'process.env.NEXT_PUBLIC_COLOR_ACCENT || 'var(--accent-color)'' }}>✓</span>
              <p>Cancellations must be made at least <span className="text-white font-medium">7 days before arrival</span> by contacting us directly.</p>
            </div>
            {reservation.amount_paid < reservation.total_price && (
              <div className="flex gap-3">
                <span className="text-yellow-400">!</span>
                <p>Your remaining balance of <span className="text-white font-medium">${((reservation.total_price - reservation.amount_paid) / 100).toFixed(2)}</span> is due at check-in.</p>
              </div>
            )}
          </div>
        </div>

        {/* Actions */}
        <div className="text-center space-y-4">
          <p className="text-gray-400 text-sm">
            Questions? Contact us at{' '}
            <a href="mailto:info@example.com" style={{ color: 'process.env.NEXT_PUBLIC_COLOR_ACCENT || 'var(--accent-color)'' }}>
              info@example.com
            </a>
          </p>
          <Link
            href="/"
            className="inline-block px-8 py-3 rounded-xl text-white font-semibold"
            style={{ backgroundColor: 'process.env.NEXT_PUBLIC_COLOR_ACCENT || 'var(--accent-color)'' }}
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
      <div className="min-h-screen flex items-center justify-center" style={{ backgroundColor: '#1C1C1C' }}>
        <p className="text-gray-400">Loading...</p>
      </div>
    }>
      <ConfirmationContent />
    </Suspense>
  )
}