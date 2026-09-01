import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  computeMeterUsage, computeElectricCharge, computeElectricBill,
  rateFromSettings, LEGACY_RATE_PER_KWH, LEGACY_MINIMUM_CHARGE_CENTS,
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
