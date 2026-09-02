import { NextRequest, NextResponse } from 'next/server'
import { renderElectricMessageFor } from '@/lib/electric-bill-tokens'
import { Resend } from 'resend'
import { createClient } from '@supabase/supabase-js'
import { buildLedger, buildStatement, type LedgerLineItem, type LedgerPayment } from '@/lib/ledger'
import { normalizeBillingMode, filterToLane, laneBalances, type LaneLineItem, type LanePayment } from '@/lib/ledger-lanes'
import { accountBuckets, billAccountBalance } from '@/lib/account-buckets'
import { requireRole } from '@/lib/require-role'

// Lazy so `next build` (which has no RESEND_API_KEY) doesn't construct — and
// throw — at import time. The client is built at request time instead.
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
      guestName,
      guestEmail,
      siteNumber,
      folioId,
      billingMonth,
      emailMessage,
      electricAmount,
      newCharges,
      paymentsReceived,
      totalBalance,
      balanceForward,
      // Additive: the walk knows the usage, and the owner's message can now mention it.
      // Absent on an older caller, in which case {{kwh}} simply renders empty.
      kwhUsed,
    } = body

    const { data: settings } = await supabase
      .from('settings')
      .select('park_name, park_location, park_email')
      .single()

    // ── PHASE 4: WHICH MONEY GOES ON THIS BILL ──────────────────────────────────────────────
    //
    // 'combined' (the default, and every park until one opts in) → the statement below is built
    // from the WHOLE folio, byte-for-byte as it always has been. 'separated' → the ELECTRIC LANE
    // ONLY, so a camper's store tab and seasonal fee never appear on an electric bill.
    //
    // Read in its own query, deliberately, rather than added to the settings select above: a park
    // that has not run the Phase 4 migration has no billing_mode column, and a failed select there
    // would break an email that works today. Any failure here — missing column, missing row —
    // lands on 'combined', which is exactly today's behaviour.
    let billingMode: 'combined' | 'separated' = 'combined'
    try {
      const { data: modeRow } = await supabase.from('settings').select('billing_mode').limit(1).single()
      billingMode = normalizeBillingMode(modeRow?.billing_mode)
    } catch {
      // stays 'combined'
    }

    // ── SEPARATED: THE BILL SHOWS THE CAMP ACCOUNT, NOT THE WHOLE ACCOUNT ──────────────────
    //
    // ⚠ THE SERVER DECIDES THIS, NOT THE CALLER. `totalBalance` arrives in the request body from
    // the Electric Billing screen. In separated mode the figure that belongs on an electric bill
    // is the CAMP ACCOUNT balance — electric, store and everything everyday — never the account
    // total, because the account total includes the season fee. A camper sent a $32 October
    // electric bill must not read "$1,632 due" because their seasonal instalment is outstanding.
    //
    // Recomputed here from the folio rather than trusted, so a stale or wrong figure from any
    // caller cannot put the season fee on an electric bill.
    //
    // Combined mode does not touch this: `campBalanceCents` stays null and the caller's
    // totalBalance is used exactly as it always has been.
    // One row type that satisfies BOTH consumers: the lane classifier and the ledger builder.
    // The select below already returns every field either of them needs; only the declared type
    // was too narrow.
    type BillItem = LaneLineItem & LedgerLineItem
    type BillPayment = LanePayment & LedgerPayment
    let folioItems: BillItem[] = []
    let folioPmts: BillPayment[] = []
    let electricItemIds = new Set<string>()
    let campBalanceCents: number | null = null
    if (folioId) {
      try {
        const [{ data: items }, { data: pmts }] = await Promise.all([
          // `id` and `product_id` are selected for lane classification; `lane` for payments. On a
          // combined park these are simply unused — the rows are identical either way.
          supabase.from('folio_line_items').select('id, description, quantity, line_total, charged_at, product_id, voided').eq('folio_id', folioId),
          supabase.from('folio_payments').select('id, method, amount, surcharge_amount, paid_at, lane').eq('folio_id', folioId).eq('status', 'completed'),
        ])
        folioItems = (items || []) as BillItem[]
        folioPmts = (pmts || []) as BillPayment[]
        if (billingMode === 'separated') {
          // THE ELECTRIC SIGNAL: the electric_readings rows that point at this folio's line items.
          // Not the category — see the long note in lib/ledger-lanes.ts about 'Fees' also being a
          // POS store category.
          const itemIds = folioItems.map(i => i.id)
          const { data: readings } = itemIds.length
            ? await supabase.from('electric_readings').select('folio_line_item_id').in('folio_line_item_id', itemIds)
            : { data: [] }
          electricItemIds = new Set(
            (readings || []).map(r => r.folio_line_item_id).filter(Boolean) as string[])
          campBalanceCents = accountBuckets(
            laneBalances(folioItems, folioPmts, { electricLineItemIds: electricItemIds }),
          ).camp.balance
        }
      } catch {
        // A folio that cannot be read leaves campBalanceCents null, so the bill falls back to the
        // caller's figure — the behaviour before this existed — rather than failing to send.
      }
    }

    /** What this bill says is owed: the Camp Account in separated mode, the whole account in
     *  combined. One value, so the headline figure and the {{balance}} token cannot disagree.
     *  The rule itself lives in lib/account-buckets.ts so it can be tested without a server. */
    const billBalance: number = billAccountBalance(billingMode, campBalanceCents, totalBalance)

    // ⚠ THE OWNER'S MESSAGE IS NOW RENDERED, NOT INSERTED RAW.
    //
    // It used to go straight into the email with only newlines converted. The billing screen now
    // offers click-to-insert merge fields for it, and chips without substitution would put a
    // literal "Hi {{first_name}}," in a camper's bill — so the two ship together.
    //
    // ⚠ AN UNKNOWN TOKEN IS LEFT VISIBLE RATHER THAN BLANKED. See renderElectricMessage(): this
    // input is free text a park may have written long before tokens existed, and silently
    // deleting a stretch of it would be worse than leaving something odd on screen. A park whose
    // message contains no braces — which is every park today — gets a byte-identical email.
    const renderedMessage = renderElectricMessageFor(String(emailMessage ?? ''), {
      guestName, siteNumber, billingMonth,
      kwhUsed: typeof kwhUsed === 'number' ? kwhUsed : null,
      amountCents: typeof electricAmount === 'number' ? electricAmount : null,
      balanceCents: typeof billBalance === 'number' ? billBalance : null,
    })

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

    const isCredit = billBalance < 0
    const balanceColor = isCredit ? '#4ADE80' : billBalance === 0 ? '#4ADE80' : '#FCD34D'
    const balanceLabel = isCredit ? 'Credit on Account' : billBalance === 0 ? '✓ Paid in Full' : 'Total Balance Due'
    const balanceDisplay = isCredit ? '$' + (Math.abs(billBalance)/100).toFixed(2) : billBalance === 0 ? '' : '$' + (billBalance/100).toFixed(2)

    // ── Account Statement: a running ledger — every charge AND payment/credit in
    //    true date order with a running balance per line.
    //
    //    COMBINED (default): pulls the COMPLETE folio — electric, POS items, payments,
    //    credits — not just this month's electric. Unchanged from before Phase 4.
    //    SEPARATED: the electric lane only. See the billing-mode block below. ──
    const money = (c: number) => '$' + (Math.abs(c) / 100).toFixed(2)
    const fmtDate = (ts: number) => new Date(ts).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })

    let statementHtml = ''
    let ledgerBuilt = false
    if (folioId) {
      try {
        // The folio rows and the electric signal were already read above, for the Camp balance.
        // Reused rather than fetched a second time, so the statement and the headline figure are
        // built from exactly the same rows and cannot disagree.
        let stmtItems: BillItem[] = folioItems
        let stmtPmts: BillPayment[] = folioPmts

        // Narrow to the electric lane ONLY when the park asked for it.
        if (billingMode === 'separated') {
          const lane = filterToLane('electric', stmtItems, stmtPmts, { electricLineItemIds: electricItemIds })
          stmtItems = lane.items
          stmtPmts = lane.payments
        }

        const stmt = buildStatement(buildLedger(stmtItems, stmtPmts), Date.now(), 90)

        const fwd = stmt.balanceForward
        const fwdColor = fwd < 0 ? '#4ADE80' : fwd === 0 ? '#9CA3AF' : '#FCD34D'
        const fwdDisplay = (fwd < 0 ? '−' : '') + money(fwd)

        const lineRows = stmt.lines.map((ev) => {
          const isPay = ev.kind === 'payment'
          const amtColor = isPay ? '#4ADE80' : '#ffffff'
          const amtDisplay = (isPay ? '−' : '') + money(ev.amount)
          const balDisplay = 'Bal ' + (ev.balanceAfter < 0 ? '−' + money(ev.balanceAfter) : money(ev.balanceAfter))
          return `
      <tr>
        <td style="padding:10px 0;border-top:1px solid #374151;vertical-align:top;">
          <div style="color:#ffffff;font-size:14px;line-height:1.3;">${ev.label}</div>
          <div style="color:#6B7280;font-size:12px;margin-top:2px;">${fmtDate(ev.ts)}</div>
        </td>
        <td style="padding:10px 0;border-top:1px solid #374151;text-align:right;vertical-align:top;white-space:nowrap;">
          <div style="color:${amtColor};font-size:14px;font-weight:bold;">${amtDisplay}</div>
          <div style="color:#6B7280;font-size:12px;margin-top:2px;">${balDisplay}</div>
        </td>
      </tr>`
        }).join('')

        const cur = stmt.currentBalance
        const curLabel = cur < 0 ? 'Credit on Account' : cur === 0 ? '✓ Paid in Full' : 'Current Balance'
        const curColor = cur <= 0 ? '#4ADE80' : '#FCD34D'
        const curDisplay = cur === 0 ? '' : money(cur)

        statementHtml = `
  <div style="background-color:#2B2B2B;margin:16px;border-radius:12px;padding:24px;">
    <h3 style="color:#ffffff;margin:0 0 4px;font-size:16px;">${billingMode === 'separated' ? 'Electric Account' : 'Account Statement'}</h3>
    <p style="color:#6B7280;margin:0 0 12px;font-size:12px;">${billingMode === 'separated'
      ? 'Your electric charges and payments in date order. Store and seasonal charges are billed separately.'
      : 'Your running account — every charge and payment in date order.'}</p>
    <table style="width:100%;border-collapse:collapse;">
      <tr>
        <td style="padding:2px 0 10px;color:#9CA3AF;font-size:14px;font-weight:bold;vertical-align:top;">Balance Forward</td>
        <td style="padding:2px 0 10px;text-align:right;color:${fwdColor};font-size:14px;font-weight:bold;vertical-align:top;white-space:nowrap;">${fwdDisplay}</td>
      </tr>${lineRows}
      <tr>
        <td style="padding:14px 0 0;border-top:2px solid #4B5563;color:#ffffff;font-size:16px;font-weight:bold;">${curLabel}</td>
        <td style="padding:14px 0 0;border-top:2px solid #4B5563;text-align:right;color:${curColor};font-size:16px;font-weight:bold;white-space:nowrap;">${curDisplay}</td>
      </tr>
    </table>
  </div>`
        ledgerBuilt = true
      } catch (e) {
        console.error('Ledger statement build failed; falling back to lump-sum:', e)
      }
    }

    if (!ledgerBuilt) {
      // Fallback (no folioId, or folio fetch failed): the original lump-sum layout,
      // so an email never breaks even if the ledger can't be assembled.
      statementHtml = `
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
  </div>`
    }

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
    <p style="color:#D1D5DB;font-size:15px;margin:0;line-height:1.6;">${renderedMessage.replace(/\n/g, "<br>")}</p>
  </div>

${statementHtml}

  <div style="padding:24px;text-align:center;">
    <p style="color:#6B7280;font-size:12px;margin:0;">Thank you! Please don't hesitate to reach out if you have any questions.</p>
    <p style="color:#6B7280;font-size:12px;margin:8px 0 0;">${campgroundName} · ${campgroundLocation}</p>
  </div>
</div>
</body>
</html>`

    await getResend().emails.send({
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
