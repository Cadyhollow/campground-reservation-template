// The pet-fee arithmetic.
//
// This is the money half of the pet feature, written and proven BEFORE anything can charge for
// it. When the fee eventually reaches lib/booking-quote.ts and lib/pricing.ts — the protected fee
// model, behind the `allow-fee-model-change` label — that change should be a handful of lines
// calling a function these tests already pin.
//
// Pure: no server, no database, no network. So it runs in the guardrails CI job on every pull
// request, unlike the route suites, which skip themselves without a configured tenant.
//
// Nothing here charges anyone yet. Every tenant is provisioned with pets_enabled false, and no
// application code calls computePetFee at all — see db/2026-08-18-pet-fee.sql in resonation-admin.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { computePetFee, type PetFeeSettings } from './pet-fee.ts'

// $25, and the four modes selected by the two toggles.
const FLAT: PetFeeSettings = { pets_enabled: true, pet_fee_amount: 2500 }
const PER_NIGHT: PetFeeSettings = { pets_enabled: true, pet_fee_amount: 2500, pet_fee_per_night: true }
const PER_PET: PetFeeSettings = { pets_enabled: true, pet_fee_amount: 2500, pet_fee_per_pet: true }
const PER_PET_NIGHT: PetFeeSettings = {
  pets_enabled: true, pet_fee_amount: 2500, pet_fee_per_pet: true, pet_fee_per_night: true,
}
const ALL_MODES = [
  ['flat/stay', FLAT],
  ['per night', PER_NIGHT],
  ['per pet', PER_PET],
  ['per pet per night', PER_PET_NIGHT],
] as const

const fee = (settings: PetFeeSettings, petCount: number, nights: number, isServiceAnimal = false) =>
  computePetFee({ petCount, nights, isServiceAnimal, settings })

// ── THE FOUR CHARGING MODES ───────────────────────────────────────────────────────────────────
// 2 pets, 3 nights, $25 throughout, so each mode produces a distinguishable number.

test('flat: one charge for the stay, regardless of pets or nights', () => {
  assert.equal(fee(FLAT, 2, 3).petFee, 2500)
  assert.equal(fee(FLAT, 1, 1).petFee, 2500)
  assert.equal(fee(FLAT, 5, 9).petFee, 2500)
})

test('per night: multiplied by nights, not by pets', () => {
  assert.equal(fee(PER_NIGHT, 2, 3).petFee, 7500)
  assert.equal(fee(PER_NIGHT, 5, 3).petFee, 7500)
})

test('per pet: multiplied by pets, not by nights', () => {
  assert.equal(fee(PER_PET, 2, 3).petFee, 5000)
  assert.equal(fee(PER_PET, 2, 9).petFee, 5000)
})

test('per pet per night: multiplied by both', () => {
  assert.equal(fee(PER_PET_NIGHT, 2, 3).petFee, 15000)
})

test('the four modes are genuinely distinct', () => {
  // Guards against a toggle being read as the other one — the kind of swap that produces a
  // plausible number and is invisible in a single-mode test.
  const totals = ALL_MODES.map(([, s]) => fee(s, 2, 3).petFee)
  assert.deepEqual(totals, [2500, 7500, 5000, 15000])
  assert.equal(new Set(totals).size, 4)
})

test('one pet, one night is the same in every mode', () => {
  for (const [name, settings] of ALL_MODES) {
    assert.equal(fee(settings, 1, 1).petFee, 2500, `mode ${name}`)
  }
})

// ── THE MASTER SWITCH ─────────────────────────────────────────────────────────────────────────

test('pets_enabled false charges nothing, in every mode and whatever is asked for', () => {
  for (const [name, on] of ALL_MODES) {
    const off = { ...on, pets_enabled: false }
    assert.deepEqual(
      fee(off, 9, 9),
      { petFee: 0, petCount: 0, capped: false },
      `mode ${name} charged with pets disabled`,
    )
  }
})

test('missing, null or undefined settings charge nothing', () => {
  for (const s of [null, undefined, {} as PetFeeSettings]) {
    assert.deepEqual(fee(s, 3, 3), { petFee: 0, petCount: 0, capped: false })
  }
})

test('pets enabled but no amount configured charges nothing, and still counts the pets', () => {
  // The park has switched pets on but not priced them: the pets are real and recorded, the
  // charge is zero. Reporting petCount 0 here would lose the fact that a dog is coming.
  const r = fee({ pets_enabled: true, pet_fee_amount: 0, pet_fee_per_pet: true }, 2, 3)
  assert.equal(r.petFee, 0)
  assert.equal(r.petCount, 2)
})

// ── THE SERVICE-ANIMAL WAIVER ─────────────────────────────────────────────────────────────────

test('a service animal is free in every mode', () => {
  for (const [name, settings] of ALL_MODES) {
    assert.equal(fee(settings, 1, 3, true).petFee, 0, `mode ${name} charged for a service animal`)
  }
})

test('a service animal is not recorded as a pet', () => {
  // A service animal is legally not a pet, so petCount must be 0 — `is_service_animal` on the
  // reservation is where that fact belongs. Charging 0 but recording 1 pet would misstate it.
  assert.deepEqual(fee(PER_PET_NIGHT, 1, 3, true), { petFee: 0, petCount: 0, capped: false })
})

test('a service animal is free even alongside a declared pet count', () => {
  assert.equal(fee(PER_PET_NIGHT, 3, 3, true).petFee, 0)
})

test('a service animal is never reported as capped', () => {
  // Nothing was reduced — the waiver applied. `capped` must not invite a caller to refuse it.
  assert.equal(fee({ ...PER_PET, pet_max: 1 }, 5, 2, true).capped, false)
})

// ── THE CAP ───────────────────────────────────────────────────────────────────────────────────

