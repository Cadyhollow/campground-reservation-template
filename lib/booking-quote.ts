// The price of a public booking — ONE arithmetic, used by both the booking page that shows
// the camper a number and the payment route that charges their card.
//
// ── Why this file exists ───────────────────────────────────────────────────────────────
// /book takes the site's price from the URL (`?nightlyRate=…&totalPrice=…`), computed the
// whole quote in the browser from it, and POSTed the resulting `amountToPay` to
// /api/payment — which charged exactly that number. The server never re-derived anything;
// it did not even SELECT base_rate. So retyping totalPrice in the address bar set your own
// price, down to zero. A forged discount code was the same attack with a smaller ceiling.
//
// The fix is not to validate the client's number — it is to stop needing it. The server
// recomputes the quote from the DATABASE (site.base_rate + pricing rules + settings + fees +
// addons + a server-validated discount) and charges what it computed. The client's figures
// arrive as untrusted hints and are used for exactly one thing: detecting a disagreement,
// which is reported rather than silently charged (charging a number other than the one the
// camper was shown is its own bug — see the "Pay in Full" fix in the fee pass).
//
// Both callers share this function so the two cannot drift. That is the same reasoning
// lib/refundable.ts records: when the UI's arithmetic and the server's arithmetic were
// written twice, they diverged, and the divergence was the bug. Here a divergence would
// either reject legitimate bookings or undercharge, so it is worth the indirection.
//
// NOTE FOR ANYONE COMPARING THIS WITH CADY'S COPY: the two are deliberately NOT identical.
// This repo is on the card-only-fee model, where the fee sits INSIDE `total`, so the deposit
// is derived from `total` and the fee charged on a payment is that payment's prorated share
// of cardOnlyFeesTotal. Cady is on Model B, where a percentage surcharge sits OUTSIDE
// cashTotal and the deposit derives from cashTotal instead. Porting Cady's arithmetic here
// would change what every campground on this template charges.
//
// Self-contained — no imports at all, like lib/bookability.ts and lib/refundable.ts. That is
// what lets `node --test` exercise the money arithmetic without a bundler or a database.
//
// Pure, synchronous and I/O-free on purpose: the caller fetches, this decides. That keeps it
// runnable from a client component and a route handler alike, and testable without a database.

export type QuoteSite = {
  site_type: string
  /** Nightly rate in cents, already resolved against pricing rules. */
  nightly_rate: number
  /** nightly_rate × nights, in cents. */
  total_price: number
  nights: number
}

export type QuoteFee = {
  id?: string
  name: string
  type: string           // 'percentage' | flat
  amount: number         // percent when type === 'percentage', else DOLLARS (×100 below)
  applies_to: string     // 'all' | comma-separated site types and/or 'addons'
  card_only?: boolean | null
}

export type QuoteAddon = { id: string; name?: string; price: number }

export type QuoteDiscount = {
  code: string
  discount_type: string  // 'percent' | 'flat'
  discount_value: number // percent, or cents when flat
} | null

export type QuoteSettings = {
  base_occupancy_adults?: number | null
  base_occupancy_children?: number | null
  extra_adult_fee?: number | null
  extra_child_fee?: number | null
  early_checkin_enabled?: boolean | null
  early_checkin_price?: number | null
  early_checkin_show_customers?: boolean | null
  late_checkout_enabled?: boolean | null
  late_checkout_price?: number | null
  late_checkout_show_customers?: boolean | null
  deposit_type?: string | null
  deposit_value?: number | null
  card_surcharge_percent?: number | string | null
} | null

export type QuoteInput = {
  site: QuoteSite
  adults: number
  children: number
  settings: QuoteSettings
  fees: QuoteFee[]
  /** Selected add-ons with the price to charge. The server passes DB prices, never the client's. */
  addonSelections: Array<{ id: string; quantity: number; price: number; name?: string }>
  discount: QuoteDiscount
  /** Camper asked for early check-in / late check-out. Still gated on settings below. */
  earlyRequested: boolean
  lateRequested: boolean
  /** Turnover conflicts — a same-day arrival/departure on this site blocks the extra. */
  earlyBlocked: boolean
  lateBlocked: boolean
}

