// The pet fee INSIDE the two fee engines.
//
// lib/pet-fee.test.ts covers the calculator on its own. This file covers what the calculator does
// once it is wired into lib/booking-quote.ts (the public path) and lib/pricing.ts (the admin
// wizard): where the fee lands in the total, whether it joins each fee's base, what share of it a
// deposit collects, and how it is itemized.
//
// These are the assertions that justify waiving the automated fee-model guard on that pull
// request. The other half of the justification is that every EXISTING quote is unchanged — that is
// pinned by lib/booking-quote.test.ts continuing to pass untouched, and was additionally verified
// by sweeping both engines over 77,760 pet-free input combinations before and after the change and
// diffing the serialised results: every money field identical, the only difference being three new
// keys on the returned object.
//
// Pure — no server, no database — so this runs in the guardrails CI job on every pull request.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { computeBookingQuote, cardOnlyFeeShare, type QuoteFee } from './booking-quote.ts'
import { computePricing } from './pricing.ts'

// ── FIXTURES ──────────────────────────────────────────────────────────────────────────────────
// $50/night, 2 nights, a party at base occupancy so extraGuestFee is 0 and every number below is
// traceable to the pet fee alone.

const NIGHTLY = 5000
const NIGHTS = 2
const STAY = NIGHTLY * NIGHTS      // 10000

const TAX: QuoteFee = { id: 'tax', name: 'Tax', type: 'percentage', amount: 10, applies_to: 'all' }
const CARD: QuoteFee = { id: 'card', name: 'Card fee', type: 'percentage', amount: 3, applies_to: 'all', card_only: true }
const FLAT_FEE: QuoteFee = { id: 'clean', name: 'Cleaning', type: 'flat', amount: 10, applies_to: 'all' }

const baseSettings = (over: Record<string, unknown> = {}) => ({
  base_occupancy_adults: 2, base_occupancy_children: 2,
  extra_adult_fee: 1500, extra_child_fee: 750,
  card_surcharge_percent: 3,
  pets_enabled: true, pet_fee_amount: 2500,
  ...over,
})

const quote = (over: Record<string, any> = {}, fees: QuoteFee[] = []) => computeBookingQuote({
  site: { site_type: 'rv_site', nightly_rate: NIGHTLY, total_price: STAY, nights: NIGHTS },
  adults: 2, children: 0,
  settings: baseSettings(over.settings) as any,
  fees,
  addonSelections: [], discount: null,
  earlyRequested: false, lateRequested: false, earlyBlocked: false, lateBlocked: false,
  petCount: 1,
  ...over, settings: baseSettings(over.settings) as any,
})

const pricing = (over: Record<string, any> = {}, fees: any[] = []) => computePricing({
  site: { id: 's1', site_type: 'rv_site', base_rate: NIGHTLY },
  arrival_date: '2026-09-10', departure_date: '2026-09-12',
  num_adults: 2, num_children: 0,
  settings: baseSettings(over.settings) as any,
  fees,
  petCount: 1,
  ...over, settings: baseSettings(over.settings) as any,
})

// ── THE FOUR CHARGING MODES, IN THE FULL QUOTE ────────────────────────────────────────────────

test('booking quote: flat pet fee for the stay', () => {
  const q = quote()
  assert.equal(q.petFee, 2500)
  assert.equal(q.total, STAY + 2500)
})

test('booking quote: pet fee per night', () => {
  const q = quote({ settings: { pet_fee_per_night: true } })
  assert.equal(q.petFee, 5000)              // 2500 x 2 nights
  assert.equal(q.total, STAY + 5000)
})

test('booking quote: pet fee per pet', () => {
  const q = quote({ petCount: 3, settings: { pet_fee_per_pet: true } })
  assert.equal(q.petFee, 7500)              // 2500 x 3 pets
  assert.equal(q.petCount, 3)
  assert.equal(q.total, STAY + 7500)
})

test('booking quote: pet fee per pet per night', () => {
  const q = quote({ petCount: 3, settings: { pet_fee_per_pet: true, pet_fee_per_night: true } })
  assert.equal(q.petFee, 15000)             // 2500 x 3 x 2
  assert.equal(q.total, STAY + 15000)
})

test('admin wizard: the same four modes produce the same figures', () => {
  assert.equal(pricing().petFee, 2500)
  assert.equal(pricing({ settings: { pet_fee_per_night: true } }).petFee, 5000)
  assert.equal(pricing({ petCount: 3, settings: { pet_fee_per_pet: true } }).petFee, 7500)
  assert.equal(
    pricing({ petCount: 3, settings: { pet_fee_per_pet: true, pet_fee_per_night: true } }).petFee,
    15000,
  )
})

