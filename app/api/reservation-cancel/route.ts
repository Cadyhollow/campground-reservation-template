import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { resolveCancellationPolicy, computePolicyRefund } from '@/lib/cancellation-policy'
import { processReservationRefund, prorateSurcharge } from '@/lib/reservation-refund'
import { processFolioRefund } from '@/lib/folio-refund'
import { requireAdmin } from '@/lib/require-admin'
import {
  reservationRefundable, allocateRefund, REFUNDABLE_STATUSES,
  type RefundAllocation,
} from '@/lib/refundable'

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
  const denied = requireAdmin(request)
  if (denied) return denied

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
    const bookingOriginalGross = (reservation.amount_paid || 0) + surchargeCents

    // ── What is still refundable, across BOTH legs ──────────────────────────────────────
    // Money reaches a reservation two ways and this route used to see only one. A booking taken
    // by staff and paid on the folio has amount_paid = 0, so the cap computed $0, the policy
    // computed a $0 refund and the cancellation returned nothing while the guest's money sat on
    // the folio. Ten live future bookings were in that state holding $763 between them.
    //
    // Every folio row on the reservation, ordered by paid_at so the aggregate's folio-budget
    // clamp is stable between calls. `status` is selected, not merely filtered on, because
    // reservationRefundable re-applies the filter over what it is handed.
    const { data: folios } = await supabase
      .from('folios').select('id').eq('reservation_id', reservationId)
    const folioIds = (folios || []).map((f: any) => f.id)

    let folioRows: any[] = []
    if (folioIds.length > 0) {
      const { data } = await supabase
        .from('folio_payments')
        .select('id, folio_id, amount, surcharge_amount, reference_number, status, method, square_payment_id')
        .in('folio_id', folioIds)
        .in('status', REFUNDABLE_STATUSES)
        .order('paid_at')
      folioRows = data || []
    }

    const refundable = reservationRefundable({
      bookingOriginalGrossCents: bookingOriginalGross,
      bookingSurchargeCents: surchargeCents,
      bookingSquarePaymentId: reservation.square_payment_id,
      folioRows,
    })

    const today = new Date().toISOString().split('T')[0]

    // ── The policy, applied to the WHOLE charge, once ────────────────────────────────────
    // originalGrossTotalCents spans both legs, so a 90% rule takes 90% of everything the guest
    // paid rather than 90% of each leg separately — applying it per-leg would round at each leg
    // and drift from the figure the operator was shown. Clamped to the aggregate remaining, so
    // a policy percentage of an original that has since been partly refunded cannot hand back
    // money already returned.
    const policyRefund = computePolicyRefund({
      policy,
      arrival: reservation.arrival_date,
      today,
      originalGrossCents: refundable.originalGrossTotalCents,
      refundableCents: refundable.totalRemainingCents,
        // Already handed back against this original: the original less what is still there.
        // Stops the percentage being re-applied in full on a retry after a partial refund.
        alreadyRefundedCents: refundable.originalGrossTotalCents - refundable.totalRemainingCents,
      paymentType: reservation.payment_type,
    })

    // What to actually refund. The operator may hand back less than the policy allows, or more
    // (a goodwill refund inside the deadline — the modal lets them tick the box and type a
    // figure). What they may never exceed is what is still refundable, and that ceiling is
    // enforced twice: clamped here against the aggregate, then again inside each writer from
    // the rows themselves. An override is recorded in the reason.
    const requestedCents = typeof refundAmount === 'number' && Number.isFinite(refundAmount)
      ? Math.max(0, Math.round(refundAmount * 100))
      : policyRefund.refundCents

    const toRefundCents = issueRefund === false
      ? 0
      : Math.min(requestedCents, refundable.totalRemainingCents)
    const isOverride = toRefundCents > policyRefund.refundCents
    const refundReason = `Cancellation — ${policy.name}${isOverride ? ' (operator override)' : ''}${reason ? `: ${reason}` : ''}`

    // ── Execute, leg by leg ─────────────────────────────────────────────────────────────
    // Ordered by allocateRefund: the booking leg, then folio card rows Square can credit, then
    // the tenders a human has to hand back. Nothing new writes a refund row — processReservation
    // Refund and processFolioRefund are the same two writers every other refund goes through,
    // each recomputing its own cap from the rows before it moves anything.
    const allocations: RefundAllocation[] = toRefundCents > 0
      ? allocateRefund(toRefundCents, refundable.legs)
      : []

    const performed: {
      kind: string; tender: string; amountCents: number; autoRefundable: boolean;
      paymentId?: string; squareRefundId?: string | null
    }[] = []
    let refundedCents = 0

    for (const { leg, amountCents } of allocations) {
      if (leg.kind === 'booking') {
        const result = await processReservationRefund({
          reservationId,
          squarePaymentId: reservation.square_payment_id,
          refundAmountCents: amountCents,
          // Derived here, not sent by the browser: the surcharge share decides how much of the
          // revenue breakout unwinds, so it comes from the same original charge the cap does.
          refundSurchargeCents: prorateSurcharge(
            amountCents,
            leg.originalGrossCents ?? bookingOriginalGross,
            surchargeCents,
            // bookingLegRefundable reports the surcharge REMAINING; prorateSurcharge expects the
            // already-refunded figure as a negative, so it is reconstructed here.
            (leg.surchargeRemainingCents ?? surchargeCents) - surchargeCents
          ),
          reason: refundReason,
          currentNotes: reservation.notes || '',
        })

        // ── Partial failure: stop, and do NOT cancel ──────────────────────────────────
        // Whatever already succeeded stays recorded as dated negative rows, so the money is not
        // lost and the folio tells the truth. The reservation stays active, which is the
        // recoverable state: a retry recomputes every cap from those rows, sees the reduced
        // headroom, and cannot hand the same money back twice. Cancelling here instead would
        // leave a cancelled booking with a half-returned payment and no way back through the UI.
        if (!result.ok) {
          return NextResponse.json({
            error: result.error,
            cancelled: false,
            refundedAmount: refundedCents / 100,
            performed,
            partial: performed.length > 0,
          }, { status: result.status })
        }
        refundedCents += result.refundedCents
        performed.push({ kind: 'booking', tender: 'booking', amountCents, autoRefundable: leg.autoRefundable })
      } else {
        const result = await processFolioRefund({
          paymentId: leg.paymentId!,
          folioId: leg.folioId!,
          refundAmountCents: amountCents,
          reason: refundReason,
        })

        if (!result.ok) {
          return NextResponse.json({
            error: result.error,
            cancelled: false,
            refundedAmount: refundedCents / 100,
            performed,
            partial: performed.length > 0,
          }, { status: result.status })
        }
        refundedCents += result.refundedCents
        performed.push({
          kind: 'folio-payment', tender: leg.tender, amountCents,
          autoRefundable: leg.autoRefundable, paymentId: leg.paymentId,
          squareRefundId: result.squareRefundId,
        })
      }
    }

    // What the operator still has to physically hand over. Recorded on the folio either way —
    // the money is owed — but no processor moved it, so the response says so and the modal
    // told them before they committed.
    const operatorHandled = performed.filter(p => !p.autoRefundable)
    const operatorHandledCents = operatorHandled.reduce((s, p) => s + p.amountCents, 0)

    // ── Only now, the cancellation ──────────────────────────────────────────────────────
    // Notes are re-read rather than reused: the refund above appended its own audit line, and
    // writing the pre-refund copy back would erase it.
    const { data: fresh } = await supabase
      .from('reservations')
      .select('notes')
      .eq('id', reservationId)
      .single()

    const stamp = new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
    // The manual portion is named in the note as well as the response. It is the part nobody
    // can verify from the data later — the folio shows a refund row either way — so the record
    // has to say which tenders a human still had to hand over.
    const manualNote = operatorHandledCents > 0
      ? ` Return by hand: ${operatorHandled.map(p => `$${(p.amountCents / 100).toFixed(2)} ${p.tender}`).join(', ')}.`
      : ''
    const cancelNote = `[Cancelled ${stamp}] ${policy.name} · ${policyRefund.explanation}${refundedCents > 0 ? ` Refunded $${(refundedCents / 100).toFixed(2)}${isOverride ? ' (override)' : ''}.` : ' No refund issued.'}${manualNote}${reason ? ` — ${reason}` : ''}`
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
      // Per-leg outcomes, so the UI can tell the operator what Square credited and what they
      // still have to hand over rather than implying every dollar went back automatically.
      performed,
      operatorHandledAmount: operatorHandledCents / 100,
      autoRefundedAmount: (refundedCents - operatorHandledCents) / 100,
    })

  } catch (error: any) {
    console.error('Reservation cancel error:', error)
    return NextResponse.json({ error: error.message || 'Cancellation failed' }, { status: 500 })
  }
}
