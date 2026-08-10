import { NextRequest, NextResponse } from 'next/server'

// WHY THIS EXISTS: middleware.ts guards admin PAGES only — its matcher is ['/admin/:path*'],
// which never matches /api/*. So every API route is reachable unauthenticated unless it checks
// for itself. Before this helper only /api/guests/balances did, leaving ~20 service-role-backed
// routes (refunds, terminal charges, manual bookings, guest PII, outbound email) open to anyone
// who could guess the URL.
//
// This is that route's check, lifted verbatim so there is one definition instead of twenty
// copies: the same 'admin_session' cookie the login sets in /api/admin-auth, covering owner AND
// staff (owner/staff is a view toggle in the UI, not a separate credential).
//
// Usage — first statement in the handler, before reading the body or touching Supabase:
//
//   const denied = requireAdmin(request)
//   if (denied) return denied
//
// Returning the response rather than throwing keeps the guard explicit at each call site: a
// reader can see the route is gated without following a throw.
//
// SCOPE: this is a session check, not a redesign of admin identity. Admin still authenticates
// with a shared password cookie and still talks to Supabase with the publishable key; moving
// admin onto real per-user Supabase logins is a later PR. What this closes is the gap where no
// session was required at all.
//
// DO NOT apply this to:
//   • /api/admin-auth — it is the login endpoint; gating it makes logging in impossible.
//   • Camper-facing routes (/api/payment, /api/availability, /api/cancellation-policy),
//     token-authenticated links (/api/sign/[token], /api/packet/[packetId], /api/unsubscribe),
//     or /api/webhooks/square, which Square calls with its own signature.
export function requireAdmin(request: NextRequest): NextResponse | null {
  const session = request.cookies.get('admin_session')
  if (!session || session.value !== 'authenticated') {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  return null
}
