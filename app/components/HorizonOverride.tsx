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
// ── WHY THE STAFF DATE INPUTS DO NOT GET A `max` ─────────────────────────────────────────────
//
// The guest-facing picker on the landing page caps its arrival input at the horizon. These do not,
// and that is deliberate rather than an omission. A `max` would grey out exactly the dates the
// override exists to allow — an operator on the phone could not type "next August" at all, and the
// override would be unreachable through the only UI that offers it. So the staff pages take any
// date and then say, in the open, that it is past the park's window and needs a deliberate tick.
//
// The asymmetry is the design: absolute for guests, advisory-with-a-record for staff.

import { useState } from 'react'
import { resolveMaxAdvanceDays, horizonLastArrival, type HorizonSettings } from '@/lib/bookability'

export type HorizonOverrideState = {
  /** True when the chosen arrival is past the park's window and an override is required. */
  beyond: boolean
  /** Whether the operator has ticked the box. Send as `override_horizon`. */
  override: boolean
  setOverride: (v: boolean) => void
  /** The configured window, or null when the park has set none. */
  maxDays: number | null
  /** The last arrival date inside the window, or null when there is no window. */
  lastArrival: string | null
  /**
   * True when the booking may be submitted as far as the horizon is concerned: either the date is
   * inside the window, or it is outside and the operator has explicitly accepted that.
   */
  cleared: boolean
}

// `settings` is typed to just the column this needs rather than the `any` the booking pages pass
// their whole settings row around as — the callers can hand in the whole row regardless, and the
// signature then says what is actually read.
export function useHorizonOverride(
  settings: HorizonSettings | null | undefined,
  arrivalDate: string
): HorizonOverrideState {
  // WHAT IS STORED IS THE DATE THE OPERATOR AGREED TO, not a boolean.
  //
  // The obvious version of this holds a `true`/`false` and clears it in an effect when the date
  // comes back inside the window. That leaves the waiver alive for a moment after the date has
  // changed, and it makes the safety property depend on an effect firing — so an operator who
  // overrides one booking and then corrects the date can keep sending override_horizon: true on
  // bookings they never meant to waive. It is also the anti-pattern the react-hooks lint rule
  // exists to catch.
  //
  // Binding the acknowledgement to a specific arrival date removes the failure mode instead of
  // tidying it up: change the date by a single day and the tick is no longer for the date on
  // screen, so it counts for nothing. There is no state to get out of step, and no effect.
  const [acknowledgedFor, setAcknowledgedFor] = useState<string | null>(null)

  // No slack, matching the guest picker. The route allows one day past this because it has no park
  // timezone, so a date this warns about is always a date the route would also have refused —
  // never the other way round, which would be an operator ticking a box for no reason and then
  // being rejected anyway.
  const maxDays = resolveMaxAdvanceDays(settings?.max_advance_days)
  const today = new Date().toISOString().split('T')[0]
  const lastArrival = maxDays === null ? null : horizonLastArrival(maxDays, today)
  const beyond = !!(lastArrival && arrivalDate && arrivalDate > lastArrival)

  const acknowledged = acknowledgedFor !== null && acknowledgedFor === arrivalDate
  // `beyond &&` so the flag can never be true for a date inside the window, whatever the checkbox
  // has been doing. The request cannot carry a waiver for a booking that did not need one.
  const override = beyond && acknowledged

  return {
    beyond,
    override,
    setOverride: (v: boolean) => setAcknowledgedFor(v ? arrivalDate : null),
    maxDays,
    lastArrival,
    cleared: !beyond || acknowledged,
  }
}

// The warning and the tick box. Renders nothing at all when the date is inside the window, so it
// can be dropped into a form unconditionally.
export function HorizonOverrideNotice({ state }: { state: HorizonOverrideState }) {
  if (!state.beyond) return null

  return (
    // col-span-full so it spans a two-column form grid; harmless where the parent is not a grid.
    // Carries its own bottom margin rather than relying on a wrapper, so that callers do not need
    // a conditional div that would otherwise leave a gap whenever this renders nothing.
    <div className="col-span-full rounded-lg border border-amber-300 bg-amber-50 p-3 mb-4">
      <p className="text-sm font-medium text-amber-900">
        This arrival is beyond your {state.maxDays}-day booking window.
      </p>
      <p className="text-xs text-amber-800 mt-0.5">
        Guests can only book online through {state.lastArrival}. You can still take this reservation,
        but confirm it below so it is not booked this far out by accident.
      </p>
      <label className="flex items-center gap-2 mt-2 cursor-pointer">
        <input
          type="checkbox"
          checked={state.override}
          onChange={e => state.setOverride(e.target.checked)}
          className="h-4 w-4"
        />
        <span className="text-sm text-amber-900">Book beyond the booking window</span>
      </label>
    </div>
  )
}
