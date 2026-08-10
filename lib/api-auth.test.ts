// Integration tests for the admin-session gate on /api/*, exercised through the REAL routes,
// served by a real Next server:
//
//   node --test --test-timeout=180000 lib/api-auth.test.ts
//
// WHY THIS FILE EXISTS: middleware.ts guards admin PAGES only (matcher '/admin/:path*'), so the
// API routes are unauthenticated unless each one checks for itself. A security audit found ~20
// service-role-backed routes open to anyone — refunds, terminal charges, manual bookings, guest
// PII, outbound email. lib/require-admin.ts closed that. Nothing but this file can tell you it
// STAYS closed: a future refactor that drops a guard leaves every other test green.
//
// The second half matters just as much and is easy to forget: the camper-facing routes must stay
// OPEN. Gating /api/payment or /api/availability would take the booking flow offline for every
// visitor, and it is exactly the kind of mistake a sweeping "add auth everywhere" change makes.
// Those assertions are here so that mistake fails a test instead of a customer's booking.
//
// SAFETY. Same interlock as payment-route.test.ts: the server starts with SQUARE_ACCESS_TOKEN
// deliberately invalid, so no request from this file can charge a card. Beyond that, the
// authenticated case is asserted ONLY against read-only routes — this file never sends a valid
// admin cookie to a money route, so it cannot issue a refund or a terminal charge by accident.

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { spawn, type ChildProcess } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, resolve as resolvePath } from 'node:path'

const REPO_ROOT = resolvePath(dirname(fileURLToPath(import.meta.url)), '..')
const ENV_PATH = resolvePath(REPO_ROOT, '.env.local')

const env: Record<string, string> = {}
if (existsSync(ENV_PATH)) {
  for (const line of readFileSync(ENV_PATH, 'utf8').split('\n')) {
    if (!line.includes('=') || line.trim().startsWith('#')) continue
    env[line.slice(0, line.indexOf('=')).trim()] = line.slice(line.indexOf('=') + 1).trim()
  }
}

// Same placeholder guard as payment-route.test.ts: the template ships a .env.local of
// placeholders, so the file existing proves nothing.
const placeholder = (v: string | undefined) =>
  !v || /YOUR_|EXAMPLE|CHANGEME|xxxx/i.test(v)
const configured =
  !placeholder(env.NEXT_PUBLIC_SUPABASE_URL) &&
  /^https:\/\/[a-z0-9]+\.supabase\./i.test(env.NEXT_PUBLIC_SUPABASE_URL || '') &&
  !placeholder(env.SUPABASE_SERVICE_ROLE_KEY)

const haveEnv = configured
const skip = configured ? false : 'no configured Supabase project in .env.local'

// A different port from payment-route.test.ts so the two files can run concurrently.
const PORT = 4874
const BASE = `http://127.0.0.1:${PORT}`

// The value /api/admin-auth sets on a successful login. Hardcoded rather than derived so the
// test breaks loudly if the session format changes.
const ADMIN_COOKIE = 'admin_session=authenticated'

let server: ChildProcess | null = null

before(async () => {
  if (!haveEnv) return
  server = spawn('npx', ['next', 'dev', '-p', String(PORT)], {
    cwd: REPO_ROOT,
    // THE SAFETY INTERLOCK: no request from this file can result in a charge.
    env: { ...process.env, ...env, SQUARE_ACCESS_TOKEN: 'INVALID_TOKEN_FOR_TESTING' },
    stdio: 'ignore',
  })

  const deadline = Date.now() + 120_000
  for (;;) {
    try {
      await fetch(`${BASE}/api/availability?arrival=2026-08-18&departure=2026-08-20`)
      return
    } catch {
      if (Date.now() > deadline) throw new Error('next dev did not come up in time')
      await new Promise(r => setTimeout(r, 500))
    }
  }
}, { timeout: 130_000 })

after(() => { server?.kill('SIGTERM') })

