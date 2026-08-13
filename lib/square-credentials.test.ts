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
  publicConfig,
  apiBaseFor,
  SquareCredentialsError,
  REFRESH_WINDOW_MS,
  type SquareCreds,
} from './square-credentials.ts'

// ── helpers ───────────────────────────────────────────────────────────────────────────────────

function connectionRow(over: Record<string, unknown> = {}) {
  return {
    access_token: 'CONNECTION_TOKEN',
    location_id: 'CONNECTION_LOCATION',
    application_id: 'CONNECTION_APP',
    environment: 'sandbox',
    status: 'connected',
    token_expires_at: null,
    ...over,
  } as any
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
  // Square always sends expires_at, so absence means an older row rather than an expired token.
  // Reporting "needs refresh" on every charge would be noise, not safety.
  assert.equal(needsRefresh(null), false)
  assert.equal(needsRefresh('not a date'), false)
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
  assert.equal((pub as any).accessToken, undefined)
  assert.equal((pub as any).apiBase, undefined)
})
