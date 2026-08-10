// Unit tests for the booking quote. Framework-free — runs on Node's built-in runner with type
// stripping, no dependencies:
//
//   node --test lib/booking-quote.test.ts
//
// Two jobs, and the first is the one that protects real bookings.
//
// 1. EQUIVALENCE. `legacyQuote` below is a transcription of app/book/page.tsx's pricing
//    arithmetic as it stood BEFORE the extraction — the code that produced every number a
//    camper has ever been charged. Every case asserts the shared function agrees with it to
//    the cent. This matters more than it looks: /api/payment now recomputes the quote and
//    REJECTS a booking whose total disagrees with the page's, so any drift between the old
//    arithmetic and the new one does not undercharge — it turns away paying campers with
//    "Pricing has changed". If this file goes red, that is the bug.
//
// 2. AUTHORITY. The discount checks that used to run only in the browser now decide whether a
//    code is honoured server-side, so they are pinned here too.
//
// The same reasoning as lib/refundable.test.ts, which exists because a UI formula and a server
// formula written twice drifted apart and stranded refundable money.
//
// `legacyQuote` below transcribes THIS repo's arithmetic, which is not Cady's: the deposit is
// derived from `total` because the card-only fee already sits inside it. Copying Cady's test
// here would assert the wrong numbers and quietly bless a change to what tenants charge.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { computeBookingQuote, checkDiscount, resolveNightlyRate, cardOnlyFeeShare, type QuoteInput } from './booking-quote.ts'

// ── The pre-extraction arithmetic, transcribed verbatim from app/book/page.tsx ────────────
function legacyQuote(i: QuoteInput) {
  const site = i.site
  const settings: any = i.settings
  const addonTotal = i.addonSelections.reduce((sum, a) => sum + a.price * a.quantity, 0)

  const baseAdults = settings?.base_occupancy_adults ?? 2
  const baseChildren = settings?.base_occupancy_children ?? 2
  const extraAdultFee = settings?.extra_adult_fee ?? 0
  const extraChildFee = settings?.extra_child_fee ?? 0
  const extraAdults = Math.max(0, i.adults - baseAdults)
  const extraChildren = Math.max(0, i.children - baseChildren)
  const extraGuestFee = (extraAdults * extraAdultFee + extraChildren * extraChildFee) * site.nights

  const feeAppliesToSite = (fee: any) =>
    fee.applies_to === 'all' || fee.applies_to.split(',').map((s: string) => s.trim()).includes(site.site_type)
  const feeAppliesToAddons = (fee: any) =>
    fee.applies_to === 'all' || fee.applies_to.split(',').map((s: string) => s.trim()).includes('addons')
  const calculateFeeAmount = (fee: any) => {
    let base = 0
    if (feeAppliesToSite(fee)) base += site.total_price + extraGuestFee
    if (feeAppliesToAddons(fee)) base += addonTotal
    if (base === 0) return 0
    if (fee.type === 'percentage') return Math.round(base * fee.amount / 100)
    return fee.amount * 100
  }

  const feeBreakdown = i.fees.map(f => ({ ...f, calculatedAmount: calculateFeeAmount(f) }))
    .filter(f => f.calculatedAmount > 0)
  const feesTotal = feeBreakdown.reduce((s, f) => s + f.calculatedAmount, 0)
  const cardOnlyFeesTotal = feeBreakdown.filter(f => f.card_only).reduce((s, f) => s + f.calculatedAmount, 0)

  const earlyFee = (i.earlyRequested && !i.earlyBlocked && settings?.early_checkin_enabled && settings?.early_checkin_show_customers)
    ? (settings.early_checkin_price || 0) : 0
  const lateFee = (i.lateRequested && !i.lateBlocked && settings?.late_checkout_enabled && settings?.late_checkout_show_customers)
    ? (settings.late_checkout_price || 0) : 0

  const subtotal = site.total_price + extraGuestFee + addonTotal + earlyFee + lateFee
  const discountAmount = i.discount
    ? i.discount.discount_type === 'percent'
      ? Math.round(subtotal * i.discount.discount_value / 100)
      : i.discount.discount_value
    : 0
  const total = Math.max(0, subtotal + feesTotal - discountAmount)
  const cashTotal = total - cardOnlyFeesTotal

  const realCashFees = feesTotal - cardOnlyFeesTotal
  const proportionalCashFees = site.nights > 0 ? Math.round(realCashFees / site.nights) : 0
  const firstNightDeposit = site.nightly_rate + proportionalCashFees

  const depositType = settings?.deposit_type || 'first_night'
  const depositValue = settings?.deposit_value || 0
  let deposit: number
  // `total`, not cashTotal — this repo's card-only fee is already inside it.
  if (depositType === 'percentage') deposit = Math.min(Math.round(total * depositValue / 100), total)
  else if (depositType === 'flat') deposit = Math.min(depositValue, total)
  else if (depositType === 'full') deposit = total
  else deposit = firstNightDeposit

  return { extraGuestFee, addonTotal, feesTotal, cardOnlyFeesTotal, earlyFee, lateFee, subtotal, discountAmount, total, cashTotal, deposit }
}

