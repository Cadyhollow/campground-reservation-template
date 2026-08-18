// The search card's fee arithmetic, and the invariant that keeps it in step with the checkout
// quote.
//
// WHAT THIS FILE IS GUARDING. /api/availability priced a site card with its own copy of the fee
// maths, and that copy disagreed with lib/booking-quote.ts in two ways: it read a flat fee's
// DOLLARS as cents, and it compared a CSV `applies_to` to one site type with `===`. It then
// returned the fees-inclusive figure as `total_price`, which /book took as the stay base and
// applied every fee to a second time — so the browser's total exceeded the server's, and
// /api/payment rejected the booking at its pricing chokepoint with "Pricing has changed since
// this page was loaded".
//
// A park that added a single tax row could therefore take no online booking at all, and it was
// invisible because onboarding seeds no `fees` rows: every FRESH tenant agrees with itself, and
// the existing route test sources its price from /api/availability on exactly such a tenant.
//
// These are pure — no server, no database — so they run in the guardrails CI job on every pull
// request, unlike the route suites, which skip themselves without a configured tenant. A skip
// that looks like a pass is how the previous pricing regression stayed hidden.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  feeAppliesToSiteType,
  searchFeeCents,
  summarizeSiteFees,
  extraGuestFeeCents,
  type SearchFee,
  type SearchOccupancySettings,
} from './search-pricing.ts'

const pct = (amount: number, applies_to = 'all'): SearchFee =>
  ({ name: `${amount}% tax`, type: 'percentage', amount, applies_to })
const flat = (amount: number, applies_to = 'all'): SearchFee =>
  ({ name: `$${amount} fee`, type: 'flat', amount, applies_to })

// ── UNITS ─────────────────────────────────────────────────────────────────────────────────────

test('a flat fee is stored in dollars and priced in cents', () => {
  // app/admin/fees/page.tsx stores `parseFloat(form.amount)`, so a $10 fee is the number 10.
  // This is the exact defect: it used to come back as 10 cents.
  assert.equal(searchFeeCents(flat(10), 11000), 1000)
})

test('a percentage fee is priced off the base in cents', () => {
  assert.equal(searchFeeCents(pct(6), 11000), 660)
})

test('a flat fee does not vary with the stay length', () => {
  assert.equal(searchFeeCents(flat(10), 5500), 1000)
  assert.equal(searchFeeCents(flat(10), 110000), 1000)
})

test('fractional dollars and fractional percents round to whole cents', () => {
  assert.equal(searchFeeCents(flat(12.5), 11000), 1250)
  // 11000 * 6.5% = 715 exactly; 3333 * 6.5% = 216.645 -> 217
  assert.equal(searchFeeCents(pct(6.5), 11000), 715)
  assert.equal(searchFeeCents(pct(6.5), 3333), 217)
  assert.ok(Number.isInteger(searchFeeCents(pct(6.5), 3333)))
})

test('a fee total never carries a fraction of a cent', () => {
  const { feesTotal, totalPrice } = summarizeSiteFees([pct(6.5), flat(12.5)], 'rv_site', 3333)
  assert.ok(Number.isInteger(feesTotal), `feesTotal was ${feesTotal}`)
  assert.ok(Number.isInteger(totalPrice), `totalPrice was ${totalPrice}`)
})

// ── applies_to MATCHING ───────────────────────────────────────────────────────────────────────

test("'all' applies to every site type", () => {
  assert.equal(feeAppliesToSiteType(pct(6, 'all'), 'rv_site'), true)
  assert.equal(feeAppliesToSiteType(pct(6, 'all'), 'cabin'), true)
})

test('a CSV applies_to matches each of its members', () => {
  // The defect: `'rv_site,cabin' === 'cabin'` is false, so this fee was invisible to search and
  // appeared for the first time at checkout.
  const fee = flat(10, 'rv_site,cabin')
  assert.equal(feeAppliesToSiteType(fee, 'rv_site'), true)
  assert.equal(feeAppliesToSiteType(fee, 'cabin'), true)
  assert.equal(feeAppliesToSiteType(fee, 'tent'), false)
})

test('a CSV applies_to tolerates spaces, as the Fees screen can write them', () => {
  assert.equal(feeAppliesToSiteType(flat(10, 'rv_site, cabin'), 'cabin'), true)
})

test('a fee that applies to no site type contributes nothing', () => {
  const { breakdown, feesTotal, totalPrice } = summarizeSiteFees([flat(10, 'cabin')], 'tent', 3000)
  assert.deepEqual(breakdown, [])
  assert.equal(feesTotal, 0)
  assert.equal(totalPrice, 3000)
})

// ── THE INVARIANT THAT WAS ACTUALLY BROKEN ────────────────────────────────────────────────────

