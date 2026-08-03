import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'

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

    const refundAmountCents = Math.round(refundAmount * 100)

    if (refundAmountCents > payment.amount) {
      return NextResponse.json({ error: 'Refund amount exceeds original payment' }, { status: 400 })
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
          idempotency_key: `refund-${paymentId}-${Date.now()}`,
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
        folio_id: folioId,
        method: payment.method,
        amount: -refundAmountCents, // negative amount
        surcharge_amount: -refundSurchargeCents, // negative too, so it nets against the original
        status: 'refunded',
        note: `Refund: ${reason || 'No reason given'}${squareRefundId ? ` · Square refund ID: ${squareRefundId}` : ''}`,
        square_payment_id: squareRefundId,
      })
      .select()
      .single()

    if (refundError) {
      return NextResponse.json({ error: 'Failed to record refund' }, { status: 500 })
    }

    // Update original payment status to 'partially_refunded' or 'refunded'
    const newStatus = refundAmountCents === payment.amount ? 'refunded' : 'partially_refunded'
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
