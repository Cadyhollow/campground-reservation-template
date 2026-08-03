import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { fetchSquareCheckout, normalizeCheckoutState } from '@/lib/square-terminal'

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

// GET /api/terminal/charge?checkoutId=... — what Square currently thinks of this checkout.
//
// The UI has polled this since terminal support was added, but only POST was ever exported,
// so every poll came back 405 and the operator saw "waiting..." until a three-minute timeout
// no matter what the terminal was doing. That blind spot is why a stuck charge had no obvious
// next step.
//
// Deliberately read-only. It would be tempting to record the payment here when Square says
// COMPLETED but the webhook never arrived, except a GET that writes money would race the
// webhook and could record the same payment twice. Recording stays with the webhook.
export async function GET(request: NextRequest) {
  const checkoutId = request.nextUrl.searchParams.get('checkoutId')
  if (!checkoutId) {
    return NextResponse.json({ error: 'Missing checkoutId' }, { status: 400 })
  }

  const { ok, checkout, errors } = await fetchSquareCheckout(checkoutId)
  if (!ok) {
    return NextResponse.json(
      { error: errors?.[0]?.detail || 'Could not read checkout status' },
      { status: 400 }
    )
  }
  return NextResponse.json({
    // Raw Square value — the calendar and guest-folio pollers compare against this.
    status: checkout.status,
    state: normalizeCheckoutState(checkout.status),
    checkoutId: checkout.id,
    paymentId: checkout.payment_ids?.[0] || null,
    amount: checkout.amount_money?.amount ?? null,
    cancelReason: checkout.cancel_reason || null,
  })
}

export async function POST(request: NextRequest) {
  try {
    const { folioId, amount, surchargeAmount, note } = await request.json()

    if (!amount || amount <= 0) {
      return NextResponse.json({ error: 'Invalid amount' }, { status: 400 })
    }

    // Get device ID from settings
    const { data: settings } = await supabase
      .from('settings')
      .select('square_terminal_device_id')
      .single()

    const deviceId = settings?.square_terminal_device_id
    if (!deviceId) {
      return NextResponse.json({ error: 'No Terminal device configured. Please pair your Terminal in Settings first.' }, { status: 400 })
    }

    const idempotencyKey = `folio-${folioId}-${Date.now()}`

    // Send checkout request to Square Terminal API
    const squareResponse = await fetch('https://connect.squareup.com/v2/terminals/checkouts', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.SQUARE_ACCESS_TOKEN}`,
        'Square-Version': '2024-01-18',
      },
      body: JSON.stringify({
        idempotency_key: idempotencyKey,
        checkout: {
          amount_money: {
            amount: amount,
            currency: 'USD',
          },
          device_options: {
            device_id: deviceId,
            tip_settings: {
              allow_tipping: false,
            },
            skip_receipt_screen: false,
          },
          note: note || 'ResoNation charge',
          payment_type: 'CARD_PRESENT',
        },
      }),
    })

    const squareData = await squareResponse.json()

    if (!squareResponse.ok || !squareData.checkout) {
      console.error('Square Terminal error:', squareData)
      return NextResponse.json(
        { error: squareData.errors?.[0]?.detail || 'Failed to send charge to Terminal' },
        { status: 400 }
      )
    }

    const checkoutId = squareData.checkout.id

    // Save terminal checkout record
    const { error: insertError } = await supabase.from('terminal_checkouts').insert({
  folio_id: folioId,
  square_checkout_id: checkoutId,
  amount: amount,
  surcharge_amount: surchargeAmount || 0,
  status: 'pending',
  device_id: deviceId,
  note: note || '',
})

if (insertError) {
  console.error('Failed to insert terminal_checkout:', insertError.message)
}

    return NextResponse.json({
      success: true,
      checkoutId,
      message: 'Charge sent to Terminal — waiting for customer to tap card',
    })

  } catch (error: any) {
    console.error('Terminal charge error:', error)
    return NextResponse.json({ error: error.message || 'Unexpected error' }, { status: 500 })
  }
}
