// TWO-BUCKET VIEW — collapses the four money lanes into the two accounts a *separated* park
// actually manages: the CAMP ACCOUNT (everyday money — electric + store + other) and SEASONAL
// (the season fee, deposit and installments). This is the grouping behind the two side-by-side
// cards on the camper page, the guest directory and the folio.
//
// ⚠ DISPLAY / GROUPING ONLY. It classifies nothing and sums nothing new — it re-groups the output
// of laneBalances() in ./ledger-lanes.ts and preserves that module's accountBalance invariant to
// the cent. Combined mode never calls this; only 'separated' does.
//
// Relative import with the extension: the repo convention for one lib module importing another,
// and the only form that resolves under `node --test` (see the note in ledger-lanes.ts).
import { classifyLineItem } from './ledger-lanes.ts'
import type { Lane, LaneBalances, LaneTotals, LaneLineItem, LanePayment, LaneContext } from './ledger-lanes.ts'

export type Bucket = 'camp' | 'seasonal'

/** Both buckets, in the order a UI should show them: Camp first (everyday), Seasonal second. */
export const BUCKETS: readonly Bucket[] = ['camp', 'seasonal'] as const

/**
 * Which bucket each lane rolls up into. Seasonal stands alone; ELECTRIC, STORE and OTHER all fold
 * into the Camp Account. The finer electric-vs-store tag stays on each line item for receipts and
 * reports — it simply stops being a *payment* split, which is the part that overstated balances
 * and confused staff.
 */
export const LANE_BUCKET: Record<Lane, Bucket> = {
  electric: 'camp',
  store: 'camp',
  other: 'camp',
  seasonal: 'seasonal',
}

/**
 * Default bucket labels. Owner-facing copy, so per the repo's configurability rule these are a
 * SUGGESTED DEFAULT a park may override from settings (e.g. settings.bucket_label_camp) — read the
 * owner's value when present, fall back to these when blank. Kept here so a park that configures
 * nothing still reads sensibly.
 */
export const BUCKET_LABEL_DEFAULT: Record<Bucket, string> = {
  camp: 'Camp Account',
  seasonal: 'Seasonal',
}

export type BucketTotals = LaneTotals // { charges, payments, balance } — integer cents

export type AccountBuckets = {
  /** Everyday: electric + store + other. Its balance is the account remainder (see below). */
  camp: BucketTotals
  /** The season fee/deposit/installments, from the seasonal lane's own charges and tagged payments. */
  seasonal: BucketTotals
  /**
   * IDENTICAL to LaneBalances.accountBalance — the whole-account figure the folio already shows.
   * THE INVARIANT: camp.balance + seasonal.balance === accountBalance, always. A test pins it.
   */
  accountBalance: number
}

/**
 * Roll lane balances up into the two buckets.
 *
 * ── WHY CAMP IS THE ACCOUNT REMAINDER, NOT "camp charges − camp-tagged payments" ───────────────
 *
 * Historical payments are overwhelmingly UNTAGGED (whole-account) — on the live park, ~2% carry a
 * lane. Summing only per-lane-tagged payments therefore leaves almost every lane showing its full
 * original charges as still owed: the "$1,865 store due" phantom on an account whose real balance
 * is a fraction of that.
 *
 * Two facts make the fix exact:
 *   1. The whole-account balance (charges − ALL payments) is always correct — it is what the folio
 *      shows today.
 *   2. Seasonal is the one bucket whose charges AND payments are reliably tagged (it is small and
 *      controlled — a couple of contracts), so its own balance is trustworthy.
 *
 * So: SEASONAL is computed from the seasonal lane directly, and CAMP is whatever the real account
 * balance has left over once Seasonal is set aside. Untagged (whole-account) payments therefore
 * reduce Camp — exactly where everyday money belongs — and Camp can NEVER show as owed something
 * the account has already been paid for. camp.balance + seasonal.balance reconciles to
 * accountBalance to the cent, which is the test that proves no money was lost or invented.
 *
 * Credits behave correctly for free: an overpaid Seasonal (seasonal.balance negative) leaves its
 * credit in the Seasonal bucket and does not bleed into Camp, matching "credits stay in their
 * lane." An untagged overpayment lands in Camp, the everyday default — also correct.
 */
export function accountBuckets(lanes: LaneBalances): AccountBuckets {
  const s = lanes.byLane.seasonal
  const seasonalBalance = s.charges - s.payments

  const campCharges =
    lanes.byLane.electric.charges + lanes.byLane.store.charges + lanes.byLane.other.charges

  // The account remainder — see the header. Equivalent to campCharges minus every non-seasonal
  // payment (tagged or untagged), which is what makes untagged money count toward Camp.
  const campBalance = lanes.accountBalance - seasonalBalance
  const campPayments = campCharges - campBalance

  return {
    camp: { charges: campCharges, payments: campPayments, balance: campBalance },
    seasonal: { charges: s.charges, payments: s.payments, balance: seasonalBalance },
    accountBalance: lanes.accountBalance,
  }
}

