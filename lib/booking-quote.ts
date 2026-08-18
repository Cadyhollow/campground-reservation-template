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
// ONE import, and it is deliberate. This file was self-contained until the pet fee, and the
// property that mattered was never "zero imports" but "no I/O, no bundler, no database" — which
// is what lets `node --test` exercise the money arithmetic directly. lib/pet-fee.ts is itself
// pure and imports nothing, so that property is intact.
//
// The pet arithmetic lives there rather than here on purpose: it keeps this file's diff small
// enough to read line by line, which is the only real safety on a change that waives the
// automated fee-model guard. Nothing else may be imported here without the same argument, and
// pet-fee.ts must never import back — a cycle between the fee model and the thing it calls would
// make the protection meaningless.
//
// Pure, synchronous and I/O-free on purpose: the caller fetches, this decides. That keeps it
// runnable from a client component and a route handler alike, and testable without a database.

import { computePetFee } from './pet-fee.ts'

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
  // ── PET FEE ─────────────────────────────────────────────────────────────────────────────────
  // All optional, and `pets_enabled` false or absent makes every one of them inert — which is the
  // state every tenant is provisioned in. See lib/pet-fee.ts for the arithmetic.
  pets_enabled?: boolean | null
  pet_fee_amount?: number | null
  pet_fee_per_night?: boolean | null
  pet_fee_per_pet?: boolean | null
  pet_max?: number | null
  pet_rules_text?: string | null
  pet_rules_require_affirmation?: boolean | null
  /** Whether the pet fee joins the base that NON-card percentage fees are computed on. */
  pet_fee_taxable?: boolean | null
  /** Whether the pet fee joins the base that CARD-ONLY fees are computed on. */
  pet_fee_surcharged?: boolean | null
  service_animal_allowed?: boolean | null
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
  /**
   * Pets declared. OPTIONAL, and absent is the only value any caller passes today — every
   * existing quote is therefore unchanged, byte for byte.
   */
  petCount?: number
  /** A declared service animal: legally not a pet, so the fee is waived. */
  isServiceAnimal?: boolean
  /**
   * Whether the guest ticked the park's pet-rules affirmation.
   *
   * Carried on the input but NOT consulted by the arithmetic: a missing affirmation is a reason to
   * REFUSE a booking, not to reprice it, and quietly zeroing the fee would let a request dodge the
   * charge by omitting a checkbox. Enforcement belongs at /api/payment and /api/manual-booking, in
   * a later step; this field exists so the shape is settled before those callers are written.
   */
  petRulesAffirmed?: boolean
}

