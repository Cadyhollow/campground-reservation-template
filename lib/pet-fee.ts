// What a guest is charged for bringing pets — the arithmetic, and nothing else.
//
// ── Why this is its own file ──────────────────────────────────────────────────────────────────
//
// A pet fee is a real charge, so it eventually has to reach the money engine
// (lib/booking-quote.ts for the public path, lib/pricing.ts for the admin wizard). Those three
// files — plus lib/ledger.ts — are the protected fee model: a pull request touching them fails CI
// unless it carries the `allow-fee-model-change` label, deliberately, because they decide what
// every campground on this template charges.
//
// Keeping the pet arithmetic HERE means the money-engine change, when it comes, is a handful of
// lines that call a function which is already written and already proven. The hard part gets
// reviewed on its own, before anything can be charged, rather than buried inside a diff against
// the files nobody wants to touch twice.
//
// THIS FILE IS NOT THE FEE MODEL and must not become it. It computes one number. It does not know
// about tax, the card surcharge, deposits, refunds, or totals, and it must not import
// booking-quote.ts, pricing.ts or ledger.ts — a cycle between "the fee model" and "the thing the
// fee model calls" is how the protection stops meaning anything.
//
// ── The charging model ────────────────────────────────────────────────────────────────────────
//
// One amount plus two toggles, which produce all four modes a campground actually uses:
//
//     per_pet   per_night   result
//     ------------------------------------------------------------------
//     false     false       one flat charge for the whole stay
//     false     true        x nights
//     true      false       x pet count
//     true      true        per pet, per night
//
// ── Dormant by construction ───────────────────────────────────────────────────────────────────
//
// `pets_enabled` false returns zero for every input, and that is the state every tenant is
// provisioned in (db/2026-08-18-pet-fee.sql in resonation-admin). So this can ship, and be wired
// in, long before any park switches it on.
//
// Self-contained — no imports at all, like lib/bookability.ts, lib/booking-quote.ts and
// lib/search-pricing.ts. That is what lets `node --test` exercise it with no bundler, no server
// and no database, which in turn is what gets it into the guardrails CI run on every pull
// request. The route suites skip themselves without a configured tenant, and a skip that looks
// like a pass is how the last pricing defect stayed hidden for months.

/** The pet half of `settings`. Every field optional — an older tenant row may have none of them. */
export type PetFeeSettings = {
  /** Master switch. While false, nothing here charges anything. */
  pets_enabled?: boolean | null
  /** CENTS. Note: NOT the `fees` table's dollars — see the migration for why they differ. */
  pet_fee_amount?: number | null
  pet_fee_per_night?: boolean | null
  pet_fee_per_pet?: boolean | null
  /** Maximum pets per reservation. 0, null or absent all mean NO CAP. */
  pet_max?: number | null
} | null | undefined

export type PetFeeInput = {
  /** What the guest asked for. Untrusted: clamped, floored and guarded below. */
  petCount: number
  /** Nights in the stay. Only used when pet_fee_per_night is on. */
  nights: number
  /** A declared service animal. Legally not a pet — waives the fee entirely. */
  isServiceAnimal?: boolean
  settings: PetFeeSettings
}

export type PetFeeResult = {
  /** INTEGER CENTS. */
  petFee: number
  /** The count actually charged for, after clamping. Store THIS on the reservation. */
  petCount: number
  /**
   * True when the request asked for more pets than `pet_max` allows.
   *
   * The caller decides what that means. Showing a guest a silently reduced number is its own bug,
   * so the booking paths should refuse rather than quietly charge for fewer pets than were
   * declared — but that is a policy decision about a request, not arithmetic, and it does not
   * belong in here.
   */
  capped: boolean
}

const NONE: PetFeeResult = { petFee: 0, petCount: 0, capped: false }