export type BookingQuote = {
  extraGuestFee: number
  addonTotal: number
  feeBreakdown: Array<QuoteFee & { calculatedAmount: number }>
  feesTotal: number
  cardOnlyFeesTotal: number
  earlyFee: number
  lateFee: number
  subtotal: number
  discountAmount: number
  /** Stay total including fees, less discount. */
  total: number
  /** Cash-canonical: `total` with card-only fees removed. What gets STORED. */
  cashTotal: number
  deposit: number
  depositLabel: string
  depositSubtext: string
  showDepositButton: boolean
  emailLines: Array<{ label: string; amount: number }>
}

/**
 * The nightly rate for a site on a date range: the highest-priority active pricing rule that
 * matches, else the site's base_rate. Mirrors /api/availability, which is where the number in
 * the booking URL came from in the first place — so the server re-derives the same figure the
 * camper was quoted rather than trusting the round trip.
 */
export function resolveNightlyRate(
  site: { id?: string; site_type: string; base_rate: number },
  pricingRules: any[],
  ruleApplies: (rule: any, site: any) => boolean,
): number {
  const applicable = (pricingRules || []).filter(r => ruleApplies(r, site))
  const best = applicable.sort((a, b) => b.priority - a.priority)[0]
  return best ? best.nightly_rate : site.base_rate
}

export type DiscountCheck =
  | { ok: true; discount: NonNullable<QuoteDiscount> }
  | { ok: false; reason: string }

/**
 * Whether a discount row may be applied today.
 *
 * These four checks used to run ONLY in the browser, against a row the browser had read for
 * itself out of the `discounts` table — so every rule here was advisory and every code was
 * enumerable. The server now runs them against its own read before any money is computed.
 *
 * `today` is passed in rather than read from the clock so the caller controls the timezone
 * and the function stays pure.
 */
export function checkDiscount(
  row: any | null | undefined,
  today: string,
): DiscountCheck {
  if (!row) return { ok: false, reason: 'Invalid or expired discount code.' }
  if (row.is_active === false) return { ok: false, reason: 'Invalid or expired discount code.' }
  if (row.valid_from && today < row.valid_from) return { ok: false, reason: 'This code is not yet valid.' }
  if (row.valid_until && today > row.valid_until) return { ok: false, reason: 'This discount code has expired.' }
  // max_uses was unenforceable before this: the counter that feeds it was never incremented
  // (see the increment call in /api/payment, and the RPC's own always-true WHERE clause).
  if (row.max_uses && (row.times_used || 0) >= row.max_uses) {
    return { ok: false, reason: 'This discount code has reached its maximum uses.' }
  }
  return { ok: true, discount: { code: row.code, discount_type: row.discount_type, discount_value: row.discount_value } }
}

/**
 * The whole quote. Every expression below is the booking page's, moved verbatim — the point is
 * that the number does not change, only who is trusted to produce it.
 */