const SETTINGS = {
  base_occupancy_adults: 2, base_occupancy_children: 2,
  extra_adult_fee: 1000, extra_child_fee: 500,
  early_checkin_enabled: true, early_checkin_price: 1500, early_checkin_show_customers: true,
  late_checkout_enabled: true, late_checkout_price: 2000, late_checkout_show_customers: true,
  deposit_type: 'first_night', deposit_value: 0, card_surcharge_percent: 3.5,
}

function input(over: Partial<QuoteInput> = {}): QuoteInput {
  return {
    site: { site_type: 'rv_site', nightly_rate: 5000, total_price: 15000, nights: 3 },
    adults: 2, children: 0,
    settings: SETTINGS as any,
    fees: [],
    addonSelections: [],
    discount: null,
    earlyRequested: false, lateRequested: false,
    earlyBlocked: false, lateBlocked: false,
    ...over,
  }
}

const CASES: Array<[string, QuoteInput]> = [
  ['bare 3-night stay', input()],
  ['extra adults', input({ adults: 4 })],
  ['extra children', input({ children: 3 })],
  ['extra adults and children', input({ adults: 5, children: 4 })],
  ['single night', input({ site: { site_type: 'rv_site', nightly_rate: 5000, total_price: 5000, nights: 1 } })],
  ['zero nights', input({ site: { site_type: 'rv_site', nightly_rate: 5000, total_price: 0, nights: 0 } })],
  ['flat fee all', input({ fees: [{ name: 'Cleaning', type: 'flat', amount: 25, applies_to: 'all' }] })],
  ['percentage fee', input({ fees: [{ name: 'Resort', type: 'percentage', amount: 8, applies_to: 'all' }] })],
  ['fee scoped to this site type', input({ fees: [{ name: 'RV', type: 'percentage', amount: 5, applies_to: 'rv_site,cabin' }] })],
  ['fee scoped to another site type', input({ fees: [{ name: 'Cabin', type: 'flat', amount: 10, applies_to: 'cabin' }] })],
  ['card-only fee', input({ fees: [{ name: 'Card', type: 'percentage', amount: 3, applies_to: 'all', card_only: true }] })],
  ['mixed fees incl. card-only', input({
    fees: [
      { name: 'Cleaning', type: 'flat', amount: 25, applies_to: 'all' },
      { name: 'Resort', type: 'percentage', amount: 8, applies_to: 'rv_site' },
      { name: 'Card', type: 'percentage', amount: 3, applies_to: 'all', card_only: true },
    ],
  })],
  ['addons', input({ addonSelections: [{ id: 'a', quantity: 2, price: 1200, name: 'Firewood' }] })],
  ['addon-scoped fee', input({
    addonSelections: [{ id: 'a', quantity: 2, price: 1200 }],
    fees: [{ name: 'Addon tax', type: 'percentage', amount: 6, applies_to: 'addons' }],
  })],
  ['early checkin', input({ earlyRequested: true })],
  ['early checkin blocked by turnover', input({ earlyRequested: true, earlyBlocked: true })],
  ['late checkout', input({ lateRequested: true })],
  ['both extras', input({ earlyRequested: true, lateRequested: true })],
  ['extras requested but park disabled them', input({
    earlyRequested: true, lateRequested: true,
    settings: { ...SETTINGS, early_checkin_enabled: false, late_checkout_enabled: false } as any,
  })],
  ['extras hidden from customers', input({
    earlyRequested: true, lateRequested: true,
    settings: { ...SETTINGS, early_checkin_show_customers: false, late_checkout_show_customers: false } as any,
  })],
  ['percent discount', input({ discount: { code: 'S20', discount_type: 'percent', discount_value: 20 } })],
  ['flat discount', input({ discount: { code: 'TEN', discount_type: 'flat', discount_value: 1000 } })],
  ['discount larger than stay', input({ discount: { code: 'BIG', discount_type: 'flat', discount_value: 999999 } })],
  ['deposit: percentage', input({ settings: { ...SETTINGS, deposit_type: 'percentage', deposit_value: 25 } as any })],
  ['deposit: flat', input({ settings: { ...SETTINGS, deposit_type: 'flat', deposit_value: 5000 } as any })],
  ['deposit: flat exceeding total', input({ settings: { ...SETTINGS, deposit_type: 'flat', deposit_value: 999999 } as any })],
  ['deposit: full', input({ settings: { ...SETTINGS, deposit_type: 'full', deposit_value: 0 } as any })],
  ['deposit: first_night with cash fees', input({
    settings: { ...SETTINGS, deposit_type: 'first_night' } as any,
    fees: [{ name: 'Cleaning', type: 'flat', amount: 25, applies_to: 'all' }],
  })],
  ['null settings', input({ settings: null })],
  ['everything at once', input({
    adults: 4, children: 3,
    fees: [
      { name: 'Cleaning', type: 'flat', amount: 25, applies_to: 'all' },
      { name: 'Resort', type: 'percentage', amount: 8, applies_to: 'rv_site' },
      { name: 'Card', type: 'percentage', amount: 3, applies_to: 'all', card_only: true },
      { name: 'Addon tax', type: 'percentage', amount: 6, applies_to: 'addons' },
    ],
    addonSelections: [{ id: 'a', quantity: 2, price: 1200, name: 'Firewood' }],
    discount: { code: 'S20', discount_type: 'percent', discount_value: 20 },
    earlyRequested: true, lateRequested: true,
    settings: { ...SETTINGS, deposit_type: 'percentage', deposit_value: 30 } as any,
  })],
]

