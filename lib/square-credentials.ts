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
 *  refresh every 7 days or less, so a week of headroom keeps a token comfortably fresh.
 *
 *  This is the ON-DEMAND guard's window and it is deliberately NARROWER than the platform sweep's
 *  14 days. The sweep should have renewed a token a full week before this check ever looks at it,
 *  so this firing at all means the sweep is not running — which is exactly the situation it exists
 *  to survive. Keep the two numbers different; collapsing them would quietly promote the charge
 *  path from safety net to primary mechanism. */
export const REFRESH_WINDOW_MS = 7 * 24 * 60 * 60 * 1000

/** After a failed refresh, stop asking for a while. Without this, a connection whose authorization
 *  has actually been revoked would add a doomed round trip to the platform — and from there to
 *  Square — to EVERY checkout on this park, turning a broken connection into a slow one as well.
 *  The platform's 3-day sweep keeps retrying regardless, and the settings screen is already
 *  showing "reconnect required", so nothing is being hidden by backing off here. */
export const REFRESH_BACKOFF_MS = 30 * 60 * 1000

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
  refresh_failed_at: string | null
}

/** The columns this module reads. refresh_token is NOT among them and must not be: the charge path
 *  has no use for it (renewal happens centrally, on the platform), and every place a long-lived
 *  credential is loaded is a place it can be logged or leaked. */
const CONNECTION_COLUMNS =
  'access_token, location_id, application_id, environment, status, token_expires_at, refresh_failed_at'

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

  // NOTE: status === 'reconnect_required' (a failed token refresh) deliberately does NOT refuse
  // here. A refresh failing does not mean the current token has stopped working — it usually has
  // days of life left, and Square being unreachable for ten minutes is a common cause. Refusing
  // would convert a warning into an outage and take a park's payments down early rather than
  // late. The loud part of loud failure is the settings screen, which shows "reconnect required"
  // from this same status; the charge path keeps working for as long as the token actually does.

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

/**
 * True when a connection's token is close enough to expiry that it should be renewed first.
 *
 * `null` IS NOT "EXPIRED" AND MUST NEVER BE. A connection can legitimately carry no expiry — a
 * token pasted in from a Square dashboard rather than issued by OAuth has neither an expiry nor a
 * refresh token, and the seeded sandbox connection that steps 1-8 were proven on is exactly that.
 * Reading absence as "past due" would make every charge on such a connection ask the platform for
 * a refresh that can never succeed, on every charge, forever — a permanent stream of failures on a
 * connection that is working perfectly. Absence of an expiry is absence of information.
 */
export function needsRefresh(tokenExpiresAt: string | null, now: number = Date.now()): boolean {
  if (!tokenExpiresAt) return false
  const expiry = Date.parse(tokenExpiresAt)
  if (Number.isNaN(expiry)) return false
  return expiry - now < REFRESH_WINDOW_MS
}

/** True when a refresh failed recently enough that the charge path should not ask again yet. */
export function isBackingOff(refreshFailedAt: string | null, now: number = Date.now()): boolean {
  if (!refreshFailedAt) return false
  const failedAt = Date.parse(refreshFailedAt)
  if (Number.isNaN(failedAt)) return false
  return now - failedAt < REFRESH_BACKOFF_MS
}

/**
 * The whole on-demand decision, as one pure predicate: should this charge ask the platform to
 * renew the token before proceeding?
 *
 * Exported and tested separately from the IO around it, because the two ways to get this wrong are
 * both invisible in normal operation — never asking (every park dies silently at 30 days) and
 * always asking (a platform round trip added to every checkout forever).
 */
export function shouldRequestRefresh(
  row: Pick<ConnectionRow, 'token_expires_at' | 'refresh_failed_at'>,
  now: number = Date.now(),
): boolean {
  return needsRefresh(row.token_expires_at, now) && !isBackingOff(row.refresh_failed_at, now)
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

  let supabase: ReturnType<typeof serviceRoleClient>
  let row: ConnectionRow | null = null
  try {
    supabase = serviceRoleClient()
    const { data } = await supabase
      .from('square_connections')
      .select(CONNECTION_COLUMNS)
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
    // ── THE ON-DEMAND GUARD (step 9) ──────────────────────────────────────────────────────────
    //
    // Square access tokens expire 30 days after issue. The platform's 3-day sweep is what keeps
    // them fresh; this is the safety net for when that sweep has silently died, which is a real
    // failure mode — a cron that stops firing produces no error, and what it takes down is every
    // park's ability to charge, a month later, with nothing to correlate against.
    //
    // It costs nothing on the ordinary path: shouldRequestRefresh is false for a healthy token, so
    // the overwhelming majority of charges never make this call. It fires only in the last week of
    // a token's life, and after one success the expiry moves out 30 days and it stops.
    //
    // THE WHOLE BLOCK IS WRAPPED, and that is the most important line in it. Everything below runs
    // on a token that ALREADY WORKS — "near expiry" is not "expired", so the refresh is an
    // optimisation, never a repair. Any error escaping here would convert a healthy checkout into
    // a failed payment, which is strictly worse than the stale-ish token it was trying to improve
    // on. requestSquareRefresh already swallows its own failures; this is the backstop for
    // everything around it.
    try {
      if (shouldRequestRefresh(row)) {
        // Loaded lazily, for a mundane but load-bearing reason: this module's unit tests import it
        // directly under Node's test runner, unbundled, where the `@/` path alias does not exist.
        // A static import would break every one of them — and those tests are most of the proof
        // this whole step has, since the behaviour cannot otherwise be observed for thirty days.
        // Keeping the refresh machinery off the module graph also keeps the resolver honest:
        // nothing here can reach the network unless a token is genuinely near expiry.
        const { requestSquareRefresh } = await import('@/lib/square-refresh-request')
        const { signSquareState } = await import('@/lib/square-state')

        const rowEnvironment = normaliseEnvironment(row.environment)
        const outcome = await requestSquareRefresh(campgroundId, (id) =>
          // The same seal as the connect handshake and the revoke call: signed with THIS tenant's
          // own secret, which the platform verifies against its registry copy. signSquareState
          // throws when the secret is unset, and requestSquareRefresh swallows that — a park with
          // no signing secret simply cannot refresh, and must still be able to take the payment it
          // has a valid token for.
          signSquareState(process.env.SQUARE_STATE_SECRET || '', {
            campground_id: id,
            return_to: process.env.NEXT_PUBLIC_BASE_URL || '',
            // The CONNECTION's environment, not the deployment's. They are the same in practice,
            // but the connection is the source of truth everywhere else in this file and a
            // disagreement should not be resolved in favour of an environment variable.
            environment: rowEnvironment,
          }),
        )

        // Re-read ONLY on a confirmed refresh. Every other outcome — not due, no refresh token,
        // another request already holding the lock, an outright failure — means the row in hand is
        // still the best one available, and it is still VALID: "near expiry" is not "expired".
        if (outcome.refreshed) {
          const { data } = await supabase
            .from('square_connections')
            .select(CONNECTION_COLUMNS)
            .eq('campground_id', campgroundId)
            .maybeSingle()
          // Keep the old row if the re-read comes back empty, for the same reason as above.
          if (data) row = data as ConnectionRow
        }
      }
    } catch (e) {
      console.error('Square credentials: on-demand refresh could not run', e)
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
