import { NextRequest, NextResponse } from 'next/server'
import { readAdminSession } from '@/lib/admin-auth'
import { roleForSession } from '@/lib/require-role'

// GET /api/me → { role, email, userId }
//
// Security PR 7-1. The admin layout hides nav items the user cannot use, and it cannot work the
// role out for itself — the role lives in `profiles`, whose RLS policy scopes SELECT to the
// caller's own row, and reading it needs the session that only the server sees at guard time.
//
// `email` names who is signed in on /admin/account and doubles as the identity its
// self-service form re-authenticates with. Every field describes the CALLER's own session only —
// this route never reveals anything about another user.
//
// This is presentation only. Nothing is authorised on the strength of this response: pages are
// enforced by proxy.ts and API routes by their own requireRole() call. Tampering with the
// reply in devtools reveals menu items whose pages then redirect and whose routes then 403.
//
// Returns 401 rather than a null role when there is no session, so it behaves like every other
// gated route and lib/api-auth.test.ts's blanket assertion covers it. A DEACTIVATED user reaches
// here with a valid Supabase session but no role — roleForSession fails closed on `active` — and
// gets that same 401, which is what app/admin/login/LoginForm.tsx uses to catch a deactivated
// account at sign-in rather than bouncing them around the admin.
export async function GET(request: NextRequest) {
  const session = await readAdminSession(request)
  if (!session) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const role = await roleForSession(session, request)
  if (!role) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  return NextResponse.json({
    role,
    email: session.email,
    userId: session.userId,
  })
}
