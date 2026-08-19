import { NextRequest, NextResponse } from 'next/server'
import { svc, isSummit, getResend, originOf, packetEmailHtml, emailConfigured, EMAIL_NOT_CONFIGURED, errMessage } from '@/lib/contract-server'
import { requireRole } from '@/lib/require-role'



// POST /api/seasonal-contracts/[id]/resend  — summit-gated.
// Re-emails the EXISTING packet link. Does NOT regenerate tokens, re-render text,
// or touch document_text — a resent email points at the same frozen documents.
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  // STAFF, deliberately kept where Cady had it (decided 2026-08-19). Resending re-mails an
  // ALREADY FROZEN packet and writes nothing at all — the front desk should be able to help a
  // camper who lost the link without finding a manager.
  const denied = await requireRole(request, 'staff')
  if (denied) return denied

  try {
    if (!(await isSummit())) {
      return NextResponse.json({ error: 'Not available on this plan.' }, { status: 403 })
    }

    // Same guard as /send. Nothing here writes, so this only prevents reporting success for an
    // email that was never delivered.
    if (!emailConfigured()) {
      return NextResponse.json({ error: EMAIL_NOT_CONFIGURED }, { status: 503 })
    }
    const { id } = await params

    const { data: contract, error } = await svc
      .from('seasonal_contracts')
      .select('id, guest_id, season_year, status, packet_id')
      .eq('id', id)
      .single()
    if (error || !contract) return NextResponse.json({ error: 'Contract not found' }, { status: 404 })
    if (!contract.packet_id || contract.status === 'draft') {
      return NextResponse.json({ error: 'This contract has not been sent yet.' }, { status: 409 })
    }
    if (contract.status === 'signed') {
      return NextResponse.json({ error: 'This packet has already been signed.' }, { status: 409 })
    }

    const { data: guest } = await svc.from('guests').select('name, email').eq('id', contract.guest_id).single()
    if (!guest?.email) {
      return NextResponse.json({ error: 'This guest has no email on file to send the packet to.' }, { status: 400 })
    }
    const { data: settings } = await svc.from('settings').select('park_name, park_email').limit(1).single()

    const packetUrl = `${originOf(request)}/packet/${contract.packet_id}`
    const campgroundName = settings?.park_name || 'Campground'
    const fromEmail = process.env.RESEND_FROM_EMAIL || 'reservations@example.com'
    const replyToEmail = settings?.park_email || process.env.RESEND_FROM_EMAIL || 'info@example.com'

    let emailError: string | null = null
    try {
      const { error: sendErr } = await getResend().emails.send({
        from: `${campgroundName} <${fromEmail}>`,
        replyTo: replyToEmail,
        to: guest.email,
        subject: `Your ${contract.season_year} seasonal packet — ${campgroundName}`,
        html: packetEmailHtml(campgroundName, guest.name || 'there', contract.season_year, packetUrl),
      })
      if (sendErr) emailError = errMessage(sendErr, 'Email failed to send')
    } catch (e) {
      emailError = errMessage(e, 'Email failed to send')
    }

    return NextResponse.json({ ok: true, packetUrl, emailed: !emailError, error: emailError })
  } catch (e) {
    return NextResponse.json({ error: errMessage(e, 'Something went wrong') }, { status: 500 })
  }
}
