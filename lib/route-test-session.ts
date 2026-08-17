// Shared plumbing for route-level tests: read .env.local, start a real Next server, and log in
// as a real person.
//
// NOT a test file — the runner's glob is lib/*.test.ts, and this deliberately does not match, so
// it is imported rather than executed.
//
// It exists because api-auth.test.ts and payment-route.test.ts had each grown their own copy of
// the same three things, and a third copy was about to be written for the manual-booking tests.
// The env parsing in particular had already caused a real problem: both copies kept surrounding
// quotes on values, so a correctly-written .env.local made every test in both files report SKIP.
// One copy of that logic is one place to get it right.
//
// WHY LOGGING IN IS DONE WITH THE REAL LIBRARY. Since PR 5c-2 there is no shared admin password
// and no /api/admin-auth to post it to; the only session that exists is a Supabase Auth session
// belonging to a specific person. The cookies are therefore built by @supabase/ssr against an
// in-memory jar — the same library the server reads them with — rather than by a hand-rolled
// encoder here, which could agree with itself and prove nothing.

import { createServerClient } from '@supabase/ssr'
import { existsSync, readFileSync } from 'node:fs'
import { spawn, type ChildProcess } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, resolve as resolvePath } from 'node:path'

export const REPO_ROOT = resolvePath(dirname(fileURLToPath(import.meta.url)), '..')
const ENV_PATH = resolvePath(REPO_ROOT, '.env.local')

export const env: Record<string, string> = {}
if (existsSync(ENV_PATH)) {
  for (const line of readFileSync(ENV_PATH, 'utf8').split('\n')) {
    if (!line.includes('=') || line.trim().startsWith('#')) continue
    // Surrounding quotes stripped: .env files legitimately carry them and Next strips them when it
    // loads the same file, so a quoted value works in the app. Keeping them here silently fails the
    // anchored URL check below and makes a whole suite skip against a perfectly good project.
    const rawValue = line.slice(line.indexOf('=') + 1).trim()
    const value = /^(["']).*\1$/.test(rawValue) ? rawValue.slice(1, -1) : rawValue
    env[line.slice(0, line.indexOf('=')).trim()] = value
  }
}

// The template ships a .env.local of placeholders, so the file existing proves nothing.
export const placeholder = (v: string | undefined) =>
  !v || /YOUR_|EXAMPLE|CHANGEME|xxxx/i.test(v)

export const configured =
  !placeholder(env.NEXT_PUBLIC_SUPABASE_URL) &&
  /^https:\/\/[a-z0-9]+\.supabase\./i.test(env.NEXT_PUBLIC_SUPABASE_URL || '') &&
  !placeholder(env.SUPABASE_SERVICE_ROLE_KEY)

export const canLogInAsStaff =
  configured && !placeholder(env.ADMIN_TEST_EMAIL) && !placeholder(env.ADMIN_TEST_PASSWORD)

/**
 * A cookie header for a real signed-in session.
 *
 * Throws rather than returning empty on failure: a test that silently proceeds without a session
 * would assert against a 401 and could "pass" for the wrong reason.
 */
export async function logIn(email: string, password: string): Promise<string> {
  const jar = new Map<string, string>()
  const client = createServerClient(
    env.NEXT_PUBLIC_SUPABASE_URL!,
    env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll: () => [...jar.entries()].map(([name, value]) => ({ name, value })),
        setAll: (list) => list.forEach(({ name, value }) => {
          if (value) jar.set(name, value)
          else jar.delete(name)
        }),
      },
    }
  )

  const { error } = await client.auth.signInWithPassword({ email, password })
  if (error) throw new Error(`signing in as ${email} failed: ${error.message}`)
  if (jar.size === 0) throw new Error(`signing in as ${email} produced no session cookies`)

  return [...jar.entries()].map(([n, v]) => `${n}=${v}`).join('; ')
}

/**
 * A real `next dev` on `port`, resolved once it answers.
 *
 * THE SAFETY INTERLOCK lives here: the server is always started with a deliberately invalid
 * SQUARE_ACCESS_TOKEN, so no request any test makes can charge a card even if every gate failed
 * at once. Callers do not get to opt out of that.
 */
export async function startServer(port: number): Promise<ChildProcess> {
  const server = spawn('npx', ['next', 'dev', '-p', String(port)], {
    cwd: REPO_ROOT,
    env: { ...process.env, ...env, SQUARE_ACCESS_TOKEN: 'INVALID_TOKEN_FOR_TESTING' },
    stdio: 'ignore',
  })

  const base = `http://127.0.0.1:${port}`
  const deadline = Date.now() + 120_000
  for (;;) {
    try {
      // Any response at all means it is listening.
      await fetch(`${base}/api/availability?arrival=2026-08-18&departure=2026-08-20`)
      return server
    } catch {
      if (Date.now() > deadline) {
        server.kill('SIGTERM')
        throw new Error(`next dev did not come up on port ${port} in time`)
      }
      await new Promise(r => setTimeout(r, 500))
    }
  }
}
