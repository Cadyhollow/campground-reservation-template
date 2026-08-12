// Who is making this request — the one answer both guards use.
//
// Security PR 7-1. There is exactly ONE way to hold an admin session in this repo: a real
// Supabase Auth session, one row in auth.users per person, carrying a user id we can attribute
// actions to and a role we can enforce.
//
// NO LEGACY PATH, AND THERE NEVER WAS ONE HERE. The reference implementation (cady-hollow-
// reservations) carried a second kind of session through its PR 5 — an HMAC-signed `admin_session`
// cookie minted from a single shared ADMIN_PASSWORD — because it had a live deployment full of
// people using that password and could not retire it in one step. That cookie carried NO IDENTITY:
// it said only "someone knew the password", so the role resolver had no choice but to treat it as
// Owner. Roles were a boundary for anyone signing in with their own email and merely a convention
// for anyone with the shared one.
//
// This repo is the blueprint new clients are generated from, and no client has ever had a shared
// password. So the transitional path is not ported. Porting it would be shipping a second, weaker
// way in — a bug, not a feature — and would reintroduce the exact hole its removal closed.
// There is no ADMIN_PASSWORD, no `admin_session` cookie, and no /api/admin-auth route.
//
// AND IT IS WHAT MAKES THE LOCKED-DOWN SCHEMA WORK. A password-cookie session never authenticated
// to Supabase, so PostgREST executed its queries as `anon` — and PR 7-2's schema revokes anon
// completely. Every admin request now carries a user JWT and runs as `authenticated`, against the
// policy set that schema installs. Without this file, the admin has no access at all.

import type { NextRequest, NextResponse } from 'next/server'
import { createRequestSupabase } from '@/lib/supabase-server'

export type AdminSession = { userId: string; email: string | null }

/**
 * The authenticated admin behind this request, or null.
 *
 * `response` is only meaningful from proxy.ts: when supplied, a Supabase session that needed
 * refreshing writes its new cookies onto it. Route handlers pass nothing and simply read — they
 * have no response object at guard time, and proxy.ts has already refreshed on the page
 * navigation that got the user here.
 */
export async function readAdminSession(
  request: NextRequest,
  response?: NextResponse
): Promise<AdminSession | null> {
  // getUser() over getSession(): getSession() decodes whatever JWT is in the cookie WITHOUT
  // verifying it, so a hand-written cookie would satisfy it. getUser() validates against the auth
  // server, which also means a signed-out or deleted user stops working immediately rather than
  // when their token expires. That is what makes the account screen's deactivate take effect on
  // the very next request instead of up to an hour later.
  //
  // COST, ACKNOWLEDGED: a network round trip on every authenticated admin request. If it ever
  // becomes a problem the escape hatch is auth.getClaims() — Supabase signs these JWTs with an
  // asymmetric key and publishes a JWKS, so claims can be verified locally with no round trip.
  // The tradeoff is that local verification cannot see a revoked session until the token expires,
  // which is precisely what makes it the wrong default for a security boundary, and more so when
  // deactivating an account is a button in the admin.
  try {
    const supabase = createRequestSupabase(request, response)
    const { data, error } = await supabase.auth.getUser()
    if (error || !data.user) return null
    return { userId: data.user.id, email: data.user.email ?? null }
  } catch {
    // Never let an auth-server hiccup read as "authenticated".
    return null
  }
}
