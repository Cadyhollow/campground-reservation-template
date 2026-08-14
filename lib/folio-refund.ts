// The folio-payment refund, as a function rather than only as an HTTP route.
//
// Lifted verbatim out of app/api/refund/route.ts so the cancel-and-refund flow can reuse it
// instead of reimplementing it — exactly the move Part 2 made for the booking leg in
// lib/reservation-refund.ts, and for the same reason. Everything that makes this refund safe
// lives in here: the cumulative cap, the Square call with its stable idempotency key, the
// dated negative row, the surcharge unwind, the cumulative status flip. There is one copy.
//
// This is NOT a new writer. It is the existing writer with two callers: /api/refund (unchanged
// behaviour, now a thin wrapper) and the cancellation orchestration. A second implementation
// would be a second place for the cap to drift out of agreement with the folio.
//
// Server-only: it holds a service-role client. Nothing in the browser may import this.

import { createClient } from '@supabase/supabase-js'
import { folioRefundRef } from '@/lib/refund-refs'
import { folioPaymentRefundable, REFUNDABLE_STATUSES } from '@/lib/refundable'
import { getSquareCredentials, SquareCredentialsError } from '@/lib/square-credentials'
import { verifyPaymentOnAccount } from '@/lib/square-refund-account'

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

export type FolioRefundInput = {
  paymentId: string
  // The folio the caller believes the payment belongs to. Checked against the payment row.
  folioId: string
  // GROSS cents — what the card was charged, surcharge included.
  refundAmountCents: number
  reason?: string
}

export type FolioRefundResult =
  | { ok: true; refundId: string; refundedCents: number; squareRefundId: string | null }
  | { ok: false; status: number; error: string }

export async function processFolioRefund(input: FolioRefundInput): Promise<FolioRefundResult> {
  const { paymentId, folioId, refundAmountCents, reason } = input

  const { data: payment } = await supabase
    .from('folio_payments')
    .select('*')
    .eq('id', paymentId)
    .single()

  if (!payment) {
    return { ok: false, status: 404, error: 'Payment not found' }
  }

  // The cap below is only as trustworthy as the folio it measures, so the folio comes from
  // the payment row rather than the caller. Every caller already passes the payment's own
  // folio; a mismatch means a malformed or hand-made request, and letting it through would
  // compute headroom against one folio while recording the refund on another.
  if (payment.folio_id !== folioId) {
    return { ok: false, status: 400, error: 'Payment does not belong to that folio' }
  }

  // ── What is still refundable on this payment ──────────────────────────────────────────
  // Recomputed here from the rows themselves on every call, which is what makes the
  // orchestration safe: a cancellation that refunds three legs in sequence re-reads this
  // between legs, so a retry after a mid-sequence failure sees the headroom the earlier legs
  // already consumed and cannot hand the same money back twice.
  const { data: folioRows } = await supabase
    .from('folio_payments')
    .select('id, amount, surcharge_amount, reference_number, status')
    .eq('folio_id', payment.folio_id)
    // Same widened status filter revenue uses. 'voided' stays out: a voided payment never
    // happened, so it neither adds headroom nor consumes it.
    .in('status', REFUNDABLE_STATUSES)

  const rows = folioRows || []

  const { remainingCents: refundableCents, priorOnPayment, priorRefundCount } =
    folioPaymentRefundable({ id: paymentId, amount: payment.amount }, rows)

  const thisPaymentRef = folioRefundRef(paymentId)

  if (refundAmountCents > refundableCents) {
    return {
      ok: false, status: 400,
      error: refundableCents === 0
        ? 'This payment has already been fully refunded.'
        : `Refund exceeds what is still refundable on this payment ($${(refundableCents / 100).toFixed(2)})`,
    }
  }

  // Share of this refund that is card surcharge, prorated the same way the refund UIs prorate
  // the amount itself. Recording it negative lets the surcharge breakout net the same way the
  // gross amounts do, instead of still counting a surcharge that was handed back.
  //
  // Guarded on the original's own surcharge, so a payment that never carried one records 0.
  const originalSurcharge = payment.surcharge_amount || 0
  const refundSurchargeCents = originalSurcharge > 0 && payment.amount > 0
    ? Math.min(originalSurcharge, Math.round(refundAmountCents * originalSurcharge / payment.amount))
    : 0

  let squareRefundId: string | null = null

  // Card with a Square payment id is the only leg the software can hand back on its own.
  // Cash, check, Venmo and a card row with no Square id reach no processor: the row below is
  // still written — the money is genuinely owed and the folio must say so — but an operator
  // has to physically return it.
  if (payment.method === 'card' && payment.square_payment_id) {
    // WHICH SQUARE ACCOUNT THIS REFUND COMES OUT OF.
    //
    // The park's connected account, with host and token resolved together — the same resolver,
    // and so the same account, the charge used. Money leaving is the direction where getting
    // the account wrong is least recoverable, so it is resolved BEFORE anything is written and
    // checked against the payment below.
    let square
    try {
      square = await getSquareCredentials()
    } catch (e) {
      const problem = e instanceof SquareCredentialsError ? e.problem : 'not_connected'
      console.error('Square credentials unavailable for a folio refund:', problem, e)
      return {
        ok: false, status: 503,
        error: 'Square is not connected, so this card refund cannot be sent. Reconnect Square in Settings and try again.',
      }
    }

    // The corner case the resolver alone cannot cover: a park that switched Square accounts
    // between this charge and this refund. See lib/square-refund-account.ts for what is checked,
    // what is deliberately not, and why a stamped account reference is the better long-term fix.
    const account = await verifyPaymentOnAccount(square, payment.square_payment_id)
    if (!account.ok) {
      return { ok: false, status: 409, error: account.error }
    }

    const squareResponse = await fetch(`${square.apiBase}/v2/refunds`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${square.accessToken}`,
        'Square-Version': '2024-01-18',
      },
      body: JSON.stringify({
        // Derived from stable inputs, never from the clock. A double-submit — an impatient
        // second click, a retried cancellation, a flaky connection — reaches Square with the
        // same key and gets back the refund that already happened instead of issuing a second
        // one. priorRefundCount is what makes a genuine second refund a different key.
        idempotency_key: `refund-${paymentId}-${refundAmountCents}-${priorRefundCount}`,
        payment_id: payment.square_payment_id,
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

  const { data: refundRecord, error: refundError } = await supabase
    .from('folio_payments')
    .insert({
      folio_id: payment.folio_id,
      method: payment.method,
      amount: -refundAmountCents,
      // Negative too, so it nets against the original.
      surcharge_amount: -refundSurchargeCents,
      status: 'refunded',
      // Ties this refund to the payment it came from, so the cap can subtract it from that
      // payment's headroom next time instead of measuring against the original amount again.
      reference_number: thisPaymentRef,
      note: `Refund: ${reason || 'No reason given'}${squareRefundId ? ` · Square refund ID: ${squareRefundId}` : ''}`,
      square_payment_id: squareRefundId,
    })
    .select()
    .single()

  if (refundError || !refundRecord) {
    return { ok: false, status: 500, error: 'Failed to record refund' }
  }

  // Measured on the CUMULATIVE total, not this refund alone — two halves of a payment refunded
  // separately leave nothing outstanding and should read 'refunded'.
  const newStatus = priorOnPayment + refundAmountCents >= payment.amount ? 'refunded' : 'partially_refunded'
  await supabase
    .from('folio_payments')
    .update({ status: newStatus })
    .eq('id', paymentId)

  return { ok: true, refundId: refundRecord.id, refundedCents: refundAmountCents, squareRefundId }
}
