import { NextRequest, NextResponse } from 'next/server'
import { Resend } from 'resend'
import { createClient } from '@supabase/supabase-js'
import { requireRole } from '@/lib/require-role'
import { notVoided } from '@/lib/ledger'
import { classifyLineItem, normalizeBillingMode, LANES, type Lane } from '@/lib/ledger-lanes'
import { paymentLines, balanceLine, receiptMoney } from '@/lib/receipt-lines'

function getResend() { return new Resend(process.env.RESEND_API_KEY) }
const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

export async function POST(request: NextRequest) {
  const denied = await requireRole(request, 'staff')
  if (denied) return denied

  try {
    const body = await request.json()
    const { folioId, receiptType, preview, lane: laneParam } = body
    // receiptType: 'reservation' | 'walkup' | 'account'
    //
    // PR 4:
    //   preview: true → RENDER AND RETURN, send nothing. This is what the printable receipt uses,
    //     so a counter payment with no email on file still produces a receipt. Same renderer, so
    //     the printed copy and the emailed copy can never differ.
    //   lane: 'electric' | 'store' | 'seasonal' → a receipt for ONE lane only (Part D).
    const isPreview = preview === true
    const onlyLane: Lane | null =
      (LANES as readonly string[]).includes(String(laneParam)) ? (laneParam as Lane) : null

    const { data: settings } = await supabase.from('settings').select('park_name, park_location, park_email').single()
    const campgroundName = settings?.park_name || 'Our Campground'
    const campgroundLocation = settings?.park_location || ''
    const fromEmail = process.env.RESEND_FROM_EMAIL || 'reservations@example.com'
    const replyToEmail = settings?.park_email || process.env.RESEND_REPLY_TO || fromEmail

    // Load folio
    const { data: folio } = await supabase.from('folios').select('*').eq('id', folioId).single()
    if (!folio) return NextResponse.json({ error: 'Folio not found' }, { status: 404 })

    // Only SENDING needs an address. A printable receipt must still render for a walk-up with
    // no email on file — which is most counter payments.
    if (!isPreview && !folio.guest_email) {
      return NextResponse.json({ error: 'No email on file for this guest' }, { status: 400 })
    }

    // Load line items
    const { data: allLineItems } = await supabase.from('folio_line_items').select('*').eq('folio_id', folioId).order('charged_at')

    // ⚠ A CANCELED CHARGE MUST NEVER APPEAR ON A RECEIPT, in either format, in either billing
    // mode, on a reservation receipt as much as a seasonal one. This route summed every line
    // item raw, so a camper with a canceled packet received a receipt whose charges and balance
    // were wrong — and which disagreed with the folio, which PR 3c had already corrected.
    //
    // OMITTED here rather than struck through: the internal folio strikes a voided row through
    // because staff need to see the charge was deliberately canceled. A camper has no reason to
    // see a charge that no longer exists.
    //
    // One filter, applied once, so both the totals and both rendered lists agree. On a folio with
    // no voided rows it removes nothing and the receipt is unchanged.
    const lineItems = (allLineItems || []).filter(notVoided)

    // Load payments
    // Includes refund rows: a booking refund is now a negative folio row and
    // reservations.amount_paid no longer shrinks, so excluding them would show the guest as
    // having paid money that was handed back.
    const { data: payments } = await supabase.from('folio_payments').select('*').eq('folio_id', folioId).in('status', ['completed', 'refunded', 'partially_refunded']).order('paid_at')

    const itemsTotal = lineItems.reduce((sum: number, i: any) => sum + i.line_total, 0)
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
    // 0 when the column is absent (un-migrated tenant), so the stay line below is the whole
    // charge exactly as it was before pets existed.
    const resPetFee = reservation ? ((reservation as any).pet_fee || 0) : 0
    const resPetCount = reservation ? ((reservation as any).pet_count || 0) : 0
    const chargesTotal = reservationCharge + itemsTotal
    const totalPaid = (reservation ? ((reservation as any).amount_paid || 0) : 0) + paymentsTotal
    const balanceRemaining = chargesTotal - totalPaid

    // ── IS THIS A LANE RECEIPT? ──────────────────────────────────────────────────────────────
    //
    // Two ways in, and the difference matters:
    //
    //   1. billing_mode === 'separated' — the park's whole-account receipt is GROUPED by lane by
    //      default, because that is how a separated park reads every account.
    //   2. an explicit `lane` was asked for — the owner pressed "Send seasonal receipt" for THIS
    //      payment. That is a deliberate per-receipt request, not a park-wide presentation
    //      default, so ⚠ IT MUST WORK ON A COMBINED PARK TOO.
    //
    // Before, `lane` was silently ignored unless the park was separated: a combined park asking
    // for a seasonal-only receipt got the whole account back, electric and store included, with
    // nothing to say the filter had been dropped. Combined is the default for every park, so the
    // feature was unreachable for almost everyone who wanted it.
    //
    // Everything else — a transient guest's account, a reservation, a walk-up — renders exactly
    // as it does today. billing_mode is still read in its own guarded query: a park without the
    // Phase 4 column must still get its receipt.
    let billingMode: 'combined' | 'separated' = 'combined'
    try {
      const { data: modeRow } = await supabase.from('settings').select('billing_mode').limit(1).single()
      billingMode = normalizeBillingMode(modeRow?.billing_mode)
    } catch { /* stays combined */ }

    let guestIsSeasonal = false
    if (folio.guest_id) {
      const { data: g } = await supabase.from('guests').select('is_seasonal').eq('id', folio.guest_id).maybeSingle()
      guestIsSeasonal = !!g?.is_seasonal
    }

    const laneReceipt =
      (onlyLane !== null || billingMode === 'separated') && guestIsSeasonal && !folio.reservation_id

    // The electric signal, resolved the same way everywhere in Phase 4 — the readings that point
    // at these charges, never the category.
    let electricIds = new Set<string>()
    if (laneReceipt && lineItems.length) {
      const { data: readings } = await supabase
        .from('electric_readings').select('folio_line_item_id')
        .in('folio_line_item_id', lineItems.map((i: any) => i.id))
      electricIds = new Set(((readings || []) as any[]).map(r => r.folio_line_item_id).filter(Boolean))
    }
    const laneOfItem = (i: any): Lane => classifyLineItem(i, { electricLineItemIds: electricIds })
    const laneOfPayment = (p: any): Lane | null =>
      (LANES as readonly string[]).includes(String(p.lane)) ? (p.lane as Lane) : null

    const isReservationType = receiptType === 'reservation' || folio.reservation_id

    // One formatter for every figure on a receipt, shared with lib/receipt-lines.ts so the rows
    // and the totals cannot render the same amount two different ways.
    const money = receiptMoney

    // Per-night transparency on the stay line. base_nightly_rate is written at booking
    // time; fall back to dividing the stay by its nights when it's absent (older rows).
    const resNights = reservation?.arrival_date && reservation?.departure_date
      ? Math.max(0, Math.round(
          (new Date((reservation as any).departure_date).getTime() -
           new Date((reservation as any).arrival_date).getTime()) / 86400000))
      : 0
    // The STAY, with the pet fee taken out — otherwise "N nights @ $X" quietly includes a charge
    // that has nothing to do with the nightly rate, and the arithmetic on the receipt does not
    // hold up if the guest checks it.
    const resStayCharge = reservationCharge - resPetFee
    const resNightlyRate = (reservation as any)?.base_nightly_rate
      || (resNights > 0 ? Math.round(resStayCharge / resNights) : 0)
    const stayLabel = resNights > 0 && resNightlyRate > 0
      ? `Reservation stay — ${resNights} night${resNights !== 1 ? 's' : ''} @ ${money(resNightlyRate)}`
      : 'Reservation stay'

    // A card payment is stored GROSS (stay + surcharge) and that gross is what this row
    // renders — unlike the folio ledger, which renders the base. So the fee here really is
    // contained in the number beside it, and the row is broken out into its two labelled
    // parts rather than annotated: base applied to the stay, fee, then the gross actually
    // charged. That also resolves what used to look like an error — a "Card $227.70" line
    // sitting under a "Total $220.00" with a zero balance. Totals are unaffected:
    // paymentsTotal nets the surcharge out and is computed from the data, not from this.
    const paymentRowsHtml = (payments || []).map((p: any) => {
      const fee = p.surcharge_amount || 0
      const label = `${p.method} — ${new Date(p.paid_at).toLocaleDateString()}${p.note ? ' · ' + p.note : ''}`
      // No fee (cash, check, a waived card fee): one row, exactly as before.
      if (fee === 0) return `
      <tr>
        <td style="padding:6px 0;color:#9CA3AF;font-size:14px;text-transform:capitalize;">${label}</td>
        <td style="padding:6px 0;color:#4ADE80;font-size:14px;text-align:right;">${money(p.amount)}</td>
      </tr>`
      // Refund rows carry a negative fee; "charged"/"Total charged" would read backwards.
      const totalLabel = p.amount < 0 ? 'Total refunded' : 'Total charged'
      return `
      <tr>
        <td style="padding:6px 0;color:#9CA3AF;font-size:14px;text-transform:capitalize;">${label}</td>
        <td style="padding:6px 0;color:#4ADE80;font-size:14px;text-align:right;">${money(p.amount - fee)}</td>
      </tr>
      <tr>
        <td style="padding:2px 0;color:#6B7280;font-size:12px;padding-left:12px;">Transaction fee</td>
        <td style="padding:2px 0;color:#6B7280;font-size:12px;text-align:right;">${money(fee)}</td>
      </tr>
      <tr>
        <td style="padding:2px 0 6px 12px;color:#9CA3AF;font-size:12px;">${totalLabel}</td>
        <td style="padding:2px 0 6px;color:#9CA3AF;font-size:12px;text-align:right;">${money(p.amount)}</td>
      </tr>`
    }).join('')

    // Same split for the plain-text receipt (walk-up sales, seasonal accounts) so the two
    // formats can't drift — a card payment is stored gross in both.
    const paymentRowsText = (payments || []).map((p: any) => {
      const fee = p.surcharge_amount || 0
      const head = `${p.method.charAt(0).toUpperCase() + p.method.slice(1)} on ${new Date(p.paid_at).toLocaleDateString()}${p.note ? ' (' + p.note + ')' : ''}`
      if (fee === 0) return `${head}: ${money(p.amount)}`
      const totalLabel = p.amount < 0 ? 'Total refunded' : 'Total charged'
      return `${head}: ${money(p.amount - fee)}\n    Transaction fee: ${money(fee)}\n    ${totalLabel}: ${money(p.amount)}`
    }).join('\n')

    // ── THE LANE-GROUPED ACCOUNT RECEIPT ─────────────────────────────────────────────────────
    //
    // Mirrors what the camper's account now shows on the folio (PR 3c): each lane with its own
    // charges, payments and subtotal, anything not filed against a lane shown HONESTLY as its
    // own line, and ONE grand total that equals the account balance. Brought up to the house
    // style — the same 🧾 theme the reservation receipt uses — with a plain-text part kept for
    // the email so nothing regresses for a text-only client.
    const LANE_LABELS: Record<Lane, string> = {
      electric: 'Electric', store: 'Camp store', seasonal: 'Seasonal fee', other: 'Other charges',
    }
    const laneSections = (LANES as readonly Lane[])
      .filter(l => !onlyLane || l === onlyLane)
      .map(l => {
        const items = lineItems.filter((i: any) => laneOfItem(i) === l)
        const pays = (payments || []).filter((p: any) => laneOfPayment(p) === l)
        const charges = items.reduce((s: number, i: any) => s + i.line_total, 0)
        const paid = pays.reduce((s: number, p: any) => s + p.amount - (p.surcharge_amount || 0), 0)
        return { lane: l, label: LANE_LABELS[l], items, pays, charges, paid, subtotal: charges - paid }
      })
      .filter(sec => sec.items.length > 0 || sec.pays.length > 0)

    const unassignedPays = (payments || []).filter((p: any) => laneOfPayment(p) === null)
    const unassignedTotal = unassignedPays.reduce((s: number, p: any) => s + p.amount - (p.surcharge_amount || 0), 0)

    // The grand total. With no lane filter this IS the account balance — every charge and every
    // payment is in exactly one bucket, so the sections and the remainder reconcile to it.
    const laneGrandTotal = onlyLane
      ? laneSections.reduce((s, sec) => s + sec.subtotal, 0)
      : itemsTotal - paymentsTotal

    // ⚠ THE ORDER AND THE LABELS ARE THE FIX. See lib/receipt-lines.ts.
    //
    // This section used to print the lane's REMAINING BALANCE beside the heading — so a camper
    // who had paid in full got a receipt reading "Seasonal fee $0.00" when their fee was
    // $1,895.00, and the same balance appeared again at the foot of the page. Right figure,
    // wrong label, printed twice.
    //
    // It now reads like an ordinary receipt: the charge, then each payment as its own line
    // (oldest first — `payments` is ordered by paid_at), then a rule, then the balance ONCE.
    const row = (label: string, value: string, o: { colour?: string; size?: number; bold?: boolean; indent?: boolean; top?: boolean } = {}) => {
      const pad = o.top ? '10px 0 4px' : '6px 0'
      const border = o.top ? 'border-top:1px solid #374151;' : ''
      const labelColour = o.bold ? '#ffffff' : (o.indent ? '#6B7280' : '#9CA3AF')
      return `
      <tr>
        <td style="padding:${pad};${o.indent ? 'padding-left:12px;' : ''}color:${labelColour};font-size:${o.size || 14}px;${o.bold ? 'font-weight:bold;' : ''}${border}">${label}</td>
        <td style="padding:${pad};color:${o.colour || '#ffffff'};font-size:${o.size || 14}px;text-align:right;${o.bold ? 'font-weight:bold;' : ''}${border}">${value}</td>
      </tr>`
    }

    const laneSectionsHtml = laneSections.map(sec => {
      // A lane-scoped receipt has no grand total below it, so its section line IS the balance.
      // The account receipt does, so its sections are subtotals. See lib/receipt-lines.ts.
      const bal = balanceLine(sec.subtotal, onlyLane ? 'balance' : 'subtotal')
      return `
  <div style="background-color:#2B2B2B;margin:16px;border-radius:12px;padding:24px;">
    <h3 style="color:#ffffff;margin:0 0 12px;font-size:16px;">${sec.label}</h3>
    <table style="width:100%;border-collapse:collapse;">
      ${sec.items.map((i: any) => row(i.description, money(i.line_total))).join('')}
      ${sec.pays.flatMap((p: any) => paymentLines(p).map(l =>
        l.kind === 'payment'
          ? row(l.label, '\u2212' + money(Math.abs(l.amount)), { colour: '#4ADE80' })
          : row(l.label, money(l.amount), { size: 12, indent: true, colour: '#6B7280' }),
      )).join('')}
      ${row(bal.label, bal.value, { bold: true, top: true, size: 15, colour: bal.paid ? '#4ADE80' : '#FCD34D' })}
    </table>
  </div>`
    }).join('')

    const unassignedHtml = (!onlyLane && unassignedTotal !== 0) ? `
  <div style="background-color:#2B2B2B;margin:16px;border-radius:12px;padding:24px;">
    <div style="display:flex;justify-content:space-between;align-items:baseline;">
      <div>
        <h3 style="color:#ffffff;margin:0 0 2px;font-size:16px;">Account credit</h3>
        <p style="color:#6B7280;margin:0;font-size:12px;">Applies to any of the above</p>
      </div>
      <span style="color:#4ADE80;font-size:16px;font-weight:bold;">−${money(unassignedTotal)}</span>
    </div>
  </div>` : ''

    const laneHtml = `<!DOCTYPE html>
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
    <p style="color:#9CA3AF;margin:0;font-size:14px;">${new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })}${onlyLane ? ' · ' + LANE_LABELS[onlyLane] : ''}</p>
  </div>
  ${laneSectionsHtml}
  ${unassignedHtml}
  ${onlyLane ? '' : `
  <div style="background-color:#2B2B2B;margin:16px;border-radius:12px;padding:24px;">
    <table style="width:100%;border-collapse:collapse;">
      <tr>
        <td style="padding:8px 0 4px;color:#ffffff;font-size:16px;font-weight:bold;">${balanceLine(laneGrandTotal).label}</td>
        <td style="padding:8px 0 4px;font-size:16px;font-weight:bold;text-align:right;color:${balanceLine(laneGrandTotal).paid ? '#4ADE80' : '#FCD34D'};">${balanceLine(laneGrandTotal).value}</td>
      </tr>
    </table>
  </div>`}
  <div style="padding:24px;text-align:center;">
    <p style="color:#6B7280;font-size:12px;margin:0;">Thank you!</p>
    <p style="color:#6B7280;font-size:12px;margin:8px 0 0;">${campgroundName}</p>
  </div>
</div>
</body>
</html>`

    // Plain-text twin, so an email always carries a readable text part.
    const laneText = `Receipt from ${campgroundName}
${campgroundLocation}
${'─'.repeat(40)}
Date: ${new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })}
Guest: ${folio.guest_name}${onlyLane ? '\n' + LANE_LABELS[onlyLane] + ' only' : ''}
${'─'.repeat(40)}
${laneSections.map(sec => `
${sec.label.toUpperCase()}
${sec.items.map((i: any) => `  ${i.description}: ${money(i.line_total)}`).join('\n')}
${sec.pays.flatMap((p: any) => paymentLines(p).map(l =>
  l.kind === 'payment' ? `  ${l.label}: -${money(Math.abs(l.amount))}` : `    ${l.label}: ${money(l.amount)}`,
)).join('\n')}
  ${balanceLine(sec.subtotal, onlyLane ? 'balance' : 'subtotal').label}: ${balanceLine(sec.subtotal, onlyLane ? 'balance' : 'subtotal').value}`).join('\n')}
${(!onlyLane && unassignedTotal !== 0) ? `\nACCOUNT CREDIT (applies to any of the above): -${money(unassignedTotal)}\n` : ''}
${onlyLane ? '' : `${'─'.repeat(40)}
${balanceLine(laneGrandTotal).label}: ${balanceLine(laneGrandTotal).value}`}
${'─'.repeat(40)}
Thank you!
${campgroundName}`

    // PREVIEW — render and RETURN, send nothing. The printable receipt renders exactly what an
    // emailed one would, because it is the same renderer; there is no second receipt path.
    if (isPreview) {
      if (laneReceipt) return NextResponse.json({ html: laneHtml, text: laneText })
      // For a reservation/walk-up preview, fall through to the shared builders below by
      // returning after they are built — handled at the end of each branch.
    }

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
        <td style="padding:6px 0;color:#9CA3AF;font-size:14px;">${stayLabel}</td>
        <td style="padding:6px 0;color:#ffffff;font-size:14px;text-align:right;">${money(resStayCharge)}</td>
      </tr>` : ''}
      ${resPetFee > 0 ? `
      <tr>
        <td style="padding:6px 0;color:#9CA3AF;font-size:14px;">Pet fee${resPetCount > 1 ? ` (${resPetCount} pets)` : ''}</td>
        <td style="padding:6px 0;color:#ffffff;font-size:14px;text-align:right;">${money(resPetFee)}</td>
      </tr>` : ''}
      ${lineItems.map((item: any) => `
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
      ${paymentRowsHtml}
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

      if (isPreview) return NextResponse.json({ html })

      await getResend().emails.send({
        from: `${campgroundName} <${fromEmail}>`,
        replyTo: replyToEmail,
        to: folio.guest_email,
        subject: `Receipt — ${campgroundName}${reservation ? ' · ' + reservation.arrival_date : ''}`,
        html,
      })
    } else if (laneReceipt) {
      // The seasonal account at a separated park — styled, grouped by lane, with the plain-text
      // twin as the email's text part.
      await getResend().emails.send({
        from: `${campgroundName} <${process.env.RESEND_GMAIL_FROM || fromEmail}>`,
        replyTo: replyToEmail,
        to: folio.guest_email,
        subject: `Receipt — ${campgroundName} · ${new Date().toLocaleDateString()}`,
        html: laneHtml,
        text: laneText,
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
${lineItems.map((item: any) => `${item.description}: ${money(item.line_total)}`).join('\n')}

Total charges: ${money(itemsTotal)}
${'─'.repeat(40)}

PAYMENTS
${paymentRowsText}

${mostRecentPayment ? 'Most recent payment: ' + money(mostRecentPayment.amount) + '\n' : ''}Balance remaining: ${balanceRemaining < 0 ? 'Credit on Account: ' + money(Math.abs(balanceRemaining)) : balanceRemaining === 0 ? 'PAID IN FULL' : money(balanceRemaining)}
${'─'.repeat(40)}
Thank you!
${campgroundName}`

      if (isPreview) return NextResponse.json({ text: plainText })

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
