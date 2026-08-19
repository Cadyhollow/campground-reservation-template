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
import { computePetFee, checkPetBooking, type PetFeeSettings, type PetPolicySettings } from './pet-fee.ts'

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

// ── THE BOOKING POLICY ────────────────────────────────────────────────────────────────────────
// checkPetBooking decides whether a booking carrying pets may proceed at all. It REFUSES rather
// than adjusting: clamping five dogs to a cap of two would bill a guest for a booking they did not
// ask for and let them arrive with animals the park never agreed to.

const policy = (over: Partial<PetPolicySettings> = {}): PetPolicySettings =>
  ({ pets_enabled: true, pet_fee_amount: 2500, ...over })

test('policy: a park with pets disabled records no pets and refuses nothing', () => {
  // Also the state of every un-migrated tenant, where pets_enabled is absent rather than false.
  for (const s of [{ pets_enabled: false }, {}, null as unknown as PetPolicySettings]) {
    const v = checkPetBooking(s as PetPolicySettings, { petCount: 3, sitePetFriendly: false })
    assert.deepEqual(v, { ok: true, petCount: 0, isServiceAnimal: false })
  }
})

test('policy: a booking with no pets passes everything', () => {
  const v = checkPetBooking(policy({ pet_max: 1, pet_rules_require_affirmation: true }), {
    petCount: 0, sitePetFriendly: false,
  })
  assert.deepEqual(v, { ok: true, petCount: 0, isServiceAnimal: false })
})

// ── THE CAP ───────────────────────────────────────────────────────────────────────────────────

test('policy: over the cap is REFUSED, not silently reduced', () => {
  const v = checkPetBooking(policy({ pet_max: 2 }), { petCount: 5, sitePetFriendly: true })
  assert.equal(v.ok, false)
  if (v.ok) return
  assert.equal(v.reason, 'pet-max')
  assert.match(v.message, /up to 2 pets/)
})

test('policy: exactly at the cap is allowed', () => {
  const v = checkPetBooking(policy({ pet_max: 2 }), { petCount: 2, sitePetFriendly: true })
  assert.equal(v.ok, true)
  if (!v.ok) return
  assert.equal(v.petCount, 2)
})

test('policy: a cap of 1 is worded in the singular', () => {
  const v = checkPetBooking(policy({ pet_max: 1 }), { petCount: 2, sitePetFriendly: true })
  assert.equal(v.ok, false)
  if (v.ok) return
  assert.match(v.message, /allows 1 pet per site/)
})

test('policy: pet_max 0 or absent imposes no cap', () => {
  for (const pet_max of [0, null, undefined]) {
    const v = checkPetBooking(policy({ pet_max } as Partial<PetPolicySettings>), { petCount: 9, sitePetFriendly: true })
    assert.equal(v.ok, true, `pet_max ${String(pet_max)} refused`)
  }
})

// ── THE RULES AFFIRMATION ─────────────────────────────────────────────────────────────────────

test('policy: a required affirmation that is missing is REFUSED', () => {
  const v = checkPetBooking(policy({ pet_rules_require_affirmation: true }), {
    petCount: 1, sitePetFriendly: true,
  })
  assert.equal(v.ok, false)
  if (v.ok) return
  assert.equal(v.reason, 'pet-rules')
})

test('policy: a required affirmation that is given passes', () => {
  const v = checkPetBooking(policy({ pet_rules_require_affirmation: true }), {
    petCount: 1, petRulesAffirmed: true, sitePetFriendly: true,
  })
  assert.equal(v.ok, true)
})

test('policy: no affirmation is demanded when the park does not require one', () => {
  const v = checkPetBooking(policy(), { petCount: 1, sitePetFriendly: true })
  assert.equal(v.ok, true)
})

// ── THE SITE RESTRICTION ──────────────────────────────────────────────────────────────────────

test('policy: pets on a non-pet-friendly site are REFUSED', () => {
  const v = checkPetBooking(policy(), { petCount: 1, sitePetFriendly: false })
  assert.equal(v.ok, false)
  if (v.ok) return
  assert.equal(v.reason, 'pet-site')
})

