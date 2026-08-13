import 'server-only'
import { createClient } from '@supabase/supabase-js'
import type { SquareEnvironment } from '@/lib/square-state'

// THE SINGLE ANSWER TO "WHICH SQUARE ACCOUNT AM I CHARGING?"
//
// Every money path used to answer that for itself, out of process.env, in fourteen places. This
// module replaces all of them, so the question is decided once and can be reviewed once.
//
// `import 'server-only'` is the first line on purpose: this module reaches a live access token,
// and importing it from a client component must be a BUILD failure rather than something spotted
// in review. Nothing here may ever be handed to a browser except applicationId, locationId and
// environment, all of which are public identifiers.
//
// WHY THE WHOLE THING OR NOTHING. The resolver returns a complete SquareCreds from ONE source or
// it throws. There is deliberately no per-field fallback, because the failure a per-field
// fallback produces is the worst one available here: a token from a connected account paired with
// a location id from the environment charges the right amount to the wrong merchant, succeeds,
// and stays invisible until somebody reconciles a bank statement. A half-configured connection is
// an error, not something to patch up with leftovers.

export type SquareCredentialSource = 'connection' | 'env'

export type SquareCreds = {
  /** Service-role only. NEVER returned to a browser. */
  accessToken: string
  locationId: string
  /** Public — safe to hand to the Web Payments SDK. */
  applicationId: string
  environment: SquareEnvironment
  /** Derived from `environment`, never from an environment variable. */
  apiBase: string
  /** Which side answered. For logging and the settings screen, never for control flow. */
  source: SquareCredentialSource
}

export type SquareCredentialProblem =
  | 'not_connected'      // no connection row and no env fallback — the park has not set up payments
  | 'location_pending'   // connected, but the owner has not chosen which location to charge on
  | 'connection_partial' // a row exists but is missing a token — never merge with env, just refuse

export class SquareCredentialsError extends Error {
  // Written out longhand rather than as a TypeScript parameter property: the test suite runs on
  // Node's strip-only type stripping, which rejects parameter properties outright.
  readonly problem: SquareCredentialProblem

  constructor(problem: SquareCredentialProblem, message: string) {
    super(message)
    this.name = 'SquareCredentialsError'
    this.problem = problem
  }
}

/** Refresh this far ahead of expiry. Square's access tokens last 30 days and Square asks for a
 *  refresh every 7 days or less, so a week of headroom keeps a token comfortably fresh. */
export const REFRESH_WINDOW_MS = 7 * 24 * 60 * 60 * 1000

export function apiBaseFor(environment: SquareEnvironment): string {
  return environment === 'sandbox'
    ? 'https://connect.squareupsandbox.com'
    : 'https://connect.squareup.com'
}

/** Sandbox is opt-in by exact match; anything else is production. Same rule everywhere. */
function normaliseEnvironment(value: unknown): SquareEnvironment {
  return String(value ?? '').trim().toLowerCase() === 'sandbox' ? 'sandbox' : 'production'
}

type ConnectionRow = {
  access_token: string | null
  location_id: string | null
  application_id: string | null
  environment: string | null
  status: string | null
  token_expires_at: string | null
}

/** Exported for tests: the pure decision, with the database and the clock passed in. */
export function credentialsFromConnection(row: ConnectionRow | null): SquareCreds | null {
  if (!row) return null

  // A row with no token is not a connection — it is wreckage from a failed handshake. Refuse
  // rather than fall through to env, so a park cannot end up charging on a mixture of the two.
  if (!row.access_token) {
    throw new SquareCredentialsError(
      'connection_partial',
      'Square connection exists but carries no access token. Reconnect Square.',
    )
  }

  if (!row.location_id || row.status === 'location_pending') {
    throw new SquareCredentialsError(
      'location_pending',
      'Square is connected but no location has been chosen to take payments on.',
    )
  }

  const environment = normaliseEnvironment(row.environment)
  return {
    accessToken: row.access_token,
    locationId: row.location_id,
    // application_id predates nothing — it is written by the callback — but a connection made
    // before that column existed would have it null. Falling back to the env app id here is NOT
    // a violation of the one-source rule: the application id is a public identifier, not a
    // credential, and the platform app for a given environment is the same value either way.
    applicationId: row.application_id || process.env.SQUARE_APPLICATION_ID || '',
    environment,
    apiBase: apiBaseFor(environment),
    source: 'connection',
  }
}

