import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { fetchSquareCheckout, normalizeCheckoutState } from '@/lib/square-terminal'
import { requireRole } from '@/lib/require-role'
import { getSquareCredentials, SquareCredentialsError } from '@/lib/square-credentials'
import { normalizeLaneSplit, laneSplitTotal, recordCardPayment } from '@/lib/lane-payments'

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
// ⚠ THIS NOW RECORDS ON COMPLETED, AND THAT REVERSES AN EARLIER DECISION — deliberately, with
// the reason it was refused before now removed.
//
// It used to be read-only, and the comment here said why: "a GET that writes money would race
// the webhook and could record the same payment twice." That was correct at the time. It is no
// longer, because recording goes through recordCardPayment(), which is IDEMPOTENT ON THE SQUARE
// PAYMENT ID — whichever of the poll and the webhook arrives first writes the rows, and the other
// finds them already there and does nothing.
//
// Removing that race is worth reversing the decision for, because relying on the webhook alone
// has a real failure mode at a counter: a park whose Square webhook is not configured (or whose
// delivery is delayed, or retried after a 500) takes a tap that never reaches the folio, and the
// operator has no way to tell. Polling is the request that already knows the customer just
// tapped. The webhook still records — it is simply no longer the only thing that can.
export async function GET(request: NextRequest) {
  const denied = await requireRole(request, 'staff')
  if (denied) return denied

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

  const paymentId = checkout.payment_ids?.[0] || null

  // COMPLETED and a real Square payment id — the two conditions, together, before a cent is
  // written. Never on PENDING, never on IN_PROGRESS, never without an id.
  let recorded = false
  if (checkout.status === 'COMPLETED' && paymentId) {
    const { data: tc } = await supabase
      .from('terminal_checkouts')
      .select('*')
      .eq('square_checkout_id', checkout.id)
      .maybeSingle()
    if (tc) {
      const rec = await recordCardPayment(supabase, {
        folioId: tc.folio_id,
        squarePaymentId: paymentId,
        split: normalizeLaneSplit(tc.lanes),
        amount: tc.amount,
        surchargeAmount: tc.surcharge_amount || 0,
        note: 'Square Terminal' + (tc.note ? ' · ' + tc.note : ''),
      })
      recorded = rec.recorded || rec.alreadyRecorded
      if (rec.error) console.error('Terminal payment could not be recorded from the poll:', rec.error, paymentId)
      if (rec.recorded) {
        await supabase.from('terminal_checkouts')
          .update({ status: 'completed', payment_id: paymentId, completed_at: new Date().toISOString() })
          .eq('square_checkout_id', checkout.id)
      }
    }
  }

  return NextResponse.json({
    // Whether the money is on the folio yet — the screen waits for this, not merely for
    // COMPLETED, so it never says "paid" before the books say so.
    recorded,
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
  const denied = await requireRole(request, 'staff')
  if (denied) return denied

  try {
    const { folioId, amount, surchargeAmount, note, lanes } = await request.json()

    // The money-lane split this checkout is paying, when it came from the lane checkout screen.
    // Absent for every other caller (folio, walk-in, calendar), which keeps recording one plain
    // whole-account row exactly as before.
    const laneSplit = normalizeLaneSplit(lanes)

    // ⚠ THE CHARGED AMOUNT IS THE SUM OF THE ROWS THAT WILL BE WRITTEN, never a separately
    // supplied total. Same rule as /api/admin-card-payment: trusting both would let the terminal
    // take one figure while the folio recorded another.
    const chargeAmount = laneSplit.length ? laneSplitTotal(laneSplit) : amount

    if (!chargeAmount || chargeAmount <= 0) {
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

    // WHICH SQUARE ACCOUNT THIS CHARGE LANDS ON — the park's connected account, host and token
    // resolved together from lib/square-credentials.ts. Resolved before the device is asked to
    // do anything, so a credentials problem never leaves a terminal waiting for a tap.
    //
    // The terminal takes no location_id: Square derives the location from the paired DEVICE.
    // That is worth stating, because it means the device and the token must belong to the same
    // merchant — pairing is done through this same resolver in /api/terminal/pair, so a device
    // paired after a reconnect belongs to the account the checkout is sent on.
    let square
    try {
      square = await getSquareCredentials()
    } catch (e) {
      const problem = e instanceof SquareCredentialsError ? e.problem : 'not_connected'
      console.error('Square credentials unavailable for a Terminal charge:', problem, e)
      return NextResponse.json({
        error: problem === 'location_pending'
          ? 'Square is connected but no location has been chosen to take payments on. Finish setup in Settings.'
          : 'Terminal charges are not available right now — Square is not connected.',
      }, { status: 503 })
    }

    const idempotencyKey = `folio-${folioId}-${Date.now()}`

    // Send checkout request to Square Terminal API
    const squareResponse = await fetch(`${square.apiBase}/v2/terminals/checkouts`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${square.accessToken}`,
        'Square-Version': '2024-01-18',
      },
      body: JSON.stringify({
        idempotency_key: idempotencyKey,
        checkout: {
          amount_money: {
            amount: chargeAmount,
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
  amount: chargeAmount,
  surcharge_amount: laneSplit.length
    ? laneSplit.reduce((sum, l) => sum + l.surchargeAmount, 0)
    : (surchargeAmount || 0),
  // Written down because completion arrives at a DIFFERENT request — a webhook or a poll — and
  // the split decided when the charge was sent has to survive that gap. Recomputing it later
  // would use balances that may have moved since the customer was asked to tap.
  lanes: laneSplit.length ? laneSplit : null,
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
