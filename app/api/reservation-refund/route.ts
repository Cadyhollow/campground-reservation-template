import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

export async function POST(request: NextRequest) {
  try {
    const {
      reservationId, squarePaymentId, refundAmount, reason, currentAmountPaid, currentNotes,
      // Gross-basis fields. Optional so an older caller still behaves exactly as before:
      // without them the cap falls back to amount_paid and no surcharge is unwound.
      refundSurchargeAmount, currentSurchargeAmount, currentGrossPaid,
    } = await request.json()

    if (!reservationId || !refundAmount) {
      return NextResponse.json({ error: 'Missing required fields' }, { status: 400 })
    }

    const refundAmountCents = Math.round(refundAmount * 100)
    const refundSurchargeCents = Math.round((refundSurchargeAmount || 0) * 100)

    // Refunds are GROSS: the card is credited what it was charged, surcharge included, as
    // the card brands require. The cap therefore has to be the gross that was charged —
    // amount_paid alone is surcharge-free and would reject a legitimate full refund. This
    // still cannot refund more than was actually taken; it just measures it correctly.
    const grossCap = typeof currentGrossPaid === 'number' ? currentGrossPaid : currentAmountPaid

    if (refundAmountCents > grossCap) {
      return NextResponse.json({ error: 'Refund amount exceeds amount paid' }, { status: 400 })
    }

    if (refundSurchargeCents > refundAmountCents) {
      return NextResponse.json({ error: 'Surcharge portion exceeds the refund' }, { status: 400 })
    }

    // Process Square refund if card payment with square_payment_id
    if (squarePaymentId) {
      const squareResponse = await fetch('https://connect.squareup.com/v2/refunds', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${process.env.SQUARE_ACCESS_TOKEN}`,
          'Square-Version': '2024-01-18',
        },
        body: JSON.stringify({
          idempotency_key: `res-refund-${reservationId}-${Date.now()}`,
          payment_id: squarePaymentId,
          amount_money: { amount: refundAmountCents, currency: 'USD' },
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
    }

    // Square was credited the GROSS, but the row records the two halves separately, so the
    // decrements have to be split the same way. amount_paid drops by the stay portion only —
    // it is cash-canonical and would stop being so if the surcharge were taken out of it —
    // and surcharge_amount drops by the surcharge portion, so revenue (which counts the
    // surcharge) falls by exactly what was handed back rather than staying overstated.
    const refundStayCents = refundAmountCents - refundSurchargeCents
    const newAmountPaid = Math.max(0, currentAmountPaid - refundStayCents)

    const refundNote = `[Refund ${new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}] $${refundAmount.toFixed(2)} refunded${refundSurchargeCents > 0 ? ` (incl. $${(refundSurchargeCents / 100).toFixed(2)} card surcharge)` : ''}${reason ? ` — ${reason}` : ''}${squarePaymentId ? ' (Square)' : ' (cash/check)'}`
    const updatedNotes = currentNotes ? `${currentNotes}\n${refundNote}` : refundNote

    // Only touch surcharge_amount when the caller supplied it, so an older caller's write
    // shape is unchanged.
    const updatePayload: Record<string, any> = { amount_paid: newAmountPaid, notes: updatedNotes }
    if (typeof currentSurchargeAmount === 'number') {
      updatePayload.surcharge_amount = Math.max(0, currentSurchargeAmount - refundSurchargeCents)
    }

    const { error } = await supabase
      .from('reservations')
      .update(updatePayload)
      .eq('id', reservationId)

    if (error) {
      return NextResponse.json({ error: 'Failed to update reservation' }, { status: 500 })
    }

    return NextResponse.json({ success: true })

  } catch (error: any) {
    console.error('Reservation refund error:', error)
    return NextResponse.json({ error: error.message || 'Refund failed' }, { status: 500 })
  }
}
