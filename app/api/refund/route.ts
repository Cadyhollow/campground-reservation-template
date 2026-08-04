import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { folioRefundRef } from '@/lib/refund-refs'
import { folioPaymentRefundable, REFUNDABLE_STATUSES } from '@/lib/refundable'

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

export async function POST(request: NextRequest) {
  try {
    const { paymentId, refundAmount, reason, folioId } = await request.json()

    if (!paymentId || !refundAmount || !folioId) {
      return NextResponse.json({ error: 'Missing required fields' }, { status: 400 })
    }

    // Get the original payment
    const { data: payment } = await supabase
      .from('folio_payments')
      .select('*')
      .eq('id', paymentId)
      .single()

    if (!payment) {
      return NextResponse.json({ error: 'Payment not found' }, { status: 404 })
    }

    // The cap below is only as trustworthy as the folio it measures, so the folio comes from
    // the payment row rather than the request body. Both callers already send the payment's
    // own folio; a mismatch means a malformed or hand-made request, and letting it through
    // would compute headroom against one folio while recording the refund on another.
    if (payment.folio_id !== folioId) {
      return NextResponse.json({ error: 'Payment does not belong to that folio' }, { status: 400 })
    }

    const refundAmountCents = Math.round(refundAmount * 100)

    // ── What is still refundable on this payment ────────────────────────────────────────
    // This used to compare against payment.amount alone, which only ever caught a SINGLE
    // oversized refund: three $50 refunds against a $100 payment each passed on their own,
    // so cumulative refunds could exceed what was charged. Square rejects the excess on card
    // payments, but cash/check reach no processor and had no backstop at all. The folio UI
    // hid the button after the first refund, which masked the hole rather than closing it.
    //
    // Computed server-side from the rows themselves, like the booking leg's cap in
    // /api/reservation-refund — a stale page or a hand-made request cannot talk it into
    // refunding more than remains.
    const { data: folioRows } = await supabase
      .from('folio_payments')
      .select('id, amount, surcharge_amount, reference_number, status')
      .eq('folio_id', payment.folio_id)
      // Same widened status filter revenue uses. 'voided' stays out: a voided payment never
      // happened, so it neither adds headroom nor consumes it. folioPaymentRefundable applies
      // this filter too, so the reports drawer — which selects every status — gets the same
      // number this route does.
      .in('status', REFUNDABLE_STATUSES)

    const rows = folioRows || []

    // The arithmetic itself now lives in lib/refundable.ts, unchanged, because the UI has to
    // decide whether to SHOW a Refund button using exactly the number this route will enforce
    // on submit. When they were separate the UI approximated with status === 'completed', which
    // hid the button on partially-refunded payments that still had headroom. One function, two
    // callers, pinned together by lib/refundable.test.ts.
    const { remainingCents: refundableCents, priorOnPayment, priorRefundCount } =
      folioPaymentRefundable({ id: paymentId, amount: payment.amount }, rows)

    const thisPaymentRef = folioRefundRef(paymentId)

    if (refundAmountCents > refundableCents) {
      return NextResponse.json({
        error: refundableCents === 0
          ? 'This payment has already been fully refunded.'
          : `Refund exceeds what is still refundable on this payment ($${(refundableCents / 100).toFixed(2)})`,
      }, { status: 400 })
    }

    // Share of this refund that is card surcharge, prorated the same way the refund UIs
    // prorate the amount itself. The refund row used to record surcharge_amount: 0, which
    // left the "Card Surcharges Collected" breakout still counting a surcharge that had been
    // handed back — the revenue total netted correctly (it sums the gross `amount`) while the
    // surcharge line did not. Recording it negative here lets the two rows net the same way.
    //
    // Guarded on the original's own surcharge, so a payment that never carried one still
    // records 0 and nothing changes for it.
    const originalSurcharge = payment.surcharge_amount || 0
    const refundSurchargeCents = originalSurcharge > 0 && payment.amount > 0
      ? Math.min(originalSurcharge, Math.round(refundAmountCents * originalSurcharge / payment.amount))
      : 0

    let squareRefundId = null

    // Process Square refund for card payments with a square_payment_id
    if (payment.method === 'card' && payment.square_payment_id) {
      const squareResponse = await fetch('https://connect.squareup.com/v2/refunds', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${process.env.SQUARE_ACCESS_TOKEN}`,
          'Square-Version': '2024-01-18',
        },
        body: JSON.stringify({
          // Derived from stable inputs, never from the clock. A double-submit — an impatient
          // second click, a retried request, a flaky connection — reaches Square with the same
          // key and gets back the refund that already happened instead of issuing a second
          // one. Date.now() made every attempt look new, so the only thing standing between a
          // double-click and a double refund was how fast the button disabled itself. Same
          // construction the booking leg has used since Part 2 (lib/reservation-refund.ts).
          idempotency_key: `refund-${paymentId}-${refundAmountCents}-${priorRefundCount}`,
          payment_id: payment.square_payment_id,
          amount_money: {
            amount: refundAmountCents,
            currency: 'USD',
          },
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

      squareRefundId = squareData.refund?.id
    }

    // Record the refund as a negative payment entry
    const { data: refundRecord, error: refundError } = await supabase
      .from('folio_payments')
      .insert({
        folio_id: payment.folio_id,
        method: payment.method,
        amount: -refundAmountCents, // negative amount
        surcharge_amount: -refundSurchargeCents, // negative too, so it nets against the original
        status: 'refunded',
        // Ties this refund to the payment it came from, so the cap above can subtract it
        // from that payment's headroom next time instead of measuring against the original
        // amount again.
        reference_number: thisPaymentRef,
        note: `Refund: ${reason || 'No reason given'}${squareRefundId ? ` · Square refund ID: ${squareRefundId}` : ''}`,
        square_payment_id: squareRefundId,
      })
      .select()
      .single()

    if (refundError) {
      return NextResponse.json({ error: 'Failed to record refund' }, { status: 500 })
    }

    // Update original payment status to 'partially_refunded' or 'refunded'. Measured on the
    // CUMULATIVE total, not this refund alone — two halves of a payment refunded separately
    // leave nothing outstanding and should read 'refunded', where comparing only the latest
    // amount left it stuck on 'partially_refunded'.
    const newStatus = priorOnPayment + refundAmountCents >= payment.amount ? 'refunded' : 'partially_refunded'
    await supabase
      .from('folio_payments')
      .update({ status: newStatus })
      .eq('id', paymentId)

    return NextResponse.json({ success: true, refundId: refundRecord.id })

  } catch (error: any) {
    console.error('Refund error:', error)
    return NextResponse.json({ error: error.message || 'Refund failed' }, { status: 500 })
  }
}
