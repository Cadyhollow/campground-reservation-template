import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { requireRole } from '@/lib/require-role'
import { getSquareCredentials, SquareCredentialsError } from '@/lib/square-credentials'

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

export async function POST(request: NextRequest) {
  const denied = await requireRole(request, 'staff')
  if (denied) return denied

  try {
    const {
      sourceId,
      folioId,
      reservationId,
      amount,
      surchargeAmount = 0,
      note = '',
      guestName = '',
    } = await request.json()

    if (!sourceId || !amount || (!folioId && !reservationId)) {
      return NextResponse.json({ error: 'Missing required fields' }, { status: 400 })
    }

    // WHICH SQUARE ACCOUNT THIS CHARGE LANDS ON.
    //
    // The park's connected Square account, falling back to this deployment's environment
    // variables only when no connection exists. Token, location and API host all come from the
    // SAME source — see lib/square-credentials.ts for why mixing them is the one failure mode
    // worth engineering against.
    //
    // BEFORE the charge, deliberately: if credentials cannot be resolved, nothing has been taken
    // and there is nothing to reconcile. Resolving afterwards would turn a configuration problem
    // into an orphaned charge.
    let square
    try {
      square = await getSquareCredentials()
    } catch (e) {
      const problem = e instanceof SquareCredentialsError ? e.problem : 'not_connected'
      console.error('Square credentials unavailable for an admin card payment:', problem, e)
      return NextResponse.json({
        error: problem === 'location_pending'
          ? 'Square is connected but no location has been chosen to take payments on. Finish setup in Settings.'
          : 'Card payments are not available right now — Square is not connected. Take this payment another way.',
      }, { status: 503 })
    }

    // Charge the card via Square
    const squareResponse = await fetch(`${square.apiBase}/v2/payments`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${square.accessToken}`,
        'Square-Version': '2024-01-18',
      },
      body: JSON.stringify({
        source_id: sourceId,
        idempotency_key: `ac-${(folioId || reservationId).slice(0,8)}-${Date.now()}`,
        amount_money: { amount, currency: 'USD' },
        location_id: square.locationId,
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

    if (folioId) {
      // Record the payment on the folio (check-in / walk-up flow)
      await supabase.from('folio_payments').insert({
        folio_id: folioId,
        method: 'card',
        amount: amount,
        surcharge_amount: surchargeAmount,
        status: 'completed',
        // See the staff folio: the fee is rendered from surcharge_amount now, so baking it
        // into the note printed it twice. Amounts unchanged; ' · Manual entry' kept.
        note: note + ' · Manual entry',
        square_payment_id: squarePaymentId,
      })
    } else {
      // Booking deposit charged against a reservation — record on the reservation,
      // not as a folio_payment, so it is never double-counted at the folio.
      await supabase.from('reservations')
        .update({ square_payment_id: squarePaymentId })
        .eq('id', reservationId)
    }

    return NextResponse.json({ success: true, paymentId: squarePaymentId })

  } catch (error: any) {
    console.error('Admin card payment error:', error)
    return NextResponse.json({ error: error.message || 'Payment failed' }, { status: 500 })
  }
}