test('totalPrice is the stay plus fees counted exactly once', () => {
  const basePrice = 11000 // 2 nights x $55
  const { feesTotal, totalPrice } = summarizeSiteFees([pct(6), flat(10)], 'rv_site', basePrice)
  assert.equal(feesTotal, 1660)      // 660 + 1000
  assert.equal(totalPrice, 12660)
  // Counted ONCE: the fees in the total are exactly feesTotal, no more.
  assert.equal(totalPrice - basePrice, feesTotal)
})

test('THE REGRESSION: the search card agrees with the checkout quote', () => {
  // This is the whole bug in one assertion.
  //
  // /book derives its stay base as nightly x nights and lets lib/booking-quote.ts add fees. If
  // the search hands it `totalPrice` instead, that base already contains the fees and they are
  // charged twice. The two numbers below must be computed from the SAME base, and the base is
  // the stay alone.
  const nightlyRate = 5500
  const nights = 2
  const stayOnly = nightlyRate * nights

  const search = summarizeSiteFees([pct(6), flat(10)], 'rv_site', stayOnly)

  // What /book will compute: the same base, the same fees, once.
  const quoteBase = nightlyRate * nights
  const quoteFees = Math.round(quoteBase * 6 / 100) + 10 * 100  // booking-quote.ts:192-193
  const quoteTotal = quoteBase + quoteFees

  assert.equal(quoteBase, stayOnly, 'the quote base must be the stay alone')
  assert.equal(search.totalPrice, quoteTotal, 'search card and checkout total must agree')

  // And the shape of the old failure, pinned so it cannot come back: feeding the fees-inclusive
  // figure in as the base compounds them.
  const doubled = summarizeSiteFees([pct(6), flat(10)], 'rv_site', search.totalPrice)
  assert.notEqual(doubled.totalPrice, quoteTotal)
  assert.ok(doubled.totalPrice > quoteTotal, 'compounding must overcharge, which is what 409d')
})

// ── THE EXTRA-GUEST FEE ───────────────────────────────────────────────────────────────────────
//
// The card ignored this entirely, so any booking above the park's base occupancy was quoted low
// and grew at checkout. Unlike the double-count it never errored — the checkout page and
// /api/payment agreed with each other, so nothing was refused; the guest was just told the wrong
// price. Every expression below mirrors lib/booking-quote.ts:171-177, defaults included.

// 2 adults + 2 children included; $15 per extra adult per night, $7.50 per extra child per night.
const occ: SearchOccupancySettings = {
  base_occupancy_adults: 2,
  base_occupancy_children: 2,
  extra_adult_fee: 1500,
  extra_child_fee: 750,
}

test('under base occupancy costs nothing extra', () => {
  assert.equal(extraGuestFeeCents(occ, 1, 0, 2), 0)
})

test('exactly at base occupancy costs nothing extra', () => {
  // The boundary. `Math.max(0, adults - baseAdults)` must be 0 here, not 1.
  assert.equal(extraGuestFeeCents(occ, 2, 2, 2), 0)
})

test('one extra adult is charged per night', () => {
  assert.equal(extraGuestFeeCents(occ, 3, 2, 2), 3000)   // 1 x $15 x 2 nights
})

test('one extra child is charged per night, at the child rate', () => {
  assert.equal(extraGuestFeeCents(occ, 2, 3, 2), 1500)   // 1 x $7.50 x 2 nights
})

test('extra adults and extra children are charged together', () => {
  assert.equal(extraGuestFeeCents(occ, 4, 3, 2), 7500)   // (2 x $15 + 1 x $7.50) x 2
})

test('the extra-guest fee scales with nights', () => {
  assert.equal(extraGuestFeeCents(occ, 3, 2, 1), 1500)
  assert.equal(extraGuestFeeCents(occ, 3, 2, 5), 7500)
  assert.equal(extraGuestFeeCents(occ, 3, 2, 0), 0)
})

test('adults over but children under does not net off', () => {
  // A party of 3 adults and 0 children still pays for the extra adult; the unused child
  // allowance is not a credit.
  assert.equal(extraGuestFeeCents(occ, 3, 0, 2), 3000)
})

test('missing occupancy settings default to 2 and 2, matching the booking quote', () => {
  // booking-quote.ts uses `?? 2` for both. lib/pricing.ts uses `?? 0` for the admin wizard —
  // copying THAT default here would charge every 1-adult search for an extra guest.
  const noBase: SearchOccupancySettings = { extra_adult_fee: 1500, extra_child_fee: 750 }
  assert.equal(extraGuestFeeCents(noBase, 2, 2, 2), 0)
  assert.equal(extraGuestFeeCents(noBase, 3, 2, 2), 3000)
})

