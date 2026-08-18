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
