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
    const {
      guestName,
      guestEmail,
      siteNumber,
      billingMonth,
      emailMessage,
      electricAmount,
      newCharges,
      paymentsReceived,
      totalBalance,
      balanceForward,
    } = body

    const { data: settings } = await supabase
      .from('settings')
      .select('park_name, park_location, park_email')
      .single()

    const campgroundName = settings?.park_name || 'Our Campground'
    const campgroundLocation = settings?.park_location || ''
    const fromEmail = process.env.RESEND_FROM_EMAIL || 'reservations@example.com'
    const replyToEmail = settings?.park_email || fromEmail

    const formatDateTime = (dateStr: string) => {
      const d = new Date(dateStr)
      return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) +
        ' at ' + d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true })
    }

    const newChargeRows = (newCharges || []).map((item: any) => `
      <tr>
        <td style="padding:6px 0;color:#9CA3AF;font-size:14px;">${item.description}${item.charged_at ? ' · ' + formatDateTime(item.charged_at) : ''}</td>
        <td style="padding:6px 0;color:#ffffff;font-size:14px;text-align:right;">$${(item.line_total/100).toFixed(2)}</td>
      </tr>`).join('')

    const isCredit = totalBalance < 0
    const balanceColor = isCredit ? '#4ADE80' : totalBalance === 0 ? '#4ADE80' : '#FCD34D'
    const balanceLabel = isCredit ? 'Credit on Account' : totalBalance === 0 ? '✓ Paid in Full' : 'Total Balance Due'
    const balanceDisplay = isCredit ? '$' + (Math.abs(totalBalance)/100).toFixed(2) : totalBalance === 0 ? '' : '$' + (totalBalance/100).toFixed(2)

    const html = `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="margin:0;padding:0;background-color:#1C1C1C;font-family:Arial,sans-serif;">
<div style="max-width:600px;margin:0 auto;background-color:#1C1C1C;">

  <div style="background-color:#2B2B2B;padding:32px;text-align:center;">
    <h1 style="color:#ffffff;margin:0 0 4px;font-size:24px;">${campgroundName}</h1>
    <p style="color:#9CA3AF;margin:0;font-size:14px;">${campgroundLocation}</p>
  </div>

  <div style="background-color:#2B2B2B;margin:16px;border-radius:12px;padding:32px;text-align:center;">
    <div style="font-size:48px;margin-bottom:16px;">⚡</div>
    <h2 style="color:#ffffff;margin:0 0 8px;font-size:24px;">${billingMonth} Electric Statement</h2>
    <p style="color:#9CA3AF;margin:0;font-size:14px;">${guestName} · Site ${siteNumber}</p>
  </div>

  <div style="background-color:#2B2B2B;margin:16px;border-radius:12px;padding:24px;">
    <p style="color:#D1D5DB;font-size:15px;margin:0;line-height:1.6;">${emailMessage.replace(/\n/g, "<br>")}</p>
  </div>

  <div style="background-color:#2B2B2B;margin:16px;border-radius:12px;padding:24px;">
    <h3 style="color:#ffffff;margin:0 0 16px;font-size:16px;">Account Statement</h3>
    <table style="width:100%;border-collapse:collapse;">
      <tr>
        <td style="padding:6px 0;color:#9CA3AF;font-size:14px;">${balanceForward < 0 ? 'Credit Forward' : 'Balance Forward'}</td>
        <td style="padding:6px 0;font-size:14px;font-weight:bold;text-align:right;color:${balanceForward < 0 ? '#4ADE80' : balanceForward === 0 ? '#9CA3AF' : '#FCA5A5'};">
          ${balanceForward < 0 ? '-$' + (Math.abs(balanceForward)/100).toFixed(2) : '$' + (balanceForward/100).toFixed(2)}
        </td>
      </tr>
      <tr><td colspan="2" style="padding:4px 0;border-top:1px solid #374151;"></td></tr>
      <tr>
        <td style="padding:6px 0;color:#9CA3AF;font-size:14px;">${billingMonth} Electric</td>
        <td style="padding:6px 0;color:#FCD34D;font-size:14px;font-weight:bold;text-align:right;">$${(electricAmount/100).toFixed(2)}</td>
      </tr>
      ${newChargeRows}
      <tr><td colspan="2" style="padding:4px 0;border-top:1px solid #374151;"></td></tr>
      <tr>
        <td style="padding:6px 0;color:#9CA3AF;font-size:14px;">Payments Received</td>
        <td style="padding:6px 0;color:${paymentsReceived > 0 ? '#4ADE80' : '#9CA3AF'};font-size:14px;font-weight:bold;text-align:right;">
          ${paymentsReceived > 0 ? '-$' + (paymentsReceived/100).toFixed(2) : '$0.00'}
        </td>
      </tr>
      <tr><td colspan="2" style="padding:8px 0 0;border-top:1px solid #374151;"></td></tr>
      <tr>
        <td style="padding:8px 0 4px;color:#ffffff;font-size:16px;font-weight:bold;">${balanceLabel}</td>
        <td style="padding:8px 0 4px;color:${balanceColor};font-size:16px;font-weight:bold;text-align:right;">
          ${balanceDisplay}
        </td>
      </tr>
    </table>
  </div>

  <div style="padding:24px;text-align:center;">
    <p style="color:#6B7280;font-size:12px;margin:0;">Thank you! Please don't hesitate to reach out if you have any questions.</p>
    <p style="color:#6B7280;font-size:12px;margin:8px 0 0;">${campgroundName} · ${campgroundLocation}</p>
  </div>
</div>
</body>
</html>`

    await resend.emails.send({
      from: `${campgroundName} <${fromEmail}>`,
      replyTo: replyToEmail,
      to: guestEmail,
      subject: `${billingMonth} Electric Statement — ${campgroundName}`,
      html,
    })

    return NextResponse.json({ success: true })
  } catch (error: any) {
    console.error('Electric bill email error:', error)
    return NextResponse.json({ error: error.message || 'Failed to send email' }, { status: 500 })
  }
}
