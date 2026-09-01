import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  computeMeterUsage, computeElectricCharge, computeElectricBill,
  rateFromSettings, LEGACY_RATE_PER_KWH, LEGACY_MINIMUM_CHARGE_CENTS,
  planElectricPost, postSkipLabel, allTimeBilled,
  type ElectricRate, type MeterUsage,
} from './electric-billing.ts'

// The electric charge arithmetic, extracted from app/admin/electric-billing/page.tsx.
//
// THE FIRST BLOCK IS THE ONE THAT MATTERS. This calculation decides what a real camper is
// charged, and it was MOVED, not rewritten. So the first test does not assert what the author
// thinks the answer should be — it asserts against a literal transcription of the ORIGINAL inline
// expression, over a spread of inputs including the awkward ones. If the extraction changed a
// single cent anywhere, that test fails and no opinion of mine can talk it out of it.

const RATE: ElectricRate = { ratePerKwh: 0.27, minimumChargeCents: 1500 }

// ── The original expression, transcribed verbatim from updateReading() before the extraction ──
// (Preserved deliberately, including the `|| 0` / `|| 0.27` / `|| 15` fallbacks and the order of
// operations, so this file keeps a copy of what the behaviour USED to be.)
function originalInline(previousReading: string, currentReading: string, ratePerKwh: string, minimumCharge: string) {
  const prev_r = parseFloat(previousReading) || 0
  const curr_r = parseFloat(currentReading) || 0
  const kwh = Math.max(0, curr_r - prev_r)
  const rate = parseFloat(ratePerKwh) || 0.27
  const minCharge = Math.round((parseFloat(minimumCharge) || 15) * 100)
  const calculated = Math.max(minCharge, Math.round(kwh * rate * 100))
  return { kwh, calculated }
}

test('the extracted arithmetic matches the original inline expression, cent for cent', () => {
  const cases: [string, string, string, string][] = [
    ['1000', '1420', '0.27', '15.00'],   // ordinary month
    ['1000', '1000', '0.27', '15.00'],   // no usage at all -> the minimum
    ['1000', '1002', '0.27', '15.00'],   // barely any usage -> still the minimum
    ['1000', '1420', '0.13', '25.00'],   // another park's rate and floor
    ['0', '1', '0.27', '15.00'],
    ['1420', '1000', '0.27', '15.00'],   // a reading LOWER than the previous one
    ['1000.5', '1420.25', '0.27', '15.00'], // fractional meters
    ['1000', '9999999', '0.27', '15.00'],   // a mistyped digit, priced the same way
    ['1000', '1420', '0.275', '15.00'],  // a rate whose product needs rounding
    ['', '', '', ''],                    // every field blank -> the fallbacks
    ['abc', 'def', 'xyz', 'nope'],       // unparseable -> the same fallbacks
  ]
  for (const [prev, curr, rate, min] of cases) {
    const before = originalInline(prev, curr, rate, min)
    const after = computeElectricCharge(
      computeMeterUsage(parseFloat(prev) || 0, parseFloat(curr) || 0),
      { ratePerKwh: parseFloat(rate) || 0.27, minimumChargeCents: Math.round((parseFloat(min) || 15) * 100) }
    )
    assert.equal(after.kwhUsed, before.kwh, `kWh differs for ${prev}->${curr}`)
    assert.equal(after.calculatedAmountCents, before.calculated, `amount differs for ${prev}->${curr} @ ${rate}/${min}`)
  }
})

test('usage is floored at zero — a reading below the previous one is never a credit', () => {
  assert.equal(computeMeterUsage(1420, 1000), 0)
  assert.equal(computeElectricCharge(computeMeterUsage(1420, 1000), RATE).calculatedAmountCents, 1500)
})

test('the minimum charge is a floor, not a fee added on top', () => {
  // 10 kWh at $0.27 = $2.70, which is under the $15 floor.
  assert.equal(computeElectricCharge(10, RATE).calculatedAmountCents, 1500)
  // 100 kWh = $27.00, over the floor, so the floor does not appear in the answer.
  assert.equal(computeElectricCharge(100, RATE).calculatedAmountCents, 2700)
})

test('rounding happens on the cents, not on the dollars', () => {
  // 1 kWh at 0.275 = 27.5 cents. Rounding the cents gives 28; rounding dollars first gives 0.28
  // too, but 3.7 kWh at 0.271 separates them: 100.27 cents -> 100, vs $1.0027 -> $1.00 -> 100.
  // The case that actually separates them is a half-cent, which Math.round takes upward.
  assert.equal(computeElectricCharge(1, { ratePerKwh: 0.275, minimumChargeCents: 0 }).calculatedAmountCents, 28)
})

// ── METER REPLACEMENT ────────────────────────────────────────────────────────────────────────

test('a meter reset measures the NEW meter alone, so usage is not a wild jump', () => {
  // The old meter read 48,210. It is swapped for a new one that starts at 0 and now reads 412.
  // Without the reset flag this is a 47,798 kWh "drop", floored to 0 — real usage lost.
  assert.equal(computeMeterUsage(48210, 412), 0)
  // With it, the answer is the 412 kWh the new meter actually recorded.
  assert.equal(computeMeterUsage(48210, 412, { isReset: true, resetStartValue: 0 }), 412)
})

