import { NextRequest, NextResponse } from 'next/server'
import { ADMIN_SESSION_COOKIE, verifyAdminSession } from '@/lib/admin-session'

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl
  const session = request.cookies.get(ADMIN_SESSION_COOKIE)

  if (
    pathname.startsWith('/admin') &&
    !pathname.startsWith('/admin/login')
  ) {
    // Was `session.value !== 'authenticated'` — a published constant anyone could send. See
    // lib/admin-session.ts. Async because verification uses Web Crypto, the one HMAC
    // implementation available in both runtimes middleware may run on.
    if (!(await verifyAdminSession(session?.value))) {
      const loginUrl = new URL('/admin/login', request.url)
      return NextResponse.redirect(loginUrl)
    }
  }

  return NextResponse.next()
}

export const config = {
  matcher: ['/admin/:path*'],
}