test('policy: a staff override waives the site restriction', () => {
  const v = checkPetBooking(policy(), { petCount: 1, sitePetFriendly: false, allowPetSiteOverride: true })
  assert.equal(v.ok, true)
})

test('policy: the override waives ONLY the site restriction', () => {
  // It must not become a skeleton key. The cap and the affirmation are the park's rules about the
  // booking itself, not about which site it lands on.
  const overCap = checkPetBooking(policy({ pet_max: 1 }), {
    petCount: 4, sitePetFriendly: false, allowPetSiteOverride: true,
  })
  assert.equal(overCap.ok, false)
  if (!overCap.ok) assert.equal(overCap.reason, 'pet-max')

  const noAffirm = checkPetBooking(policy({ pet_rules_require_affirmation: true }), {
    petCount: 1, sitePetFriendly: false, allowPetSiteOverride: true,
  })
  assert.equal(noAffirm.ok, false)
  if (!noAffirm.ok) assert.equal(noAffirm.reason, 'pet-rules')
})

test('policy: a missing pet_friendly column is treated as unrestricted, not forbidden', () => {
  // undefined means the tenant has no such column. Refusing every site would take a park offline;
  // a column that IS present and false is a real refusal, asserted above.
  const v = checkPetBooking(policy(), { petCount: 1, sitePetFriendly: undefined })
  assert.equal(v.ok, true)
})

// ── THE SERVICE-ANIMAL WAIVER ─────────────────────────────────────────────────────────────────

test('policy: a service animal bypasses the cap, the affirmation and the site restriction', () => {
  const v = checkPetBooking(policy({ pet_max: 1, pet_rules_require_affirmation: true }), {
    petCount: 3, isServiceAnimal: true, sitePetFriendly: false,
  })
  assert.deepEqual(v, { ok: true, petCount: 0, isServiceAnimal: true })
})

test('policy: a park that has opted out of honouring service animals treats one as a pet', () => {
  // service_animal_allowed false means "do not waive". The animal is then subject to the fee, the
  // cap and the site restriction like any other pet — which is what the Settings copy promises.
  const v = checkPetBooking(policy({ service_animal_allowed: false }), {
    petCount: 1, isServiceAnimal: true, sitePetFriendly: false,
  })
  assert.equal(v.ok, false)
  if (v.ok) return
  assert.equal(v.reason, 'pet-site')
})

test('policy: the RESOLVED service-animal flag is what feeds the fee', () => {
  // The value returned here is what must be passed to computePetFee — never the raw request
  // field, or a park that opted out would still hand out free stays.
  const optedOut = checkPetBooking(policy({ service_animal_allowed: false }), {
    petCount: 1, isServiceAnimal: true, sitePetFriendly: true,
  })
  assert.equal(optedOut.ok, true)
  if (!optedOut.ok) return
  assert.equal(optedOut.isServiceAnimal, false)
  assert.equal(optedOut.petCount, 1)
  // And the fee follows from it.
  assert.equal(computePetFee({ petCount: optedOut.petCount, nights: 2, isServiceAnimal: optedOut.isServiceAnimal, settings: policy({ service_animal_allowed: false }) }).petFee, 2500)
})

// ── UNTRUSTED INPUT ───────────────────────────────────────────────────────────────────────────

test('policy: junk pet counts are treated as no pets, never as a refusal', () => {
  for (const bad of [NaN, -3, Infinity, '2', true, null, undefined, {}, []]) {
    const v = checkPetBooking(policy({ pet_max: 1 }), {
      petCount: bad as unknown as number, sitePetFriendly: false,
    })
    assert.equal(v.ok, true, `petCount ${String(bad)} was refused`)
    if (v.ok) assert.equal(v.petCount, 0)
  }
})

test('policy: a fractional count is floored before the cap is applied', () => {
  // 2.9 floors to 2, which is within a cap of 2 — the cap must not see 2.9 and refuse.
  const v = checkPetBooking(policy({ pet_max: 2 }), { petCount: 2.9, sitePetFriendly: true })
  assert.equal(v.ok, true)
  if (v.ok) assert.equal(v.petCount, 2)
})
