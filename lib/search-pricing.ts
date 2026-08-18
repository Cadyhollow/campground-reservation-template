// The fee arithmetic the AVAILABILITY SEARCH uses to price a site card.
//
// ── Why this is a file and not four lines inside the route ────────────────────────────────────
//
// It was four lines inside app/api/availability/route.ts, and it was wrong in two ways at once:
//
//   1. A flat fee's `amount` is stored in DOLLARS (app/admin/fees/page.tsx saves a bare
//      parseFloat of what the owner typed, so a $10 fee is the number 10). lib/booking-quote.ts
//      and lib/pricing.ts both multiply it by 100. The search did not, so a $10 cleaning fee
//      entered the search total as 10 CENTS and the fee total summed cents and dollars together.
//
//   2. `applies_to` is a CSV ('rv_site,cabin'), and the search compared the whole string to one
//      site type with `===`. Every multi-type fee was therefore invisible to search and appeared
//      for the first time at checkout.
//
// Both were invisible for as long as a tenant had no `fees` rows, which is how every tenant is
// provisioned — onboarding seeds none. They bit the first owner to add a tax.
//
// Pulling them out here is what lets `node --test` check them with no server and no database, so
// they are covered by the guardrails CI run rather than by a route test that only executes when a
// human points it at a live tenant. That distinction is the whole reason this file exists: the
// route suites skip themselves without a configured tenant, and a skip that looks like a pass is
// how the last pricing regression stayed invisible.
//
// Self-contained — no imports, like lib/bookability.ts and lib/booking-quote.ts.
//
// NOT THE FEE MODEL. This does not decide what anyone is charged; /api/payment recomputes the
// real quote from the database with lib/booking-quote.ts and charges that. This decides what the
// search CARD displays. It is kept in step with the quote on purpose — a card that disagrees with
// checkout is the bug this file was extracted to fix — but lib/booking-quote.ts stays the single
// authority on money, and nothing here may be imported into it.

export type SearchFee = {
  name: string
  /** 'percentage' | 'flat' */
  type: string
  /** percentage: percent value (6 = 6%); flat: DOLLARS, matching what the Fees screen stores. */
  amount: number
  /** 'all', or a CSV of site types and/or 'addons'. */
  applies_to: string
}

export type SearchFeeLine = {
  name: string
  type: string
  /** INTEGER CENTS. */
  amount: number
}

/**
 * Whether a fee applies to a site of this type.
 *
 * Mirrors appliesToSite() in lib/booking-quote.ts, including the CSV split. Keep the two in step:
 * a fee the search hides is a fee that appears for the first time on the checkout page.
 */
export function feeAppliesToSiteType(fee: SearchFee, siteType: string): boolean {
  if (fee.applies_to === 'all') return true
  return fee.applies_to.split(',').map(s => s.trim()).includes(siteType)
}

/**
 * One fee's contribution, in INTEGER CENTS.
 *
 * Mirrors calculateFeeAmount() in lib/booking-quote.ts for the site half of the base — the search
 * has no add-ons and no guest counts, so `basePriceCents` is the stay alone.
 */
export function searchFeeCents(fee: SearchFee, basePriceCents: number): number {
  return fee.type === 'percentage'
    ? Math.round(basePriceCents * fee.amount / 100)
    : Math.round(fee.amount * 100)
}

export type SiteSearchTotals = {
  /** Per-fee lines for the card, in integer cents. */
  breakdown: SearchFeeLine[]
  /** Sum of `breakdown`, in integer cents. */
  feesTotal: number
  /**
   * DISPLAY ONLY — stay + fees, so the card shows a number that includes fees rather than a stay
   * price that grows at checkout.
   *
   * Deliberately NOT the base a booking quote computes fees on. /book derives that for itself as
   * nightly × nights; handing it this figure is what made every fee count twice.
   */
  totalPrice: number
}

/**
 * Everything the search card needs about fees for one site.
 *
 * `basePriceCents` is the STAY ALONE — nightly rate × nights, no fees. Passing anything else here
 * computes fees on top of fees.
 */
export function summarizeSiteFees(
  fees: SearchFee[] | null | undefined,
  siteType: string,
  basePriceCents: number,
): SiteSearchTotals {
  const breakdown = (fees || [])
    .filter(fee => feeAppliesToSiteType(fee, siteType))
    .map(fee => ({ name: fee.name, type: fee.type, amount: searchFeeCents(fee, basePriceCents) }))
  const feesTotal = breakdown.reduce((sum, f) => sum + f.amount, 0)
  return { breakdown, feesTotal, totalPrice: basePriceCents + feesTotal }
}
