'use client'

// The staff side of the closed season, for all three booking pages.
//
// Same arrangement as the booking horizon: /admin/manual-booking, /admin/new-reservation and
// /admin/walkin-booking all POST to /api/manual-booking, which refuses an out-of-season stay
// unless the request carries `override_season`. This is where that flag comes from.
//
// ── THE KEY IS BOTH DATES, AND THAT IS THE WHOLE POINT ───────────────────────────────────────
//
// The horizon keys its acknowledgement on the arrival alone, because it is an arrival-only rule.
// The season is a WHOLE-STAY rule, so the departure changes the verdict: a stay that is entirely
// in season becomes an out-of-season stay the moment someone drags the departure past closing.
//
// Keyed on `arrival|departure`, moving either date withdraws the waiver and the operator has to
// look at the warning again. Keyed on the arrival alone — the obvious copy-paste from the horizon
// — an operator could acknowledge a short in-season stay and then extend the departure weeks into
// the closed period with the waiver still silently attached, which is the exact bug the
// date-bound design exists to prevent.
//
// ── WHY RED, AND WHY STAFF GET AN OVERRIDE AT ALL ────────────────────────────────────────────
//
// A closed season is not a preference like the booking window; the park is SHUT. So it is red
// rather than amber, and the public flow has no override whatsoever — a guest is hard-blocked.
//
// Staff keep one because the real workflow exists: a park takes a group booking either side of
// its posted dates, or opens early for an event. What makes it acceptable is that it is explicit,
// bound to these exact dates, and waives the SEASON ONLY — double-booking, and every other rule
// the route enforces, are untouched by it.

import { checkSeasonSpan, type SeasonSettings } from '@/lib/bookability'
import { useDateBoundAcknowledgement, OverrideNotice, type OverrideState } from './OverrideNotice'

export type SeasonOverrideState = OverrideState & {
  /** True when some night of the stay falls outside the open season. Alias of `triggered`. */
  outOfSeason: boolean
  /** The park's own closed-season wording, for the notice. */
  message: string
  seasonStart: string | null
  seasonEnd: string | null
}

export function useSeasonOverride(
  // Typed to just the columns this reads, like the horizon hook. Callers hand in their whole
  // settings row regardless; the signature then states what is actually used.
  settings: SeasonSettings | null | undefined,
  arrivalDate: string,
  departureDate: string
): SeasonOverrideState {
  // Both dates required: a half-entered form has no stay to judge, and warning about it while the
  // operator is still typing would train them to ignore the notice.
  const hasRange = !!arrivalDate && !!departureDate && departureDate > arrivalDate
  const verdict = hasRange
    ? checkSeasonSpan(arrivalDate, departureDate, settings)
    : { bookable: true, reason: 'ok' as const, message: '' }
  const outOfSeason = !verdict.bookable

  const state = useDateBoundAcknowledgement(outOfSeason, `${arrivalDate}|${departureDate}`)

  return {
    ...state,
    outOfSeason,
    message: verdict.message,
    seasonStart: settings?.season_start ?? null,
    seasonEnd: settings?.season_end ?? null,
  }
}

export function SeasonOverrideNotice({ state }: { state: SeasonOverrideState }) {
  const window =
    state.seasonStart && state.seasonEnd
      ? ` The park is open ${state.seasonStart} through ${state.seasonEnd}.`
      : ''

  return (
    <OverrideNotice
      tone="red"
      title="Some nights of this stay fall outside your open season."
      body={`Guests cannot book these dates online at all.${window} You can still take this reservation, but confirm it below — the campground is closed for part of this stay.`}
      label="Book outside the open season"
      state={state}
    />
  )
}
