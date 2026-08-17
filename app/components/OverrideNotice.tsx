'use client'

// The generic half of every staff override: an acknowledgement bound to the dates it was given
// for, and the panel that collects it.
//
// Extracted from HorizonOverride.tsx when the closed-season override arrived, because the piece
// worth sharing is not the wording — it is the acknowledgement's SHAPE, and getting that shape
// wrong is silent.
//
// ── WHY THE STORED VALUE IS A KEY, NOT A BOOLEAN ─────────────────────────────────────────────
//
// The obvious implementation holds true/false and clears it in an effect when the constraint
// stops applying. That leaves the waiver alive for a moment after the dates have changed, and it
// makes the safety property depend on an effect firing — so an operator who overrides one booking
// and then corrects the dates can keep sending an override they believe they took back. It is
// also the anti-pattern the react-hooks lint rule exists to catch.
//
// Storing the KEY the operator agreed to removes the failure mode instead of tidying it up:
// change the dates and the stored key no longer matches the one on screen, so the tick counts for
// nothing. No state to fall out of step, and no effect.
//
// The key differs per constraint, and choosing it is the whole design decision:
//
//   horizon  key = arrival              it is an arrival-only rule
//   season   key = `${arrival}|${departure}`   it is a WHOLE-STAY rule, so extending the
//                                              departure past closing changes the verdict and
//                                              must withdraw the waiver
//
// A season override keyed on arrival alone would let an operator acknowledge a short in-season
// stay and then drag the departure into the closed period with the waiver still attached. That is
// the exact bug this shape exists to prevent, which is why the key is a parameter rather than
// something the hook derives for itself.

import { useState, type ReactNode } from 'react'

export type OverrideState = {
  /** True when the constraint applies to the current dates and an override is required. */
  triggered: boolean
  /** Whether the operator has ticked the box FOR THESE DATES. Send as the override_* flag. */
  override: boolean
  setOverride: (v: boolean) => void
  /**
   * True when the booking may be submitted as far as this constraint is concerned: either it does
   * not apply, or it does and the operator has explicitly accepted that for these exact dates.
   */
  cleared: boolean
}

export function useDateBoundAcknowledgement(triggered: boolean, key: string): OverrideState {
  const [acknowledgedFor, setAcknowledgedFor] = useState<string | null>(null)

  const acknowledged = acknowledgedFor !== null && acknowledgedFor === key
  // `triggered &&` so the flag can never be true when the constraint does not apply, whatever the
  // checkbox has been doing. A request cannot carry a waiver for a booking that did not need one.
  const override = triggered && acknowledged

  return {
    triggered,
    override,
    setOverride: (v: boolean) => setAcknowledgedFor(v ? key : null),
    cleared: !triggered || acknowledged,
  }
}

// Two severities, because these are not the same kind of rule. The booking window is the park's
// own preference about how far ahead it takes reservations — amber. A closed season means the
// park is SHUT: no staff, possibly no water or power, and a guest who turns up has nowhere to go.
// That is a red warning, and it should not look like the other one.
const TONES = {
  amber: {
    box: 'border-amber-300 bg-amber-50',
    title: 'text-amber-900',
    body: 'text-amber-800',
    label: 'text-amber-900',
  },
  red: {
    box: 'border-red-300 bg-red-50',
    title: 'text-red-900',
    body: 'text-red-800',
    label: 'text-red-900',
  },
} as const

export type OverrideTone = keyof typeof TONES

// Renders nothing at all when the constraint does not apply, so it can be dropped into a form
// unconditionally. col-span-full spans a two-column form grid and is harmless elsewhere; the
// bottom margin is carried here so callers need no conditional wrapper, which would otherwise
// leave a gap on every booking the notice does not apply to.
export function OverrideNotice({
  tone,
  title,
  body,
  label,
  state,
}: {
  tone: OverrideTone
  title: string
  body: ReactNode
  label: string
  state: OverrideState
}) {
  if (!state.triggered) return null
  const t = TONES[tone]

  return (
    <div className={`col-span-full rounded-lg border p-3 mb-4 ${t.box}`}>
      <p className={`text-sm font-medium ${t.title}`}>{title}</p>
      <p className={`text-xs mt-0.5 ${t.body}`}>{body}</p>
      <label className="flex items-center gap-2 mt-2 cursor-pointer">
        <input
          type="checkbox"
          checked={state.override}
          onChange={e => state.setOverride(e.target.checked)}
          // `native-checkbox` opts out of the global `input { appearance: none; width: 100% }`
          // rule in globals.css, which otherwise renders this box INVISIBLE and stretches it
          // across the row. See the comment on the class. The horizon override has rendered
          // that way since it merged — caught only when the season override's browser walk
          // finally put a human in front of one.
          className="native-checkbox"
        />
        <span className={`text-sm ${t.label}`}>{label}</span>
      </label>
    </div>
  )
}