test('missing per-guest rates cost nothing', () => {
  const noRates: SearchOccupancySettings = { base_occupancy_adults: 2, base_occupancy_children: 2 }
  assert.equal(extraGuestFeeCents(noRates, 9, 9, 3), 0)
})

test('null and undefined settings are safe', () => {
  assert.equal(extraGuestFeeCents(null, 4, 3, 2), 0)
  assert.equal(extraGuestFeeCents(undefined, 4, 3, 2), 0)
})

// ── THE EXTRA GUEST FEE INSIDE THE FEE BASE ───────────────────────────────────────────────────

test('a percentage fee is charged on the stay PLUS the extra guests', () => {
  // The subtlety that makes or breaks the match: booking-quote.ts:189 computes a site fee on
  // `site.total_price + extraGuestFee`. Taxing the stay alone here would leave the card short by
  // the tax on the guest fee — $4.50 in the reproduction — even with the fee itself included.
  const stay = 11000, egf = 7500
  const { breakdown, feesTotal, totalPrice } = summarizeSiteFees([pct(6), flat(10)], 'rv_site', stay, egf)
  assert.equal(breakdown[0].amount, 1110)             // 6% of 18500, NOT 6% of 11000 (660)
  assert.equal(feesTotal, 1110 + 1000)
  assert.equal(totalPrice, stay + egf + feesTotal)    // 20610
})

test('a flat fee does not change when extra guests are added', () => {
  assert.equal(summarizeSiteFees([flat(10)], 'rv_site', 11000, 7500).feesTotal, 1000)
})

test('omitting the extra-guest argument is the same as zero', () => {
  // Keeps every caller that predates this parameter behaving exactly as it did.
  const withZero = summarizeSiteFees([pct(6), flat(10)], 'rv_site', 11000, 0)
  const omitted = summarizeSiteFees([pct(6), flat(10)], 'rv_site', 11000)
  assert.deepEqual(omitted, withZero)
  assert.equal(omitted.totalPrice, 12660)
})

test('totalPrice reports the extra-guest fee it contains', () => {
  const r = summarizeSiteFees([], 'rv_site', 11000, 7500)
  assert.equal(r.extraGuestFee, 7500)
  assert.equal(r.totalPrice - r.extraGuestFee - r.feesTotal, 11000)
})

test('THE REGRESSION: the card matches checkout for a party above occupancy', () => {
  // The full reproduction, as arithmetic. 2 nights at $55, 4 adults + 3 children against a 2/2
  // base, a 6% tax and a $10 flat fee.
  //
  // Before the fix the card said $126.60 and checkout said $206.10.
  const nightlyRate = 5500, nights = 2, adults = 4, children = 3
  const stayOnly = nightlyRate * nights

  const egf = extraGuestFeeCents(occ, adults, children, nights)
  const card = summarizeSiteFees([pct(6), flat(10)], 'rv_site', stayOnly, egf)

  // What computeBookingQuote will produce, by its own expressions (booking-quote.ts:177, :189, :212).
  const quoteExtraGuest = (Math.max(0, adults - 2) * 1500 + Math.max(0, children - 2) * 750) * nights
  const quoteFeeBase = stayOnly + quoteExtraGuest
  const quoteFees = Math.round(quoteFeeBase * 6 / 100) + 10 * 100
  const quoteTotal = stayOnly + quoteExtraGuest + quoteFees

  assert.equal(egf, quoteExtraGuest, 'the guest fee must match the quote')
  assert.equal(card.totalPrice, quoteTotal, 'search card and checkout total must agree')
  assert.equal(card.totalPrice, 20610)

  // And the shape of the old failure, pinned: ignoring the guest fee understates the card by the
  // fee AND the tax on it.
  const ignoringGuests = summarizeSiteFees([pct(6), flat(10)], 'rv_site', stayOnly, 0)
  assert.equal(ignoringGuests.totalPrice, 12660)
  assert.equal(quoteTotal - ignoringGuests.totalPrice, 7950)  // $75.00 + $4.50 tax on it
})

// ── DEGENERATE INPUTS ─────────────────────────────────────────────────────────────────────────

test('no fees configured leaves the stay untouched', () => {
  // The state every tenant is provisioned in, and the reason this bug hid for so long.
  for (const fees of [null, undefined, [] as SearchFee[]]) {
    const { breakdown, feesTotal, totalPrice } = summarizeSiteFees(fees, 'rv_site', 11000)
    assert.deepEqual(breakdown, [])
    assert.equal(feesTotal, 0)
    assert.equal(totalPrice, 11000)
  }
})

test('a zero-night search prices a percentage fee at zero and a flat fee in full', () => {
  const { feesTotal } = summarizeSiteFees([pct(6), flat(10)], 'rv_site', 0)
  assert.equal(feesTotal, 1000)
})