test('a replacement meter that did not start at zero is measured from where it did', () => {
  // Refurbished units are not always zeroed; the installer notes what it read on the day.
  assert.equal(computeMeterUsage(48210, 900, { isReset: true, resetStartValue: 500 }), 400)
})

test('a reset never produces a negative, even with a start value above the current reading', () => {
  assert.equal(computeMeterUsage(48210, 100, { isReset: true, resetStartValue: 500 }), 0)
})

test('the reset flag is what changes the answer — the same numbers without it are unchanged', () => {
  assert.equal(computeMeterUsage(100, 412, { isReset: false, resetStartValue: 999 }), 312)
})

// ── THE DOUBLE-SITE BILL ─────────────────────────────────────────────────────────────────────

const meter = (n: string, prev: number, curr: number): MeterUsage => ({
  meterId: 'm' + n, meterNumber: n, previousReading: prev, currentReading: curr,
  kwh: computeMeterUsage(prev, curr), isReset: false,
})

test('a camper on two sites is billed for BOTH meters, summed into one total', () => {
  const bill = computeElectricBill([meter('43', 1000, 1300), meter('44', 500, 700)], RATE)
  assert.equal(bill.kwhUsed, 500, '300 on meter 43 + 200 on meter 44')
  assert.equal(bill.calculatedAmountCents, Math.round(500 * 0.27 * 100))
  assert.equal(bill.meters.length, 2, 'both readings stay individually visible')
})

test('the minimum charge is met ONCE per camper, not once per meter', () => {
  // Two meters, 10 kWh each. Per-meter pricing would charge the $15 floor twice = $30.
  const bill = computeElectricBill([meter('43', 0, 10), meter('44', 0, 10)], RATE)
  assert.equal(bill.kwhUsed, 20)
  assert.equal(bill.calculatedAmountCents, 1500, 'one bill, one floor')
})

test('a single-site camper takes the identical path and is unchanged', () => {
  const one = computeElectricBill([meter('12', 1000, 1420)], RATE)
  const direct = computeElectricCharge(420, RATE)
  assert.equal(one.calculatedAmountCents, direct.calculatedAmountCents)
  assert.equal(one.kwhUsed, direct.kwhUsed)
})

test('one dead meter on a double site does not drag the other one negative', () => {
  const bill = computeElectricBill([meter('43', 1000, 1300), meter('44', 900, 100)], RATE)
  assert.equal(bill.kwhUsed, 300, 'the bad meter contributes 0, not -800')
})

// ── THE PARK'S RATE ──────────────────────────────────────────────────────────────────────────

test('a park that has never set a rate sees exactly the old on-screen defaults', () => {
  assert.deepEqual(rateFromSettings(null), {
    ratePerKwh: LEGACY_RATE_PER_KWH, minimumChargeCents: LEGACY_MINIMUM_CHARGE_CENTS,
  })
  assert.deepEqual(rateFromSettings({}), {
    ratePerKwh: LEGACY_RATE_PER_KWH, minimumChargeCents: LEGACY_MINIMUM_CHARGE_CENTS,
  })
  assert.deepEqual(rateFromSettings({ electric_rate_per_kwh: null, electric_minimum_charge: null }), {
    ratePerKwh: LEGACY_RATE_PER_KWH, minimumChargeCents: LEGACY_MINIMUM_CHARGE_CENTS,
  })
})

test("a park's own rate is used when set, and each half falls back independently", () => {
  assert.deepEqual(rateFromSettings({ electric_rate_per_kwh: 0.13, electric_minimum_charge: 2500 }),
    { ratePerKwh: 0.13, minimumChargeCents: 2500 })
  assert.deepEqual(rateFromSettings({ electric_rate_per_kwh: 0.13 }),
    { ratePerKwh: 0.13, minimumChargeCents: LEGACY_MINIMUM_CHARGE_CENTS })
  assert.deepEqual(rateFromSettings({ electric_minimum_charge: 2500 }),
    { ratePerKwh: LEGACY_RATE_PER_KWH, minimumChargeCents: 2500 })
})

test('a rate of ZERO is honoured — a park that bills nothing per kWh is not "unset"', () => {
  // The trap in a `|| fallback`: 0 is falsy, so a park charging a flat minimum only would
  // silently get 0.27 back. It reads the value, not its truthiness.
  assert.equal(rateFromSettings({ electric_rate_per_kwh: 0 }).ratePerKwh, 0)
  assert.equal(rateFromSettings({ electric_minimum_charge: 0 }).minimumChargeCents, 0)
  assert.equal(computeElectricCharge(500, { ratePerKwh: 0, minimumChargeCents: 0 }).calculatedAmountCents, 0)
})

test('numeric columns arriving as strings from PostgREST are parsed, not dropped', () => {
  assert.equal(rateFromSettings({ electric_rate_per_kwh: '0.135' }).ratePerKwh, 0.135)
})


