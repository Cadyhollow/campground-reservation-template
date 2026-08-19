// lib/pricing.ts
// Single source of truth for reservation pricing across ResoNation.
// ALL money is integer cents. The cash total is canonical; the card
// surcharge is applied per-payment, never baked into the stored total.

import { computePetFee } from './pet-fee.ts'

export interface PricingSite {
  id: string
  site_type: string
  base_rate: number              // cents per night
  amp_service?: string | null    // 'none' | '30amp' | '30_50amp'
  max_rv_length?: number | null  // feet (RV sites only)
}

export interface PricingSettings {
  base_occupancy_adults: number
  base_occupancy_children: number
  extra_adult_fee: number        // cents, per extra adult, per night
  extra_child_fee: number        // cents, per extra child, per night
  card_surcharge_percent: number // e.g. 3 means 3%
  early_checkin_enabled?: boolean
  early_checkin_price?: number   // cents
  late_checkout_enabled?: boolean
  late_checkout_price?: number   // cents
  deposit_type?: string          // 'first_night' | 'percentage' | 'flat' | 'full' (default first_night)
  deposit_value?: number         // percentage: whole percent (50 = 50%); flat: cents. Ignored for first_night/full.
  // ── PET FEE ───────────────────────────────────────────────────────────────────────────────
  // Optional throughout; pets_enabled false or absent makes them all inert. See lib/pet-fee.ts.
  pets_enabled?: boolean | null
  pet_fee_amount?: number | null // CENTS
  pet_fee_per_night?: boolean | null
  pet_fee_per_pet?: boolean | null
  pet_max?: number | null
  /** Whether the pet fee joins the base that NON-card fees are computed on. */
  pet_fee_taxable?: boolean | null
  /** Whether the pet fee joins the base that CARD-ONLY fees are computed on. See the note in the
   *  surcharge section below about what this can and cannot mean on the wizard. */
  pet_fee_surcharged?: boolean | null
}

export interface PricingFee {
  id?: string
  name: string
  type: 'percentage' | 'flat'
  amount: number                 // percentage: percent value (5 = 5%); flat: DOLLARS (matches existing data)
  applies_to: string             // 'all' or CSV of site_types
  card_only?: boolean
}

export interface PricingRule {
  nightly_rate: number           // cents
  priority: number
  start_date: string
  end_date: string
  site_ids?: string | null       // CSV of site ids
  site_id?: string | null
  site_type?: string | null
}

export interface PricingAddon {
  name?: string
  price: number                  // cents
  quantity: number
}

export interface PricingInput {
  site: PricingSite | null
  arrival_date: string
  departure_date: string
  num_adults: number
  num_children: number
  settings: PricingSettings
  fees?: PricingFee[]
  enabledFeeNames?: Record<string, boolean> // toggle map; absent or true = enabled
  addons?: PricingAddon[]
  pricingRules?: PricingRule[]
  earlyCheckin?: boolean
  lateCheckout?: boolean
  /** Pets declared. Optional — no caller passes it today, so every existing quote is unchanged. */
  petCount?: number
  /** A declared service animal: legally not a pet, so the fee is waived. */
  isServiceAnimal?: boolean
}

export interface PricingLine {
  label: string
  amount: number                 // cents
}

export interface PricingResult {
  nights: number
  nightlyRate: number            // cents (after any pricing-rule override)
  lines: PricingLine[]           // itemized CASH lines, in order
  baseTotal: number
  extraGuestFee: number
  feesTotalCash: number          // enabled, non-card-only fees
  cardOnlyFeesTotal: number      // enabled card-only fees (NOT in cashTotal)
  addonTotal: number
  earlyFee: number
  lateFee: number
  petFee: number                 // cents; 0 when pets are off, none declared, or a service animal
  petCount: number               // pets actually charged for, after the park's cap
  petCapped: boolean             // more pets were requested than pet_max allows
  cashTotal: number              // canonical price — no card surcharge baked in
  cardSurchargePercent: number
  cardSurcharge: (amountCents: number) => number // surcharge for a given paid amount
  firstNightDeposit: number      // first night's base rate + proportional cash fees
  deposit: number                // configured up-front deposit in cents (driven by deposit_type)
  depositLabel: string           // dynamic button label, e.g. 'Deposit', '50% deposit', 'Pay in full'
}

function nightsBetween(arrival: string, departure: string): number {
  if (!arrival || !departure) return 0
  const ms = new Date(departure).getTime() - new Date(arrival).getTime()
  return ms > 0 ? Math.round(ms / 86400000) : 0
}

