import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { requireAdmin } from '@/lib/require-admin'
import {
  fetchSquareCheckout,
  cancelSquareCheckout,
  normalizeCheckoutState,
  isCancellable,
} from '@/lib/square-terminal'

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

// POST /api/terminal/cancel  { checkoutId }
//
// Clears a terminal charge that is hanging — the terminal asleep, a card that will not read,
// a customer who has walked off — so the operator can retry from ResoNation instead of walking
// to the device. Without this the only way out was to cancel on the terminal itself and then
// find some way to make the reservation look settled, which is how a payment that never
// happened ends up recorded by hand.
export async function POST(request: NextRequest) {
  const denied = requireAdmin(request)
  if (denied) return denied

  try {
    const { checkoutId } = await request.json()

    if (!checkoutId) {
      return NextResponse.json({ error: 'Missing checkoutId' }, { status: 400 })
    }

    // Square is the authority on whether this checkout is still open, so ask it before
    // cancelling anything. Our own terminal_checkouts row can be stale: it is only advanced
    // by the webhook, and a missed or delayed webhook is exactly the situation an operator
    // reaches for Cancel in.
    const { ok, checkout, errors } = await fetchSquareCheckout(checkoutId)
    if (!ok) {
      return NextResponse.json(
        { error: errors?.[0]?.detail || 'Could not read checkout status' },
        { status: 400 }
      )
    }

    const state = normalizeCheckoutState(checkout.status)

    // Never cancel a checkout Square reports as COMPLETED. The money is taken; cancelling
    // would leave the operator believing nothing was charged while the customer's card says
    // otherwise. Refunding is the correct route for that, so say so plainly.
    if (state === 'completed') {
      return NextResponse.json({
        error: 'This charge already completed on the terminal — the customer has been charged. Refund it instead of cancelling.',
        status: checkout.status,
        state,
        paymentId: checkout.payment_ids?.[0] || null,
      }, { status: 409 })
    }

    // Already finished cancelling: report success so the UI settles rather than erroring on
    // a second click or a retry of the same request.
    if (state === 'canceled') {
      await supabase.from('terminal_checkouts')
        .update({ status: 'cancelled' })
        .eq('square_checkout_id', checkoutId)
      return NextResponse.json({ success: true, status: checkout.status, state, alreadyCanceled: true })
    }

    if (!isCancellable(state) && state !== 'canceling') {
      return NextResponse.json({
        error: `This charge cannot be cancelled (Square reports ${checkout.status}).`,
        status: checkout.status,
        state,
      }, { status: 409 })
    }

    const cancelled = await cancelSquareCheckout(checkoutId)
    if (!cancelled.ok) {
      return NextResponse.json(
        { error: cancelled.errors?.[0]?.detail || 'Square could not cancel the charge' },
        { status: 400 }
      )
    }

    // Mirror it locally so the folio stops showing a charge in flight. The webhook writes the
    // same value when it arrives; both are idempotent.
    await supabase.from('terminal_checkouts')
      .update({ status: 'cancelled' })
      .eq('square_checkout_id', checkoutId)

    const finalStatus = cancelled.checkout?.status || 'CANCELED'
    return NextResponse.json({
      success: true,
      status: finalStatus,
      state: normalizeCheckoutState(finalStatus),
    })

  } catch (error: any) {
    console.error('Terminal cancel error:', error)
    return NextResponse.json({ error: error.message || 'Unexpected error' }, { status: 500 })
  }
}