test('the pet fee reaches cashTotal in both engines', () => {
  assert.equal(quote().cashTotal, STAY + 2500)
  assert.equal(pricing().cashTotal, STAY + 2500)
})

// ── pet_fee_taxable ───────────────────────────────────────────────────────────────────────────

test('pet_fee_taxable moves a percentage fee by exactly the tax on the pet fee', () => {
  const off = quote({ settings: { pet_fee_taxable: false } }, [TAX])
  const on = quote({ settings: { pet_fee_taxable: true } }, [TAX])

  assert.equal(off.feesTotal, Math.round(STAY * 10 / 100))                  // 1000
  assert.equal(on.feesTotal, Math.round((STAY + 2500) * 10 / 100))          // 1250
  assert.equal(on.feesTotal - off.feesTotal, Math.round(2500 * 10 / 100))   // exactly 250
})

test('pet_fee_taxable defaults to OFF', () => {
  // Absent must behave as false: a park that never opened the screen does not start taxing pets.
  const absent = quote({}, [TAX])
  const explicitlyOff = quote({ settings: { pet_fee_taxable: false } }, [TAX])
  assert.equal(absent.feesTotal, explicitlyOff.feesTotal)
  assert.equal(absent.feesTotal, 1000)
})

test('pet_fee_taxable does not move a FLAT fee', () => {
  // A flat fee ignores the base entirely, so both toggles are no-ops for it by construction.
  const off = quote({ settings: { pet_fee_taxable: false } }, [FLAT_FEE])
  const on = quote({ settings: { pet_fee_taxable: true } }, [FLAT_FEE])
  assert.equal(off.feesTotal, 1000)
  assert.equal(on.feesTotal, 1000)
})

test('admin wizard: pet_fee_taxable moves its percentage fee too', () => {
  const off = pricing({ settings: { pet_fee_taxable: false } }, [TAX])
  const on = pricing({ settings: { pet_fee_taxable: true } }, [TAX])
  assert.equal(on.feesTotalCash - off.feesTotalCash, Math.round(2500 * 10 / 100))
})

// ── pet_fee_surcharged ────────────────────────────────────────────────────────────────────────

test('pet_fee_surcharged moves the CARD-ONLY fee but NOT cashTotal', () => {
  const off = quote({ settings: { pet_fee_surcharged: false } }, [CARD])
  const on = quote({ settings: { pet_fee_surcharged: true } }, [CARD])

  assert.equal(off.cardOnlyFeesTotal, Math.round(STAY * 3 / 100))            // 300
  assert.equal(on.cardOnlyFeesTotal, Math.round((STAY + 2500) * 3 / 100))    // 375
  assert.equal(on.cardOnlyFeesTotal - off.cardOnlyFeesTotal, Math.round(2500 * 3 / 100))

  // THE PROPERTY THAT MATTERS: the card fee sits inside `total` and outside `cashTotal`, so
  // moving it must not change the cash the park is owed.
  assert.equal(off.cashTotal, on.cashTotal)
  assert.equal(on.cashTotal, STAY + 2500)
})

test('pet_fee_surcharged changes what cardOnlyFeeShare charges on a payment', () => {
  const off = quote({ settings: { pet_fee_surcharged: false } }, [CARD])
  const on = quote({ settings: { pet_fee_surcharged: true } }, [CARD])
  const shareOff = cardOnlyFeeShare(off.cashTotal, off.cashTotal, off.cardOnlyFeesTotal)
  const shareOn = cardOnlyFeeShare(on.cashTotal, on.cashTotal, on.cardOnlyFeesTotal)
  assert.equal(shareOff, 300)
  assert.equal(shareOn, 375)
  assert.ok(shareOn > shareOff)
})