/**
 * A non-negative whole number, or 0 for anything that is not one.
 *
 * Everything reaching this function is untrusted — a JSON body, a URL parameter, or a column on a
 * row written by an older version of this app. `Number(...)` alone is not enough: it turns `true`
 * into 1, `''` into 0 and `[]` into 0, and NaN silently poisons every multiplication downstream
 * into NaN, which would then be written to a money column. So the type is checked first and
 * anything else is refused outright.
 *
 * Fractional input is FLOORED rather than rounded: 2.9 pets is 2 pets. Rounding up would charge
 * for an animal nobody declared.
 *
 * Shared with checkPetBooking below, deliberately: if the cap and the charge normalised counts
 * differently, a request could pass the cap and then be billed for a different number of animals.
 */
function wholeCount(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return 0
  return Math.floor(value)
}

/**
 * The pet fee for one reservation.
 *
 * Pure, synchronous and I/O-free: the caller fetches, this decides. That keeps it runnable from a
 * client component and a route handler alike, and testable without a database.
 */
export function computePetFee(input: PetFeeInput): PetFeeResult {
  const { settings } = input

  // The master switch, first. A park that has not turned pets on is charged nothing and records
  // no pet count, whatever the request says.
  if (!settings?.pets_enabled) return NONE

  // A SERVICE ANIMAL IS NOT A PET. This is a legal distinction, not a discount: the waiver removes
  // the fee AND (elsewhere) the pet-site restriction. Checked before the count so that declaring a
  // service animal never produces a charge, in any of the four modes.
  //
  // petCount comes back 0 deliberately. A service animal is not a pet, so recording it as one
  // would misstate the reservation — `is_service_animal` on the row is where that fact lives.
  if (input.isServiceAnimal) return NONE

  const requested = wholeCount(input.petCount)
  if (requested === 0) return NONE

  // pet_max: 0, null or absent all mean NO CAP. "0 pets allowed" would be the wrong reading — it
  // is the value every tenant is provisioned with, and a park that wants no pets sets
  // pets_enabled false instead. A negative or fractional cap is treated as no cap rather than as
  // a refusal, so a garbage setting cannot silently stop a park taking bookings.
  const cap = wholeCount(settings.pet_max)
  const petCount = cap > 0 ? Math.min(requested, cap) : requested
  const capped = petCount < requested

  const amount = wholeCount(settings.pet_fee_amount)
  if (amount === 0) return { petFee: 0, petCount, capped }

  let petFee = amount
  if (settings.pet_fee_per_pet) petFee *= petCount
  // Nights are guarded the same way. A zero- or negative-night stay is not bookable, and a
  // per-night fee on one is 0 rather than NaN or a negative charge.
  if (settings.pet_fee_per_night) petFee *= wholeCount(input.nights)

  return { petFee, petCount, capped }
}

// ── THE BOOKING POLICY ────────────────────────────────────────────────────────────────────────
//
// computePetFee above answers "what does this cost?". This answers "may this be booked at all?" —
// the cap, the rules affirmation, and the pet-site restriction.
//
// WHY THIS IS HERE AND NOT IN lib/bookability.ts. checkBookability is the natural chokepoint and
// was the first choice, but its settings read names its columns explicitly, and it gates EVERY
// booking on both routes. The pet columns are deliberately absent from live tenants
// (resonation-admin/db/2026-08-18-pet-fee.sql), and PostgREST errors on a column it cannot find —
// so naming a pet column there would stop all bookings on every un-migrated park. The same is
// true of the named `sites` select in /api/payment.
//
// So the DECISION lives here, pure and shared, and each route feeds it from its own tolerant
// reads. One implementation, no drift, and no landmine in the universal chokepoint. The cost is
// that the routes must remember to call it — which is what the route tests are for.

export type PetPolicySettings = PetFeeSettings & {
  pet_rules_require_affirmation?: boolean | null
  service_animal_allowed?: boolean | null
}

