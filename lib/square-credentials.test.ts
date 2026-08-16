// Tests for the Square credential resolver — the module that decides WHICH SQUARE ACCOUNT a
// charge lands on. Framework-free, runs on Node's built-in runner with type stripping:
//
//   node --conditions=react-server --test lib/square-credentials.test.ts
//
// THE FLAG IS NOT OPTIONAL. square-credentials.ts opens with `import 'server-only'`, whose whole
// job is to throw when it is resolved outside a server context — and plain `node --test` is one.
// `--conditions=react-server` picks the package's empty server entry, the same way the Next build
// does. If this file ever starts failing with "This module cannot be imported from a Client
// Component module", the flag is missing, not the code.
//
// The property this file exists to pin is not "the resolver returns credentials". It is:
//
//   A charge is never assembled from two different sources.
//
// The failure that motivates it is quiet and expensive. Pair an access token from a park's
// connected Square account with a location id left over in an environment variable and the charge
// SUCCEEDS — right amount, right card, wrong merchant — and nobody finds out until someone
// reconciles a bank statement weeks later. Every "partial" case below therefore asserts a REFUSAL
// rather than a best-effort result, because a plausible answer is worse than an error here.
//
// The env-var fallback is deliberate (it keeps the migration non-breaking and preserves the
// operator-managed option), which is exactly why it needs guarding: a fallback that can blend
// with the connection is the bug this whole design is trying not to ship.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  credentialsFromConnection,
  credentialsFromEnv,
  needsRefresh,
  isBackingOff,
  shouldRequestRefresh,
  publicConfig,
  apiBaseFor,
  SquareCredentialsError,
  REFRESH_WINDOW_MS,
  REFRESH_BACKOFF_MS,
  type SquareCreds,
} from './square-credentials.ts'

// ── helpers ───────────────────────────────────────────────────────────────────────────────────

type Row = Parameters<typeof credentialsFromConnection>[0]

function connectionRow(over: Record<string, unknown> = {}): Row {
  return {
    access_token: 'CONNECTION_TOKEN',
    location_id: 'CONNECTION_LOCATION',
    application_id: 'CONNECTION_APP',
    environment: 'sandbox',
    status: 'connected',
    token_expires_at: null,
    refresh_failed_at: null,
    ...over,
  } as Row
}

const ENV_KEYS = [
  'SQUARE_ACCESS_TOKEN',
  'SQUARE_LOCATION_ID',
  'SQUARE_APPLICATION_ID',
  'NEXT_PUBLIC_SQUARE_APP_ID',
  'SQUARE_ENVIRONMENT',
]

function withEnv(values: Record<string, string | undefined>, fn: () => void) {
  const saved: Record<string, string | undefined> = {}
  for (const k of ENV_KEYS) saved[k] = process.env[k]
  for (const k of ENV_KEYS) delete process.env[k]
  for (const [k, v] of Object.entries(values)) {
    if (v !== undefined) process.env[k] = v
  }
  try {
    fn()
  } finally {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k]
      else process.env[k] = saved[k]
    }
  }
}

const FULL_ENV = {
  SQUARE_ACCESS_TOKEN: 'ENV_TOKEN',
  SQUARE_LOCATION_ID: 'ENV_LOCATION',
  SQUARE_APPLICATION_ID: 'ENV_APP',
  SQUARE_ENVIRONMENT: 'production',
}

// ── the connection path ───────────────────────────────────────────────────────────────────────

test('a complete connection resolves entirely from the connection', () => {
  withEnv(FULL_ENV, () => {
    const creds = credentialsFromConnection(connectionRow())!
    assert.equal(creds.accessToken, 'CONNECTION_TOKEN')
    assert.equal(creds.locationId, 'CONNECTION_LOCATION')
    assert.equal(creds.applicationId, 'CONNECTION_APP')
    assert.equal(creds.environment, 'sandbox')
    assert.equal(creds.source, 'connection')
    // The host follows the CONNECTION, not the deployment. A production env var must not drag a
    // sandbox connection's charges onto the production host.
    assert.equal(creds.apiBase, 'https://connect.squareupsandbox.com')
  })
})

test('the connection wins over env vars — an operator cannot silently override the owner', () => {
  withEnv(FULL_ENV, () => {
    const creds = credentialsFromConnection(connectionRow())!
    assert.equal(creds.accessToken, 'CONNECTION_TOKEN')
    assert.notEqual(creds.accessToken, process.env.SQUARE_ACCESS_TOKEN)
    assert.notEqual(creds.locationId, process.env.SQUARE_LOCATION_ID)
  })
})

test('null row means "no opinion" — it falls through rather than throwing', () => {
  assert.equal(credentialsFromConnection(null), null)
})

// ── THE ATOMICITY RULE ────────────────────────────────────────────────────────────────────────