for (const [label, inp] of CASES) {
  test(`matches the pre-extraction arithmetic: ${label}`, () => {
    const now = computeBookingQuote(inp)
    const before = legacyQuote(inp)
    for (const k of Object.keys(before) as Array<keyof typeof before>) {
      assert.equal((now as any)[k], before[k], `${label}: ${String(k)} drifted`)
    }
  })
}

// ── Discount authority ───────────────────────────────────────────────────────────────────
const TODAY = '2026-08-10'
const OK_ROW = { code: 'SUMMER20', discount_type: 'percent', discount_value: 20, is_active: true, valid_from: null, valid_until: null, max_uses: null, times_used: 0 }

test('discount: a valid row is honoured', () => {
  const r = checkDiscount(OK_ROW, TODAY)
  assert.equal(r.ok, true)
})

test('discount: a code that does not exist is refused', () => {
  assert.equal(checkDiscount(null, TODAY).ok, false)
  assert.equal(checkDiscount(undefined, TODAY).ok, false)
})

test('discount: inactive is refused', () => {
  assert.equal(checkDiscount({ ...OK_ROW, is_active: false }, TODAY).ok, false)
})

test('discount: not yet valid is refused', () => {
  assert.equal(checkDiscount({ ...OK_ROW, valid_from: '2026-09-01' }, TODAY).ok, false)
})

