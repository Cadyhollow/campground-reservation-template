import { Resend } from 'resend'
import { createClient } from '@supabase/supabase-js'

// The confirmation + staff notification emails, lifted VERBATIM out of app/api/email/route.ts
// so the booking flow can send them with a direct function call instead of an HTTP self-fetch.
//
// WHY: /api/payment used to do `await fetch(`${request.nextUrl.origin}/api/email`, ...)` — the
// server calling its own public URL. That made the confirmation email depend on a route that had
// to stay open to the internet, so it could not be put behind the admin session without breaking
// live bookings. It was also fragile in its own right: an extra network hop, dependent on
// nextUrl.origin resolving correctly behind Vercel's proxy.
//
// Calling this function directly removes both problems at once. /api/email survives only as a
// thin admin-gated wrapper for the admin screens that re-send a confirmation by hand.
//
// The email bodies below are byte-identical to what THIS repo's route sent — spliced from it,
// not retyped, and not copied from Cady, whose version of this route differs (lazy Resend
// construction, different field ordering, no tax model). A guest's confirmation email is
// unchanged by this refactor.

function getResend() { return new Resend(process.env.RESEND_API_KEY) }

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

// Shape is the request body /api/email always accepted. Left permissive on purpose: this is a
// verbatim extraction, and tightening the contract is a separate change from moving it.
export type ConfirmationEmailPayload = Record<string, any>