export function computeBookingQuote(input: QuoteInput): BookingQuote {
  const { site, adults, children, settings, fees, addonSelections, discount } = input

  const addonTotal = addonSelections.reduce((sum, a) => sum + a.price * a.quantity, 0)

  const baseAdults = settings?.base_occupancy_adults ?? 2
  const baseChildren = settings?.base_occupancy_children ?? 2
  const extraAdultFee = settings?.extra_adult_fee ?? 0
  const extraChildFee = settings?.extra_child_fee ?? 0
  const extraAdults = Math.max(0, adults - baseAdults)
  const extraChildren = Math.max(0, children - baseChildren)
  const extraGuestFee = (extraAdults * extraAdultFee + extraChildren * extraChildFee) * site.nights

  const appliesToSite = (fee: QuoteFee) => {
    if (fee.applies_to === 'all') return true
    return fee.applies_to.split(',').map(s => s.trim()).includes(site.site_type)
  }
  const appliesToAddons = (fee: QuoteFee) => {
    if (fee.applies_to === 'all') return true
    return fee.applies_to.split(',').map(s => s.trim()).includes('addons')
  }
  const calculateFeeAmount = (fee: QuoteFee): number => {
    let base = 0
    if (appliesToSite(fee)) base += site.total_price + extraGuestFee
    if (appliesToAddons(fee)) base += addonTotal
    if (base === 0) return 0
    if (fee.type === 'percentage') return Math.round(base * fee.amount / 100)
    return fee.amount * 100
  }

  const feeBreakdown = (fees || [])
    .map(fee => ({ ...fee, calculatedAmount: calculateFeeAmount(fee) }))
    .filter(fee => fee.calculatedAmount > 0)

  const feesTotal = feeBreakdown.reduce((sum, fee) => sum + fee.calculatedAmount, 0)
  const cardOnlyFeesTotal = feeBreakdown.filter(f => f.card_only).reduce((sum, f) => sum + f.calculatedAmount, 0)

  // Both extras are gated on the park having enabled them AND on showing them to customers —
  // a camper cannot buy an extra the park has switched off by asserting it in the request.
  const earlyFee = (input.earlyRequested && !input.earlyBlocked
    && settings?.early_checkin_enabled && settings?.early_checkin_show_customers)
    ? (settings.early_checkin_price || 0) : 0
  const lateFee = (input.lateRequested && !input.lateBlocked
    && settings?.late_checkout_enabled && settings?.late_checkout_show_customers)
    ? (settings.late_checkout_price || 0) : 0

  const subtotal = site.total_price + extraGuestFee + addonTotal + earlyFee + lateFee

  const discountAmount = discount
    ? discount.discount_type === 'percent'
      ? Math.round(subtotal * discount.discount_value / 100)
      : discount.discount_value
    : 0

  const total = Math.max(0, subtotal + feesTotal - discountAmount)
  const cashTotal = total - cardOnlyFeesTotal

  // Deposit — always a CASH value; the transaction fee is added per-payment at charge time.
  const realCashFees = feesTotal - cardOnlyFeesTotal
  const proportionalCashFees = site.nights > 0 ? Math.round(realCashFees / site.nights) : 0
  const firstNightDeposit = site.nightly_rate + proportionalCashFees

  const depositType = settings?.deposit_type || 'first_night'
  const depositValue = settings?.deposit_value || 0
  let deposit: number
  let depositLabel: string
  let depositSubtext: string
  if (depositType === 'percentage') {
    // `total`, not cashTotal — this repo's card-only fee is already inside it. See the note
    // at the top of the file before "fixing" this to match Cady.
    deposit = Math.min(Math.round(total * depositValue / 100), total)
    depositLabel = `Pay ${depositValue}% Deposit`
    depositSubtext = 'Balance due at check-in'
  } else if (depositType === 'flat') {
    deposit = Math.min(depositValue, total)
    depositLabel = 'Pay Deposit'
    depositSubtext = 'Balance due at check-in'
  } else if (depositType === 'full') {
    deposit = total
    depositLabel = 'Pay in Full'
    depositSubtext = ''
  } else {
    deposit = firstNightDeposit
    depositLabel = 'Pay Deposit'
    depositSubtext = 'First night only · Balance due at check-in'
  }

  // Itemized cash lines for the confirmation email — the { label, amount } shape lib/pricing
  // produces for the admin wizard, so both paths render identically. Card-only fees are
  // excluded, matching the cash total they are kept out of.
  const emailLines: Array<{ label: string; amount: number }> = [
    ...(site.nights > 0
      ? [{ label: `${site.nights} night${site.nights !== 1 ? 's' : ''} × $${(site.nightly_rate / 100).toFixed(2)}`, amount: site.total_price }]
      : []),
    ...(extraGuestFee > 0 ? [{ label: 'Extra guests', amount: extraGuestFee }] : []),
    ...feeBreakdown.filter(f => !f.card_only).map(f => ({ label: f.name, amount: f.calculatedAmount })),
    ...addonSelections.filter(a => a.quantity > 0).map(a => ({ label: `${a.name || 'Add-on'} ×${a.quantity}`, amount: a.price * a.quantity })),
    ...(earlyFee > 0 ? [{ label: 'Early check-in', amount: earlyFee }] : []),
    ...(lateFee > 0 ? [{ label: 'Late check-out', amount: lateFee }] : []),
  ]

  return {
    extraGuestFee, addonTotal, feeBreakdown, feesTotal, cardOnlyFeesTotal,
    earlyFee, lateFee, subtotal, discountAmount, total, cashTotal,
    deposit, depositLabel, depositSubtext,
    showDepositButton: depositType !== 'full',
    emailLines,
  }
}

/**
 * The card fee charged on one payment: that payment's prorated share of the card-only fees
 * already contained in `total`. This is the expression app/book/page.tsx uses at charge time,
 * moved here so the server computes the same figure it is asked to honour.
 *
 * Cady's equivalent is cardSurchargeFor() in lib/pricing.ts, which is a different model —
 * a percentage applied OUTSIDE the cash total. Do not swap one for the other.
 */
export function cardOnlyFeeShare(paymentCents: number, cashTotal: number, cardOnlyFeesTotal: number): number {
  if (cashTotal <= 0) return 0
  return Math.round(paymentCents * cardOnlyFeesTotal / cashTotal)
}
