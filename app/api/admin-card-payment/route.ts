import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

export async function POST(request: NextRequest) {
  try {
    const {
      sourceId,
      folioId,
      amount,
      surchargeAmount = 0,
      note = '',
      guestName = '',
    } = await request.json()

    if (!sourceId || !folioId || !amount) {
      return NextResponse.json({ error: 'Missing required fields' }, { status: 400 })
    }

    // Charge the card via Square
    const squareResponse = await fetch('https://connect.squareup.com/v2/payments', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.SQUARE_ACCESS_TOKEN}`,
        'Square-Version': '2024-01-18',
      },
      body: JSON.stringify({
        source_id: sourceId,
        idempotency_key: `ac-${folioId.slice(0,8)}-${Date.now()}`,
        amount_money: { amount, currency: 'USD' },
        location_id: process.env.SQUARE_LOCATION_ID,
      }),
    })

    const squareData = await squareResponse.json()

    if (!squareResponse.ok || !squareData.payment) {
      console.error('Square error:', squareData)
      return NextResponse.json({
        error: squareData.errors?.[0]?.detail || 'Card payment failed. Please check the card details and try again.'
      }, { status: 400 })
    }

    const squarePaymentId = squareData.payment.id

    // Record the payment on the folio
    await supabase.from('folio_payments').insert({
      folio_id: folioId,
      method: 'card',
      amount: amount,
      surcharge_amount: surchargeAmount,
      status: 'completed',
      note: note + (surchargeAmount > 0 ? ` (incl. card fee: $${(surchargeAmount/100).toFixed(2)})` : '') + ' · Manual entry',
      square_payment_id: squarePaymentId,
    })

    return NextResponse.json({ success: true, paymentId: squarePaymentId })

  } catch (error: any) {
    console.error('Admin card payment error:', error)
    return NextResponse.json({ error: error.message || 'Payment failed' }, { status: 500 })
  }
}