// Sends the guest confirmation and the staff notification. Throws on Resend failure — callers
// decide whether that should fail their request (see /api/payment, which deliberately swallows
// it: the card is already charged, so a dead mail provider must not fail the booking).
export async function sendConfirmationEmails(payload: ConfirmationEmailPayload): Promise<void> {
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
      camperType = '',
      camperLength = 0,
      camperAmperage = '',
      totalPrice,
      amountPaid,
      surchargeAmount = 0,
      // Itemized cash lines, in order, as { label, amount } — straight from
      // lib/pricing's PricingResult.lines where the caller has it. Rendering these
      // verbatim is what makes every fee its own row instead of being absorbed into
      // the site charge (see the derived fallback below for callers that can't supply
      // them). Label wording therefore lives in lib/pricing.ts, deliberately.
      lines = [],
      nightlyRate = 0,
      // Only used by the derived fallback — the itemized path gets fees as real lines.
      feesTotal = 0,
      // Tax is rendered when a client has it configured. The template carries no tax
      // model today (Cady does), so these stay 0 and the row simply never appears.
      taxAmount = 0,
      taxLabel = 'Sales tax',
      taxRate = 0,
      paymentType,
      confirmationNumber,
      addonDetails = [],
      extraGuestFee = 0,
      discountAmount = 0,
      discountCode = null,
      earlyCheckin = false,
      earlyCheckinFee = 0,
      lateCheckout = false,
      lateCheckoutFee = 0,
    } = payload

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

    const camperTypeLabel = (val: string) => ({
      travel_trailer: 'Travel Trailer',
      fifth_wheel: 'Fifth Wheel',
      class_a: 'Class A',
      class_c: 'Class C',
      van: 'Van',
      other: 'Other',
    }[val] || val)

    const amperageLabel = (val: string) => val.replace('amp', ' Amp')

    const balanceDue = totalPrice - amountPaid

    const hasAddons = addonDetails && addonDetails.length > 0
    const hasExtraGuests = extraGuestFee > 0
    const hasDiscount = discountAmount > 0
    const hasCamperInfo = camperType && camperType !== ''
    const hasTax = taxAmount > 0

    const money = (c: number) => `$${(c / 100).toFixed(2)}`
    const nightsLabel = `${nights} night${nights !== 1 ? 's' : ''}`

    // ── Itemization ───────────────────────────────────────────────────────────
    // Preferred: the caller sends `lines` (lib/pricing's itemized cash lines), so every
    // component — per-night site charge, each named fee, each add-on — is its own row.
    const hasLines = Array.isArray(lines) && lines.length > 0
    const addonsSum = hasAddons
      ? addonDetails.reduce((s: number, a: any) => s + a.price * a.quantity, 0)
      : 0

    // Fallback for callers that can't supply lines. Note feesTotal is subtracted here:
    // omitting it silently folded configured fees (cleaning, pet…) into the site charge,
    // overstating it with no fee row of its own.
    const derivedSiteCharge =
      totalPrice - extraGuestFee - addonsSum - earlyCheckinFee - lateCheckoutFee - feesTotal + discountAmount
    // Per-night when the rate is known, else the old lump label.
    const siteChargeLabel = nightlyRate > 0
      ? `Site charges — ${nightsLabel} @ ${money(nightlyRate)}`
      : `Site charges (${nightsLabel})`

    // Pre-tax, pre-discount. Shown only when tax or a discount follows it; otherwise it
    // would just restate the Total on the very next row.
    const subtotal = hasLines
      ? lines.reduce((s: number, l: any) => s + (l.amount || 0), 0)
      : derivedSiteCharge + extraGuestFee + addonsSum + earlyCheckinFee + lateCheckoutFee + feesTotal
    const showSubtotal = hasTax || hasDiscount

    // totalPrice stays authoritative — it is what was actually charged and billed, and this
    // route must never restate it. But we now print the components beside it, so if the
    // caller's numbers disagree the guest sees a breakdown that doesn't add up. Surface
    // that loudly rather than emitting a quietly wrong receipt.
    const reconciled = subtotal + taxAmount - discountAmount
    if (reconciled !== totalPrice) {
      console.warn(
        `[email] itemization does not reconcile for ${confirmationNumber}: ` +
        `subtotal ${subtotal} + tax ${taxAmount} - discount ${discountAmount} = ${reconciled}, ` +
        `but totalPrice is ${totalPrice} (off by ${reconciled - totalPrice}). ` +
        `Total shown is totalPrice; check the caller's payload.`
      )
    }

    const row = (label: string, value: string, opts: { color?: string; bold?: boolean; size?: string } = {}) => {
      const c = opts.color || '#ffffff'
      const size = opts.size || '14px'
      const weight = opts.bold ? 'font-weight:bold;' : ''
      return `<tr>
                  <td style="padding:6px 0;color:${opts.color === '#4ADE80' || opts.color === '#FBBF24' ? c : '#9CA3AF'};font-size:${size};${weight}">${label}</td>
                  <td style="padding:6px 0;color:${c};font-size:${size};text-align:right;${weight}">${value}</td>
                </tr>`
    }

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

    // Itemized rows for the customer email. Defined after addonRowsDark because the
    // fallback branch reuses it.
    const itemRowsDark = hasLines
      ? lines.map((l: any) => row(l.label, money(l.amount || 0))).join('')
      : [
          row(siteChargeLabel, money(derivedSiteCharge)),
          hasExtraGuests ? row('Extra guests', money(extraGuestFee)) : '',
          addonRowsDark,
          earlyCheckin ? row('Early Check-In', money(earlyCheckinFee)) : '',
          lateCheckout ? row('Late Check-Out', money(lateCheckoutFee)) : '',
          feesTotal > 0 ? row('Fees', money(feesTotal)) : '',
        ].join('')

    // ── Customer confirmation email ──────────────────────────────────────────
    await getResend().emails.send({
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
                ${hasCamperInfo ? `
                <tr>
                  <td style="padding:8px 0;color:#9CA3AF;font-size:14px;">Camper Type</td>
                  <td style="padding:8px 0;color:#ffffff;font-size:14px;">${camperTypeLabel(camperType)}</td>
                </tr>
                <tr>
                  <td style="padding:8px 0;color:#9CA3AF;font-size:14px;">Camper Length</td>
                  <td style="padding:8px 0;color:#ffffff;font-size:14px;">${camperLength} ft</td>
                </tr>
                <tr>
                  <td style="padding:8px 0;color:#9CA3AF;font-size:14px;">Amperage</td>
                  <td style="padding:8px 0;color:#ffffff;font-size:14px;">${amperageLabel(camperAmperage)}</td>
                </tr>
                ` : ''}
              </table>
            </div>

            <!-- Payment Summary -->
            <div style="background-color:#2B2B2B;margin:16px;border-radius:12px;padding:24px;">
              <h3 style="color:#ffffff;margin:0 0 16px;font-size:18px;">Payment Summary</h3>
              <table style="width:100%;border-collapse:collapse;">
                ${itemRowsDark}
                ${showSubtotal ? `
                <tr>
                  <td style="padding:6px 0;color:#9CA3AF;font-size:14px;">Subtotal</td>
                  <td style="padding:6px 0;color:#ffffff;font-size:14px;text-align:right;">${money(subtotal)}</td>
                </tr>` : ''}
                ${hasTax ? `
                <tr>
                  <td style="padding:6px 0;color:#9CA3AF;font-size:14px;">${taxLabel}${taxRate > 0 ? ` (${taxRate}%)` : ''}</td>
                  <td style="padding:6px 0;color:#ffffff;font-size:14px;text-align:right;">${money(taxAmount)}</td>
                </tr>` : ''}
                ${hasDiscount ? `
                <tr>
                  <td style="padding:6px 0;color:#4ADE80;font-size:14px;">Discount${discountCode ? ` (${discountCode})` : ''}</td>
                  <td style="padding:6px 0;color:#4ADE80;font-size:14px;text-align:right;">-${money(discountAmount)}</td>
                </tr>` : ''}
                <tr style="border-top:1px solid #374151;">
                  <td style="padding:8px 0 6px;color:#ffffff;font-size:15px;font-weight:bold;">Total reservation cost</td>
                  <td style="padding:8px 0 6px;color:#ffffff;font-size:15px;font-weight:bold;text-align:right;">${money(totalPrice)}</td>
                </tr>
                ${surchargeAmount > 0 ? `
                <tr>
                  <td style="padding:6px 0;color:#9CA3AF;font-size:13px;">Stay payment</td>
                  <td style="padding:6px 0;color:#9CA3AF;font-size:13px;text-align:right;">$${(amountPaid / 100).toFixed(2)}</td>
                </tr>
                <tr>
                  <td style="padding:6px 0;color:#9CA3AF;font-size:13px;">Card processing fee</td>
                  <td style="padding:6px 0;color:#9CA3AF;font-size:13px;text-align:right;">$${(surchargeAmount / 100).toFixed(2)}</td>
                </tr>` : ''}
                <tr>
                  <td style="padding:6px 0;color:#4ADE80;font-size:14px;font-weight:bold;">Paid Today</td>
                  <td style="padding:6px 0;color:#4ADE80;font-size:14px;font-weight:bold;text-align:right;">$${((amountPaid + surchargeAmount) / 100).toFixed(2)}</td>
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
    await getResend().emails.send({
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
              ${hasCamperInfo ? `
              <tr><td style="padding:6px 0;color:#6B7280;font-size:14px;">Camper Type</td><td style="padding:6px 0;font-size:14px;font-weight:bold;">${camperTypeLabel(camperType)}</td></tr>
              <tr><td style="padding:6px 0;color:#6B7280;font-size:14px;">Camper Length</td><td style="padding:6px 0;font-size:14px;">${camperLength} ft</td></tr>
              <tr><td style="padding:6px 0;color:#6B7280;font-size:14px;">Amperage</td><td style="padding:6px 0;font-size:14px;">${amperageLabel(camperAmperage)}</td></tr>
              ` : ''}
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
}
