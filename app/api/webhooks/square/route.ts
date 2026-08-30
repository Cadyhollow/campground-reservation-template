import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import crypto from 'crypto'
import { normalizeLaneSplit, recordCardPayment } from '@/lib/lane-payments'

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

    // FAIL CLOSED. This used to verify the signature only when a key happened to be configured —
    // `if (sigKey && sigKey !== 'your_webhook_secret_here')` — which removed the guarantee on
    // exactly the deployments that needed it most. Provisioned tenants are never given a
    // SQUARE_WEBHOOK_SIGNATURE_KEY, so the check was skipped entirely and this route accepted
    // unsigned POSTs from anyone. A forged terminal.checkout.updated inserts a folio_payments row
    // and marks a folio paid with no money behind it.
    //
    // No key means this endpoint cannot tell Square from a stranger, and the only safe reading of
    // that is refusal. An unconfigured webhook answering 503 is a visible setup gap; one that
    // quietly accepts forgeries is a way to be robbed.
    if (!sigKey || sigKey === 'your_webhook_secret_here') {
      console.error('Square webhook rejected: SQUARE_WEBHOOK_SIGNATURE_KEY is not configured')
      return NextResponse.json({ error: 'Webhooks are not configured' }, { status: 503 })
    }
    if (!verifySquareWebhook(body, signature, sigKey, url)) {
      console.error('Invalid Square webhook signature')
      return NextResponse.json({ error: 'Invalid signature' }, { status: 401 })
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

        // Record on the folio through THE SHARED SINK — the same function /api/admin-card-payment
        // uses, so the two card paths cannot drift, and one row per lane is written when this
        // checkout was paying specific lanes.
        //
        // ⚠ IDEMPOTENT ON THE SQUARE PAYMENT ID, which this path needs more than any other:
        // Square RETRIES a webhook that did not 200, and the counter screen polls the same
        // checkout while it waits. Without the guard a customer who tapped once could be recorded
        // as having paid twice. With it, whichever gets here first wins and the rest are no-ops.
        const rec = await recordCardPayment(supabase, {
          folioId: terminalCheckout.folio_id,
          squarePaymentId: paymentId,
          split: normalizeLaneSplit(terminalCheckout.lanes),
          amount: terminalCheckout.amount,
          surchargeAmount: terminalCheckout.surcharge_amount || 0,
          note: 'Square Terminal' + (terminalCheckout.note ? ' · ' + terminalCheckout.note : ''),
        })
        if (rec.error) console.error('Terminal payment could not be recorded:', rec.error, paymentId)
        else if (rec.alreadyRecorded) console.log('Terminal payment already recorded, skipping:', paymentId)

        // NOTE: We intentionally do NOT mirror Terminal payments into
        // reservations.amount_paid. Folio money lives ONLY in folio_payments.
        // Mirroring here double-counted the same dollar (booking amount_paid +
        // folio payment), which inflated revenue and produced phantom
        // balances/credits. Paid status is derived everywhere from
        // total_price - amount_paid - folio_payments.

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
