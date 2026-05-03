import { NextRequest, NextResponse } from 'next/server'
import { Resend } from 'resend'
import { createClient } from '@supabase/supabase-js'

const resend = new Resend(process.env.RESEND_API_KEY)

async function getSettings() {
  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  )
  const { data } = await supabase
    .from('settings')
    .select('park_name, park_location, park_email, park_phone, confirmation_message')
    .limit(1)
    .single()
  return data
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json()
    const {
      guestName,
      guestEmail,
      siteNumber,
      siteType,
      arrival,
      departure,
      nights,
      adults,
      children,
      totalPrice,
      amountPaid,
      paymentType,
      confirmationNumber,
      addonDetails = [],       // [{ name, quantity, price }]
      extraGuestFee = 0,
      discountAmount = 0,
      discountCode = null,
    } = body

    const settings = await getSettings()
    const campgroundName = settings?.park_name || 'Campground'
    const campgroundLocation = settings?.park_location || ''
    const contactEmail = settings?.park_email || process.env.RESEND_FROM_EMAIL || 'reservations@example.com'
    const contactPhone = settings?.park_phone || ''
    const fromEmail = process.env.RESEND_FROM_EMAIL || 'reservations@example.com'
    const replyToEmail = settings?.park_email || process.env.RESEND_FROM_EMAIL || 'info@example.com'

    // Convert confirmation_message newlines into HTML paragraphs
    const rawMessage = settings?.confirmation_message || ''
    const confirmationParagraphs = rawMessage
      .split('\n\n')
      .filter((p: string) => p.trim())
      .map((p: string) => `<p style="color:#9CA3AF;font-size:14px;margin:0 0 12px;">${p.trim().replace(/\n/g, '<br/>')}</p>`)
      .join('')

    const siteTypeLabel = (type: string) =>
      ({ rv_site: 'RV Site', cabin: 'Cabin', tent: 'Tent Site' }[type] || type)

    const balanceDue = totalPrice - amountPaid

    // ── Build itemized add-ons rows (shared by both emails) ──────────────────
    const hasAddons = addonDetails && addonDetails.length > 0
    const hasExtraGuests = extraGuestFee > 0
    const hasDiscount = discountAmount > 0

    // For customer email (dark theme)
    const addonRowsDark = hasAddons
      ? addonDetails.map((a: any) =>
          `<tr>
            <td style="padding:6px 0;color:#9CA3AF;font-size:14px;">
              ${a.name}${a.quantity > 1 ? ` ×${a.quantity}` : ''}
            </td>
            <td style="padding:6px 0;color:#ffffff;font-size:14px;text-align:right;">
              $${((a.price * a.quantity) / 100).toFixed(2)}
            </td>
          </tr>`
        ).join('')
      : ''

    // For staff email (light theme)
    const addonRowsLight = hasAddons
      ? addonDetails.map((a: any) =>
          `<tr>
            <td style="padding:4px 0;color:#6B7280;font-size:13px;">
              Add-on: ${a.name}${a.quantity > 1 ? ` ×${a.quantity}` : ''}
            </td>
            <td style="padding:4px 0;font-size:13px;">
              $${((a.price * a.quantity) / 100).toFixed(2)}
            </td>
          </tr>`
        ).join('')
      : ''

    // ── Customer confirmation email ──────────────────────────────────────────
    await resend.emails.send({
      from: `${campgroundName} <${fromEmail}>`,
      replyTo: replyToEmail,
      to: guestEmail,
      subject: `Reservation Confirmed — ${siteTypeLabel(siteType)} ${siteNumber} · ${arrival}`,
      html: `
        <!DOCTYPE html>
        <html>
        <head>
          <meta charset="utf-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
        </head>
        <body style="margin:0;padding:0;background-color:#1C1C1C;font-family:Arial,sans-serif;">
          <div style="max-width:600px;margin:0 auto;background-color:#1C1C1C;">

            <!-- Header -->
            <div style="background-color:#2B2B2B;padding:32px;text-align:center;">
              <h1 style="color:#ffffff;margin:0 0 4px;font-size:24px;">${campgroundName}</h1>
              <p style="color:#9CA3AF;margin:0;font-size:14px;">${campgroundLocation}</p>
            </div>

            <!-- Success Banner -->
            <div style="background-color:#2B2B2B;margin:16px;border-radius:12px;padding:32px;text-align:center;">
              <div style="font-size:48px;margin-bottom:16px;">🎉</div>
              <h2 style="color:#ffffff;margin:0 0 8px;font-size:28px;">You're all set, ${guestName}!</h2>
              <p style="color:#9CA3AF;margin:0 0 8px;">Your reservation is confirmed.</p>
              <p style="color:#6B7280;margin:0;font-size:14px;">Confirmation #${confirmationNumber}</p>
            </div>

            <!-- Reservation Details -->
            <div style="background-color:#2B2B2B;margin:16px;border-radius:12px;padding:24px;">
              <h3 style="color:#ffffff;margin:0 0 16px;font-size:18px;">Reservation Details</h3>
              <table style="width:100%;border-collapse:collapse;">
                <tr>
                  <td style="padding:8px 0;color:#9CA3AF;font-size:14px;width:40%;">Site</td>
                  <td style="padding:8px 0;color:#ffffff;font-size:14px;font-weight:bold;">${siteTypeLabel(siteType)} ${siteNumber}</td>
                </tr>
                <tr>
                  <td style="padding:8px 0;color:#9CA3AF;font-size:14px;">Arrival</td>
                  <td style="padding:8px 0;color:#ffffff;font-size:14px;">${arrival}</td>
                </tr>
                <tr>
                  <td style="padding:8px 0;color:#9CA3AF;font-size:14px;">Departure</td>
                  <td style="padding:8px 0;color:#ffffff;font-size:14px;">${departure}</td>
                </tr>
                <tr>
                  <td style="padding:8px 0;color:#9CA3AF;font-size:14px;">Duration</td>
                  <td style="padding:8px 0;color:#ffffff;font-size:14px;">${nights} night${nights !== 1 ? 's' : ''}</td>
                </tr>
                <tr>
                  <td style="padding:8px 0;color:#9CA3AF;font-size:14px;">Guests</td>
                  <td style="padding:8px 0;color:#ffffff;font-size:14px;">${adults} adult${adults !== 1 ? 's' : ''}${children > 0 ? `, ${children} child${children !== 1 ? 'ren' : ''}` : ''}</td>
                </tr>
              </table>
            </div>

            <!-- Payment Summary -->
            <div style="background-color:#2B2B2B;margin:16px;border-radius:12px;padding:24px;">
              <h3 style="color:#ffffff;margin:0 0 16px;font-size:18px;">Payment Summary</h3>
              <table style="width:100%;border-collapse:collapse;">
                <tr>
                  <td style="padding:6px 0;color:#9CA3AF;font-size:14px;">Site charges (${nights} night${nights !== 1 ? 's' : ''})</td>
                  <td style="padding:6px 0;color:#ffffff;font-size:14px;text-align:right;">$${((totalPrice - extraGuestFee - (hasAddons ? addonDetails.reduce((s: number, a: any) => s + a.price * a.quantity, 0) : 0) + discountAmount) / 100).toFixed(2)}</td>
                </tr>
                ${hasExtraGuests ? `
                <tr>
                  <td style="padding:6px 0;color:#9CA3AF;font-size:14px;">Extra guest fees</td>
                  <td style="padding:6px 0;color:#ffffff;font-size:14px;text-align:right;">$${(extraGuestFee / 100).toFixed(2)}</td>
                </tr>` : ''}
                ${addonRowsDark}
                ${hasDiscount ? `
                <tr>
                  <td style="padding:6px 0;color:#4ADE80;font-size:14px;">Discount${discountCode ? ` (${discountCode})` : ''}</td>
                  <td style="padding:6px 0;color:#4ADE80;font-size:14px;text-align:right;">-$${(discountAmount / 100).toFixed(2)}</td>
                </tr>` : ''}
                <tr style="border-top:1px solid #374151;">
                  <td style="padding:8px 0 6px;color:#ffffff;font-size:15px;font-weight:bold;">Total</td>
                  <td style="padding:8px 0 6px;color:#ffffff;font-size:15px;font-weight:bold;text-align:right;">$${(totalPrice / 100).toFixed(2)}</td>
                </tr>
                <tr>
                  <td style="padding:6px 0;color:#4ADE80;font-size:14px;">Paid Today</td>
                  <td style="padding:6px 0;color:#4ADE80;font-size:14px;text-align:right;">$${(amountPaid / 100).toFixed(2)}</td>
                </tr>
                ${balanceDue > 0 ? `
                <tr>
                  <td style="padding:6px 0;color:#FBBF24;font-size:14px;">Balance Due at Check-in</td>
                  <td style="padding:6px 0;color:#FBBF24;font-size:14px;text-align:right;">$${(balanceDue / 100).toFixed(2)}</td>
                </tr>` : ''}
              </table>
            </div>

            <!-- Important Information (from settings) -->
            ${confirmationParagraphs ? `
            <div style="background-color:#2B2B2B;margin:16px;border-radius:12px;padding:24px;">
              <h3 style="color:#ffffff;margin:0 0 16px;font-size:18px;">Important Information</h3>
              ${confirmationParagraphs}
            </div>
            ` : ''}

            <!-- Contact -->
            <div style="margin:16px;padding:24px;text-align:center;">
              <p style="color:#6B7280;font-size:14px;margin:0 0 4px;">Questions? We're happy to help!</p>
              <a href="mailto:${contactEmail}" style="color:#12c9e5;font-size:14px;">${contactEmail}</a>
              ${contactPhone ? `<p style="color:#6B7280;font-size:14px;margin:8px 0 0;">${contactPhone}</p>` : ''}
              <p style="color:#4B5563;font-size:12px;margin:16px 0 0;">© 2026 ${campgroundName} · ${campgroundLocation}</p>
            </div>

          </div>
        </body>
        </html>
      `,
    })

    // ── Staff notification email ─────────────────────────────────────────────
    await resend.emails.send({
      from: `${campgroundName} <${fromEmail}>`,
      replyTo: replyToEmail,
      to: contactEmail,
      subject: `New Reservation — ${siteTypeLabel(siteType)} ${siteNumber} · ${arrival}`,
      html: `
        <!DOCTYPE html>
        <html>
        <body style="font-family:Arial,sans-serif;background:#f3f4f6;padding:20px;">
          <div style="max-width:500px;margin:0 auto;background:#ffffff;border-radius:12px;padding:24px;">
            <h2 style="color:#166534;margin:0 0 16px;">New Reservation Received!</h2>
            <table style="width:100%;border-collapse:collapse;">
              <tr><td style="padding:6px 0;color:#6B7280;font-size:14px;">Guest</td><td style="padding:6px 0;font-size:14px;font-weight:bold;">${guestName}</td></tr>
              <tr><td style="padding:6px 0;color:#6B7280;font-size:14px;">Email</td><td style="padding:6px 0;font-size:14px;"><a href="mailto:${guestEmail}">${guestEmail}</a></td></tr>
              <tr><td style="padding:6px 0;color:#6B7280;font-size:14px;">Site</td><td style="padding:6px 0;font-size:14px;">${siteTypeLabel(siteType)} ${siteNumber}</td></tr>
              <tr><td style="padding:6px 0;color:#6B7280;font-size:14px;">Arrival</td><td style="padding:6px 0;font-size:14px;">${arrival}</td></tr>
              <tr><td style="padding:6px 0;color:#6B7280;font-size:14px;">Departure</td><td style="padding:6px 0;font-size:14px;">${departure}</td></tr>
              <tr><td style="padding:6px 0;color:#6B7280;font-size:14px;">Nights</td><td style="padding:6px 0;font-size:14px;">${nights}</td></tr>
              <tr><td style="padding:6px 0;color:#6B7280;font-size:14px;">Guests</td><td style="padding:6px 0;font-size:14px;">${adults} adults, ${children} children</td></tr>
              ${hasExtraGuests ? `<tr><td style="padding:6px 0;color:#6B7280;font-size:14px;">Extra guest fees</td><td style="padding:6px 0;font-size:14px;">$${(extraGuestFee / 100).toFixed(2)}</td></tr>` : ''}
              ${addonRowsLight}
              ${hasDiscount ? `<tr><td style="padding:6px 0;color:#6B7280;font-size:14px;">Discount${discountCode ? ` (${discountCode})` : ''}</td><td style="padding:6px 0;font-size:14px;color:#166534;">-$${(discountAmount / 100).toFixed(2)}</td></tr>` : ''}
              <tr><td style="padding:6px 0;color:#6B7280;font-size:14px;">Paid</td><td style="padding:6px 0;font-size:14px;color:#166534;font-weight:bold;">$${(amountPaid / 100).toFixed(2)} (${paymentType === 'deposit' ? 'Deposit' : paymentType === 'unpaid' ? 'Pay on Arrival' : 'Full Payment'})</td></tr>
              <tr><td style="padding:6px 0;color:#6B7280;font-size:14px;">Total</td><td style="padding:6px 0;font-size:14px;font-weight:bold;">$${(totalPrice / 100).toFixed(2)}</td></tr>
              <tr><td style="padding:6px 0;color:#6B7280;font-size:14px;">Confirmation #</td><td style="padding:6px 0;font-size:14px;">${confirmationNumber}</td></tr>
            </table>
          </div>
        </body>
        </html>
      `,
    })

    return NextResponse.json({ success: true })

  } catch (error: any) {
    console.error('Email error:', error)
    return NextResponse.json(
      { error: error.message || 'Failed to send email.' },
      { status: 500 }
    )
  }
}
