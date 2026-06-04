import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

export async function POST(request: NextRequest) {
  try {
    const { reservationId, squarePaymentId, refundAmount, reason, currentAmountPaid, currentNotes } = await request.json()

    if (!reservationId || !refundAmount) {
      return NextResponse.json({ error: 'Missing required fields' }, { status: 400 })
    }

    const refundAmountCents = Math.round(refundAmount * 100)

    if (refundAmountCents > currentAmountPaid) {
      return NextResponse.json({ error: 'Refund amount exceeds amount paid' }, { status: 400 })
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

    // Update amount_paid and append audit note
    const newAmountPaid = Math.max(0, currentAmountPaid - refundAmountCents)
    const refundNote = `[Refund ${new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}] $${refundAmount.toFixed(2)} refunded${reason ? ` — ${reason}` : ''}${squarePaymentId ? ' (Square)' : ' (cash/check)'}`
    const updatedNotes = currentNotes ? `${currentNotes}\n${refundNote}` : refundNote

    const { error } = await supabase
      .from('reservations')
      .update({ amount_paid: newAmountPaid, notes: updatedNotes })
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
