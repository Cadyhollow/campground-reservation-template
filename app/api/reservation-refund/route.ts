import { NextRequest, NextResponse } from 'next/server'
import { BOOKING_REFUND_REF } from '@/lib/refund-refs'
import { processReservationRefund } from '@/lib/reservation-refund'
import { requireAdmin } from '@/lib/require-admin'

// Marks a negative folio row as a refund of the BOOKING leg (reservations.amount_paid +
// surcharge_amount) rather than a refund of some payment taken on the folio itself. Both
// kinds live in folio_payments and both are negative, so without this they are
// indistinguishable — and the refund panel needs to subtract only its own kind when working
// out how much of the booking charge is still refundable.
//
// Now defined in lib/refund-refs.ts alongside the per-payment tag, because /api/refund's cap
// has to exclude booking-leg refunds from the folio's headroom and the two must agree on the
// string. Re-exported here so the original import path keeps working.
export { BOOKING_REFUND_REF }

// The refund itself now lives in lib/reservation-refund.ts, unchanged, so that
// /api/reservation-cancel can reuse it rather than reimplement the cap, the Square call and
// the folio row. This route is the HTTP wrapper it always was: same request body, same
// responses.
export async function POST(request: NextRequest) {
  const denied = await requireAdmin(request)
  if (denied) return denied

  try {
    const {
      reservationId, squarePaymentId, refundAmount, reason, currentNotes,
      refundSurchargeAmount,
    } = await request.json()

    if (!reservationId || !refundAmount) {
      return NextResponse.json({ error: 'Missing required fields' }, { status: 400 })
    }

    const result = await processReservationRefund({
      reservationId,
      squarePaymentId,
      refundAmountCents: Math.round(refundAmount * 100),
      refundSurchargeCents: Math.round((refundSurchargeAmount || 0) * 100),
      reason,
      currentNotes,
    })

    if (!result.ok) {
      return NextResponse.json({ error: result.error }, { status: result.status })
    }

    return NextResponse.json({ success: true })

  } catch (error: any) {
    console.error('Reservation refund error:', error)
    return NextResponse.json({ error: error.message || 'Refund failed' }, { status: 500 })
  }
}