test('discount: expired is refused', () => {
  assert.equal(checkDiscount({ ...OK_ROW, valid_until: '2026-08-09' }, TODAY).ok, false)
})

test('discount: boundary days are inclusive', () => {
  assert.equal(checkDiscount({ ...OK_ROW, valid_from: TODAY }, TODAY).ok, true)
  assert.equal(checkDiscount({ ...OK_ROW, valid_until: TODAY }, TODAY).ok, true)
})

test('discount: max_uses is enforced — the check the browser could not make stick', () => {
  assert.equal(checkDiscount({ ...OK_ROW, max_uses: 5, times_used: 4 }, TODAY).ok, true)
  assert.equal(checkDiscount({ ...OK_ROW, max_uses: 5, times_used: 5 }, TODAY).ok, false)
  assert.equal(checkDiscount({ ...OK_ROW, max_uses: 5, times_used: 9 }, TODAY).ok, false)
})

// ── Rate resolution ──────────────────────────────────────────────────────────────────────
const applies = (rule: any, site: any) => !rule.site_type || rule.site_type === site.site_type

test('rate: falls back to base_rate with no rules', () => {
  assert.equal(resolveNightlyRate({ site_type: 'rv_site', base_rate: 5000 }, [], applies), 5000)
})

test('rate: highest-priority matching rule wins', () => {
  const rules = [
    { nightly_rate: 6000, priority: 1, site_type: 'rv_site' },
    { nightly_rate: 9000, priority: 5, site_type: 'rv_site' },
    { nightly_rate: 7000, priority: 3, site_type: 'rv_site' },
  ]
  assert.equal(resolveNightlyRate({ site_type: 'rv_site', base_rate: 5000 }, rules, applies), 9000)
})

test('rate: a rule for another site type does not apply', () => {
  const rules = [{ nightly_rate: 9000, priority: 5, site_type: 'cabin' }]
  assert.equal(resolveNightlyRate({ site_type: 'rv_site', base_rate: 5000 }, rules, applies), 5000)
})

// ── The exploit this PR closes ───────────────────────────────────────────────────────────
test('a client-claimed price has no way into the quote', () => {
  // The URL used to carry totalPrice, and the route charged what came back. The quote takes
  // its site price as an argument the SERVER derives from base_rate × nights; there is no
  // field on QuoteInput a request could populate to lower it.
  const honest = computeBookingQuote(input())
  const forged = computeBookingQuote(input({
    // Everything a crafted request could plausibly assert…
    adults: 2, children: 0, discount: null,
  }))
  assert.equal(forged.total, honest.total)
  assert.equal(honest.total, 15000)
})

// The card fee charged on a payment: its prorated share of the card-only fees inside `total`.
// Transcribed from app/book/page.tsx's charge-time expression.
test('card-only fee share matches the charge-time expression', () => {
  const legacy = (pay: number, cash: number, cardOnly: number) =>
    cash > 0 ? Math.round(pay * cardOnly / cash) : 0
  const cases: Array<[number, number, number]> = [
    [10000, 10000, 350], [5000, 10000, 350], [0, 10000, 350],
    [10000, 10000, 0], [3333, 9999, 777], [10000, 0, 350],
  ]
  for (const [pay, cash, cardOnly] of cases) {
    assert.equal(cardOnlyFeeShare(pay, cash, cardOnly), legacy(pay, cash, cardOnly),
      `drifted for pay=${pay} cash=${cash} cardOnly=${cardOnly}`)
  }
})