// Every route that requires an admin session, with a method that reaches its handler.
// Bodies are intentionally empty: the guard is the FIRST statement in each handler, so an
// unauthenticated request must be refused before the body is ever parsed.
const GATED: [string, string][] = [
  ['POST', '/api/admin-card-payment'],
  ['POST', '/api/broadcast-email'],
  ['POST', '/api/electric-bill-email'],
  ['POST', '/api/electric-payment-receipt'],
  ['POST', '/api/email'],
  ['POST', '/api/guests/balances'],
  ['POST', '/api/manual-booking'],
  ['POST', '/api/receipt'],
  ['POST', '/api/refund'],
  ['POST', '/api/reservation-cancel'],
  ['POST', '/api/reservation-refund'],
  ['POST', '/api/send-waiver'],
  ['POST', '/api/sync-guests'],
  ['POST', '/api/terminal/cancel'],
  ['GET', '/api/terminal/charge'],
  ['POST', '/api/terminal/charge'],
  ['GET', '/api/terminal/pair'],
  ['POST', '/api/terminal/pair'],
  // Template-only: the Square OAuth admin screen. Cady has no equivalent, so these were
  // categorized on this repo's own evidence — all three are called solely from
  // app/admin/settings/square/page.tsx.
  ['GET', '/api/square/connect'],
  ['POST', '/api/square/disconnect'],
  ['GET', '/api/square/status'],
]

for (const [method, path] of GATED) {
  test(`${method} ${path} refuses an unauthenticated caller`, { skip }, async () => {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: method === 'GET' ? undefined : '{}',
    })
    assert.equal(res.status, 401, `${method} ${path} should be 401 without an admin session`)
  })
}

// The other half: the camper-facing routes must NOT be gated. If a future change sweeps auth
// across /api/* indiscriminately, these fail rather than the live booking flow.
//
// "Reachable" is asserted as "not 401", not as a success code — /api/payment with an empty body
// legitimately fails validation or the bookability gate. What must never happen is that an
// unauthenticated camper is turned away at the door.
const PUBLIC: [string, string][] = [
  ['POST', '/api/payment'],
  ['GET', '/api/availability?arrival=2026-08-18&departure=2026-08-20'],
  ['GET', '/api/cancellation-policy?arrival=2026-08-18'],
]

for (const [method, path] of PUBLIC) {
  test(`${method} ${path} stays reachable without auth`, { skip }, async () => {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: method === 'GET' ? undefined : '{}',
    })
    assert.notEqual(
      res.status, 401,
      `${method} ${path} must stay open to unauthenticated visitors — gating it breaks the booking flow`
    )
  })
}

// /api/availability is the one the booking page cannot work without, so assert it actually
// serves rather than merely not-401-ing.
test('GET /api/availability serves data to an anonymous visitor', { skip }, async () => {
  const res = await fetch(`${BASE}/api/availability?arrival=2026-08-18&departure=2026-08-20`)
  assert.equal(res.status, 200)
  const json: any = await res.json()
  assert.ok(Array.isArray(json?.sites), 'expected a sites array')
})

// The gate must accept a real admin session, not just reject everyone — a `return 401` with no
// cookie check would pass every test above while locking staff out entirely.
//
// Read-only routes ONLY. This test never sends the admin cookie to a money route.
test('a valid admin session is accepted (read-only routes)', { skip }, async () => {
  for (const path of ['/api/square/status']) {
    const res = await fetch(`${BASE}${path}`, { headers: { cookie: ADMIN_COOKIE } })
    assert.notEqual(res.status, 401, `${path} should accept a valid admin_session cookie`)
  }
})

// /api/admin-auth is the login endpoint and MUST NOT be gated — gating it makes logging in
// impossible, locking every admin out permanently.
//
// It cannot be asserted with "not 401" like the routes above: a wrong password is itself a
// legitimate 401 from its own handler. So distinguish by BODY. requireAdmin always answers
// {"error":"Unauthorized"}; the login route answers {"error":"Incorrect password."}. Seeing the
// login route's own message proves the request reached the handler rather than a guard.
test('POST /api/admin-auth reaches its own handler (never gated)', { skip }, async () => {
  const res = await fetch(`${BASE}/api/admin-auth`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: 'definitely-not-the-admin-password' }),
  })
  const json: any = await res.json().catch(() => ({}))
  assert.notEqual(
    json?.error, 'Unauthorized',
    'the login route answered with requireAdmin\'s message — it has been gated, which locks admins out'
  )
  assert.equal(json?.error, 'Incorrect password.')
})

// A cookie that exists but carries the wrong value must still be refused — guards against a
// check that merely tests for the cookie's presence.
test('a forged admin_session value is refused', { skip }, async () => {
  const res = await fetch(`${BASE}/api/square/status`, {
    headers: { cookie: 'admin_session=not-authenticated' },
  })
  assert.equal(res.status, 401)
})
