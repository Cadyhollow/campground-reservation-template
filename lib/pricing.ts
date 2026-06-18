// lib/pricing.ts
// Single source of truth for reservation pricing across ResoNation.
// ALL money is integer cents. The cash total is canonical; the card
// surcharge is applied per-payment, never baked into the stored total.

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

  // Fees — filter by applies_to, then by enabled toggle. Card-only split out of cash.
  const applicable = site
    ? fees.filter(f =>
        f.applies_to === 'all' ||
        f.applies_to.split(',').map(s => s.trim()).includes(site.site_type))
    : []
  const isEnabled = (f: PricingFee) => !enabled || enabled[f.name] !== false
  const feeCents = (f: PricingFee) =>
    f.type === 'percentage'
      ? Math.round(baseTotal * f.amount / 100)
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

  const cashTotal = baseTotal + extraGuestFee + feesTotalCash + addonTotal + earlyFee + lateFee

  const pct = settings.card_surcharge_percent || 0
  const cardSurcharge = (amountCents: number) => Math.round(amountCents * pct / 100)

  const firstNightBase = site ? site.base_rate : 0
  const proportionalFees = nights > 0 ? Math.round(feesTotalCash / nights) : 0
  const firstNightDeposit = site ? firstNightBase + proportionalFees : 0

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