export type PetBookingRequest = {
  /** What the guest declared. Untrusted. */
  petCount: number
  isServiceAnimal?: boolean
  petRulesAffirmed?: boolean
  /** The chosen site's pet_friendly flag. `undefined` when the tenant has no such column. */
  sitePetFriendly?: boolean | null
  /** Staff waiver of the pet-site restriction ONLY. Never set by the public path. */
  allowPetSiteOverride?: boolean
}

export type PetBookingRefusal = {
  ok: false
  reason: 'pet-max' | 'pet-rules' | 'pet-site'
  message: string
}

export type PetBookingVerdict =
  | {
      ok: true
      /** Pets to charge for and to STORE. 0 for a service animal — it is not a pet. */
      petCount: number
      /**
       * The service-animal waiver as RESOLVED, which is not the same as what was declared: a park
       * that has switched `service_animal_allowed` off has opted out of waiving, so a declared
       * service animal is treated as an ordinary pet — fee, cap and site restriction all apply.
       *
       * computePetFee deliberately does not know about that setting; it waives whenever it is told
       * the animal is a service animal. Resolving it here keeps the calculator simple and keeps
       * the policy in one place. Pass THIS value to computePetFee, never the raw request field.
       */
      isServiceAnimal: boolean
    }
  | PetBookingRefusal

/**
 * Whether a booking carrying pets may proceed.
 *
 * REFUSES rather than silently adjusting. Clamping a party of five dogs to the park's maximum of
 * two and charging for two would bill a guest for a booking they did not ask for and let them
 * arrive with animals the park never agreed to — so an over-cap request is an error, not a
 * discount. Same for a missing affirmation: quietly zeroing the fee would let a crafted request
 * dodge the charge by omitting a checkbox.
 */
export function checkPetBooking(
  settings: PetPolicySettings,
  request: PetBookingRequest,
): PetBookingVerdict {
  // A park that does not run the feature has no pet policy to enforce and records no pets. This
  // is also the state of every un-migrated tenant, where `pets_enabled` is not merely false but
  // absent — so the whole pet path is dead there.
  if (!settings?.pets_enabled) {
    return { ok: true, petCount: 0, isServiceAnimal: false }
  }

  // The waiver applies only if the park honours it. See the note on the field above.
  const isServiceAnimal = !!request.isServiceAnimal && settings.service_animal_allowed !== false

  // A service animal is not a pet: no fee, no cap, no rules affirmation, and no site restriction.
  // Checked first so none of the gates below can refuse one.
  if (isServiceAnimal) {
    return { ok: true, petCount: 0, isServiceAnimal: true }
  }

  const requested = wholeCount(request.petCount)
  if (requested === 0) {
    return { ok: true, petCount: 0, isServiceAnimal: false }
  }

  // The cap. 0 / null / absent all mean NO limit.
  const cap = wholeCount(settings.pet_max)
  if (cap > 0 && requested > cap) {
    return {
      ok: false,
      reason: 'pet-max',
      message: cap === 1
        ? 'This campground allows 1 pet per site.'
        : `This campground allows up to ${cap} pets per site.`,
    }
  }

  if (settings.pet_rules_require_affirmation && !request.petRulesAffirmed) {
    return {
      ok: false,
      reason: 'pet-rules',
      message: 'Please agree to the pet rules before booking.',
    }
  }

  // The site restriction. `undefined` means the tenant has no pet_friendly column at all, which
  // cannot happen while pets_enabled is true on a properly migrated tenant — but if it somehow
  // does, refusing every site would take the park offline, so an absent column is treated as
  // "unrestricted" rather than "forbidden". A column that is present and false is a real refusal.
  if (request.sitePetFriendly === false && !request.allowPetSiteOverride) {
    return {
      ok: false,
      reason: 'pet-site',
      message: 'That site does not allow pets. Please choose a pet-friendly site.',
    }
  }

  return { ok: true, petCount: requested, isServiceAnimal: false }
}
