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
    .select('park_name, park_location, park_email')
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
    } = body

    const settings = await getSettings()
    const campgroundName = settings?.park_name || 'Campground'
    const campgroundLocation = settings?.park_location || ''
    const contactEmail = settings?.park_email || process.env.RESEND_FROM_EMAIL || 'reservations@example.com'
    const fromEmail = process.env.RESEND_FROM_EMAIL || 'reservations@example.com'
    const replyToEmail = settings?.park_email || process.env.RESEND_FROM_EMAIL || 'info@example.com'

    const siteTypeLabel = (type: string) =>
      ({ rv_site: 'RV Site', cabin: 'Cabin', tent: 'Tent Site' }[type] || type)

    const balanceDue = totalPrice - amountPaid

    // Customer confirmation email
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
                  <td style="padding:8px 0;color:#ffffff;font-size:14px;">${arrival} <span style="color:#6B7280;font-size:12px;">(Check-in: 2:00 PM)</span></td>
                </tr>
                <tr>
                  <td style="padding:8px 0;color:#9CA3AF;font-size:14px;">Departure</td>
                  <td style="padding:8px 0;color:#ffffff;font-size:14px;">${departure} <span style="color:#6B7280;font-size:12px;">(Check-out: 12:00 PM)</span></td>
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
                  <td style="padding:8px 0;color:#9CA3AF;font-size:14px;">Total Cost</td>
                  <td style="padding:8px 0;color:#ffffff;font-size:14px;text-align:right;">$${(totalPrice / 100).toFixed(2)}</td>
                </tr>
                <tr>
                  <td style="padding:8px 0;color:#4ADE80;font-size:14px;">Paid Today</td>
                  <td style="padding:8px 0;color:#4ADE80;font-size:14px;text-align:right;">$${(amountPaid / 100).toFixed(2)}</td>
                </tr>
                ${balanceDue > 0 ? `
                <tr>
                  <td style="padding:8px 0;color:#FBBF24;font-size:14px;border-top:1px solid #374151;">Balance Due at Check-in</td>
                  <td style="padding:8px 0;color:#FBBF24;font-size:14px;text-align:right;border-top:1px solid #374151;">$${(balanceDue / 100).toFixed(2)}</td>
                </tr>
                ` : ''}
              </table>
            </div>

            <!-- Important Info -->
            <div style="background-color:#2B2B2B;margin:16px;border-radius:12px;padding:24px;">
              <h3 style="color:#ffffff;margin:0 0 16px;font-size:18px;">Important Information</h3>
              <div>
                <p style="color:#9CA3AF;font-size:14px;margin:0 0 8px;">✓ Check-in is at <strong style="color:#ffffff;">2:00 PM</strong>. Please check in at the office upon arrival.</p>
                <p style="color:#9CA3AF;font-size:14px;margin:0 0 8px;">✓ Check-out is at <strong style="color:#ffffff;">12:00 PM (noon)</strong>.</p>
                <p style="color:#9CA3AF;font-size:14px;margin:0 0 8px;">✓ All pets must be on a leash at all times.</p>
                <p style="color:#9CA3AF;font-size:14px;margin:0;">✓ Cancellations must be made at least <strong style="color:#ffffff;">7 days before arrival</strong> by contacting us directly.</p>
              </div>
            </div>

            <!-- Contact -->
            <div style="margin:16px;padding:24px;text-align:center;">
              <p style="color:#6B7280;font-size:14px;margin:0 0 4px;">Questions? We're happy to help!</p>
              <a href="mailto:${contactEmail}" style="color:#12c9e5;font-size:14px;">${contactEmail}</a>
              <p style="color:#4B5563;font-size:12px;margin:16px 0 0;">© 2026 ${campgroundName} · ${campgroundLocation}</p>
            </div>

          </div>
        </body>
        </html>
      `,
    })

    // Staff notification email
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
              <tr><td style="padding:6px 0;color:#6B7280;font-size:14px;">Email</td><td style="padding:6px 0;font-size:14px;">${guestEmail}</td></tr>
              <tr><td style="padding:6px 0;color:#6B7280;font-size:14px;">Site</td><td style="padding:6px 0;font-size:14px;">${siteTypeLabel(siteType)} ${siteNumber}</td></tr>
              <tr><td style="padding:6px 0;color:#6B7280;font-size:14px;">Arrival</td><td style="padding:6px 0;font-size:14px;">${arrival}</td></tr>
              <tr><td style="padding:6px 0;color:#6B7280;font-size:14px;">Departure</td><td style="padding:6px 0;font-size:14px;">${departure}</td></tr>
              <tr><td style="padding:6px 0;color:#6B7280;font-size:14px;">Nights</td><td style="padding:6px 0;font-size:14px;">${nights}</td></tr>
              <tr><td style="padding:6px 0;color:#6B7280;font-size:14px;">Guests</td><td style="padding:6px 0;font-size:14px;">${adults} adults, ${children} children</td></tr>
              <tr><td style="padding:6px 0;color:#6B7280;font-size:14px;">Paid</td><td style="padding:6px 0;font-size:14px;color:#166534;font-weight:bold;">$${(amountPaid / 100).toFixed(2)} (${paymentType === 'deposit' ? 'Deposit' : 'Full Payment'})</td></tr>
              <tr><td style="padding:6px 0;color:#6B7280;font-size:14px;">Total</td><td style="padding:6px 0;font-size:14px;">$${(totalPrice / 100).toFixed(2)}</td></tr>
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