/** Exported for tests: the env-var fallback, resolved as a whole or not at all. */
export function credentialsFromEnv(): SquareCreds | null {
  const accessToken = process.env.SQUARE_ACCESS_TOKEN || ''
  const locationId = process.env.SQUARE_LOCATION_ID || ''

  // Both or neither. One without the other is a misconfiguration, and treating it as a partial
  // success is how a charge ends up somewhere nobody intended.
  if (!accessToken || !locationId) return null

  const environment = normaliseEnvironment(process.env.SQUARE_ENVIRONMENT)
  return {
    accessToken,
    locationId,
    applicationId: process.env.SQUARE_APPLICATION_ID || process.env.NEXT_PUBLIC_SQUARE_APP_ID || '',
    environment,
    apiBase: apiBaseFor(environment),
    source: 'env',
  }
}

/** True when a connection's token is close enough to expiry that it should be renewed first. */
export function needsRefresh(tokenExpiresAt: string | null, now: number = Date.now()): boolean {
  if (!tokenExpiresAt) return false
  const expiry = Date.parse(tokenExpiresAt)
  if (Number.isNaN(expiry)) return false
  return expiry - now < REFRESH_WINDOW_MS
}

function serviceRoleClient() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  )
}

/**
 * Resolve the Square credentials this deployment should charge with.
 *
 * Order is connection first, environment second. A park that has connected their own Square
 * account is charging on it, full stop — an operator-set env var must never quietly override what
 * the owner did in their own admin screen.
 *
 * THE ENV FALLBACK IS DELIBERATE AND WORTH ITS COST. It keeps every step of this migration
 * non-breaking (a tenant with env vars and no connection behaves exactly as it did before), it
 * preserves the operator-managed option for a client who would rather hand over a static token,
 * and it is the break-glass when a connection goes bad out of hours. The whole cost is the two
 * branches below, and the one-source rule keeps it honest.
 */
export async function getSquareCredentials(): Promise<SquareCreds> {
  const campgroundId = process.env.CAMPGROUND_ID || 'default'

  let row: ConnectionRow | null = null
  try {
    const supabase = serviceRoleClient()
    const { data } = await supabase
      .from('square_connections')
      .select('access_token, location_id, application_id, environment, status, token_expires_at')
      .eq('campground_id', campgroundId)
      .maybeSingle()
    row = (data as ConnectionRow) ?? null
  } catch (e) {
    // A database hiccup must not silently demote a connected park to whatever stale env vars
    // happen to be lying around — that is the cross-source mix the one-source rule forbids, just
    // arrived at by accident. Refuse instead.
    console.error('Square credentials: could not read square_connections', e)
    throw new SquareCredentialsError(
      'not_connected',
      'Could not read the Square connection. Payments are unavailable right now.',
    )
  }

  if (row) {
    // The refresh hook. Step 9 puts a real renewal behind this; until then it only reports, which
    // is harmless in sandbox where tokens are minted fresh. Left here now so the call site exists
    // and step 9 is a one-function change rather than another sweep of every money path.
    if (needsRefresh(row.token_expires_at)) {
      console.warn(
        `Square token for ${campgroundId} expires at ${row.token_expires_at} — within the refresh window. ` +
        'Automatic refresh lands in step 9; reconnect Square if charges begin failing.',
      )
    }
    return credentialsFromConnection(row)!
  }

  const fromEnv = credentialsFromEnv()
  if (fromEnv) return fromEnv

  throw new SquareCredentialsError(
    'not_connected',
    'Square is not connected. Connect a Square account in Settings to take payments.',
  )
}

/**
 * The subset that is safe to send to a browser.
 *
 * Three fields, listed one at a time and nowhere near a spread of the credentials object. The one
 * mistake that leaks a token on this path is returning more of the object than intended, so the
 * shape is pinned by this type and asserted by a test.
 */
export type PublicSquareConfig = {
  applicationId: string
  locationId: string
  environment: SquareEnvironment
}

export function publicConfig(creds: SquareCreds): PublicSquareConfig {
  return {
    applicationId: creds.applicationId,
    locationId: creds.locationId,
    environment: creds.environment,
  }
}
