import { NextRequest, NextResponse } from 'next/server'
import { Resend } from 'resend'
import { createClient } from '@supabase/supabase-js'
import { requireRole } from '@/lib/require-role'
import { normalizeBillingMode, laneBalances } from '@/lib/ledger-lanes'
import { accountBuckets } from '@/lib/account-buckets'

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
    const {
      guestName, guestEmail, siteNumber, paymentAmount, paymentMethod, paymentNote, paidAt,
      // ⚠ NOT TRUSTED. Kept only as the fallback for a folio that cannot be read — see below.
      remainingBalance,
      // The folio to recompute from. Absent on an older caller, in which case the fallback applies.
      folioId,
    } = body

    const { data: settings } = await supabase.from('settings').select('park_name, park_location, park_email, park_phone').single()

    // ── WHAT THIS RECEIPT SAYS IS STILL OWED ────────────────────────────────────────────────
    //
    // ⚠ THE SERVER DECIDES IT, NOT THE CALLER. `remainingBalance` arrives in the request body
    // from the Electric Billing screen. This figure is printed in a CAMPER'S receipt, so a stale
    // or wrong one from any caller — or a crafted request — would state a balance the camper does
    // not owe. The bill route recomputes for exactly this reason; this now matches it.
    //
    // SEPARATED → the CAMP ACCOUNT balance (electric, store and everyday). A camper who has just
    // paid their electric must not be told they still owe their season fee.
    // COMBINED → the whole account, which is what that park's receipts have always shown.
    //
    // Both figures come from laneBalances(), which already excludes voided charges — so this also
    // cannot quote a balance inflated by a charge that was voided.
    //
    // ⚠ ITS OWN GUARDED SELECT for billing_mode, like the bill route: a park that has not run the
    // Phase 4 migration has no such column, and a failed select there would break a receipt that
    // works today. Any failure lands on 'combined', which is today's behaviour.
    let billingMode: 'combined' | 'separated' = 'combined'
    try {
      const { data: modeRow } = await supabase.from('settings').select('billing_mode').limit(1).single()
      billingMode = normalizeBillingMode(modeRow?.billing_mode)
    } catch {
      // stays 'combined'
    }

    let recomputedBalance: number | null = null
    if (folioId) {
      try {
        const [{ data: items }, { data: pmts }] = await Promise.all([
          supabase.from('folio_line_items').select('id, line_total, voided, product_id, lane').eq('folio_id', folioId),
          supabase.from('folio_payments').select('amount, surcharge_amount, lane').eq('folio_id', folioId).eq('status', 'completed'),
        ])
        // The electric signal, so a metered charge classifies as electric rather than `other`.
        // Both fold into Camp, so it does not move this number — it is read for correctness of
        // the classification itself, exactly as the bill route does.
        const itemIds = (items || []).map(i => i.id)
        const { data: readings } = itemIds.length
          ? await supabase.from('electric_readings').select('folio_line_item_id').in('folio_line_item_id', itemIds)
          : { data: [] }
        const lanes = laneBalances(items || [], pmts || [], {
          electricLineItemIds: new Set((readings || []).map(r => r.folio_line_item_id).filter(Boolean) as string[]),
        })
        recomputedBalance = billingMode === 'separated'
          ? accountBuckets(lanes).camp.balance
          : lanes.accountBalance
      } catch {
        // A folio that cannot be read falls back below rather than failing to send the receipt —
        // the same trade the bill route makes.
      }
    }

    /** What the receipt states. The recomputed figure whenever there is one. */
    const statedBalance: number =
      recomputedBalance !== null ? recomputedBalance : Number(remainingBalance) || 0

    const campgroundName = settings?.park_name || 'Our Campground'
    const campgroundLocation = settings?.park_location || ''
    const campgroundPhone = settings?.park_phone || ''
    const fromEmail = process.env.RESEND_FROM_EMAIL || 'reservations@myresonation.com'
    const replyToEmail = settings?.park_email || fromEmail

    const paymentDate = paidAt
      ? new Date(paidAt).toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })
      : new Date().toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })

    const methodDisplay = paymentMethod ? paymentMethod.charAt(0).toUpperCase() + paymentMethod.slice(1) : 'Payment'

    const remainingDisplay = statedBalance > 0
      ? `<p style="margin:0;font-size:15px;color:#6B7280;">Your remaining balance is <strong style="color:#DC2626;">$${(statedBalance / 100).toFixed(2)}</strong>.</p>`
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
    <div style="background:${statedBalance > 0 ? '#fef2f2' : '#f0fdf4'};border:1px solid ${statedBalance > 0 ? '#fecaca' : '#bbf7d0'};border-radius:10px;padding:16px 20px;margin-bottom:28px;">
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

    await getResend().emails.send({
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
