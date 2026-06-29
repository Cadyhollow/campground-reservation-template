import { NextRequest, NextResponse } from 'next/server'
import { Resend } from 'resend'
import { createClient } from '@supabase/supabase-js'

function getResend() { return new Resend(process.env.RESEND_API_KEY) }
const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

export async function POST(request: NextRequest) {
  try {
    const body = await request.json()
    const { folioId, receiptType } = body
    // receiptType: 'reservation' | 'walkup' | 'account'

    const { data: settings } = await supabase.from('settings').select('park_name, park_location, park_email').single()
    const campgroundName = settings?.park_name || 'Our Campground'
    const campgroundLocation = settings?.park_location || ''
    const fromEmail = process.env.RESEND_FROM_EMAIL || 'reservations@example.com'
    const replyToEmail = settings?.park_email || process.env.RESEND_REPLY_TO || fromEmail

    // Load folio
    const { data: folio } = await supabase.from('folios').select('*').eq('id', folioId).single()
    if (!folio) return NextResponse.json({ error: 'Folio not found' }, { status: 404 })

    if (!folio.guest_email) return NextResponse.json({ error: 'No email on file for this guest' }, { status: 400 })

    // Load line items
    const { data: lineItems } = await supabase.from('folio_line_items').select('*').eq('folio_id', folioId).order('charged_at')

    // Load payments
    const { data: payments } = await supabase.from('folio_payments').select('*').eq('folio_id', folioId).eq('status', 'completed').order('paid_at')

    const itemsTotal = (lineItems || []).reduce((sum: number, i: any) => sum + i.line_total, 0)
    const paymentsTotal = (payments || []).reduce((sum: number, p: any) => sum + p.amount - (p.surcharge_amount || 0), 0)
    const mostRecentPayment = payments && payments.length > 0 ? payments[payments.length - 1] : null

    // Load reservation if applicable
    let reservation = null
    if (folio.reservation_id) {
      const { data: res } = await supabase
        .from('reservations')
        .select('*, sites(site_number, site_type)')
        .eq('id', folio.reservation_id)
        .single()
      reservation = res
    }
    // Include the reservation's own stay charge, not just folio line items.
    // Mirror the folio page: count booking-path money (amount_paid) + folio payments.
    const reservationCharge = reservation ? ((reservation as any).total_price || 0) : 0
    const chargesTotal = reservationCharge + itemsTotal
    const totalPaid = (reservation ? ((reservation as any).amount_paid || 0) : 0) + paymentsTotal
    const balanceRemaining = chargesTotal - totalPaid

    const isReservationType = receiptType === 'reservation' || folio.reservation_id

    if (isReservationType) {
      // STYLED HTML RECEIPT — matches confirmation email theme
      const siteLabel = reservation?.sites?.site_type === 'rv_site' ? 'RV Site' :
        reservation?.sites?.site_type === 'cabin' ? 'Cabin' :
        reservation?.sites?.site_type === 'tent' ? 'Tent Site' :
        reservation?.sites?.site_type || 'Site'

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
    <div style="font-size:48px;margin-bottom:16px;">🧾</div>
    <h2 style="color:#ffffff;margin:0 0 8px;font-size:26px;">Receipt for ${folio.guest_name}</h2>
    <p style="color:#9CA3AF;margin:0;font-size:14px;">${new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })}</p>
  </div>
  ${reservation ? `
  <div style="background-color:#2B2B2B;margin:16px;border-radius:12px;padding:24px;">
    <h3 style="color:#ffffff;margin:0 0 16px;font-size:16px;">Reservation Details</h3>
    <table style="width:100%;border-collapse:collapse;">
      <tr><td style="padding:6px 0;color:#9CA3AF;font-size:14px;width:40%;">Site</td><td style="padding:6px 0;color:#ffffff;font-size:14px;font-weight:bold;">${siteLabel} ${reservation.sites?.site_number}</td></tr>
      <tr><td style="padding:6px 0;color:#9CA3AF;font-size:14px;">Arrival</td><td style="padding:6px 0;color:#ffffff;font-size:14px;">${reservation.arrival_date}</td></tr>
      <tr><td style="padding:6px 0;color:#9CA3AF;font-size:14px;">Departure</td><td style="padding:6px 0;color:#ffffff;font-size:14px;">${reservation.departure_date}</td></tr>
    </table>
  </div>` : ''}
  <div style="background-color:#2B2B2B;margin:16px;border-radius:12px;padding:24px;">
    <h3 style="color:#ffffff;margin:0 0 16px;font-size:16px;">Charges</h3>
    <table style="width:100%;border-collapse:collapse;">
      ${reservation ? `
      <tr>
        <td style="padding:6px 0;color:#9CA3AF;font-size:14px;">Reservation stay</td>
        <td style="padding:6px 0;color:#ffffff;font-size:14px;text-align:right;">$${(reservationCharge/100).toFixed(2)}</td>
      </tr>` : ''}
      ${(lineItems || []).map((item: any) => `
      <tr>
        <td style="padding:6px 0;color:#9CA3AF;font-size:14px;">${item.description}</td>
        <td style="padding:6px 0;color:#ffffff;font-size:14px;text-align:right;">$${(item.line_total/100).toFixed(2)}</td>
      </tr>`).join('')}
      <tr style="border-top:1px solid #374151;">
        <td style="padding:8px 0 4px;color:#ffffff;font-size:15px;font-weight:bold;">Total</td>
        <td style="padding:8px 0 4px;color:#ffffff;font-size:15px;font-weight:bold;text-align:right;">$${(chargesTotal/100).toFixed(2)}</td>
      </tr>
    </table>
  </div>
  <div style="background-color:#2B2B2B;margin:16px;border-radius:12px;padding:24px;">
    <h3 style="color:#ffffff;margin:0 0 16px;font-size:16px;">Payment</h3>
    <table style="width:100%;border-collapse:collapse;">
      ${(payments || []).map((p: any) => `
      <tr>
        <td style="padding:6px 0;color:#9CA3AF;font-size:14px;text-transform:capitalize;">${p.method} — ${new Date(p.paid_at).toLocaleDateString()}${p.note ? ' · ' + p.note : ''}</td>
        <td style="padding:6px 0;color:#4ADE80;font-size:14px;text-align:right;">$${(p.amount/100).toFixed(2)}</td>
      </tr>`).join('')}
      <tr style="border-top:1px solid #374151;">
        <td style="padding:8px 0 4px;color:#ffffff;font-size:15px;font-weight:bold;">Balance remaining</td>
        <td style="padding:8px 0 4px;font-size:15px;font-weight:bold;text-align:right;color:${balanceRemaining <= 0 ? '#4ADE80' : '#FCD34D'};">${balanceRemaining < 0 ? 'Credit on Account: $' + (Math.abs(balanceRemaining)/100).toFixed(2) : balanceRemaining === 0 ? '✓ Paid in full' : '$' + (balanceRemaining/100).toFixed(2)}</td>
      </tr>
    </table>
  </div>
  <div style="padding:24px;text-align:center;">
    <p style="color:#6B7280;font-size:12px;margin:0;">Thank you for staying with us!</p>
  </div>
</div>
</body>
</html>`

      await getResend().emails.send({
        from: `${campgroundName} <${fromEmail}>`,
        replyTo: replyToEmail,
        to: folio.guest_email,
        subject: `Receipt — ${campgroundName}${reservation ? ' · ' + reservation.arrival_date : ''}`,
        html,
      })
    } else {
      // PLAIN TEXT RECEIPT — for walk-up sales, seasonal accounts
      const plainText = `Receipt from ${campgroundName}
${campgroundLocation}
${'─'.repeat(40)}
Date: ${new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })}
Guest: ${folio.guest_name}
${'─'.repeat(40)}

