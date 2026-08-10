// The booking-leg refund, as a function rather than only as an HTTP route.
//
// Lifted verbatim out of app/api/reservation-refund/route.ts so the cancel-and-refund flow can
// reuse it instead of reimplementing it. Everything that makes a refund safe lives in here —
// the cumulative over-refund cap, the Square call, the negative folio row, the surcharge
// unwind, the audit note — and there is now exactly one copy of it. A second implementation
// would be a second place for the cap to drift out of agreement with the folio.
//
// Server-only: it holds a service-role client. Nothing in the browser may import this.

import { createClient } from '@supabase/supabase-js'
import { BOOKING_REFUND_REF } from '@/lib/refund-refs'
import { bookingLegRefundable, REFUNDABLE_STATUSES } from '@/lib/refundable'

// prorateSurcharge now lives in lib/refundable.ts so the admin pages can use it without
// dragging this module's service-role client into the client bundle. Re-exported here because
// /api/reservation-cancel imports it from this path.
export { prorateSurcharge } from '@/lib/refundable'

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

export type ReservationRefundInput = {
  reservationId: string
  squarePaymentId?: string | null
  refundAmountCents: number
  refundSurchargeCents: number
  reason?: string
  // What the caller believes the notes to be. Falls back to the stored notes.
  currentNotes?: string | null
}

export type ReservationRefundResult =
  | { ok: true; squareRefundId: string | null; refundedCents: number; notes: string }
  | { ok: false; status: number; error: string }

// The booking-leg refunds already recorded, as negative cents (amount and its surcharge
// share), plus how many of them there are. Callers that need to know what is still refundable
// — or what surcharge is left to unwind — before deciding an amount read it from here rather
// than counting the rows themselves.
export async function bookingRefundsSoFar(
  reservationId: string
): Promise<{ cents: number; surchargeCents: number; count: number }> {
  const { data: existingFolios } = await supabase
    .from('folios')
    .select('id')
    .eq('reservation_id', reservationId)

  const folioIds = (existingFolios || []).map((f: any) => f.id)
  if (folioIds.length === 0) return { cents: 0, surchargeCents: 0, count: 0 }

  const { data: priorRefunds } = await supabase
    .from('folio_payments')
    .select('amount, surcharge_amount, reference_number, status')
    .in('folio_id', folioIds)
    .in('status', REFUNDABLE_STATUSES)

  // Counted through the shared function so this and the refund panel that displays it cannot
  // disagree. The status filter is new here — it previously summed booking-refund rows of ANY
  // status. No such row exists at any status other than 'refunded' (they are only ever written
  // by processReservationRefund below), so this changes no current number; it means a VOIDED
  // refund correctly stops consuming headroom, matching how the folio side already behaves.
  const { priorRefundCents, priorRefundSurchargeCents, priorRefundCount } =
    bookingLegRefundable(0, 0, priorRefunds || [])

  return { cents: priorRefundCents, surchargeCents: priorRefundSurchargeCents, count: priorRefundCount }
}

export async function processReservationRefund(
  input: ReservationRefundInput
): Promise<ReservationRefundResult> {
  const {
    reservationId, squarePaymentId, refundAmountCents, refundSurchargeCents,
    reason, currentNotes,
  } = input

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
    return { ok: false, status: 404, error: 'Reservation not found' }
  }

  const { data: existingFolios } = await supabase
    .from('folios')
    .select('id')
    .eq('reservation_id', reservationId)

  const folioIds = (existingFolios || []).map((f: any) => f.id)

  // Booking-leg refunds already recorded. Read through the same shared function the refund
  // panel uses to decide what to offer, so the figure the operator was shown and the ceiling
  // enforced here are computed identically.
  let priorRows: any[] = []
  if (folioIds.length > 0) {
    const { data: priorRefunds } = await supabase
      .from('folio_payments')
      .select('amount, surcharge_amount, reference_number, status')
      .in('folio_id', folioIds)
      .in('status', REFUNDABLE_STATUSES)
    priorRows = priorRefunds || []
  }

  // amount_paid is cash-canonical and surcharge_amount sits beside it, so the card was
  // charged the sum. Both are now immutable, so this stays the ORIGINAL booking charge for
  // the life of the reservation and the remaining headroom comes from the refunds instead.
  const originalGross = (reservation.amount_paid || 0) + (reservation.surcharge_amount || 0)
  const { remainingCents: remainingRefundable, priorRefundCount } =
    bookingLegRefundable(originalGross, reservation.surcharge_amount || 0, priorRows)

  if (refundAmountCents > remainingRefundable) {
    return {
      ok: false, status: 400,
      error: `Refund exceeds the amount still refundable on this booking ($${(remainingRefundable / 100).toFixed(2)})`,
    }
  }

  if (refundSurchargeCents > refundAmountCents) {
    return { ok: false, status: 400, error: 'Surcharge portion exceeds the refund' }
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
        // Derived from stable inputs, never from the clock. A double-submit — an impatient
        // second click, a retried request — reaches Square with the same key and gets back
        // the refund that already happened instead of issuing a second one. Date.now() made
        // every attempt look new, so the only thing standing between a double-click and a
        // double refund was how fast the button disabled itself.
        idempotency_key: `res-refund-${reservationId}-${refundAmountCents}-${priorRefundCount}`,
        payment_id: squarePaymentId,
        amount_money: { amount: refundAmountCents, currency: 'USD' },
        reason: reason || 'Refund',
      }),
    })

    const squareData = await squareResponse.json()
    if (!squareResponse.ok || squareData.errors) {
      console.error('Square refund error:', squareData)
      return {
        ok: false, status: 400,
        error: squareData.errors?.[0]?.detail || 'Square refund failed',
      }
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
      return { ok: false, status: 500, error: 'Could not open a folio to record the refund' }
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
    return { ok: false, status: 500, error: 'Failed to record refund' }
  }

  // amount_paid and surcharge_amount are deliberately NOT touched. They are the record of
  // what was originally taken on the booking; every movement after that lives on the folio,
  // so revenue is reduced exactly once — by the negative row above — instead of twice.
  // The audit note stays, since it is what an operator reads on the reservation.
  const refundAmount = refundAmountCents / 100
  const refundNote = `[Refund ${new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}] $${refundAmount.toFixed(2)} refunded${refundSurchargeCents > 0 ? ` (incl. $${(refundSurchargeCents / 100).toFixed(2)} transaction fee)` : ''}${reason ? ` — ${reason}` : ''}${squarePaymentId ? ' (Square)' : ' (cash/check)'}`
  const baseNotes = currentNotes ?? reservation.notes ?? ''
  const updatedNotes = baseNotes ? `${baseNotes}\n${refundNote}` : refundNote

  const { error } = await supabase
    .from('reservations')
    .update({ notes: updatedNotes })
    .eq('id', reservationId)

  if (error) {
    return { ok: false, status: 500, error: 'Failed to update reservation' }
  }

  return { ok: true, squareRefundId, refundedCents: refundAmountCents, notes: updatedNotes }
}
