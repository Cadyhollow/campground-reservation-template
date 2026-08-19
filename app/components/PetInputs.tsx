'use client'

// The staff side of the pet fee, in one place for all three booking wizards.
//
// /admin/manual-booking, /admin/new-reservation and /admin/walkin-booking all POST to
// /api/manual-booking, which already enforces the park's cap, its rules affirmation and its
// pet-site restriction, recomputes the fee from the database and stores it (step 5). So nothing
// here is a gate — it collects what the operator knows and shows them the consequence.
//
// It exists as a shared module for the same reason HorizonOverride.tsx does: three copies of "is
// this site pet-friendly, and what does this cost" is three chances for one wizard to disagree
// with the other two, and with the server. The fee shown here comes from the SAME computePetFee
// the route calls, so display and charge match by construction rather than by care.
//
// ── INVISIBLE UNLESS IT APPLIES ───────────────────────────────────────────────────────────────
//
// Renders nothing at all unless the park has switched pets on. On a tenant that has not had the
// pet migration applied, `pets_enabled` is not merely false but absent, so this is dead code —
// the same posture the Settings and Sites pages take.

import { computePetFee } from '@/lib/pet-fee'

export type PetSettings = {
  pets_enabled?: boolean | null
  pet_fee_amount?: number | null
  pet_fee_per_night?: boolean | null
  pet_fee_per_pet?: boolean | null
  pet_max?: number | null
  pet_rules_text?: string | null
  pet_rules_require_affirmation?: boolean | null
  service_animal_allowed?: boolean | null
} | null | undefined

export type PetFormState = {
  petCount: number
  isServiceAnimal: boolean
  petRulesAffirmed: boolean
  overridePetSite: boolean
}

export const emptyPetForm: PetFormState = {
  petCount: 0,
  isServiceAnimal: false,
  petRulesAffirmed: false,
  overridePetSite: false,
}

export type PetInputsState = {
  /** False when the park does not run the feature, or the tenant has no pet columns. */
  active: boolean
  settings: PetSettings
  value: PetFormState
  onChange: (next: PetFormState) => void
  /** The fee this booking will carry, in cents. Computed by the same function the server uses. */
  petFee: number
  /** Pets to charge for — 0 for a service animal, which is not a pet. */
  petCount: number
  /** True when this booking needs the site override to be accepted. */
  needsSiteOverride: boolean
  /**
   * Why the operator cannot submit yet, or null. UX only: /api/manual-booking refuses the same
   * cases regardless, so this exists to say so at the control the operator can act on rather
   * than after they press Save.
   */
  blockedReason: string | null
}

export function usePetInputs(
  settings: PetSettings,
  value: PetFormState,
  onChange: (next: PetFormState) => void,
  site: { pet_friendly?: boolean | null } | null | undefined,
  nights: number,
): PetInputsState {
  const active = !!settings?.pets_enabled

  // The waiver applies only if the park honours it — resolved here exactly as checkPetBooking
  // resolves it server-side, so the figure below cannot disagree with the charge.
  const isServiceAnimal = value.isServiceAnimal && settings?.service_animal_allowed !== false

  const { petFee, petCount } = computePetFee({
    petCount: value.petCount,
    nights,
    isServiceAnimal,
    settings: settings ?? undefined,
  })

  // Only meaningful once a site is chosen. A service animal is exempt from the restriction.
  const needsSiteOverride =
    active && petCount > 0 && !isServiceAnimal && site?.pet_friendly === false

  const cap = settings?.pet_max || 0
  let blockedReason: string | null = null
  if (active && !isServiceAnimal && value.petCount > 0) {
    if (cap > 0 && value.petCount > cap) {
      blockedReason = `This park allows up to ${cap} pet${cap === 1 ? '' : 's'} per site.`
    } else if (settings?.pet_rules_require_affirmation && !value.petRulesAffirmed) {
      blockedReason = 'Confirm the guest has agreed to the pet rules.'
    } else if (needsSiteOverride && !value.overridePetSite) {
      blockedReason = 'This site is not marked pet-friendly — confirm the exception below.'
    }
  }

  return { active, settings, value, onChange, petFee, petCount, needsSiteOverride, blockedReason }
}

/** The fields to add to a /api/manual-booking POST body. Empty when the feature is off. */
export function petBookingFields(state: PetInputsState): Record<string, unknown> {
  if (!state.active) return {}
  return {
    pet_count: state.value.petCount,
    is_service_animal: state.value.isServiceAnimal,
    pet_rules_affirmed: state.value.petRulesAffirmed,
    override_pet_site: state.value.overridePetSite,
  }
}

