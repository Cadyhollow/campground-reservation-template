import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { Resend } from 'resend'
import { randomBytes } from 'crypto'

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)
const resend = new Resend(process.env.RESEND_API_KEY)

// POST /api/send-waiver
// body: { reservationId, sendEmail?: boolean }
// - Always creates a fresh pending signature with an unguessable token.
// - If sendEmail is true and the guest has an email, also emails the link.
// - Returns { success, token, signUrl, emailed } so the caller can either
//   show "sent" or open the sign page directly (in-person).
export async function POST(request: NextRequest) {
  try {
    const body = await request.json()
    const reservationId: string | undefined = body.reservationId
    const sendEmail: boolean = body.sendEmail === true

    if (!reservationId) {
      return NextResponse.json({ error: 'Missing reservationId' }, { status: 400 })
    }

    // Look up the reservation (guest name/email for the signature + email)
    const { data: reservation, error: resErr } = await supabase
      .from('reservations')
      .select('id, guest_name, guest_email')
      .eq('id', reservationId)
      .single()
    if (resErr || !reservation) {
      return NextResponse.json({ error: 'Reservation not found' }, { status: 404 })
    }

    // Reuse an existing unsigned request if one is already pending, so repeated
    // taps don't pile up duplicate tokens for the same reservation.
    let token: string
    const { data: existing } = await supabase
      .from('signatures')
      .select('id, sign_token')
      .eq('reservation_id', reservationId)
      .eq('doc_type', 'booking_waiver')
      .eq('status', 'pending')
      .limit(1)
      .maybeSingle()

    if (existing?.sign_token) {
      token = existing.sign_token
    } else {
      token = randomBytes(24).toString('base64url')
      const { error: insErr } = await supabase.from('signatures').insert({
        doc_type: 'booking_waiver',
        reservation_id: reservation.id,
        signer_name: reservation.guest_name || '',
        signer_email: reservation.guest_email || '',
        sign_token: token,
        status: 'pending',
      })
      if (insErr) {
        return NextResponse.json({ error: insErr.message }, { status: 500 })
      }
    }

    // Build an absolute URL that works on localhost and in production.
    const origin =
      request.headers.get('origin') ||
      (request.headers.get('host') ? `https://${request.headers.get('host')}` : '')
    const signUrl = `${origin}/sign/${token}`

    // Optionally email the link
    let emailed = false
    let emailError: string | null = null
    if (sendEmail && reservation.guest_email) {
      const { data: settings } = await supabase
        .from('settings')
        .select('park_name, park_email')
        .limit(1)
        .single()
      const campgroundName = settings?.park_name || 'Campground'
      const fromEmail = process.env.RESEND_FROM_EMAIL || 'reservations@example.com'
      const replyToEmail = settings?.park_email || process.env.RESEND_FROM_EMAIL || 'info@example.com'

      try {
        const { error: sendErr } = await resend.emails.send({
          from: `${campgroundName} <${fromEmail}>`,
          replyTo: replyToEmail,
          to: reservation.guest_email,
          subject: `Please sign your waiver — ${campgroundName}`,
          html: `
            <div style="font-family: sans-serif; max-width: 520px; margin: 0 auto; color: #374151;">
              <h2 style="color:#15803d; margin-bottom: 8px;">${campgroundName}</h2>
              <p>Hi ${reservation.guest_name || 'there'},</p>
              <p>Before your stay, please take a moment to read and sign our liability waiver. It only takes a minute and can be done right from your phone.</p>
              <p style="text-align:center; margin: 28px 0;">
                <a href="${signUrl}" style="background:#15803d; color:#fff; text-decoration:none; padding:14px 28px; border-radius:8px; font-weight:700; display:inline-block;">Review &amp; Sign Waiver</a>
              </p>
              <p style="font-size:13px; color:#6b7280;">Or paste this link into your browser:<br><span style="color:#2E6B8A;">${signUrl}</span></p>
              <p style="font-size:13px; color:#6b7280;">Thank you!<br>${campgroundName}</p>
            </div>
          `,
        })
        if (sendErr) { emailError = (sendErr as any)?.message || 'Email failed to send' }
        else { emailed = true }
      } catch (e: any) {
        emailError = e?.message || 'Email failed to send'
      }
    }

    return NextResponse.json({
      success: true,
      token,
      signUrl,
      emailed,
      emailError,
      guestEmail: reservation.guest_email || '',
    })
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || 'Something went wrong' }, { status: 500 })
  }
}
