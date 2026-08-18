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
  type SearchFee,
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
