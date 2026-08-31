// How a receipt reads, top to bottom. PURE and DISPLAY-ONLY — this file arranges and labels
// figures that were computed elsewhere, and computes no money of its own.
//
// ⚠ WHY THIS EXISTS. The seasonal receipt printed the lane's REMAINING BALANCE in the header,
// right beside the words "Seasonal fee". So a camper who had paid in full received a receipt
// reading "Seasonal fee $0.00" — their fee was not nothing, it was $1,895.00 — and the same
// balance then appeared again at the foot of the page. The figure was right and its label was
// wrong, which is the worst way for a money document to be wrong: nothing looks broken.
//
// The order below is the ordinary receipt order, and the labels say what each number IS:
//     the fee            what was charged
//     each payment       what came off it, oldest first
//     ── divider ──
//     the balance        ONCE, at the bottom

/**
 * Money, as it prints on a receipt.
 *
 * With a thousands separator, because a four-figure sum without one — "$1895.00" — is the number
 * a person has to stop and parse on the document where they can least afford to misread it. The
 * VALUE is untouched; only its rendering changes.
 */
export const receiptMoney = (cents: number): string =>
  '$' + (Math.abs(cents) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

/** A payment as the receipt needs it. Amounts are integer cents; `amount` is GROSS. */
export type ReceiptPayment = {
  method?: string | null
  paid_at?: string | null
  note?: string | null
  amount: number
  surcharge_amount?: number | null
}

/** One rendered line: a label, a figure, and how prominent it is. */
export type ReceiptLine = { label: string; amount: number; kind: 'payment' | 'fee' | 'total' }

/**
 * The lines ONE payment produces.
 *
 * A cheque or cash payment is a single line. A CARD payment is three, because the stored
 * `amount` is the gross and the balance is worked out from the net — printing only one of those
 * two numbers leaves a receipt whose arithmetic does not close. So the split is shown:
 *
 *     Payment — Card · 31 Aug 2026      −$947.50     ← the net, which is what comes off the fee
 *       Transaction fee                    $27.50
 *       Total charged                     $975.00     ← what actually left their card
 *
 * A REFUND carries a negative amount and a negative fee, so "Total charged" would read
 * backwards; it says "Total refunded" instead.
 */
/**
 * A payment's date, as it prints.
 *
 * `paid_at` is a timestamptz, so it parses unambiguously and this is normally a plain format.
 * The guard is for a DATE-ONLY value: `new Date('2026-08-31')` is midnight UTC, which renders as
 * **August 30th** anywhere west of Greenwich — a payment printing on a customer's receipt one day
 * before they made it. Noon local makes that impossible in either direction. lib/contracts.ts
 * already does exactly this, for exactly this reason.
 */
export function receiptDate(raw: string | null | undefined): string {
  if (!raw) return ''
  const iso = /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw + 'T12:00:00' : raw
  const d = new Date(iso)
  if (isNaN(d.getTime())) return ''
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

export function paymentLines(p: ReceiptPayment): ReceiptLine[] {
  const fee = p.surcharge_amount || 0
  const when = receiptDate(p.paid_at)
  const method = (p.method || 'payment').toString()
  const head = `Payment — ${method}${when ? ' · ' + when : ''}${p.note ? ' · ' + p.note : ''}`
  if (fee === 0) return [{ label: head, amount: p.amount, kind: 'payment' }]
  return [
    { label: head, amount: p.amount - fee, kind: 'payment' },
    { label: 'Transaction fee', amount: fee, kind: 'fee' },
    { label: p.amount < 0 ? 'Total refunded' : 'Total charged', amount: p.amount, kind: 'total' },
  ]
}

/**
 * The single balance line at the foot.
 *
 * Three states, and each says what it means in words rather than leaving a bare figure to be
 * interpreted:
 *   0        → "Balance"      ✓ Paid in full
 *   positive → "Balance due"  $947.50
 *   negative → "Credit on account" $500.00   (an early deposit, or an overpayment)
 */
export function balanceLine(cents: number, kind: 'balance' | 'subtotal' = 'balance'): { label: string; value: string; paid: boolean } {
  const money = receiptMoney
  // ⚠ A SECTION ON A MULTI-LANE RECEIPT IS A SUBTOTAL, NOT THE BALANCE.
  //
  // Calling both "Balance due" printed the same words and the same figure twice on an account
  // with a single lane — the very duplication this work set out to remove, moved one card down
  // rather than fixed. On a lane-scoped receipt the section IS the whole story, so it says
  // "Balance"; on the account receipt it says "Subtotal" and the grand total below says
  // "Balance due".
  if (kind === 'subtotal') {
    if (cents === 0) return { label: 'Subtotal', value: '✓ Paid in full', paid: true }
    if (cents < 0) return { label: 'Subtotal — credit', value: money(cents), paid: true }
    return { label: 'Subtotal due', value: money(cents), paid: false }
  }
  if (cents === 0) return { label: 'Balance', value: '✓ Paid in full', paid: true }
  if (cents < 0) return { label: 'Credit on account', value: money(cents), paid: true }
  return { label: 'Balance due', value: money(cents), paid: false }
}
