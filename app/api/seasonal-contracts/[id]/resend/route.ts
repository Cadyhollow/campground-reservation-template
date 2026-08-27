import { NextRequest, NextResponse } from 'next/server'
import { svc, isSummit, getResend, originOf, packetEmailHtml, emailConfigured, EMAIL_NOT_CONFIGURED, errMessage, renderPacketIntro } from '@/lib/contract-server'
import { requireRole } from '@/lib/require-role'



// POST /api/seasonal-contracts/[id]/resend  — summit-gated.
// Re-emails the EXISTING packet link. Does NOT regenerate tokens, re-render the DOCUMENTS,
// or touch document_text — a resent email points at the same frozen documents.
//
// Phase 3: the email's covering MESSAGE is re-rendered from settings.packet_email_intro against
// the contract's (already frozen) values. That is the one thing which can differ between a send
// and a resend, and it is a cover note rather than part of the agreement.
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  // MANAGER. THIS REVERSES AN EARLIER DECISION, DELIBERATELY AND WITH THE REASON RECORDED.
  //
  // Resend was first kept at 'staff' — it re-mails an ALREADY FROZEN packet and writes nothing,
  // so letting the front desk help a camper who lost their link cost nothing. What that missed is
  // that Send and Resend share ONE BUTTON SLOT on the camper's page: Send while the contract is a
  // draft, Resend once it has gone out. There is no other surface for either.
  //
  // So a staff-level resend had nowhere to live unless the seasonals screen were opened to staff.
  // Presented with that, Charissa chose manager-only for the whole area (2026-08-19). Leaving the
  // ROUTE at staff would have been a gate that nothing enforces and nobody can reach — worse than
  // either answer. Route and screen now agree.
  const denied = await requireRole(request, 'manager')
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

    // select('*') rather than a named list: renderPacketIntro substitutes the contract's merge
    // tokens (total_due, deposit_due, the due-by dates, the charge note…), so it needs the whole
    // row. A named list here would silently render a blank token every time a new field is added.
    const { data: contract, error } = await svc
      .from('seasonal_contracts')
      .select('*')
      .eq('id', id)
      .single()
    if (error || !contract) return NextResponse.json({ error: 'Contract not found' }, { status: 404 })
    if (!contract.packet_id || contract.status === 'draft') {
      return NextResponse.json({ error: 'This contract has not been sent yet.' }, { status: 409 })
    }
    if (contract.status === 'signed') {
      return NextResponse.json({ error: 'This packet has already been signed.' }, { status: 409 })
    }

    // Whole guest row, same reason as the contract above — the intro can merge {{name}},
    // {{site_number}} and the home address.
    const { data: guest } = await svc.from('guests').select('*').eq('id', contract.guest_id).single()
    if (!guest?.email) {
      return NextResponse.json({ error: 'This guest has no email on file to send the packet to.' }, { status: 400 })
    }
    const { data: settings } = await svc.from('settings')
      .select('park_name, park_email, packet_email_intro').limit(1).single()

    // The contract's season, for {{season_name}} and the effective dates — loaded fresh here,
    // where /send gets it back from freezePacket.
    const { data: season } = contract.season_id
      ? await svc.from('seasons').select('name, opens, closes').eq('id', contract.season_id).single()
      : { data: null }

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
        // ⚠ RENDERED FRESH, DELIBERATELY. The intro is a COVER NOTE, not part of the signed
        // packet: the two documents were frozen onto signature rows at send and are never
        // re-read. So editing the message between a send and a resend changes what the covering
        // email says, and cannot change what the camper signs — the link below still points at
        // the same frozen documents. The contract's own values are frozen, so the amounts and
        // dates merged in here are the ones on the agreement.
        html: packetEmailHtml(campgroundName, guest.name || 'there', contract.season_year, packetUrl,
          renderPacketIntro(guest, contract, season, settings)),
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
