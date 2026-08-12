// The role ladder — the ONE definition of Owner > Manager > Staff.
//
// Security PR 7-1. This module is deliberately pure: no imports, no Supabase, no next/server. It
// is the half of the role model the BROWSER is allowed to have.
//
// WHY IT IS SPLIT OUT. app/admin/layout.tsx hides nav items the user cannot use, so it needs
// atLeast(). When that lived in lib/require-role.ts the import pulled lib/supabase-server.ts —
// and therefore next/headers — into the client bundle, and the build failed outright:
//
//   Client Component Browser:
//     ./lib/supabase-server.ts → ./lib/require-role.ts → ./app/admin/layout.tsx
//
// That failure was doing its job. Server-only auth code has no business in a browser bundle, and
// the fix is this file rather than a bundler escape hatch: comparing two role strings needs
// nothing privileged, while READING someone's role needs the session and belongs on the server.
//
// The ladder must agree with two other places, and all three are load-bearing:
//   * the CHECK constraint on public.profiles.role (the profiles table, PR 7-2)
//   * app.at_least() in the database in the database, which the RLS policies call
// Adding a tier means changing all three.

export type Role = 'owner' | 'manager' | 'staff'

// An unrecognised value scores 0 and therefore satisfies nothing — the same fail-closed shape as
// app.at_least(), where an unknown role also falls through to no access.
const RANK: Record<string, number> = { owner: 3, manager: 2, staff: 1 }

/**
 * True when `role` meets `minimum`.
 *
 * In the browser this decides whether a nav item is drawn, and that is ALL it decides. Hiding a
 * link authorises nothing: proxy.ts refuses the page and requireRole() refuses the route,
 * whether or not the link was ever rendered.
 */
export function atLeast(role: Role | null | undefined, minimum: Role): boolean {
  return !!role && (RANK[role] ?? 0) >= (RANK[minimum] ?? Infinity)
}

/** Rank lookup for callers that need to compare directly. Unknown roles score 0. */
export function rankOf(role: string | null | undefined): number {
  return role ? (RANK[role] ?? 0) : 0
}

/**
 * The ladder as a person reads it, for the account screens (see app/admin/users).
 *
 * Here rather than in lib/admin-users.ts because that module constructs a service-role client at
 * import — pulling it into a client component would be a build error at best. This file is the
 * browser-safe half of the role model, which is exactly what a dropdown needs.
 *
 * The blurbs describe what each tier actually reaches, per lib/admin-pages.ts and the requireRole
 * call in each route. They are the only place a person is told what they are choosing, so they
 * should be corrected alongside any change to the route→role map.
 */
export const ROLE_OPTIONS: { value: Role; label: string; blurb: string }[] = [
  { value: 'owner', label: 'Owner', blurb: 'everything, including settings, pricing and accounts' },
  { value: 'manager', label: 'Manager', blurb: 'day-to-day plus refunds, reports and billing' },
  { value: 'staff', label: 'Staff', blurb: 'bookings and guests; no refunds or cancellations' },
]
