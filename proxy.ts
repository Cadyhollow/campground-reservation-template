import { NextRequest, NextResponse } from 'next/server'
import { readAdminSession } from '@/lib/admin-auth'
import { roleForSession } from '@/lib/require-role'
import { atLeast } from '@/lib/roles'
import { roleForPath } from '@/lib/admin-pages'

// This was middleware.ts. Next 16 deprecated the `middleware` file convention and renamed it to
// `proxy` (node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/proxy.md); the
// functionality is identical and the codemod is a rename. Renamed here rather than left behind
// because this file was being rewritten for role enforcement anyway, and this repo is the
// blueprint every new client is generated from — shipping a fresh deprecated convention into
// every future client is a debt with no upside. It also gains the Node.js runtime by default,
// which middleware only had opt-in.
//
// WHAT THIS IS, AND WHAT IT IS NOT. Next's own guidance is that proxy should not be a full
// authorization solution — it is an optimistic check, and the real boundary belongs as close to
// the data as possible. That is exactly how this app is arranged, and it is worth being able to
// point at:
//
//   proxy.ts (here)      — redirects a user away from a page they cannot use. UX and a first cut.
//   requireRole()        — the boundary for every /api/* route. Returns 401/403 from the server.
//   RLS policies         — the boundary for the raw PostgREST reads and writes the admin pages
//                          make from the browser. Enforced by the database itself.
//
// So a user who defeats this file gains a rendered page shell whose every data call still fails.
// That is the intended failure mode, and it is why the matcher below covering only /admin is
// sufficient: /api/* is not protected here and was never meant to be.

export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl

  if (
    pathname.startsWith('/admin') &&
    !pathname.startsWith('/admin/login')
  ) {
    // The response is created BEFORE the check so a Supabase session that needs refreshing has
    // somewhere to write its new cookies. Handing it to readAdminSession is what keeps a logged-in
    // user logged in past their access token's hour.
    const response = NextResponse.next({ request })

    const session = await readAdminSession(request, response)
    if (!session) {
      return NextResponse.redirect(new URL('/admin/login', request.url))
    }

    // Authentication is not the whole story. Every admin page has a minimum role
    // (lib/admin-pages.ts) and this is where it is checked before the page renders, whether the
    // user clicked a link or typed the URL. Hiding the nav item in app/admin/layout.tsx is a
    // courtesy on top of this, never a substitute for it.
    const required = roleForPath(pathname)
    const role = await roleForSession(session, request)

    // NO ROLE AT ALL is a different failure from "your role is too low", and sending it down the
    // same path is a redirect loop.
    //
    // roleForSession() returns null for an authenticated user who has no usable role: a Supabase
    // user with no profiles row, or one whose account has been DEACTIVATED. The branch below
    // redirects to /admin — but /admin is itself gated, at 'staff', and atLeast(null, 'staff') is
    // false, so that redirect arrives here and redirects again, forever. The browser gives up with
    // ERR_TOO_MANY_REDIRECTS and the user cannot even reach the login page to sign out.
    //
    // They are authenticated but not provisioned, so there is nowhere inside the admin to send
    // them. The login page is the one page under /admin this matcher deliberately skips, which
    // makes it the only safe destination, and `inactive` tells it to explain rather than silently
    // present an empty form. LoginForm also re-checks after a successful sign-in, so a deactivated
    // user is stopped at the door instead of being bounced back here.
    if (!role) {
      const inactive = new URL('/admin/login', request.url)
      inactive.searchParams.set('inactive', '1')
      return NextResponse.redirect(inactive)
    }

    if (!atLeast(role, required)) {
      // Redirect rather than a bare 403 body. The page never renders either way — this is the
      // same server-side refusal — but a 403 leaves a browser user on a dead end with no way
      // back, while /admin can tell them what happened and is Staff-level, so it is reachable by
      // anyone who got this far. The API routes are where a machine-readable 403 belongs, and
      // requireRole returns one there.
      //
      // Reaching here means the user HAS a role and it is simply too low, because the null case
      // was handled above — /admin is a real destination for them.
      const denied = new URL('/admin', request.url)
      denied.searchParams.set('denied', pathname)
      return NextResponse.redirect(denied)
    }

    return response
  }

  return NextResponse.next()
}

export const config = {
  matcher: ['/admin/:path*'],
}
