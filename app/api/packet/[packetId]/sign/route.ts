import { NextRequest, NextResponse } from 'next/server'
import { svc, clientIp, getResend, packetReceiptHtml, emailConfigured } from '@/lib/contract-server'

// POST /api/packet/[packetId]/sign — public. body: { signedName, agreed: true }
// One submit signs ALL pending rows in the packet. Each row's signed_text_snapshot
// is a copy of ITS OWN document_text (never re-fetched), plus IP + user-agent.
// After signing, emails the camper a COPY of the signed documents (a receipt) — for
// BOTH in-person and remote — skipped if no email, and never allowed to fail the sign.
export async function POST(request: NextRequest, { params }: { params: Promise<{ packetId: string }> }) {
  try {
    const { packetId } = await params
    if (!packetId) return NextResponse.json({ error: 'Missing packet' }, { status: 400 })

    const body = await request.json()
    // BOUNDED. This is the only public, unauthenticated WRITE in the whole seasonal feature, and
    // the value lands in the database and in an email. A typed signature is a person's name; 200
    // characters is generous for that and stops an unbounded string being stored and mailed.
    const MAX_SIGNED_NAME = 200
    const signedName: string = String(body.signedName ?? '').trim().slice(0, MAX_SIGNED_NAME)
    const agreed: boolean = body.agreed === true
    if (!signedName || !agreed) {
      return NextResponse.json({ error: 'Please type your name and check the agreement box.' }, { status: 400 })
    }

    const { data: rows, error } = await svc
      .from('signatures')
      .select('id, status, document_text, document_title, sign_order, guest_id')
      .eq('packet_id', packetId)
    if (error || !rows || rows.length === 0) {
      return NextResponse.json({ error: 'This signing link is no longer valid.' }, { status: 404 })
    }

    const pending = rows.filter(r => r.status !== 'signed')
    if (pending.length === 0) {
      return NextResponse.json({ error: 'This packet has already been signed.' }, { status: 409 })
    }

    const ip = clientIp(request)
    const userAgent = request.headers.get('user-agent') || ''
    const now = new Date().toISOString()

    for (const r of pending) {
      const { error: upErr } = await svc.from('signatures').update({
        status: 'signed',
        agreed: true,
        signed_name: signedName,
        signed_at: now,
        ip_address: ip,
        user_agent: userAgent,
        signed_text_snapshot: r.document_text || '', // this row's OWN bytes, copied
      }).eq('id', r.id).neq('status', 'signed')
      if (upErr) return NextResponse.json({ error: 'Could not record your signature. Please try again.' }, { status: 500 })
    }

    // Reflect on the contract (by packet).
    await svc.from('seasonal_contracts')
      .update({ status: 'signed', signed_at: now })
      .eq('packet_id', packetId)
      .neq('status', 'signed')

    // Receipt email — the camper's signed COPY, for BOTH in-person and remote. NOT
    // compensated and fully best-effort: the packet is signed and real, so a missing
    // email or a send failure must never fail the signing.
    try {
      const guestId = rows.find(r => r.guest_id)?.guest_id
      if (guestId) {
        const [{ data: guest }, { data: settings }, { data: contract }] = await Promise.all([
          svc.from('guests').select('name, email').eq('id', guestId).single(),
          svc.from('settings').select('park_name, park_email').limit(1).single(),
          svc.from('seasonal_contracts').select('season_year').eq('packet_id', packetId).maybeSingle(),
        ])
        // emailConfigured() as well as an address: without a key getResend() would construct and
        // throw, which the catch below would swallow anyway — but failing silently on purpose
        // reads better than failing silently by accident.
        if (guest?.email && emailConfigured()) {
          const campgroundName = settings?.park_name || 'Campground'
          const fromEmail = process.env.RESEND_FROM_EMAIL || 'reservations@example.com'
          const replyToEmail = settings?.park_email || process.env.RESEND_FROM_EMAIL || 'info@example.com'
          const year = contract?.season_year || new Date(now).getFullYear()
          const docs = [...rows]
            .sort((a, b) => (a.sign_order || 0) - (b.sign_order || 0))
            .map(r => ({ title: r.document_title || 'Document', text: r.document_text || '' }))
          const signedAtLabel = new Date(now).toLocaleString('en-US', { dateStyle: 'long', timeStyle: 'short' })
          await getResend().emails.send({
            from: `${campgroundName} <${fromEmail}>`,
            replyTo: replyToEmail,
            to: guest.email,
            subject: `Your signed ${year} seasonal packet — ${campgroundName}`,
            html: packetReceiptHtml(campgroundName, guest.name || 'there', year, signedName, signedAtLabel, docs),
          })
        }
      }
    } catch {
      // best-effort receipt; swallow — signing already succeeded
    }

    return NextResponse.json({ success: true })
  } catch {
    // DELIBERATELY GENERIC, unlike the admin routes, which echo the underlying message back.
    // This handler is PUBLIC: a raw Postgres or Supabase error string handed to an anonymous
    // caller describes the schema to somebody who should not be able to see it, and tells the
    // camper nothing useful either. `any` is also forbidden by this repo's lint.
    return NextResponse.json(
      { error: 'Could not record your signature. Please try again, or contact the campground.' },
      { status: 500 },
    )
  }
}
