// Ask the platform to renew this park's Square access token.
//
// WHY THIS IS A REQUEST TO ANOTHER SERVICE AND NOT A FUNCTION CALL. Square's access tokens expire
// 30 days after issue, and renewing one is `POST /oauth2/token` with grant_type=refresh_token —
// authenticated with the PLATFORM application's client_secret. That secret deliberately does not
// exist on this deployment: a tenant holding it could mint tokens for any park that has ever
// authorised the platform, which is the exact concentration the whole per-tenant-key design avoids.
// So this deployment cannot refresh its own token, and asks resonation-admin to, which then writes
// the new token straight into this park's own database.
//
// Identical in shape and in trust model to revokeAtSquare() in lib/square-oauth.ts, on purpose:
// proof of identity is a state signed with THIS tenant's own SQUARE_STATE_SECRET, verified by the
// platform against the copy in its registry. No second credential to manage, no second thing to
// get wrong, and a caller cannot produce a state the platform accepts for a park whose secret they
// do not hold.
//
// WHY THE TENANT ASKS AT ALL, GIVEN THE PLATFORM SWEEPS EVERY 3 DAYS. The sweep is the mechanism
// that is supposed to work; if it does, this never fires. But a cron that stops firing is a silent
// failure — no error, nothing to see — and what it takes down, thirty days later, is every park's
// ability to charge. This is the second of two independent chances, and it is on the charge path
// precisely because that is the moment where being wrong is most expensive.
//
// NEVER THROWS. It is called immediately before a payment. A platform having a bad morning must
// not be the reason a camper cannot check out — the existing token is still valid (that is what
// "near expiry" means), so the correct response to any failure here is to carry on and charge.

/** Where the platform lives. Overridable so a preview deployment can be pointed at a preview of
 *  resonation-admin during testing; production is the default, so forgetting to set it lands on
 *  the right value rather than a broken one. Same rule as SQUARE_REDIRECT_URI on the callback. */
export const RESONATION_ADMIN_URL =
  process.env.RESONATION_ADMIN_URL || 'https://admin.myresonation.com'

/** Give up quickly. This sits in front of a checkout, and a platform that is not answering is a
 *  reason to charge with the current (still valid) token, not a reason to make the guest wait. */
const REFRESH_TIMEOUT_MS = 8000

export type RefreshRequestOutcome =
  | { refreshed: true }
  | { refreshed: false; reason: string }

/**
 * Returns `{ refreshed: true }` only when the platform confirms it wrote a NEW token, which is the
 * caller's signal to re-read the connection row. Every other outcome — not due, no refresh token,
 * another request already refreshing, an outright failure — means the row on hand is still the
 * best one available and should be used as-is.
 */
export async function requestSquareRefresh(
  campgroundId: string,
  signState: (campgroundId: string) => string,
): Promise<RefreshRequestOutcome> {
  try {
    const state = signState(campgroundId)

    const res = await fetch(`${RESONATION_ADMIN_URL}/api/square/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ state }),
      signal: AbortSignal.timeout(REFRESH_TIMEOUT_MS),
    })

    const data = await res.json().catch(() => ({}))
    if (!res.ok) {
      console.error('Square refresh request rejected:', res.status, data)
      return { refreshed: false, reason: `http_${res.status}` }
    }
    if (data?.refreshed === true) return { refreshed: true }
    return { refreshed: false, reason: String(data?.reason ?? 'unknown') }
  } catch (e) {
    // Includes the timeout above and a missing SQUARE_STATE_SECRET (signState throws). Logged and
    // swallowed: see the header — the charge proceeds on the current token.
    console.error('Square refresh request failed:', e)
    return { refreshed: false, reason: 'request_failed' }
  }
}
