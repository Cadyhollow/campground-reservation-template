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
    const { guestName, guestEmail, siteNumber, paymentAmount, paymentMethod, paymentNote, paidAt, remainingBalance } = body

    const { data: settings } = await supabase.from('settings').select('park_name, park_location, park_email, park_phone').single()

    const campgroundName = settings?.park_name || 'Our Campground'
    const campgroundLocation = settings?.park_location || ''
    const campgroundPhone = settings?.park_phone || ''
    const fromEmail = process.env.RESEND_FROM_EMAIL || 'reservations@myresonation.com'
    const replyToEmail = settings?.park_email || fromEmail

    const paymentDate = paidAt
      ? new Date(paidAt).toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })
      : new Date().toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })

    const methodDisplay = paymentMethod ? paymentMethod.charAt(0).toUpperCase() + paymentMethod.slice(1) : 'Payment'

    const remainingDisplay = remainingBalance > 0
      ? `<p style="margin:0;font-size:15px;color:#6B7280;">Your remaining balance is <strong style="color:#DC2626;">$${(remainingBalance / 100).toFixed(2)}</strong>.</p>`
      : `<p style="margin:0;font-size:15px;color:#15803d;font-weight:600;">&#10003; Your account is fully paid up &mdash; thank you!</p>`

    const noteRow = paymentNote
      ? `<tr><td style="padding:6px 0;color:#6B7280;font-size:14px;">Note</td><td style="padding:6px 0;font-size:14px;text-align:right;color:#111827;">${paymentNote}</td></tr>`
      : ''

    const html = `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f3f4f6;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
<div style="max-width:560px;margin:40px auto;background:#fff;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,0.08);">
  <div style="background:linear-gradient(135deg,#2E6B8A 0%,#1e4f6b 100%);padding:36px 40px;text-align:center;">
    <div style="font-size:40px;margin-bottom:8px;">&#129534;</div>
    <h1 style="margin:0;color:#fff;font-size:22px;font-weight:700;letter-spacing:-0.3px;">Payment Receipt</h1>
    <p style="margin:6px 0 0;color:rgba(255,255,255,0.8);font-size:14px;">${campgroundName}</p>
  </div>
  <div style="padding:36px 40px;">
    <p style="margin:0 0 24px;font-size:16px;color:#374151;">Hi ${guestName},</p>
    <p style="margin:0 0 28px;font-size:15px;color:#6B7280;line-height:1.6;">Thank you so much for your payment! We truly appreciate you &mdash; it&apos;s a pleasure having you at ${campgroundName}, and we&apos;re grateful for the trust you place in us. Here&apos;s your receipt for your records.</p>
    <div style="background:#f9fafb;border:1px solid #e5e7eb;border-radius:12px;padding:24px;margin-bottom:24px;">
      <h2 style="margin:0 0 16px;font-size:15px;font-weight:700;color:#111827;text-transform:uppercase;letter-spacing:0.05em;">Payment Details</h2>
      <table style="width:100%;border-collapse:collapse;">
        <tr><td style="padding:6px 0;color:#6B7280;font-size:14px;">Site</td><td style="padding:6px 0;font-size:14px;text-align:right;color:#111827;font-weight:600;">${siteNumber}</td></tr>
        <tr><td style="padding:6px 0;color:#6B7280;font-size:14px;">Date</td><td style="padding:6px 0;font-size:14px;text-align:right;color:#111827;">${paymentDate}</td></tr>
        <tr><td style="padding:6px 0;color:#6B7280;font-size:14px;">Method</td><td style="padding:6px 0;font-size:14px;text-align:right;color:#111827;">${methodDisplay}</td></tr>
        ${noteRow}
        <tr style="border-top:2px solid #e5e7eb;">
          <td style="padding:14px 0 6px;font-size:16px;font-weight:700;color:#111827;">Amount Paid</td>
          <td style="padding:14px 0 6px;font-size:22px;font-weight:800;text-align:right;color:#15803d;">$${(paymentAmount / 100).toFixed(2)}</td>
        </tr>
      </table>
    </div>
    <div style="background:${remainingBalance > 0 ? '#fef2f2' : '#f0fdf4'};border:1px solid ${remainingBalance > 0 ? '#fecaca' : '#bbf7d0'};border-radius:10px;padding:16px 20px;margin-bottom:28px;">
      ${remainingDisplay}
    </div>
    <p style="margin:0 0 6px;font-size:14px;color:#9ca3af;text-align:center;">Questions? Reach out to us anytime.</p>
    ${campgroundPhone ? `<p style="margin:0;font-size:14px;color:#9ca3af;text-align:center;">${campgroundPhone}</p>` : ''}
  </div>
  <div style="background:#f9fafb;border-top:1px solid #e5e7eb;padding:20px 40px;text-align:center;">
    <p style="margin:0;color:#9CA3AF;font-size:12px;">${campgroundName}${campgroundLocation ? ' &middot; ' + campgroundLocation : ''}</p>
    <p style="margin:6px 0 0;color:#d1d5db;font-size:11px;">Thank you for being part of our community &#127957;</p>
  </div>
</div>
</body>
</html>`

    await resend.emails.send({
      from: `${campgroundName} <${fromEmail}>`,
      replyTo: replyToEmail,
      to: guestEmail,
      subject: `Payment Receipt — ${campgroundName}`,
      html,
    })

    // Stamp receipt_sent_at on the payment record
    if (body.paymentId) {
      await supabase
        .from('folio_payments')
        .update({ receipt_sent_at: new Date().toISOString() })
        .eq('id', body.paymentId)
    }

    return NextResponse.json({ success: true })
  } catch (error: any) {
    console.error('Payment receipt email error:', error)
    return NextResponse.json({ error: error.message || 'Failed to send receipt' }, { status: 500 })
  }
}
