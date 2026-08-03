import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

// Marks a negative folio row as a refund of the BOOKING leg (reservations.amount_paid +
// surcharge_amount) rather than a refund of some payment taken on the folio itself. Both
// kinds live in folio_payments and both are negative, so without this they are
// indistinguishable — and the refund panel needs to subtract only its own kind when working
// out how much of the booking charge is still refundable.
//
// reference_number is an existing column that nothing else writes or reads, so this needs no
// schema change.
export const BOOKING_REFUND_REF = 'booking-refund'

export async function POST(request: NextRequest) {
  try {
    const {
      reservationId, squarePaymentId, refundAmount, reason, currentNotes,
      refundSurchargeAmount,
    } = await request.json()

    if (!reservationId || !refundAmount) {
      return NextResponse.json({ error: 'Missing required fields' }, { status: 400 })
    }

    const refundAmountCents = Math.round(refundAmount * 100)

    // ── What is still refundable, computed here rather than taken from the caller ────────
    // This is the guard on money leaving the business, so it is derived server-side from the
    // reservation and the refunds already recorded. The panel computes the same figure to
    // show the operator, but a stale page or a hand-made request cannot talk this into
    // refunding more than remains.
    const { data: reservation } = await supabase
      .from('reservations')
      .select('id, guest_name, guest_email, amount_paid, surcharge_amount, notes')
      .eq('id', reservationId)
      .single()

    if (!reservation) {
      return NextResponse.json({ error: 'Reservation not found' }, { status: 404 })
    }

    const { data: existingFolios } = await supabase
      .from('folios')
      .select('id')
      .eq('reservation_id', reservationId)

    const folioIds = (existingFolios || []).map((f: any) => f.id)

    // Booking-leg refunds already recorded, as negative cents.
    let alreadyRefunded = 0
    if (folioIds.length > 0) {
      const { data: priorRefunds } = await supabase
        .from('folio_payments')
        .select('amount')
        .in('folio_id', folioIds)
        .eq('reference_number', BOOKING_REFUND_REF)
      alreadyRefunded = (priorRefunds || []).reduce((s: number, r: any) => s + (r.amount || 0), 0)
    }

    // amount_paid is cash-canonical and surcharge_amount sits beside it, so the card was
    // charged the sum. Both are now immutable, so this stays the ORIGINAL booking charge for
    // the life of the reservation and the remaining headroom comes from the refunds instead.
    const originalGross = (reservation.amount_paid || 0) + (reservation.surcharge_amount || 0)
    const remainingRefundable = Math.max(0, originalGross + alreadyRefunded)

    if (refundAmountCents > remainingRefundable) {
      return NextResponse.json({
        error: `Refund exceeds the amount still refundable on this booking ($${(remainingRefundable / 100).toFixed(2)})`,
      }, { status: 400 })
    }

    const refundSurchargeCents = Math.round((refundSurchargeAmount || 0) * 100)
    if (refundSurchargeCents > refundAmountCents) {
      return NextResponse.json({ error: 'Surcharge portion exceeds the refund' }, { status: 400 })
    }

    // Process Square refund if card payment with square_payment_id
    let squareRefundId: string | null = null
    if (squarePaymentId) {
      const squareResponse = await fetch('https://connect.squareup.com/v2/refunds', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${process.env.SQUARE_ACCESS_TOKEN}`,
          'Square-Version': '2024-01-18',
        },
        body: JSON.stringify({
          idempotency_key: `res-refund-${reservationId}-${Date.now()}`,
          payment_id: squarePaymentId,
          amount_money: { amount: refundAmountCents, currency: 'USD' },
          reason: reason || 'Refund',
        }),
      })

      const squareData = await squareResponse.json()
      if (!squareResponse.ok || squareData.errors) {
        console.error('Square refund error:', squareData)
        return NextResponse.json({
          error: squareData.errors?.[0]?.detail || 'Square refund failed'
        }, { status: 400 })
      }
      squareRefundId = squareData.refund?.id || null
    }

    // ── Record the refund on the folio, not on the reservation ──────────────────────────
    // The reservation row carries no payment timestamp, so revenue dates the booking leg by
    // created_at. Decrementing amount_paid therefore pushed the reduction back into the
    // month the booking was CREATED — possibly a closed month — instead of the month the
    // money actually went back. folio_payments has a real paid_at, so recording the refund
    // here dates it correctly and it nets through the same widened status filter and
    // surcharge breakout the folio-side refunds already use.
    //
    // A folio is created on demand: a booking paid entirely online may never have needed one.
    let folioId = folioIds[0]
    if (!folioId) {
      const { data: newFolio, error: folioErr } = await supabase
        .from('folios')
        .insert({
          reservation_id: reservationId,
          guest_name: reservation.guest_name || 'Guest',
          guest_email: reservation.guest_email || '',
          folio_type: 'reservation',
          status: 'open',
        })
        .select()
        .single()
      if (folioErr || !newFolio) {
        return NextResponse.json({ error: 'Could not open a folio to record the refund' }, { status: 500 })
      }
      folioId = newFolio.id
    }

    const { error: rowErr } = await supabase
      .from('folio_payments')
      .insert({
        folio_id: folioId,
        method: squarePaymentId ? 'card' : 'cash',
        amount: -refundAmountCents,
        // Negative like the amount, so the surcharge breakout unwinds by exactly what was
        // handed back instead of still counting it as collected.
        surcharge_amount: -refundSurchargeCents,
        // Counted by the revenue queries (they include 'refunded'), so this reduces revenue
        // in the month it happened.
        status: 'refunded',
        reference_number: BOOKING_REFUND_REF,
        note: `Booking refund: ${reason || 'No reason given'}${squareRefundId ? ` · Square refund ID: ${squareRefundId}` : ''}`,
        square_payment_id: squareRefundId,
      })

    if (rowErr) {
      return NextResponse.json({ error: 'Failed to record refund' }, { status: 500 })
    }

    // amount_paid and surcharge_amount are deliberately NOT touched. They are the record of
    // what was originally taken on the booking; every movement after that lives on the folio,
    // so revenue is reduced exactly once — by the negative row above — instead of twice.
    // The audit note stays, since it is what an operator reads on the reservation.
    const refundNote = `[Refund ${new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}] $${refundAmount.toFixed(2)} refunded${refundSurchargeCents > 0 ? ` (incl. $${(refundSurchargeCents / 100).toFixed(2)} card surcharge)` : ''}${reason ? ` — ${reason}` : ''}${squarePaymentId ? ' (Square)' : ' (cash/check)'}`
    const baseNotes = currentNotes ?? reservation.notes ?? ''
    const updatedNotes = baseNotes ? `${baseNotes}\n${refundNote}` : refundNote

    const { error } = await supabase
      .from('reservations')
      .update({ notes: updatedNotes })
      .eq('id', reservationId)

    if (error) {
      return NextResponse.json({ error: 'Failed to update reservation' }, { status: 500 })
    }

    return NextResponse.json({ success: true })

  } catch (error: any) {
    console.error('Reservation refund error:', error)
    return NextResponse.json({ error: error.message || 'Refund failed' }, { status: 500 })
  }
}
