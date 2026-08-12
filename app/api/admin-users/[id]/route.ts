import { NextRequest, NextResponse } from 'next/server'
import { requireRole } from '@/lib/require-role'
import { readAdminSession } from '@/lib/admin-auth'
import {
  adminDb,
  getAdminUser,
  isRole,
  lockoutProblem,
  passwordProblem,
  type AdminUser,
} from '@/lib/admin-users'

// PATCH /api/admin-users/[id] — change one account.
//
// Security PR 7-1. Owner-gated. One route for all four operations, because they share the guard
// and the guard is the hard part: role change, password reset, deactivate and reactivate can each
// strand the park, and splitting them across four handlers would mean four copies of the same
// check with four chances to forget one.
//
//   { role: 'manager' }        change a user's role
//   { active: false }          deactivate (soft — the profiles row and its history stay)
//   { active: true }           reactivate
//   { password: '...' }        Owner-driven reset; the new password is handed over in person
//   { full_name: 'Jo Smith' }  cosmetic
//
// THERE IS NO DELETE, on purpose. Bookings, folio lines and audit trails point at these accounts;
// removing the row would leave history attributed to nobody. Deactivation is the reversible
// version and readAdminSession/roleForSession already treat it as a full stop — app.user_role()
// filters on `active`, so the RLS policies deny a deactivated user at the database too, not just
// in the app.
//
// WHY NO EMAIL-BASED RESET: this project has no SMTP configured, so there is nothing to send a
// reset link with. Passwords are therefore Owner-driven from this route, or self-service from
// /admin/account. scripts/seed-user.mjs stays as the break-glass for the case this route cannot
// cover — an Owner who cannot log in to reach it.

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const denied = await requireRole(request, 'owner')
  if (denied) return denied

  const { id } = await params

  // WHO is asking, for the self-lockout guard. Every session in this repo is a real account with
  // a user id behind it, so "you cannot deactivate yourself" always has a self to compare
  // against. The last-active-Owner rule does not depend on identity and applies to every caller.
  const session = await readAdminSession(request)
  const callerId = session?.userId ?? null

  const target: AdminUser | null = await getAdminUser(id)
  if (!target) return NextResponse.json({ error: 'No such account.' }, { status: 404 })

  const body = await request.json().catch(() => ({}))

  // ---- validate every field BEFORE writing any of them -------------------------------------
  let nextRole: AdminUser['role'] | undefined
  if (body?.role !== undefined) {
    if (!isRole(body.role)) {
      return NextResponse.json({ error: 'Choose a role: owner, manager or staff.' }, { status: 400 })
    }
    nextRole = body.role
  }

  let nextActive: boolean | undefined
  if (body?.active !== undefined) {
    if (typeof body.active !== 'boolean') {
      return NextResponse.json({ error: 'active must be true or false.' }, { status: 400 })
    }
    nextActive = body.active
  }

  let nextPassword: string | undefined
  if (body?.password !== undefined) {
    const bad = passwordProblem(body.password)
    if (bad) return NextResponse.json({ error: bad }, { status: 400 })
    nextPassword = body.password
  }

  let nextFullName: string | null | undefined
  if (body?.full_name !== undefined) {
    if (typeof body.full_name !== 'string') {
      return NextResponse.json({ error: 'full_name must be text.' }, { status: 400 })
    }
    nextFullName = body.full_name.trim() || null
  }

  if (
    nextRole === undefined &&
    nextActive === undefined &&
    nextPassword === undefined &&
    nextFullName === undefined
  ) {
    return NextResponse.json({ error: 'Nothing to change.' }, { status: 400 })
  }

  // ---- the lockout guard, before anything is written ----------------------------------------
  const problem = await lockoutProblem({ target, callerId, nextRole, nextActive })
  if (problem) {
    // 409 rather than 403: the caller has every right to make this request, and the request is
    // well formed. It conflicts with the state of the world — there is only one owner — and that
    // is what a 409 says. A 403 would read as "you are not allowed", which would send an Owner
    // hunting for a permission they already have.
    return NextResponse.json({ error: problem }, { status: 409 })
  }

  // ---- apply -------------------------------------------------------------------------------
  // The password goes first. It is the change that cannot be inferred from the row afterwards, so
  // if the two writes are ever going to disagree, better that the visible half (the profile) is
  // the one still showing the old value than that the Owner is told a password was set when it
  // was not.
  if (nextPassword !== undefined) {
    const { error } = await adminDb.auth.admin.updateUserById(id, { password: nextPassword })
    if (error) return NextResponse.json({ error: error.message }, { status: 400 })
  }

  const patch: Record<string, unknown> = {}
  if (nextRole !== undefined) patch.role = nextRole
  if (nextActive !== undefined) patch.active = nextActive
  if (nextFullName !== undefined) patch.full_name = nextFullName

  if (Object.keys(patch).length === 0) {
    return NextResponse.json({ user: target, passwordChanged: true })
  }

  const { data, error } = await adminDb
    .from('profiles')
    .update(patch)
    .eq('id', id)
    .select('id, email, full_name, role, active, created_at')
    .single()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  return NextResponse.json({ user: data, passwordChanged: nextPassword !== undefined })
}
