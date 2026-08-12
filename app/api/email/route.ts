import { NextRequest, NextResponse } from 'next/server'
import { requireRole } from '@/lib/require-role'
import { sendConfirmationEmails } from '@/lib/confirmation-email'

// Thin wrapper. The email bodies moved VERBATIM to lib/confirmation-email.ts — see that file for
// why. What remains here is the HTTP surface the admin screens use to re-send a confirmation by
// hand (manual-booking, new-reservation, reservations).
//
// GATED: the camper booking flow no longer reaches this route at all. /api/payment now calls
// sendConfirmationEmails() directly, so the only remaining callers are admin screens and this can
// require an admin session without touching the booking flow. Before that change, gating this
// route would have silently killed every confirmation email a camper receives.
export async function POST(request: NextRequest) {
  const denied = await requireRole(request, 'staff')
  if (denied) return denied

  try {
    const body = await request.json()
    await sendConfirmationEmails(body)
    return NextResponse.json({ success: true })
  } catch (error: any) {
    console.error('Email error:', error)
    return NextResponse.json(
      { error: error.message || 'Failed to send email.' },
      { status: 500 }
    )
  }
}
