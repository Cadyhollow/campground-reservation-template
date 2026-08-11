import { NextRequest, NextResponse } from 'next/server'
import {
  ADMIN_SESSION_COOKIE,
  ADMIN_SESSION_TTL_SECONDS,
  mintAdminSession,
} from '@/lib/admin-session'

export async function POST(request: NextRequest) {
  const { password } = await request.json()

  // Both operands must be real strings. Previously this was a bare
  // `password === process.env.ADMIN_PASSWORD`, which on a deployment where ADMIN_PASSWORD was
  // never set compared undefined to undefined — posting `{}` logged the caller in. mintAdminSession
  // fails closed on the same condition; this check is here so the failure is a 401 rather than a 500.
  const expected = process.env.ADMIN_PASSWORD
  const valid =
    typeof expected === 'string' &&
    expected.length > 0 &&
    typeof password === 'string' &&
    password === expected

  if (valid) {
    const session = await mintAdminSession()
    if (!session) {
      return NextResponse.json(
        { error: 'Login is unavailable. ADMIN_PASSWORD is not configured.' },
        { status: 500 }
      )
    }

    const response = NextResponse.json({ success: true })
    response.cookies.set(ADMIN_SESSION_COOKIE, session, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: ADMIN_SESSION_TTL_SECONDS, // 24 hours, matching the signed expiry
      path: '/',
    })
    return response
  }

  return NextResponse.json(
    { error: 'Incorrect password.' },
    { status: 401 }
  )
}

export async function DELETE() {
  const response = NextResponse.json({ success: true })
  response.cookies.delete(ADMIN_SESSION_COOKIE)
  return response
}
