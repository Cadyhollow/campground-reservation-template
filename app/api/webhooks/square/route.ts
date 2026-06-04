import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import crypto from 'crypto'

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

function verifySquareWebhook(body: string, signature: string, sigKey: string, url: string): boolean {
  try {
    const hmac = crypto.createHmac('sha256', sigKey)
    hmac.update(url + body)
    const hash = hmac.digest('base64')
    return hash === signature
  } catch {
    return false
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.text()
    const signature = request.headers.get('x-square-hmacsha256-signature') || ''
    const sigKey = process.env.SQUARE_WEBHOOK_SIGNATURE_KEY || ''
    const url = request.url

    // Verify webhook signature in production
    if (sigKey && sigKey !== 'your_webhook_secret_here') {
      const valid = verifySquareWebhook(body, signature, sigKey, url)
      if (!valid) {
        console.error('Invalid Square webhook signature')
        return NextResponse.json({ error: 'Invalid signature' }, { status: 401 })
      }
    }

    const event = JSON.parse(body)
    console.log('Square webhook event:', event.type)

    // Handle Terminal checkout events
    if (event.type === 'terminal.checkout.updated') {
      const checkout = event.data?.object?.checkout
      if (!checkout) return NextResponse.json({ ok: true })

      const squareCheckoutId = checkout.id
      const status = checkout.status // COMPLETED, CANCELED, etc.
      const paymentId = checkout.payment_ids?.[0] || ''

      // Find the terminal checkout record
      const { data: terminalCheckout } = await supabase
        .from('terminal_checkouts')
        .select('*')
        .eq('square_checkout_id', squareCheckoutId)
        .single()

      if (!terminalCheckout) {
        console.log('Terminal checkout not found:', squareCheckoutId)
        return NextResponse.json({ ok: true })
      }

      if (status === 'COMPLETED') {
        // Update terminal checkout record
        await supabase
          .from('terminal_checkouts')
          .update({ status: 'completed', payment_id: paymentId, completed_at: new Date().toISOString() })
          .eq('square_checkout_id', squareCheckoutId)

        // Record payment on the folio
        const surchargeAmount = terminalCheckout.surcharge_amount || 0
        await supabase.from('folio_payments').insert({
          folio_id: terminalCheckout.folio_id,
          method: 'card',
          amount: terminalCheckout.amount,
          surcharge_amount: surchargeAmount,
          status: 'completed',
          square_payment_id: paymentId,
          note: 'Square Terminal' + (terminalCheckout.note ? ' · ' + terminalCheckout.note : ''),
        })

        // Update reservation amount_paid if this folio has a reservation
        const { data: folio } = await supabase
          .from('folios')
          .select('reservation_id')
          .eq('id', terminalCheckout.folio_id)
          .single()

        if (folio?.reservation_id) {
          const { data: reservation } = await supabase
            .from('reservations')
            .select('amount_paid, total_price')
            .eq('id', folio.reservation_id)
            .single()
          if (reservation) {
            const baseAmount = terminalCheckout.amount - surchargeAmount
            await supabase
              .from('reservations')
              .update({ amount_paid: reservation.amount_paid + baseAmount })
              .eq('id', folio.reservation_id)
          }
        }

        console.log('Payment recorded for folio:', terminalCheckout.folio_id)

      } else if (status === 'CANCELED') {
        await supabase
          .from('terminal_checkouts')
          .update({ status: 'cancelled' })
          .eq('square_checkout_id', squareCheckoutId)
        console.log('Terminal checkout cancelled:', squareCheckoutId)
      }
    }

    return NextResponse.json({ ok: true })
  } catch (error: any) {
    console.error('Webhook error:', error)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
}