// ── POSTING CONSUMES ITS DRAFT ───────────────────────────────────────────────────────────────
//
// ⚠ FROM A LIVE INCIDENT. A park posted 49 correct September bills and was left with 47 orphaned
// DRAFT rows for the same month — every one of them still postable. No money had moved (a draft
// carries no folio line item), but reopening the month and pressing Send All would have billed
// those campers a second time, some from readings the owner had corrected at posting.
//
// Two causes: the post path copied instead of consuming, and the cleanup that should have removed
// the draft was a DELETE whose result nobody checked, against a table the browser role holds no
// DELETE privilege on. PostgREST returned success having deleted nothing, for an entire run.

test('posting CONSUMES the draft — it names the row to promote, never a copy', () => {
  const plan = planElectricPost({
    alreadyPostedThisMonth: false, draftId: 'draft-abc', finalAmountCents: 1500,
  })
  assert.deepEqual(plan, { action: 'post', consumesDraftId: 'draft-abc' })
})

test('⚠ A SECOND POST OF THE SAME MONTH IS A NO-OP — this is the double-bill guard', () => {
  const plan = planElectricPost({
    alreadyPostedThisMonth: true, draftId: 'orphan-xyz', finalAmountCents: 1500,
  })
  assert.deepEqual(plan, { action: 'skip', reason: 'already-posted' })
  assert.match(postSkipLabel('already-posted'), /already billed/i)
})

test('a leftover orphan cannot bill, however tempting its amount', () => {
  // The exact shape of the incident: a draft still sitting there after the real bill posted.
  for (const cents of [1500, 18387, 156681]) {
    assert.equal(
      planElectricPost({ alreadyPostedThisMonth: true, draftId: 'orphan', finalAmountCents: cents }).action,
      'skip')
  }
})

test('a bill typed in by hand still posts — it just consumes no draft', () => {
  // The pre-existing path: no meter walk, so no draft to promote. An insert, as before.
  assert.deepEqual(
    planElectricPost({ alreadyPostedThisMonth: false, draftId: null, finalAmountCents: 4200 }),
    { action: 'post', consumesDraftId: null })
  assert.deepEqual(
    planElectricPost({ alreadyPostedThisMonth: false, finalAmountCents: 4200 }),
    { action: 'post', consumesDraftId: null })
})

test('Skip and a zero amount are still honoured, and are distinguishable', () => {
  assert.deepEqual(
    planElectricPost({ alreadyPostedThisMonth: false, skipped: true, finalAmountCents: 1500 }),
    { action: 'skip', reason: 'skipped-by-owner' })
  assert.deepEqual(
    planElectricPost({ alreadyPostedThisMonth: false, finalAmountCents: 0 }),
    { action: 'skip', reason: 'no-amount' })
})

test('⚠ "already billed" is reported ahead of "no amount" — the more useful sentence wins', () => {
  // A camper already billed AND showing no amount is the orphan case. Telling somebody "enter
  // meter readings first" there would send them to type a reading for a bill already sent.
  assert.deepEqual(
    planElectricPost({ alreadyPostedThisMonth: true, finalAmountCents: 0 }),
    { action: 'skip', reason: 'already-posted' })
})

test('the owner pressing Skip beats everything, including an unbilled month', () => {
  assert.equal(
    planElectricPost({ alreadyPostedThisMonth: false, skipped: true, draftId: 'd', finalAmountCents: 9999 }).reason,
    'skipped-by-owner')
})

test('every skip reason has a plain-English label', () => {
  for (const r of ['already-posted', 'no-amount', 'skipped-by-owner'] as const) {
    assert.ok(postSkipLabel(r).length > 0, r)
  }
})


// ── The all-time billed total, in the camper's billing history ───────────────────────────────
//
// This row was dropped once by a redesign of the billing page. These tests are here so that it
// cannot happen quietly a second time, and so the void rule stays pinned.

test('the all-time total is what the camper has been billed', () => {
  assert.equal(allTimeBilled([
    { final_amount: 1500 },
    { final_amount: 1728 },
    { final_amount: 1500 },
  ]), 4728)
})

test('⚠ A VOIDED BILL IS NOT MONEY THE CAMPER WAS CHARGED', () => {
  // Voiding takes the charge off their balance. Counting it here would tell the owner a camper
  // owed money they do not, on the one line of that table meant to be the plain truth.
  assert.equal(allTimeBilled([
    { final_amount: 1500 },
    { final_amount: 11998, voided: true },
    { final_amount: 1728 },
  ]), 3228)
})

test('voided:false and a missing flag both count — only an explicit void is excluded', () => {
  assert.equal(allTimeBilled([
    { final_amount: 1000, voided: false },
    { final_amount: 2000 },
    { final_amount: 4000, voided: null },
  ]), 7000)
})

test('a camper with no history totals zero, not NaN', () => {
  assert.equal(allTimeBilled([]), 0)
  assert.equal(allTimeBilled(null), 0)
  assert.equal(allTimeBilled(undefined), 0)
})

test('every bill voided reads as zero rather than as the pre-void figure', () => {
  assert.equal(allTimeBilled([
    { final_amount: 11998, voided: true },
    { final_amount: 3197, voided: true },
  ]), 0)
})