CHARGES
${(lineItems || []).map((item: any) => `${item.description}: $${(item.line_total/100).toFixed(2)}`).join('\n')}

Total charges: $${(itemsTotal/100).toFixed(2)}
${'─'.repeat(40)}

PAYMENTS
${(payments || []).map((p: any) => `${p.method.charAt(0).toUpperCase() + p.method.slice(1)} on ${new Date(p.paid_at).toLocaleDateString()}${p.note ? ' (' + p.note + ')' : ''}: $${(p.amount/100).toFixed(2)}`).join('\n')}

${mostRecentPayment ? 'Most recent payment: $' + (mostRecentPayment.amount/100).toFixed(2) + '\n' : ''}Balance remaining: ${balanceRemaining < 0 ? 'Credit on Account: $' + (Math.abs(balanceRemaining)/100).toFixed(2) : balanceRemaining === 0 ? 'PAID IN FULL' : '$' + (balanceRemaining/100).toFixed(2)}
${'─'.repeat(40)}
Thank you!
${campgroundName}`

      const gmailFrom = process.env.RESEND_GMAIL_FROM || fromEmail

      await getResend().emails.send({
        from: `${campgroundName} <${gmailFrom}>`,
        replyTo: replyToEmail,
        to: folio.guest_email,
        subject: `Receipt — ${campgroundName} · ${new Date().toLocaleDateString()}`,
        text: plainText,
      })
    }

    return NextResponse.json({ success: true })
  } catch (error: any) {
    console.error('Receipt error:', error)
    return NextResponse.json({ error: error.message || 'Failed to send receipt' }, { status: 500 })
  }
}
