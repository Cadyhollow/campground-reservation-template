import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { resolveCancellationPolicy, computePolicyRefund } from '@/lib/cancellation-policy'
import {
  processReservationRefund, bookingRefundsSoFar, prorateSurcharge,
} from '@/lib/reservation-refund'

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

// ── Cancel and refund, in that order ──────────────────────────────────────────────────────
//
// Cancelling used to be a bare status write from the browser: it never touched the folio,
// never applied the policy, and never returned any money — and because the refund panel is
// hidden on a cancelled reservation, cancelling FIRST stranded the guest's money where no
// operator could give it back. This route makes the two halves one action, and orders them so
// the irreversible half goes first.
//
// Refund first, cancel second. A refund that fails leaves the reservation exactly as it was —
// still active, still refundable, the operator can retry. The opposite order would land a
// booking in cancelled-but-unrefunded, which is the state that needs a human and a phone call
// to get out of.
export async function POST(request: NextRequest) {
  try {
    const {
      reservationId,
      // The operator's requested refund in dollars. A REQUEST, not a ceiling: the ceiling is
      // recomputed below from the reservation and the refunds already recorded. Omit it and
      // the server uses the policy figure it computes itself.
      refundAmount,
      // False for a no-refund cancel: policy says $0, or the operator declined the refund.
      issueRefund = true,
      reason,
    } = await request.json()

    if (!reservationId) {
      return NextResponse.json({ error: 'Missing reservation id' }, { status: 400 })
    }

    const { data: reservation } = await supabase
      .from('reservations')
      .select('id, guest_name, arrival_date, amount_paid, surcharge_amount, payment_type, status, notes, square_payment_id')
      .eq('id', reservationId)
      .single()

    if (!reservation) {
      return NextResponse.json({ error: 'Reservation not found' }, { status: 404 })
    }

    // Already cancelled: answer as a success rather than an error. A second submit of the same
    // cancellation should be a no-op, not a red banner over work that already landed. No
    // refund is attempted, because a refund on a cancelled booking is the operator's explicit
    // call from the refund panel, not something a repeated cancel should trigger.
    if (reservation.status === 'cancelled') {
      return NextResponse.json({ success: true, alreadyCancelled: true, refundedAmount: 0 })
    }

    // ── The policy, resolved server-side ────────────────────────────────────────────────
    // The modal shows the operator a figure computed in the browser from this same rule; it
    // is recomputed here so a stale page, an edited rule, or a hand-made request cannot pass
    // off a number the policy never produced as the policy amount.
    const policy = await resolveCancellationPolicy(supabase, reservation.arrival_date)

    const surchargeCents = reservation.surcharge_amount || 0
    const originalGross = (reservation.amount_paid || 0) + surchargeCents
    const prior = await bookingRefundsSoFar(reservationId)
    const refundableCents = Math.max(0, originalGross + prior.cents)

    const today = new Date().toISOString().split('T')[0]
    const policyRefund = computePolicyRefund({
      policy,
      arrival: reservation.arrival_date,
      today,
      originalGrossCents: originalGross,
      refundableCents,
      paymentType: reservation.payment_type,
    })

    // What to actually refund. The operator may hand back less than the policy allows, or more
    // (a goodwill refund inside the deadline — the modal lets them tick the box and type a
    // figure). What they may never exceed is what is still refundable on the booking, and that
    // cap is enforced inside processReservationRefund from the folio rows themselves, not from
    // anything sent here. An override is recorded in the reason so the folio note says why the
    // amount is not the policy amount.
    const requestedCents = typeof refundAmount === 'number' && Number.isFinite(refundAmount)
      ? Math.max(0, Math.round(refundAmount * 100))
      : policyRefund.refundCents

    const toRefundCents = issueRefund === false ? 0 : Math.min(requestedCents, refundableCents)
    const isOverride = toRefundCents > policyRefund.refundCents

    let refundedCents = 0
    if (toRefundCents > 0) {
      const refundReason = `Cancellation — ${policy.name}${isOverride ? ' (operator override)' : ''}${reason ? `: ${reason}` : ''}`

      const result = await processReservationRefund({
        reservationId,
        squarePaymentId: reservation.square_payment_id,
        refundAmountCents: toRefundCents,
        // Computed here, not sent by the browser: the surcharge share decides how much of the
        // revenue breakout unwinds, so it is derived from the same original charge the cap is.
        refundSurchargeCents: prorateSurcharge(
          toRefundCents, originalGross, surchargeCents, prior.surchargeCents
        ),
        reason: refundReason,
        currentNotes: reservation.notes || '',
      })

      // Money did not move, so nothing else moves either. The reservation stays active and
      // fully refundable, and the operator sees why and can retry.
      if (!result.ok) {
        return NextResponse.json({
          error: result.error,
          cancelled: false,
          refundedAmount: 0,
        }, { status: result.status })
      }
      refundedCents = result.refundedCents
    }

    // ── Only now, the cancellation ──────────────────────────────────────────────────────
    // Notes are re-read rather than reused: the refund above appended its own audit line, and
    // writing the pre-refund copy back would erase it.
    const { data: fresh } = await supabase
      .from('reservations')
      .select('notes')
      .eq('id', reservationId)
      .single()

    const stamp = new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
    const cancelNote = `[Cancelled ${stamp}] ${policy.name} · ${policyRefund.explanation}${refundedCents > 0 ? ` Refunded $${(refundedCents / 100).toFixed(2)}${isOverride ? ' (override)' : ''}.` : ' No refund issued.'}${reason ? ` — ${reason}` : ''}`
    const baseNotes = fresh?.notes ?? reservation.notes ?? ''
    const updatedNotes = baseNotes ? `${baseNotes}\n${cancelNote}` : cancelNote

    const { error: cancelErr } = await supabase
      .from('reservations')
      .update({ status: 'cancelled', notes: updatedNotes })
      .eq('id', reservationId)

    if (cancelErr) {
      // The refund landed but the status write did not. Say so plainly: the money is back with
      // the guest and recorded on the folio, and the reservation still needs cancelling — a
      // retry will find nothing left to refund and simply cancel.
      return NextResponse.json({
        error: refundedCents > 0
          ? `Refund of $${(refundedCents / 100).toFixed(2)} succeeded but the reservation could not be marked cancelled. Try cancelling again — the refund will not be repeated.`
          : 'Could not cancel the reservation.',
        cancelled: false,
        refundedAmount: refundedCents / 100,
      }, { status: 500 })
    }

    return NextResponse.json({
      success: true,
      cancelled: true,
      refundedAmount: refundedCents / 100,
      policy: {
        name: policy.name,
        refund_percent: policy.refund_percent,
        cancellation_deadline_days: policy.cancellation_deadline_days,
        deposit_refundable: policy.deposit_refundable,
        source: policy.source,
      },
      policyRefundAmount: policyRefund.refundCents / 100,
      wasOverride: isOverride,
    })

  } catch (error: any) {
    console.error('Reservation cancel error:', error)
    return NextResponse.json({ error: error.message || 'Cancellation failed' }, { status: 500 })
  }
}