/**
 * The lane a payment taken through a given bucket's "Take a payment" door should be tagged with.
 *
 * A SEASONAL payment is tagged `'seasonal'` so it settles the Seasonal bucket exactly. A CAMP
 * payment is left UNTAGGED (returns null) — a whole-account payment, exactly as every payment is
 * today — because Camp is computed as the account remainder, so tagging camp payments would be
 * busywork that changes no displayed balance. This is also why the migration never has to retag
 * the park's existing untagged payments: they already read as Camp.
 */
export function paymentLaneForBucket(bucket: Bucket): Lane | null {
  return bucket === 'seasonal' ? 'seasonal' : null
}

/**
 * The line items and payments belonging to ONE bucket — what a bucket-scoped statement (the
 * electric / Camp bill) is built from.
 *
 * Items are grouped by their lane's bucket (LANE_BUCKET). Payments follow the bucket model:
 *   - seasonal → only payments explicitly tagged 'seasonal'.
 *   - camp     → every payment NOT tagged 'seasonal' — untagged whole-account payments INCLUDED,
 *                because untagged money is everyday/Camp money. This is what makes the camp
 *                statement's running balance reconcile to accountBuckets(...).camp.balance.
 * Voided items are kept for display; downstream totals still run through notVoided.
 */
export function filterToBucket<I extends LaneLineItem, P extends LanePayment>(
  bucket: Bucket,
  items: I[] | null | undefined,
  payments: P[] | null | undefined,
  ctx: LaneContext,
): { items: I[]; payments: P[] } {
  const isSeasonalPayment = (p: P) => String(p.lane ?? '').trim().toLowerCase() === 'seasonal'
  return {
    items: (items || []).filter(i => LANE_BUCKET[classifyLineItem(i, ctx)] === bucket),
    payments: (payments || []).filter(p => (bucket === 'seasonal' ? isSeasonalPayment(p) : !isSeasonalPayment(p))),
  }
}

/**
 * The balance an ELECTRIC BILL should state.
 *
 * ⚠ IN SEPARATED MODE THIS IS THE CAMP ACCOUNT, NEVER THE WHOLE ACCOUNT. An electric bill that
 * quoted the account total would put the season fee on it: a camper sent a $32 October electric
 * bill would read "$1,632 due" because an instalment is outstanding. That is the single most
 * alarming way this app could be wrong at a camper, and it is the bug this exists to prevent.
 *
 * Combined mode is untouched — the whole-account figure, exactly as every bill has always shown.
 *
 * `campBalance` is null when it could not be derived (no folio, or a read that failed). Falling
 * back to the caller's own total is deliberate: a bill that cannot compute the Camp balance
 * should send with the figure it has always sent rather than not send at all.
 */
export function billAccountBalance(
  mode: 'combined' | 'separated',
  campBalance: number | null | undefined,
  wholeAccountBalance: number,
): number {
  if (mode !== 'separated') return wholeAccountBalance
  return typeof campBalance === 'number' ? campBalance : wholeAccountBalance
}

/**
 * The SEASONAL slice of a folio, from rows the caller already has.
 *
 * For screens that compute a whole-account balance themselves and need the Camp figure without a
 * second query or a full laneBalances() pass. Seasonal is DECLARED — `lane = 'seasonal'` on both
 * the charge and the payment — so no electric signal and no product_id inspection is needed here.
 *
 * ⚠ IT DELIBERATELY DOES NOT FILTER VOIDED ROWS, and that is not an oversight. This exists to be
 * subtracted from a caller's own account total, and the two must be summed the SAME way or the
 * remainder is not the Camp balance. A caller whose account total excludes voided rows should
 * pass rows already filtered; one whose total includes them should pass them all. Mixing the two
 * rules is the only way to get a wrong answer here, so the rule lives in this comment rather than
 * being silently chosen for the caller.
 *
 * Payments are netted of their surcharge, matching how every balance in the app is summed.
 */
export function seasonalBalanceOf(
  items: { line_total: number; lane?: string | null }[] | null | undefined,
  payments: { amount: number; surcharge_amount?: number | null; lane?: string | null }[] | null | undefined,
): number {
  const isSeasonal = (lane: string | null | undefined) =>
    String(lane ?? '').trim().toLowerCase() === 'seasonal'
  const charges = (items || [])
    .filter(i => isSeasonal(i.lane))
    .reduce((sum, i) => sum + (i.line_total || 0), 0)
  const paid = (payments || [])
    .filter(p => isSeasonal(p.lane))
    .reduce((sum, p) => sum + ((p.amount || 0) - (p.surcharge_amount || 0)), 0)
  return charges - paid
}

/**
 * Camp is the account remainder — the same rule accountBuckets() applies, for callers that
 * already hold the whole-account figure.
 *
 * ⚠ THE SUBTRACTION IS THE POINT. "Camp charges minus camp-tagged payments" would show everyday
 * money as still owed, because almost no payment carries a lane. Taking Seasonal off the true
 * account balance is exact, and guarantees the two shown figures can never exceed the account.
 */
export function campFromAccount(accountBalance: number, seasonalBalance: number): number {
  return accountBalance - seasonalBalance
}