const box: React.CSSProperties = {
  border: '1px solid #e5e7eb', borderRadius: 12, padding: 16, background: '#f9fafb',
}

export function PetInputs({ state }: { state: PetInputsState }) {
  if (!state.active) return null
  const { settings, value, onChange } = state
  const set = (patch: Partial<PetFormState>) => onChange({ ...value, ...patch })
  const cap = settings?.pet_max || 0

  return (
    <div style={box} className="md:col-span-2 lg:col-span-3">
      <p className="text-sm font-semibold text-gray-900 mb-3">Pets</p>

      <div className="flex flex-wrap items-end gap-4">
        <div>
          <label className="block text-xs font-medium text-gray-700 mb-1">Number of pets</label>
          <input type="number" min={0} max={cap > 0 ? cap : 20}
            className="w-28 border border-gray-200 rounded-lg px-3 py-2 text-sm"
            value={value.isServiceAnimal ? 0 : value.petCount}
            disabled={value.isServiceAnimal}
            onChange={e => set({ petCount: Math.max(0, parseInt(e.target.value) || 0) })} />
          {cap > 0 && <p className="text-xs text-gray-400 mt-1">Max {cap} per site</p>}
        </div>

        {settings?.service_animal_allowed !== false && (
          <label className="flex items-center gap-2 cursor-pointer pb-2">
            <input type="checkbox" checked={value.isServiceAnimal}
              onChange={e => set({ isServiceAnimal: e.target.checked, petCount: e.target.checked ? 0 : value.petCount })} />
            <span className="text-sm text-gray-700">Service animal</span>
          </label>
        )}

        {state.petFee > 0 && (
          <div className="pb-2">
            <p className="text-xs text-gray-500">Pet fee</p>
            <p className="text-sm font-semibold text-green-700">${(state.petFee / 100).toFixed(2)}</p>
          </div>
        )}
      </div>

      {value.isServiceAnimal && (
        <p className="text-xs text-gray-500 mt-3">
          A service animal is not a pet: no fee, and any site may be booked.
        </p>
      )}

      {!value.isServiceAnimal && value.petCount > 0 && settings?.pet_rules_text && (
        <div className="mt-3 rounded-lg bg-white border border-gray-200 p-3">
          <p className="text-xs text-gray-600 whitespace-pre-line">{settings.pet_rules_text}</p>
        </div>
      )}

      {!value.isServiceAnimal && value.petCount > 0 && settings?.pet_rules_require_affirmation && (
        <label className="flex items-start gap-2 mt-3 cursor-pointer">
          <input type="checkbox" className="mt-0.5" checked={value.petRulesAffirmed}
            onChange={e => set({ petRulesAffirmed: e.target.checked })} />
          <span className="text-xs text-gray-700">The guest has agreed to the pet rules.</span>
        </label>
      )}

      {/* ── THE SITE OVERRIDE ────────────────────────────────────────────────────────────────
          Appears only when it is actually needed: pets on a site the park has not marked
          pet-friendly. It is an acknowledgement rather than a date-bound one like the horizon
          and season overrides — the fact it waives is about the SITE, so there is no date for it
          to go stale against. Choosing a different site simply makes it disappear.

          It waives the site restriction and nothing else: the cap and the rules affirmation
          still apply, on the server as well as here. */}
      {state.needsSiteOverride && (
        <div className="mt-3 rounded-lg border p-3" style={{ borderColor: '#fcd34d', background: '#fffbeb' }}>
          <p className="text-xs font-semibold" style={{ color: '#92400e' }}>
            This site is not marked pet-friendly.
          </p>
          <p className="text-xs mt-1" style={{ color: '#92400e' }}>
            Guests booking online cannot choose it with a pet. You can still take this booking —
            confirm below so it is not done by accident.
          </p>
          <label className="flex items-start gap-2 mt-2 cursor-pointer">
            <input type="checkbox" className="mt-0.5" checked={value.overridePetSite}
              onChange={e => set({ overridePetSite: e.target.checked })} />
            <span className="text-xs" style={{ color: '#92400e' }}>Allow pets on this site for this booking</span>
          </label>
        </div>
      )}

      {state.blockedReason && (
        <p className="text-xs mt-3 font-medium" style={{ color: '#b91c1c' }}>{state.blockedReason}</p>
      )}
    </div>
  )
}
