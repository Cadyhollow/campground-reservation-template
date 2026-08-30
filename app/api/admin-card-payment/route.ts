import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { requireRole } from '@/lib/require-role'
import { getSquareCredentials, SquareCredentialsError } from '@/lib/square-credentials'
import { normalizeLaneSplit, laneSplitTotal, recordCardPayment } from '@/lib/lane-payments'

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
      // PHASE 4 PR 3 — OPTIONAL, and its absence is the entire existing behaviour.
      //
      // When the lane checkout takes a card payment across several lanes it sends the split here
      // rather than charging the card several times or writing rows of its own:
      //   lanes: [{ lane: 'electric', amount: 4200, surchargeAmount: 126 }, …]
      // ONE Square charge for the sum, then ONE folio_payments row PER LANE, all sharing the same
      // square_payment_id. The camper sees a single charge on their statement; the ledger sees
      // each lane settle exactly. Every other caller omits this and is completely unaffected.
      lanes,
    } = await request.json()

    // Normalise the lane split. Rows with no positive amount are dropped rather than written as
    // zero-value payments.
    // Normalised by the shared helper, so this path and the Terminal path read a split the
    // same way — including a split that arrived as jsonb from the database.
    const laneSplit = normalizeLaneSplit(lanes)

    // ⚠ THE CHARGED TOTAL IS THE SUM OF THE ROWS THAT WILL BE WRITTEN, not a separately-supplied
    // figure. Trusting `amount` alongside a split would let the two disagree — the card charged
    // for one number while the ledger recorded another, which is the worst possible money bug.
    const chargeAmount = laneSplit.length ? laneSplitTotal(laneSplit) : amount

    if (!sourceId || !chargeAmount || (!folioId && !reservationId)) {
      return NextResponse.json({ error: 'Missing required fields' }, { status: 400 })
    }
    if (laneSplit.length && !folioId) {
      return NextResponse.json({ error: 'A lane payment must be against a folio.' }, { status: 400 })
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
        amount_money: { amount: chargeAmount, currency: 'USD' },
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
      // THE SHARED SINK — the same function the Square Terminal's completion records through, so
      // the two card paths cannot drift. It writes one row per lane when a split is given, one
      // plain row when it is not, and is idempotent on the Square payment id.
      const rec = await recordCardPayment(supabase, {
        folioId,
        squarePaymentId,
        split: laneSplit,
        amount,
        surchargeAmount,
        // See the staff folio: the fee is rendered from surcharge_amount now, so baking it
        // into the note printed it twice. Amounts unchanged; ' · Manual entry' kept.
        note: note + ' · Manual entry',
      })
      if (rec.error) {
        // The CARD HAS BEEN CHARGED. Never report failure — that invites a second charge. Surface
        // the Square id so the payment can be entered by hand against the right lanes.
        console.error('Card charged but the payment rows failed to write:', rec.error, squarePaymentId)
        return NextResponse.json({
          success: true, paymentId: squarePaymentId,
          warning: `The card was charged, but recording it failed. Add it manually on the folio — Square payment ${squarePaymentId}.`,
        })
      }
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