test('a connection with no token REFUSES — it never borrows the env token', () => {
  withEnv(FULL_ENV, () => {
    assert.throws(
      () => credentialsFromConnection(connectionRow({ access_token: null })),
      (e: unknown) => e instanceof SquareCredentialsError && e.problem === 'connection_partial',
    )
  })
})

test('a connection with no location REFUSES — it never borrows the env location', () => {
  withEnv(FULL_ENV, () => {
    assert.throws(
      () => credentialsFromConnection(connectionRow({ location_id: null })),
      (e: unknown) => e instanceof SquareCredentialsError && e.problem === 'location_pending',
    )
  })
})

test('location_pending REFUSES even when a location id is present', () => {
  // The status is the owner's unfinished choice; a stale id in the column does not override it.
  assert.throws(
    () => credentialsFromConnection(connectionRow({ status: 'location_pending' })),
    (e: unknown) => e instanceof SquareCredentialsError && e.problem === 'location_pending',
  )
})

test('an empty-string location is treated as missing, not as a location', () => {
  assert.throws(
    () => credentialsFromConnection(connectionRow({ location_id: '' })),
    (e: unknown) => e instanceof SquareCredentialsError && e.problem === 'location_pending',
  )
})

// ── the env fallback ──────────────────────────────────────────────────────────────────────────

test('a complete env pair resolves, and is labelled as env', () => {
  withEnv(FULL_ENV, () => {
    const creds = credentialsFromEnv()!
    assert.equal(creds.accessToken, 'ENV_TOKEN')
    assert.equal(creds.locationId, 'ENV_LOCATION')
    assert.equal(creds.environment, 'production')
    assert.equal(creds.apiBase, 'https://connect.squareup.com')
    assert.equal(creds.source, 'env')
  })
})

test('env with a token but no location resolves to NOTHING — both or neither', () => {
  withEnv({ SQUARE_ACCESS_TOKEN: 'ENV_TOKEN' }, () => {
    assert.equal(credentialsFromEnv(), null)
  })
})

test('env with a location but no token resolves to NOTHING', () => {
  withEnv({ SQUARE_LOCATION_ID: 'ENV_LOCATION' }, () => {
    assert.equal(credentialsFromEnv(), null)
  })
})

test('no env at all resolves to nothing — the caller turns this into not_connected', () => {
  withEnv({}, () => {
    assert.equal(credentialsFromEnv(), null)
  })
})

// ── environment normalisation: sandbox is opt-in, everything else is production ───────────────

test('only the exact word "sandbox" reaches the sandbox host', () => {
  for (const value of ['sandbox', ' sandbox ', 'SANDBOX', 'Sandbox']) {
    const creds = credentialsFromConnection(connectionRow({ environment: value }))!
    assert.equal(creds.environment, 'sandbox', `${JSON.stringify(value)} should be sandbox`)
  }
  for (const value of ['production', '', 'prod', 'sandbox-ish', 'PRODUCTION', null, undefined, 'sandboxx']) {
    const creds = credentialsFromConnection(connectionRow({ environment: value }))!
    assert.equal(creds.environment, 'production', `${JSON.stringify(value)} must be production`)
    assert.equal(creds.apiBase, 'https://connect.squareup.com')
  }
})

test('apiBaseFor pins the two hosts', () => {
  assert.equal(apiBaseFor('sandbox'), 'https://connect.squareupsandbox.com')
  assert.equal(apiBaseFor('production'), 'https://connect.squareup.com')
})

// ── refresh window ────────────────────────────────────────────────────────────────────────────

test('needsRefresh is true inside the window and false outside it', () => {
  const now = Date.parse('2026-08-13T00:00:00Z')
  const inside = new Date(now + REFRESH_WINDOW_MS - 60_000).toISOString()
  const outside = new Date(now + REFRESH_WINDOW_MS + 60_000).toISOString()
  assert.equal(needsRefresh(inside, now), true)
  assert.equal(needsRefresh(outside, now), false)
})

test('an already-expired token needs refreshing', () => {
  const now = Date.parse('2026-08-13T00:00:00Z')
  assert.equal(needsRefresh(new Date(now - 1000).toISOString(), now), true)
})

test('a missing or unparseable expiry does not claim a refresh is needed', () => {
  // THE REGRESSION THIS PINS (step 9). A connection can legitimately carry no expiry: a token
  // pasted in from a Square dashboard has neither an expiry nor a refresh token, and the seeded
  // sandbox connection that steps 1-8 were proven on is exactly one. Reading absence as "past due"
  // would make EVERY charge on such a connection ask the platform for a refresh that can never
  // succeed — a permanent stream of failures, and a red "reconnect required" banner, on a park
  // whose payments are working perfectly.
  assert.equal(needsRefresh(null), false)
  assert.equal(needsRefresh('not a date'), false)
})

// ── THE ON-DEMAND GUARD (step 9) ──────────────────────────────────────────────────────────────
//
// The charge path asks the platform to renew a near-expiry token before charging. Both ways of
// getting this wrong are invisible in normal operation: never asking means every park silently
// stops taking payments thirty days after connecting, and always asking means a cross-service
// round trip bolted onto every checkout forever.

