import { NextRequest, NextResponse } from 'next/server'
import { Resend } from 'resend'
import { createClient } from '@supabase/supabase-js'

const resend = new Resend(process.env.RESEND_API_KEY)
const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

export async function POST(request: NextRequest) {
  try {
    const body = await request.json()
    const { recipients, subject, message, buttonLabel, buttonUrl, headerImageUrl, imageAltText, bypassOptOut } = body

    const { data: settings } = await supabase
      .from('settings')
      .select('park_name, park_location, park_email, park_phone')
      .single()

    const campgroundName = settings?.park_name || 'Our Campground'
    const campgroundLocation = settings?.park_location || ''
    const campgroundPhone = settings?.park_phone || ''
    const fromEmail = process.env.RESEND_FROM_EMAIL || 'reservations@myresonation.com'
    const replyToEmail = settings?.park_email || fromEmail
    const baseUrl = process.env.NEXT_PUBLIC_BASE_URL || 'https://book.cadyhollow.com'

    let sentCount = 0
    const errors: string[] = []

    for (const recipient of recipients) {
      try {
        const unsubscribeUrl = `${baseUrl}/api/unsubscribe?id=${recipient.id}`

        const headerImageHtml = headerImageUrl ? `
          <div style="margin-bottom:0;">
            <img src="${headerImageUrl}" alt="${imageAltText || campgroundName}" style="width:100%;max-width:600px;height:auto;display:block;border-radius:12px 12px 0 0;" />
          </div>` : ''

        const buttonHtml = buttonLabel && buttonUrl ? `
          <div style="text-align:center;margin:28px 0 8px;">
            <a href="${buttonUrl}" style="display:inline-block;background:#2E6B8A;color:#ffffff;text-decoration:none;padding:14px 36px;border-radius:8px;font-weight:700;font-size:15px;">${buttonLabel}</a>
          </div>` : ''

        const unsubscribeHtml = bypassOptOut ? '' : `
          <p style="margin:16px 0 0;font-size:11px;color:#9ca3af;text-align:center;">
            You're receiving this email because you've stayed with us or signed up for updates.<br>
            <a href="${unsubscribeUrl}" style="color:#9ca3af;">Unsubscribe</a>
          </p>`

        const html = `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f3f4f6;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
<div style="max-width:600px;margin:40px auto;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,0.08);">
  ${headerImageHtml}
  <div style="background:linear-gradient(135deg,#2E6B8A 0%,#1e4f6b 100%);padding:${headerImageUrl ? '24px 40px' : '36px 40px'};text-align:center;">
    <h1 style="margin:0;color:#fff;font-size:22px;font-weight:700;letter-spacing:-0.3px;">${campgroundName}</h1>
    ${campgroundLocation ? `<p style="margin:4px 0 0;color:rgba(255,255,255,0.8);font-size:13px;">${campgroundLocation}</p>` : ''}
  </div>
  <div style="padding:36px 40px;">
    <h2 style="margin:0 0 20px;font-size:20px;font-weight:700;color:#111827;">${subject}</h2>
    <div style="font-size:15px;color:#374151;line-height:1.7;white-space:pre-wrap;">${message.replace(/\n/g, '<br>')}</div>
    ${buttonHtml}
  </div>
  <div style="background:#f9fafb;border-top:1px solid #e5e7eb;padding:20px 40px;text-align:center;">
    <p style="margin:0;color:#9CA3AF;font-size:12px;">${campgroundName}${campgroundLocation ? ' · ' + campgroundLocation : ''}${campgroundPhone ? ' · ' + campgroundPhone : ''}</p>
    ${unsubscribeHtml}
  </div>
</div>
</body>
</html>`

        await resend.emails.send({
          from: `${campgroundName} <${fromEmail}>`,
          replyTo: replyToEmail,
          to: recipient.email,
          subject,
          html,
        })

        sentCount++
      } catch (err: any) {
        errors.push(`${recipient.email}: ${err.message}`)
      }
    }

    // Log the broadcast
    await supabase.from('broadcast_emails').insert({
      subject,
      message,
      recipient_count: sentCount,
      bypassed_opt_out: bypassOptOut || false,
    })

    return NextResponse.json({ success: true, sentCount, errors })
  } catch (error: any) {
    console.error('Broadcast email error:', error)
    return NextResponse.json({ error: error.message || 'Failed to send' }, { status: 500 })
  }
}
