import { NextRequest, NextResponse } from 'next/server'
import { isSummit, getResend, originOf, packetEmailHtml, freezePacket, emailConfigured, EMAIL_NOT_CONFIGURED, errMessage, renderPacketIntro } from '@/lib/contract-server'
import { requireRole } from '@/lib/require-role'



// POST /api/seasonal-contracts/[id]/send  — THE REMOTE FLOW
// Freezes the draft into a packet via freezePacket() (which owns the empty-doc
// guard, the rig/site snapshot, the two signature rows, and compensation-on-
// failure), then emails the sign-invite. requireEmail:true reproduces the original
// "no email on file → 400 before anything is frozen" behavior. The EMAIL is NOT
// compensated: once the packet is committed it's real, so a failed email returns
// { ok:true, emailed:false } and leaves everything intact for a resend.
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  // MANAGER, raised from Cady's 'staff' (decided 2026-08-19). Sending freezes the draft into a
  // signable packet and emails a legal agreement to a camper — squarely "creating or changing a
  // seasonal contract", which staff are not to do. `resend`, which only re-mails an ALREADY
  // frozen packet and writes nothing, deliberately stays at staff.
  const denied = await requireRole(request, 'manager')
  if (denied) return denied

  try {
    if (!(await isSummit())) {
      return NextResponse.json({ error: 'Not available on this plan.' }, { status: 403 })
    }

    // BEFORE freezePacket, deliberately. Freezing marks the contract 'sent' and writes two
    // signature rows; doing that and then failing to email would leave a contract that claims to
    // have been sent to a camper who never received it, and it cannot be re-frozen (freezePacket
    // refuses anything not in 'draft'). Checking first means a misconfigured deployment changes
    // nothing at all.
    if (!emailConfigured()) {
      return NextResponse.json({ error: EMAIL_NOT_CONFIGURED }, { status: 503 })
    }
    const { id } = await params

    const result = await freezePacket(id, { requireEmail: true })
    if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status })
    const { packet_id, guest, contract, settings, season } = result

    // Email last — NOT compensated. The packet is committed and real.
    const origin = originOf(request)
    const packetUrl = `${origin}/packet/${packet_id}`
    // freezePacket returns these rows as DbRow (Record<string, unknown>) since step 2 replaced
    // Cady's `any`. Narrowing at the point of use is the cost of that, and it is a real check:
    // `to:` below must be a string, and Resend silently accepts very little else.
    const str = (v: unknown, fallback = '') => (typeof v === 'string' && v ? v : fallback)
    const campgroundName = str(settings?.park_name, 'Campground')
    const fromEmail = process.env.RESEND_FROM_EMAIL || 'reservations@example.com'
    const replyToEmail = str(settings?.park_email, process.env.RESEND_FROM_EMAIL || 'info@example.com')
    const guestEmail = str(guest.email)
    const seasonYear = Number(contract.season_year) || new Date().getFullYear()
    let emailError: string | null = null
    try {
      const { error: sendErr } = await getResend().emails.send({
        from: `${campgroundName} <${fromEmail}>`,
        replyTo: replyToEmail,
        to: guestEmail,
        subject: `Your ${seasonYear} seasonal packet — ${campgroundName}`,
        // Phase 3: the park's own message, rendered against the same guest/contract/season the
        // document was. Blank setting → packetEmailHtml falls back to its built-in paragraph.
        html: packetEmailHtml(campgroundName, str(guest.name, 'there'), seasonYear, packetUrl,
          renderPacketIntro(guest, contract, season, settings)),
      })
      if (sendErr) emailError = errMessage(sendErr, 'Email failed to send')
    } catch (e) {
      emailError = errMessage(e, 'Email failed to send')
    }

    return NextResponse.json({ ok: true, packet_id, packetUrl, emailed: !emailError, error: emailError })
  } catch (e) {
    return NextResponse.json({ error: errMessage(e, 'Something went wrong') }, { status: 500 })
  }
}