export type BookingQuote = {
  extraGuestFee: number
  addonTotal: number
  feeBreakdown: Array<QuoteFee & { calculatedAmount: number }>
  feesTotal: number
  cardOnlyFeesTotal: number
  earlyFee: number
  lateFee: number
  /** The pet fee, in cents. 0 whenever pets are off, none were declared, or it is a service animal. */
  petFee: number
  /** Pets actually charged for, after the park's cap. Store THIS on the reservation. */
  petCount: number
  /**
   * True when more pets were requested than `pet_max` allows.
   *
   * Reported, not acted on. Charging for fewer pets than the guest declared is its own bug, so the
   * booking routes should refuse — but that is a decision about a request, not arithmetic.
   */
  petCapped: boolean
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

  // ── THE PET FEE ───────────────────────────────────────────────────────────────────────────────
  //
  // Computed HERE, above calculateFeeAmount, because the fee base below may need it — see the
  // conditional in calculateFeeAmount and the note on the two toggles there.
  //
  // The arithmetic itself is NOT in this file. lib/pet-fee.ts owns it, is pure, imports nothing,
  // and was reviewed and tested on its own PR before anything could charge for it. That split is
  // deliberate: it keeps this file's diff small enough to read line by line, which is the only
  // real safety on a change that carries the fee-model label.
  //
  // INERT TODAY. No caller passes petCount, and every tenant is provisioned with pets_enabled
  // false, so computePetFee returns zero and every expression below behaves exactly as it did
  // before this existed.
  const { petFee, petCount, capped: petCapped } = computePetFee({
    petCount: input.petCount ?? 0,
    nights: site.nights,
    isServiceAnimal: input.isServiceAnimal,
    settings,
  })

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
    if (appliesToSite(fee)) {
      base += site.total_price + extraGuestFee
      // ── THE MOST CONSEQUENTIAL LINE IN THE PET FEATURE. READ IT SLOWLY. ──────────────────────
      //
      // This is the ENTIRE meaning of the two settings toggles. There is no tax rate stored
      // anywhere on this platform: reservation "tax" is just a percentage row in the `fees` table
      // (the Fees screen is literally titled "Taxes & Fees" and suggests "e.g. PA State Tax"), and
      // the card surcharge on this repo is a `fees` row with card_only set. So "is the pet fee
      // taxable?" and "does the card surcharge apply to it?" both reduce to the same mechanical
      // question — does the pet fee join the base this fee is computed on? — and the answer
      // differs by which KIND of fee is being computed:
      //
      //   card_only fee  -> governed by pet_fee_surcharged
      //   any other fee  -> governed by pet_fee_taxable
      //
      // That is why the condition switches on fee.card_only rather than applying one flag to
      // everything. Collapsing it to a single toggle would silently tie a park's tax treatment to
      // its card-fee treatment, and those are set by different authorities — a state or county
      // decides the first, the payment processor and the park's own policy decide the second.
      //
      // Both default FALSE, so a park that has not opened the screen taxes and surcharges the pet
      // fee not at all, and every existing quote is unaffected.
      //
      // KNOWN AND ACCEPTED IMPRECISION, worth naming rather than hiding: pet_fee_taxable applies
      // to every non-card-only percentage fee, not only to ones that are genuinely taxes. A park
      // with a percentage "resort fee" gets the pet fee in that base too. This matches how
      // `applies_to` already works on this platform — the park's fee rows are the park's business
      // — but a park wanting to tax pets while exempting them from a resort fee cannot express
      // that here. Splitting the flag per fee row is the fix if that ever comes up.
      //
      // A flat fee is unaffected either way: its amount does not depend on the base at all (see
      // the return below), so both toggles are no-ops for flat rows by construction.
      if (fee.card_only ? settings?.pet_fee_surcharged : settings?.pet_fee_taxable) base += petFee
    }
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

  // petFee joins the subtotal, which means it is inside `total` and inside `cashTotal` below, and
  // therefore inside amount_paid, the refund cap and the cancellation percentage — all by
  // construction, with no further edits. `total` and `cashTotal` are deliberately untouched.
  const subtotal = site.total_price + extraGuestFee + addonTotal + earlyFee + lateFee + petFee

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

  // ── THE PET FEE'S SHARE OF A FIRST-NIGHT DEPOSIT ──────────────────────────────────────────────
  //
  // The other three deposit types need no decision: `full` and `percentage` take their share of
  // `total` automatically, and `flat` is a fixed number the park chose. Only `first_night` has to
  // answer "how much of the pet fee is due up front?", and there is no arithmetic that settles it
  // — it is a judgement, so it is written out here rather than falling out of an expression.
  //
  // THE RULE: prorate a PER-NIGHT pet fee; collect a flat one in full.
  //
  // A per-night pet fee is a nightly charge, so one night's worth belongs in a one-night deposit,
  // exactly as cash fees are prorated on the line above. A flat pet fee is not a per-night thing
  // at all — dividing it by the length of the stay would make the same dog cost a different
  // deposit on a two-night and a ten-night booking, which is arbitrary rather than merely
  // approximate. A park charging a flat pet fee is charging for the animal being there, so it is
  // collected with the first payment.
  //
  // Both directions are pinned by tests. If this is ever revisited, change it HERE and nowhere
  // else — `deposit` below reads this value and nothing recomputes it.
  const petFeeInFirstNight = settings?.pet_fee_per_night
    ? (site.nights > 0 ? Math.round(petFee / site.nights) : 0)
    : petFee
  const firstNightDeposit = site.nightly_rate + proportionalCashFees + petFeeInFirstNight

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
    // Its own named line, never folded into the site charge or the fee block. A pet fee the guest
    // cannot find on their confirmation is a support call, and `reservations.pet_fee` exists as a
    // column precisely so every downstream surface can name it.
    ...(petFee > 0 ? [{ label: 'Pet fee', amount: petFee }] : []),
    ...feeBreakdown.filter(f => !f.card_only).map(f => ({ label: f.name, amount: f.calculatedAmount })),
    ...addonSelections.filter(a => a.quantity > 0).map(a => ({ label: `${a.name || 'Add-on'} ×${a.quantity}`, amount: a.price * a.quantity })),
    ...(earlyFee > 0 ? [{ label: 'Early check-in', amount: earlyFee }] : []),
    ...(lateFee > 0 ? [{ label: 'Late check-out', amount: lateFee }] : []),
  ]

  return {
    extraGuestFee, addonTotal, feeBreakdown, feesTotal, cardOnlyFeesTotal,
    earlyFee, lateFee, petFee, petCount, petCapped,
    subtotal, discountAmount, total, cashTotal,
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