test('pet_max clamps the count that is charged for', () => {
  const r = fee({ ...PER_PET, pet_max: 3 }, 5, 2)
  assert.equal(r.petCount, 3)
  assert.equal(r.petFee, 7500)     // 3 x $25, not 5
  assert.equal(r.capped, true)
})

test('at the cap is not capped', () => {
  // The boundary. Asking for exactly the maximum is a normal booking, not a reduced one.
  const r = fee({ ...PER_PET, pet_max: 3 }, 3, 2)
  assert.equal(r.petCount, 3)
  assert.equal(r.capped, false)
})

test('under the cap is untouched', () => {
  const r = fee({ ...PER_PET, pet_max: 3 }, 2, 2)
  assert.equal(r.petCount, 2)
  assert.equal(r.capped, false)
})

test('pet_max 0 means NO CAP, not zero pets allowed', () => {
  // 0 is the value every tenant is provisioned with. Reading it as "no pets" would refuse
  // bookings at every park that switched pets on without setting a limit.
  const r = fee({ ...PER_PET, pet_max: 0 }, 7, 2)
  assert.equal(r.petCount, 7)
  assert.equal(r.petFee, 17500)
  assert.equal(r.capped, false)
})

test('an absent or null pet_max means no cap', () => {
  assert.equal(fee(PER_PET, 7, 2).petCount, 7)
  assert.equal(fee({ ...PER_PET, pet_max: null }, 7, 2).petCount, 7)
})

test('a nonsense pet_max means no cap rather than a refusal', () => {
  // A garbage setting must not silently stop a park taking bookings.
  for (const bad of [-3, NaN, 1.5 as number]) {
    const r = fee({ ...PER_PET, pet_max: bad }, 4, 2)
    if (bad === 1.5) {
      // 1.5 floors to 1 — a real, if odd, cap. Asserted explicitly rather than lumped in.
      assert.equal(r.petCount, 1)
    } else {
      assert.equal(r.petCount, 4, `pet_max ${bad} was treated as a cap`)
    }
  }
})

// ── UNTRUSTED INPUT ───────────────────────────────────────────────────────────────────────────
// Everything here arrives from a JSON body, a URL parameter, or a row written by an older
// version of this app. None of it may produce NaN, a negative charge, or a fractional cent.

test('zero, negative and fractional pet counts are safe', () => {
  assert.deepEqual(fee(PER_PET_NIGHT, 0, 3), { petFee: 0, petCount: 0, capped: false })
  assert.deepEqual(fee(PER_PET_NIGHT, -2, 3), { petFee: 0, petCount: 0, capped: false })
  // Floored, not rounded: 2.9 pets is 2 pets. Rounding up would charge for an undeclared animal.
  assert.equal(fee(PER_PET, 2.9, 3).petCount, 2)
  assert.equal(fee(PER_PET, 2.9, 3).petFee, 5000)
})

test('non-numeric pet counts charge nothing instead of producing NaN', () => {
  // `Number(...)` alone would turn true into 1 and '' into 0; NaN would poison the multiplication
  // and be written to a money column.
  for (const bad of [NaN, Infinity, -Infinity, '3', true, false, null, undefined, {}, [], '']) {
    const r = computePetFee({
      petCount: bad as unknown as number, nights: 3, settings: PER_PET_NIGHT,
    })
    assert.deepEqual(r, { petFee: 0, petCount: 0, capped: false }, `petCount ${String(bad)}`)
  }
})

test('bad nights values cannot produce a negative or NaN charge', () => {
  for (const bad of [0, -5, NaN, Infinity, '2', true, null, undefined]) {
    const r = computePetFee({
      petCount: 2, nights: bad as unknown as number, settings: PER_PET_NIGHT,
    })
    assert.equal(r.petFee, 0, `nights ${String(bad)}`)
    assert.ok(Number.isFinite(r.petFee))
  }
})

test('a bad pet_fee_amount charges nothing rather than NaN', () => {
  for (const bad of [NaN, -2500, Infinity, '2500', null, undefined]) {
    const r = fee({ ...PER_PET, pet_fee_amount: bad as unknown as number }, 2, 3)
    assert.equal(r.petFee, 0, `amount ${String(bad)}`)
  }
})

test('a fractional configured amount is floored to whole cents', () => {
  // Money is integer cents everywhere in this schema; a fraction here would propagate into the
  // reservation total.
  const r = fee({ ...PER_PET, pet_fee_amount: 2500.7 }, 2, 3)
  assert.equal(r.petFee, 5000)
  assert.ok(Number.isInteger(r.petFee))
})

test('every result is a non-negative whole number of cents', () => {
  const counts = [0, 1, 2, 7, -1, 2.5, NaN]
  const nightsList = [0, 1, 3, 30, -2, NaN]
  for (const [, settings] of ALL_MODES) {
    for (const c of counts) for (const n of nightsList) {
      const r = computePetFee({ petCount: c, nights: n, settings })
      assert.ok(Number.isInteger(r.petFee), `petFee ${r.petFee} for ${c} pets / ${n} nights`)
      assert.ok(r.petFee >= 0, `negative petFee ${r.petFee}`)
      assert.ok(Number.isInteger(r.petCount) && r.petCount >= 0)
    }
  }
})

// ── PURITY ────────────────────────────────────────────────────────────────────────────────────

test('the same input always gives the same answer, and the input is not mutated', () => {
  const settings = { ...PER_PET_NIGHT, pet_max: 3 }
  const frozen = Object.freeze({ ...settings })
  const a = computePetFee({ petCount: 5, nights: 3, settings: frozen })
  const b = computePetFee({ petCount: 5, nights: 3, settings: frozen })
  assert.deepEqual(a, b)
  assert.deepEqual(frozen, settings)
})