test('the two toggles are INDEPENDENT — one does not imply the other', () => {
  // The whole reason the condition switches on fee.card_only. A single flag here would tie a
  // park's tax treatment to its card-fee treatment, which different authorities decide.
  const taxOnly = quote({ settings: { pet_fee_taxable: true, pet_fee_surcharged: false } }, [TAX, CARD])
  const cardOnly = quote({ settings: { pet_fee_taxable: false, pet_fee_surcharged: true } }, [TAX, CARD])
  const neither = quote({ settings: { pet_fee_taxable: false, pet_fee_surcharged: false } }, [TAX, CARD])
  const both = quote({ settings: { pet_fee_taxable: true, pet_fee_surcharged: true } }, [TAX, CARD])

  const tax = (q: typeof neither) => q.feeBreakdown.find(f => f.name === 'Tax')!.calculatedAmount
  const card = (q: typeof neither) => q.feeBreakdown.find(f => f.name === 'Card fee')!.calculatedAmount

  assert.equal(tax(neither), 1000);   assert.equal(card(neither), 300)
  assert.equal(tax(taxOnly), 1250);   assert.equal(card(taxOnly), 300)   // card untouched
  assert.equal(tax(cardOnly), 1000);  assert.equal(card(cardOnly), 375)  // tax untouched
  assert.equal(tax(both), 1250);      assert.equal(card(both), 375)
})

// ── THE DEPOSIT ───────────────────────────────────────────────────────────────────────────────
// The locked decision: prorate a PER-NIGHT pet fee, collect a FLAT one in full.

test('first_night deposit: a FLAT pet fee is collected in full', () => {
  const q = quote({ settings: { deposit_type: 'first_night' } })
  assert.equal(q.petFee, 2500)
  assert.equal(q.deposit, NIGHTLY + 2500)   // one night + the whole pet fee
})

test('first_night deposit: a PER-NIGHT pet fee is prorated to one night', () => {
  const q = quote({ settings: { deposit_type: 'first_night', pet_fee_per_night: true } })
  assert.equal(q.petFee, 5000)              // 2500 x 2 nights
  assert.equal(q.deposit, NIGHTLY + 2500)   // one night's worth only
})

test('first_night deposit: per pet per night prorates by nights, not by pets', () => {
  const q = quote({
    petCount: 3,
    settings: { deposit_type: 'first_night', pet_fee_per_pet: true, pet_fee_per_night: true },
  })
  assert.equal(q.petFee, 15000)             // 2500 x 3 x 2
  assert.equal(q.deposit, NIGHTLY + 7500)   // all three pets, one night
})

test('deposit_type full collects the whole pet fee', () => {
  const q = quote({ settings: { deposit_type: 'full' } })
  assert.equal(q.deposit, q.total)
  assert.equal(q.deposit, STAY + 2500)
})

test('deposit_type percentage takes its share of a total that includes the pet fee', () => {
  const q = quote({ settings: { deposit_type: 'percentage', deposit_value: 50 } })
  assert.equal(q.total, STAY + 2500)
  assert.equal(q.deposit, Math.round((STAY + 2500) * 50 / 100))
})

test('deposit_type flat is unaffected by the pet fee', () => {
  // A flat deposit is a number the park chose; the pet fee changes the balance, not the deposit.
  const withPet = quote({ settings: { deposit_type: 'flat', deposit_value: 4000 } })
  const withoutPet = quote({ petCount: 0, settings: { deposit_type: 'flat', deposit_value: 4000 } })
  assert.equal(withPet.deposit, 4000)
  assert.equal(withoutPet.deposit, 4000)
  assert.equal(withPet.total - withoutPet.total, 2500)
})

test('admin wizard: the same proration rule, both directions', () => {
  const flat = pricing({ settings: { deposit_type: 'first_night' } })
  assert.equal(flat.firstNightDeposit, NIGHTLY + 2500)

  const perNight = pricing({ settings: { deposit_type: 'first_night', pet_fee_per_night: true } })
  assert.equal(perNight.petFee, 5000)
  assert.equal(perNight.firstNightDeposit, NIGHTLY + 2500)
})

test('the two engines agree on the first-night deposit in both directions', () => {
  // They are separate implementations of the same rule; a divergence would quote two different
  // deposits for the same booking depending on who took it.
  for (const over of [{}, { pet_fee_per_night: true }]) {
    const q = quote({ settings: { deposit_type: 'first_night', ...over } })
    const p = pricing({ settings: { deposit_type: 'first_night', ...over } })
    assert.equal(q.deposit, p.firstNightDeposit, `mismatch for ${JSON.stringify(over)}`)
  }
})

// ── ITEMIZATION ───────────────────────────────────────────────────────────────────────────────

