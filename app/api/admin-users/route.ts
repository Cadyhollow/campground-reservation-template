import { NextRequest, NextResponse } from 'next/server'
import { requireRole } from '@/lib/require-role'
import {
  adminDb,
  findAuthUserByEmail,
  isRole,
  listAdminUsers,
  normalizeEmail,
  passwordProblem,
} from '@/lib/admin-users'

// The admin account list, and the route that creates one.
//
// Security PR 7-1. OWNER-GATED, both verbs — this is the screen that decides who can issue a
// refund, so it sits at the top of the ladder. requireRole is the FIRST statement in each handler,
// before the body is read, because proxy.ts's matcher is ['/admin/:path*'] and never sees
// /api/* — an ungated route here would be open to anyone who could guess the URL. See
// lib/require-role.ts, and lib/api-auth.test.ts, which asserts both of these stay 401 for an
// unauthenticated caller.
//
// GET  /api/admin-users → { users: [...] }
// POST /api/admin-users { email, password, role, full_name? } → { user }

export async function GET(request: NextRequest) {
  const denied = await requireRole(request, 'owner')
  if (denied) return denied

  const { users, error } = await listAdminUsers()
  if (error) return NextResponse.json({ error }, { status: 500 })

  return NextResponse.json({ users })
}

export async function POST(request: NextRequest) {
  const denied = await requireRole(request, 'owner')
  if (denied) return denied

  const body = await request.json().catch(() => ({}))

  const email = normalizeEmail(body?.email)
  if (!email) return NextResponse.json({ error: 'Enter a valid email address.' }, { status: 400 })

  const badPassword = passwordProblem(body?.password)
  if (badPassword) return NextResponse.json({ error: badPassword }, { status: 400 })
  const password: string = body.password

  if (!isRole(body?.role)) {
    return NextResponse.json({ error: 'Choose a role: owner, manager or staff.' }, { status: 400 })
  }
  const role = body.role

  const fullName =
    typeof body?.full_name === 'string' && body.full_name.trim() ? body.full_name.trim() : null

  // An account is TWO rows — an auth.users row (the login) and a profiles row (the role). They are
  // written by two different APIs and cannot be made atomic from here, so the interesting case is
  // the half-finished one: an auth user whose profile write failed. That user can sign in and is
  // then refused everywhere, because roleForSession() fails closed on a missing profile — safe,
  // but baffling to whoever is holding the password.
  //
  // So creating an account that already half-exists REPAIRS it rather than erroring, which is the
  // same shape as scripts/seed-user.mjs's upsert and needs no destructive rollback. A FULLY
  // existing account is a genuine mistake and gets a 409: the Owner meant to add someone, and
  // silently resetting a colleague's password instead would be the worst possible reading of that
  // click. Changing an existing account is what PATCH is for.
  const { user: existingAuth, error: lookupError } = await findAuthUserByEmail(email)
  if (lookupError) {
    return NextResponse.json({ error: `Could not check existing accounts: ${lookupError}` }, { status: 500 })
  }

  let userId: string

  if (existingAuth) {
    const { data: existingProfile } = await adminDb
      .from('profiles')
      .select('id')
      .eq('id', existingAuth.id)
      .maybeSingle()

    if (existingProfile) {
      return NextResponse.json(
        { error: 'An account with that email already exists. Edit it below instead.' },
        { status: 409 }
      )
    }

    // Repair. The password the Owner just typed becomes the real one, so what they hand over
    // works — the alternative is an account whose password only the failed attempt knew.
    userId = existingAuth.id
    const { error: resetError } = await adminDb.auth.admin.updateUserById(userId, { password })
    if (resetError) {
      return NextResponse.json({ error: resetError.message }, { status: 400 })
    }
  } else {
    // email_confirm: true because this project has NO SMTP — there is no confirmation mail to
    // send and no address to verify. The Owner sets the password directly and hands it over, which
    // is the whole delivery mechanism. Without this flag the account would be created unconfirmed
    // and could never sign in.
    const { data, error } = await adminDb.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
    })
    if (error || !data?.user) {
      return NextResponse.json({ error: error?.message ?? 'Could not create the login.' }, { status: 400 })
    }
    userId = data.user.id
  }

  const { data: profile, error: profileError } = await adminDb
    .from('profiles')
    .upsert({ id: userId, email, full_name: fullName, role, active: true }, { onConflict: 'id' })
    .select('id, email, full_name, role, active, created_at')
    .single()

  if (profileError) {
    // The login exists but has no role. Say so precisely rather than "something went wrong":
    // submitting the same form again lands in the repair branch above and finishes the job.
    return NextResponse.json(
      {
        error:
          `The login was created but its role could not be saved (${profileError.message}). ` +
          `Submit the same details again to finish setting the account up.`,
      },
      { status: 500 }
    )
  }

  return NextResponse.json({ user: profile }, { status: 201 })
}
