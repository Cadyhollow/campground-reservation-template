// Single source of truth for plan-based feature gating.
// Plans are tiered: trailhead < ridgeline < summit. Everything fails CLOSED —
// a null / unset / unrecognized plan resolves to the lowest tier (trailhead),
// never the highest.

export type Plan = 'trailhead' | 'ridgeline' | 'summit'

export const PLAN_LEVELS: Record<Plan, number> = {
  trailhead: 1,
  ridgeline: 2,
  summit: 3,
}

// null / undefined / any unrecognized value → lowest tier (fail closed)
export function normalizePlan(raw: unknown): Plan {
  return raw === 'ridgeline' || raw === 'summit' ? raw : 'trailhead'
}

// `current` may be a raw/nullable settings value — it is normalized internally
// so an unknown plan can never satisfy a gate.
export function planAtLeast(current: unknown, required: Plan): boolean {
  return PLAN_LEVELS[normalizePlan(current)] >= PLAN_LEVELS[required]
}
