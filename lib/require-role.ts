import { NextRequest, NextResponse } from 'next/server'
import { readAdminSession, type AdminSession } from '@/lib/admin-auth'
import { createRequestSupabase } from '@/lib/supabase-server'
import { atLeast, rankOf, type Role } from '@/lib/roles'

// Re-exported so server-side callers have one import for the guard and its vocabulary. The
// browser must import from '@/lib/roles' directly — see the note at the top of that file.
export { atLeast, type Role }

// WHY THIS EXISTS: proxy.ts guards admin PAGES only — its matcher is ['/admin/:path*'], which
// never matches /api/*. So every API route is reachable unauthenticated unless it checks for
// itself. This is that check, in one place instead of twenty copies.
//
// Usage — first statement in the handler, before reading the body or touching Supabase:
//
//   const denied = await requireRole(request, 'manager')
//   if (denied) return denied
//
// The await is not optional. Without it `denied` is a Promise, which is always truthy, and every
// gated route would return the Promise instead of running — a failure loud enough to catch in
// development, but await it and read this note rather than finding out.
//
// Returning the response rather than throwing keeps the guard explicit at each call site: a
// reader can see the route is gated, and at what level, without following a throw.
//
// EVERY ROUTE NAMES THE MINIMUM ROLE IT NEEDS. This replaced a guard that asked only "is someone
// logged in", which is the question that let a Staff member issue a refund. "Is an admin" is no
// longer a question any route in this repo should be asking.
//
// DO NOT apply this to:
//   • Camper-facing routes (/api/payment, /api/availability, /api/cancellation-policy),
//     token-authenticated links (/api/sign/[token], /api/unsubscribe), or /api/webhooks/square,
//     which Square calls with its own signature.
//   lib/api-auth.test.ts asserts both halves — that the gated routes stay gated, AND that those
//   camper-facing routes stay open.

/**
 * The caller's role, or null if they are not a logged-in admin at all.
 *
 * Every answer comes from that person's own profiles row, so there is no way around the ladder.
 * There is no shared credential in this repo that could resolve to a role without an identity
 * behind it — see lib/admin-auth.ts for why that matters.
 */
export async function resolveRole(request: NextRequest): Promise<Role | null> {
  const session = await readAdminSession(request)
  return session ? roleForSession(session, request) : null
}

/**
 * The role for a session that has ALREADY been read.
 *
 * proxy.ts needs this split out: it calls readAdminSession() itself, with a response to write
 * refreshed cookies onto, and would otherwise pay for a second getUser() round trip on every
 * admin page navigation just to learn the role.
 */
export async function roleForSession(
  session: AdminSession,
  request: NextRequest
): Promise<Role | null> {
  // The role lives in public.profiles.
  //
  // Read over the USER'S OWN session, not service-role. The schema's "Users read their own
  // profile" policy scopes SELECT to auth.uid() = id, so this can only ever return the caller's
  // row, and it keeps the service key out of a code path that proxy.ts also runs on every admin
  // navigation. It is not a trust problem: profiles has no INSERT or UPDATE policy for
  // `authenticated` and the grants are revoked, so a user cannot write the column they are being
  // judged by.
  try {
    const supabase = createRequestSupabase(request)
    const { data, error } = await supabase
      .from('profiles')
      .select('role, active')
      .eq('id', session.userId)
      .single()

    // FAIL CLOSED on every ambiguous case: no row (an auth user who was never provisioned),
    // a deactivated account, a role outside the ladder, or an error reaching the database.
    // Public signup should be disabled on a provisioned project, but this is what keeps the
    // model safe if it is ever switched back on — a stranger who signs up gets no role at all.
    if (error || !data || !data.active) return null
    return rankOf(data.role) > 0 ? (data.role as Role) : null
  } catch {
    return null
  }
}

/**
 * Gate a route handler on a minimum role.
 *
 * 401 vs 403 is a deliberate distinction, not decoration:
 *   401 — no admin session at all. lib/api-auth.test.ts asserts exactly this for every gated
 *         route, so an unauthenticated caller must keep getting 401 and not 403.
 *   403 — a real, logged-in admin whose role is too low. This is the acceptance test for the
 *         role model: a Staff user hitting /api/refund gets 403, from the server, with no UI
 *         involved.
 */
export async function requireRole(
  request: NextRequest,
  minimum: Role
): Promise<NextResponse | null> {
  const role = await resolveRole(request)

  if (!role) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  if (!atLeast(role, minimum)) {
    return NextResponse.json(
      { error: 'Forbidden', required: minimum, role },
      { status: 403 }
    )
  }

  return null
}