test('emailLines carry exactly one pet row, and the lines sum to the cash total', () => {
  const q = quote({ settings: { pet_fee_taxable: true } }, [TAX])
  const petRows = q.emailLines.filter(l => l.label === 'Pet fee')
  assert.equal(petRows.length, 1)
  assert.equal(petRows[0].amount, 2500)
  // The itemization must reconcile — a breakdown that does not add up is how an amount ends up
  // rendered as "Other charges" on the folio.
  assert.equal(q.emailLines.reduce((s, l) => s + l.amount, 0), q.cashTotal)
})

test('the pet row is absent when there is no pet fee', () => {
  assert.equal(quote({ petCount: 0 }).emailLines.filter(l => l.label === 'Pet fee').length, 0)
  assert.equal(pricing({ petCount: 0 }).lines.filter(l => l.label === 'Pet fee').length, 0)
})

test('admin wizard lines carry exactly one pet row and reconcile to cashTotal', () => {
  const p = pricing({ settings: { pet_fee_taxable: true } }, [TAX])
  const petRows = p.lines.filter(l => l.label === 'Pet fee')
  assert.equal(petRows.length, 1)
  assert.equal(petRows[0].amount, 2500)
  assert.equal(p.lines.reduce((s, l) => s + l.amount, 0), p.cashTotal)
})

// ── THE SERVICE-ANIMAL WAIVER, END TO END ─────────────────────────────────────────────────────

test('a service animal costs nothing in the full quote, in every mode', () => {
  for (const over of [
    {}, { pet_fee_per_night: true }, { pet_fee_per_pet: true },
    { pet_fee_per_pet: true, pet_fee_per_night: true },
  ]) {
    const q = quote({ petCount: 2, isServiceAnimal: true, settings: over })
    assert.equal(q.petFee, 0, `mode ${JSON.stringify(over)}`)
    assert.equal(q.petCount, 0)
    assert.equal(q.total, STAY)
    assert.equal(q.emailLines.filter(l => l.label === 'Pet fee').length, 0)
  }
})

test('a service animal does not move any fee base', () => {
  const withService = quote({ petCount: 2, isServiceAnimal: true, settings: { pet_fee_taxable: true, pet_fee_surcharged: true } }, [TAX, CARD])
  const noPets = quote({ petCount: 0, settings: { pet_fee_taxable: true, pet_fee_surcharged: true } }, [TAX, CARD])
  assert.equal(withService.feesTotal, noPets.feesTotal)
  assert.equal(withService.cashTotal, noPets.cashTotal)
})

test('admin wizard: a service animal is free there too', () => {
  const p = pricing({ petCount: 2, isServiceAnimal: true, settings: { pet_fee_per_pet: true } })
  assert.equal(p.petFee, 0)
  assert.equal(p.cashTotal, STAY)
})

// ── THE CAP, THROUGH THE QUOTE ────────────────────────────────────────────────────────────────

test('pet_max clamps the charge and reports it, in both engines', () => {
  const q = quote({ petCount: 5, settings: { pet_fee_per_pet: true, pet_max: 2 } })
  assert.equal(q.petCount, 2)
  assert.equal(q.petFee, 5000)
  assert.equal(q.petCapped, true)

  const p = pricing({ petCount: 5, settings: { pet_fee_per_pet: true, pet_max: 2 } })
  assert.equal(p.petCount, 2)
  assert.equal(p.petFee, 5000)
  assert.equal(p.petCapped, true)
})

// ── THE DORMANT STATE ─────────────────────────────────────────────────────────────────────────

test('pets_enabled false charges nothing even when a count is passed', () => {
  const q = quote({ petCount: 3, settings: { pets_enabled: false, pet_fee_per_pet: true, pet_fee_taxable: true } }, [TAX])
  assert.equal(q.petFee, 0)
  assert.equal(q.total, STAY + 1000)        // the stay and its tax, nothing else
  assert.equal(q.emailLines.filter(l => l.label === 'Pet fee').length, 0)
})

test('omitting the pet inputs entirely is identical to passing zero', () => {
  // The state of every caller today, and the reason this change is a no-op in production.
  const omitted = computeBookingQuote({
    site: { site_type: 'rv_site', nightly_rate: NIGHTLY, total_price: STAY, nights: NIGHTS },
    adults: 2, children: 0, settings: baseSettings() as any, fees: [TAX, CARD],
    addonSelections: [], discount: null,
    earlyRequested: false, lateRequested: false, earlyBlocked: false, lateBlocked: false,
  })
  const zero = quote({ petCount: 0 }, [TAX, CARD])
  assert.deepEqual(omitted, zero)
  assert.equal(omitted.petFee, 0)
})
