'use client'

// The staff side of the booking horizon, in one place for all three booking pages.
//
// /admin/manual-booking, /admin/new-reservation and /admin/walkin-booking all POST to
// /api/manual-booking, which enforces the park's booking window unless the request carries
// `override_horizon`. This is where that flag comes from, and it exists as a shared module
// specifically so the three pages cannot drift: three copies of "is this date beyond the window"
// is three chances for one of them to compute the boundary a day differently from the route that
// enforces it.
//
// The acknowledgement machinery now lives in OverrideNotice.tsx and is shared with the closed
// season. This file keeps only what is specific to the horizon: what triggers it, what the guest
// would have been told, and the fact that the key is the ARRIVAL alone — the horizon is an
// arrival-only rule, unlike the season, which is whole-stay and keys on both dates.
//
// ── WHY THE STAFF DATE INPUTS DO NOT GET A `max` ─────────────────────────────────────────────
//
// The guest-facing picker on the landing page caps its arrival input at the horizon. These do not,
// and that is deliberate rather than an omission. A `max` would grey out exactly the dates the
// override exists to allow — an operator on the phone could not type "next August" at all, and the
// override would be unreachable through the only UI that offers it. So the staff pages take any
// date and then say, in the open, that it is past the park's window and needs a deliberate tick.
//
// The asymmetry is the design: absolute for guests, advisory-with-a-record for staff.

import { resolveMaxAdvanceDays, horizonLastArrival, type HorizonSettings } from '@/lib/bookability'
import { useDateBoundAcknowledgement, OverrideNotice, type OverrideState } from './OverrideNotice'

export type HorizonOverrideState = OverrideState & {
  /** True when the chosen arrival is past the park's window. Alias of `triggered`. */
  beyond: boolean
  /** The configured window, or null when the park has set none. */
  maxDays: number | null
  /** The last arrival date inside the window, or null when there is no window. */
  lastArrival: string | null
}

// `settings` is typed to just the column this needs rather than the `any` the booking pages pass
// their whole settings row around as — the callers can hand in the whole row regardless, and the
// signature then says what is actually read.
export function useHorizonOverride(
  settings: HorizonSettings | null | undefined,
  arrivalDate: string
): HorizonOverrideState {
  // No slack, matching the guest picker. The route allows one day past this because it has no park
  // timezone, so a date this warns about is always a date the route would also have refused —
  // never the other way round, which would be an operator ticking a box for no reason and then
  // being rejected anyway.
  const maxDays = resolveMaxAdvanceDays(settings?.max_advance_days)
  const today = new Date().toISOString().split('T')[0]
  const lastArrival = maxDays === null ? null : horizonLastArrival(maxDays, today)
  const beyond = !!(lastArrival && arrivalDate && arrivalDate > lastArrival)

  // ARRIVAL ONLY as the key. The horizon is a statement about how far ahead someone may plan, so
  // the departure cannot change the verdict and must not withdraw the acknowledgement.
  const state = useDateBoundAcknowledgement(beyond, arrivalDate)

  return { ...state, beyond, maxDays, lastArrival }
}

export function HorizonOverrideNotice({ state }: { state: HorizonOverrideState }) {
  return (
    <OverrideNotice
      tone="amber"
      title={`This arrival is beyond your ${state.maxDays}-day booking window.`}
      body={`Guests can only book online through ${state.lastArrival}. You can still take this reservation, but confirm it below so it is not booked this far out by accident.`}
      label="Book beyond the booking window"
      state={state}
    />
  )
}