export function computePricing(input: PricingInput): PricingResult {
  const {
    site, arrival_date, departure_date,
    num_adults, num_children, settings,
  } = input
  const fees = input.fees ?? []
  const addons = input.addons ?? []
  const pricingRules = input.pricingRules ?? []
  const enabled = input.enabledFeeNames

  const nights = nightsBetween(arrival_date, departure_date)

  // Nightly rate: highest-priority active pricing rule that matches, else base_rate.
  let nightlyRate = site ? site.base_rate : 0
  if (site && nights > 0 && pricingRules.length > 0) {
    const matches = pricingRules.filter(rule => {
      const withinDates = rule.start_date <= departure_date && rule.end_date >= arrival_date
      if (!withinDates) return false
      if (rule.site_ids) return rule.site_ids.split(',').includes(site.id)
      if (rule.site_id) return rule.site_id === site.id
      if (rule.site_type) return rule.site_type === site.site_type
      return false
    }).sort((a, b) => b.priority - a.priority)
    if (matches[0]) nightlyRate = matches[0].nightly_rate
  }
  const baseTotal = site ? nightlyRate * nights : 0

  // Extra-guest fee — thresholds and rates come from settings, charged per night.
  const inclAdults = settings.base_occupancy_adults ?? 0
  const inclChildren = settings.base_occupancy_children ?? 0
  const extraAdults = Math.max(0, num_adults - inclAdults)
  const extraChildren = Math.max(0, num_children - inclChildren)
  const extraGuestFee =
    (extraAdults * (settings.extra_adult_fee || 0) +
     extraChildren * (settings.extra_child_fee || 0)) * nights

  // ── THE PET FEE ─────────────────────────────────────────────────────────────────────────────
  //
  // Computed above the fee arithmetic because the fee base below may include it. The arithmetic
  // itself lives in lib/pet-fee.ts — pure, importing nothing, reviewed on its own PR — so that it
  // is written once and cannot drift between this engine and lib/booking-quote.ts.
  //
  // INERT TODAY: no caller passes petCount, and every tenant is provisioned with pets_enabled
  // false, so this returns zero and nothing below changes.
  const { petFee, petCount, capped: petCapped } = computePetFee({
    petCount: input.petCount ?? 0,
    nights,
    isServiceAnimal: input.isServiceAnimal,
    settings,
  })

  // Fees — filter by applies_to, then by enabled toggle. Card-only split out of cash.
  const applicable = site
    ? fees.filter(f =>
        f.applies_to === 'all' ||
        f.applies_to.split(',').map(s => s.trim()).includes(site.site_type))
    : []
  const isEnabled = (f: PricingFee) => !enabled || enabled[f.name] !== false
  // The pet fee's place in the fee base, by the same rule lib/booking-quote.ts applies: a
  // card_only fee is governed by pet_fee_surcharged, everything else by pet_fee_taxable. Both
  // default false, so an existing quote is untouched.
  //
  // NOTE THE BASE. This engine computes a percentage fee on `baseTotal` — the stay alone —
  // whereas booking-quote uses `site.total_price + extraGuestFee`. That divergence predates the
  // pet fee and is deliberately NOT corrected here: the two engines serve different models (see
  // the header of lib/booking-quote.ts) and changing the wizard's base would alter what every
  // existing admin booking charges. The pet fee simply follows whichever base each engine
  // already uses.
  const feeBaseFor = (f: PricingFee) =>
    baseTotal + ((f.card_only ? settings.pet_fee_surcharged : settings.pet_fee_taxable) ? petFee : 0)
  const feeCents = (f: PricingFee) =>
    f.type === 'percentage'
      ? Math.round(feeBaseFor(f) * f.amount / 100)
      : Math.round(f.amount * 100)
  const cashFees = applicable.filter(f => isEnabled(f) && !f.card_only)
  const cardOnlyFees = applicable.filter(f => isEnabled(f) && f.card_only)
  const feesTotalCash = cashFees.reduce((s, f) => s + feeCents(f), 0)
  const cardOnlyFeesTotal = cardOnlyFees.reduce((s, f) => s + feeCents(f), 0)

  const addonTotal = addons.reduce((s, a) => s + a.price * (a.quantity || 0), 0)

  const earlyFee = input.earlyCheckin && settings.early_checkin_enabled
    ? (settings.early_checkin_price || 0) : 0
  const lateFee = input.lateCheckout && settings.late_checkout_enabled
    ? (settings.late_checkout_price || 0) : 0

  const cashTotal = baseTotal + extraGuestFee + feesTotalCash + addonTotal + earlyFee + lateFee + petFee

  // ── AN ACCEPTED ASYMMETRY IN v1, STATED RATHER THAN HIDDEN ──────────────────────────────────
  //
  // `pet_fee_surcharged` is only INDEPENDENTLY honoured on the public path.
  //
  // The two engines carry different surcharge models. In lib/booking-quote.ts the card fee is a
  // `fees` row with card_only set, computed on its own base — so excluding the pet fee from that
  // base is meaningful, and the toggle does exactly what it says. Here, the surcharge is a flat
  // percentage applied by cardSurcharge() to whatever amount is being paid, and that amount is
  // derived from cashTotal — which now contains the pet fee. So on the wizard the pet fee is
  // effectively always surcharged once it is charged at all, whatever the toggle says. (The
  // toggle still governs card_only `fees` ROWS here, via feeBaseFor above; it simply cannot reach
  // the percentage surcharge.)
  //
  // NOT FIXED, deliberately. Making it independent would mean surcharging something other than
  // the amount actually being collected — a second, divergent surcharge base inside the engine
  // that already differs from the public one. That is a real change to what every existing admin
  // booking charges, and it does not belong in the same pull request as introducing the pet fee.
  // A park that needs the distinction should collect pet fees through the public path, or the
  // wizard's surcharge model should be revisited on its own.
  const pct = settings.card_surcharge_percent || 0
  const cardSurcharge = (amountCents: number) => Math.round(amountCents * pct / 100)

  const firstNightBase = site ? site.base_rate : 0
  const proportionalFees = nights > 0 ? Math.round(feesTotalCash / nights) : 0
  // The pet fee's share of a first-night deposit, by the SAME rule as lib/booking-quote.ts:
  // prorate a per-night pet fee, collect a flat one in full. A flat pet fee is not a per-night
  // charge, so dividing it by the length of the stay would make the same dog cost a different
  // deposit on a two-night and a ten-night booking. Both directions are pinned by tests; if this
  // is revisited, change it in BOTH engines or they will quote different deposits.
  const petFeeInFirstNight = settings.pet_fee_per_night
    ? (nights > 0 ? Math.round(petFee / nights) : 0)
    : petFee
  const firstNightDeposit = site ? firstNightBase + proportionalFees + petFeeInFirstNight : 0

  // Configurable deposit. Defaults to first-night behavior, so any campground
  // whose deposit_type column is null/absent (e.g. Cady today) is unchanged.
  const depositType = settings.deposit_type || 'first_night'
  const depositValue = settings.deposit_value || 0
  let deposit: number
  let depositLabel: string
  if (depositType === 'percentage') {
    deposit = Math.min(Math.round(cashTotal * depositValue / 100), cashTotal)
    depositLabel = `${depositValue}% deposit`
  } else if (depositType === 'flat') {
    deposit = Math.min(depositValue, cashTotal)
    depositLabel = 'Deposit'
  } else if (depositType === 'full') {
    deposit = cashTotal
    depositLabel = 'Pay in full'
  } else {
    deposit = firstNightDeposit
    depositLabel = 'First night'
  }

  const lines: PricingLine[] = []
  if (site) {
    lines.push({ label: `${nights} night${nights !== 1 ? 's' : ''} × $${(nightlyRate / 100).toFixed(2)}`, amount: baseTotal })
  }
  if (extraGuestFee > 0) lines.push({ label: 'Extra guests', amount: extraGuestFee })
  // Its own named line, matching lib/booking-quote.ts's emailLines, so the wizard's confirmation
  // and the public one itemize identically.
  if (petFee > 0) lines.push({ label: 'Pet fee', amount: petFee })
  for (const f of cashFees) lines.push({ label: f.name, amount: feeCents(f) })
  for (const a of addons) {
    if ((a.quantity || 0) > 0) {
      lines.push({ label: `${a.name || 'Add-on'} ×${a.quantity}`, amount: a.price * a.quantity })
    }
  }
  if (earlyFee > 0) lines.push({ label: 'Early check-in', amount: earlyFee })
  if (lateFee > 0) lines.push({ label: 'Late check-out', amount: lateFee })

  return {
    nights, nightlyRate, lines, baseTotal, extraGuestFee,
    feesTotalCash, cardOnlyFeesTotal, addonTotal, earlyFee, lateFee,
    petFee, petCount, petCapped,
    cashTotal, cardSurchargePercent: pct, cardSurcharge, firstNightDeposit,
    deposit, depositLabel,
  }
}

// Camper-fit check for RV sites. Cabins/tents (no amp/length data) always pass.
export function siteFitsCamper(
  site: PricingSite,
  camper: { length?: number | null; amperage?: '30amp' | '50amp' | null },
): { fits: boolean; reason?: string } {
  if (site.site_type !== 'rv_site') return { fits: true }
  if (camper.amperage === '50amp' && site.amp_service !== '30_50amp') {
    return { fits: false, reason: '30 amp only' }
  }
  if (camper.length && site.max_rv_length && camper.length > site.max_rv_length) {
    return { fits: false, reason: `max ${site.max_rv_length} ft` }
  }
  return { fits: true }
}