test('the guard fires inside the window and stays quiet outside it', () => {
  const now = Date.parse('2026-08-14T00:00:00Z')
  const inside = new Date(now + REFRESH_WINDOW_MS - 60_000).toISOString()
  const outside = new Date(now + REFRESH_WINDOW_MS + 60_000).toISOString()

  assert.equal(shouldRequestRefresh({ token_expires_at: inside, refresh_failed_at: null }, now), true)
  assert.equal(shouldRequestRefresh({ token_expires_at: outside, refresh_failed_at: null }, now), false)
})

test('the guard NEVER fires for a connection with no expiry', () => {
  // The same property as needsRefresh(null), asserted at the level that actually decides whether a
  // network call happens on the charge path.
  const now = Date.parse('2026-08-14T00:00:00Z')
  assert.equal(shouldRequestRefresh({ token_expires_at: null, refresh_failed_at: null }, now), false)
  // ...not even if a previous failure is on record.
  assert.equal(
    shouldRequestRefresh({ token_expires_at: null, refresh_failed_at: new Date(now - 1000).toISOString() }, now),
    false,
  )
})

test('a recent failure backs the guard off, so a broken connection does not slow every checkout', () => {
  const now = Date.parse('2026-08-14T00:00:00Z')
  const nearExpiry = new Date(now + 60 * 60 * 1000).toISOString()

  const justFailed = new Date(now - 60_000).toISOString()
  assert.equal(shouldRequestRefresh({ token_expires_at: nearExpiry, refresh_failed_at: justFailed }, now), false)

  // ...and the backoff expires, so the charge path resumes trying on its own rather than giving up
  // permanently on the strength of one bad minute.
  const longAgo = new Date(now - REFRESH_BACKOFF_MS - 60_000).toISOString()
  assert.equal(shouldRequestRefresh({ token_expires_at: nearExpiry, refresh_failed_at: longAgo }, now), true)
})

test('isBackingOff treats a missing or unparseable stamp as "not backing off"', () => {
  const now = Date.parse('2026-08-14T00:00:00Z')
  assert.equal(isBackingOff(null, now), false)
  assert.equal(isBackingOff('not a date', now), false)
  assert.equal(isBackingOff(new Date(now - REFRESH_BACKOFF_MS + 1000).toISOString(), now), true)
  assert.equal(isBackingOff(new Date(now - REFRESH_BACKOFF_MS - 1000).toISOString(), now), false)
})

test('the guard window is NARROWER than the platform sweep window', () => {
  // The sweep (resonation-admin, every 3 days) renews at 14 days out; this guard at 7. The gap is
  // the design: by the time a charge looks, the sweep should have renewed a week ago, so the guard
  // firing at all means the sweep is not running. Collapsing them would quietly promote the charge
  // path from safety net to primary mechanism.
  const SWEEP_WINDOW_MS = 14 * 24 * 60 * 60 * 1000
  assert.ok(REFRESH_WINDOW_MS < SWEEP_WINDOW_MS)
  assert.equal(REFRESH_WINDOW_MS, 7 * 24 * 60 * 60 * 1000)
})

test('a reconnect_required connection still resolves — a failed refresh is not an outage', () => {
  // Deliberate. A refresh failing does not mean the token has stopped working; it usually has days
  // left, and a ten-minute Square outage is a common cause. Refusing here would take a park's
  // payments down EARLY rather than late, on the strength of a warning. The settings screen is
  // where this becomes visible; the charge path keeps working while the token does.
  const creds = credentialsFromConnection(connectionRow({ status: 'reconnect_required' }))!
  assert.equal(creds.accessToken, 'CONNECTION_TOKEN')
  assert.equal(creds.source, 'connection')
})

// ── THE LEAK TEST ─────────────────────────────────────────────────────────────────────────────

test('publicConfig exposes exactly three keys, and the token is not among them', () => {
  const creds: SquareCreds = {
    accessToken: 'SUPER_SECRET_TOKEN',
    locationId: 'L1',
    applicationId: 'APP1',
    environment: 'sandbox',
    apiBase: 'https://connect.squareupsandbox.com',
    source: 'connection',
  }
  const pub = publicConfig(creds)

  // Pinned key set. If someone later spreads the credentials object into the response, this fails
  // — which is the whole point, because that is the one mistake that puts a live payment token in
  // a browser.
  assert.deepEqual(Object.keys(pub).sort(), ['applicationId', 'environment', 'locationId'])

  // And belt-and-braces: the token must not appear anywhere in the serialised output.
  assert.ok(!JSON.stringify(pub).includes('SUPER_SECRET_TOKEN'))
  const asRecord = pub as unknown as Record<string, unknown>
  assert.equal(asRecord.accessToken, undefined)
  assert.equal(asRecord.apiBase, undefined)
})
