import { NextRequest, NextResponse } from 'next/server'
import { processFolioRefund } from '@/lib/folio-refund'
import { requireRole } from '@/lib/require-role'

// The refund itself now lives in lib/folio-refund.ts, unchanged, so that
// /api/reservation-cancel can reuse it rather than reimplement the cap, the Square call and the
// negative row. Same move Part 2 made for the booking leg. This route is the HTTP wrapper it
// always was: same request body, same responses.
export async function POST(request: NextRequest) {
  const denied = await requireRole(request, 'manager')
  if (denied) return denied

  try {
    const { paymentId, refundAmount, reason, folioId } = await request.json()

    if (!paymentId || !refundAmount || !folioId) {
      return NextResponse.json({ error: 'Missing required fields' }, { status: 400 })
    }

    const result = await processFolioRefund({
      paymentId,
      folioId,
      refundAmountCents: Math.round(refundAmount * 100),
      reason,
    })

    if (!result.ok) {
      return NextResponse.json({ error: result.error }, { status: result.status })
    }

    return NextResponse.json({ success: true, refundId: result.refundId })

  } catch (error: any) {
    console.error('Refund error:', error)
    return NextResponse.json({ error: error.message || 'Refund failed' }, { status: 500 })
  }
}
