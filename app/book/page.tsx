// The booking page, as a server component.
//
// Security PR 7-1. This file used to BE the booking form — a 'use client' component that opened
// a Supabase client with the publishable key and queried settings, fees, addons, reservations
// and discounts straight from the browser. Those reads now run here on the service-role key
// (lib/book-server.ts) or behind a scoped server route (/api/discount), and the interactive half
// receives their results as props. The form itself moved to ./BookingForm.tsx unchanged apart
// from where its data comes from.
//
// It is not only a hardening move, it is now the only thing that works: a camper has no session,
// so a browser client runs as `anon`, and the locked-down schema grants anon nothing. Left as it
// was, /book would price every stay from empty arrays.
//
// Same move app/page.tsx makes for the home page, and lib/confirmation-server.ts for the
// confirmation. After this there is no publishable-key read left in the browser on any public
// page.

import { Suspense } from 'react'
import { getBookingPageData } from '@/lib/book-server'
import BookingForm from './BookingForm'

// The layout already forces dynamic rendering, but it is stated here too because the reason is
// local: this page's data is a live read of settings, fees, add-ons and the site's turnover, and
// prerendering it would serve one build's answer to every later booking.
export const dynamic = 'force-dynamic'

// A query string can repeat a key (`?siteId=a&siteId=b`), in which case Next hands back an
// array. Take the first, the way URLSearchParams.get() does — which is what the browser half
// still uses, so both halves read the same value out of the same URL.
function first(v: string | string[] | undefined): string {
  return (Array.isArray(v) ? v[0] : v) || ''
}

export default async function BookPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>
}) {
  const sp = await searchParams

  // Only the three the server needs: the site and dates that decide the turnover check.
  // Everything else in the link — site number, rate, nights, guests — is still read in the
  // browser by useSearchParams, exactly as before.
  const data = await getBookingPageData(
    first(sp.siteId),
    first(sp.arrival),
    first(sp.departure),
  )

  return (
    <Suspense fallback={<div className="min-h-screen flex items-center justify-center" style={{ backgroundColor: 'var(--surface-bg)' }}><p className="text-[var(--text-muted)]">Loading...</p></div>}>
      <BookingForm
        settings={data.settings}
        fees={data.fees}
        addons={data.addons}
        earlyBlocked={data.earlyBlocked}
        lateBlocked={data.lateBlocked}
      />
    </Suspense>
  )
}
