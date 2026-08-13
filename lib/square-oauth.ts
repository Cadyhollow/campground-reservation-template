import { createClient } from '@supabase/supabase-js'
import { signSquareState, type SquareEnvironment } from '@/lib/square-state'

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

// Sandbox is opt-in by EXACT match and everything else is production — the same fail-to-
// production rule lib/square-env.ts applies to charging, for the same reason: a deployment
// wrongly on sandbox still "succeeds" while no money moves, and that is the failure that hides.
//
// This used to read `=== 'production' ? production : sandbox`, which sent every unset or
// misspelled value to SANDBOX.
export const SQUARE_OAUTH_ENVIRONMENT: SquareEnvironment =
  (process.env.SQUARE_ENVIRONMENT ?? '').trim().toLowerCase() === 'sandbox' ? 'sandbox' : 'production'

const SQUARE_BASE_URL =
  SQUARE_OAUTH_ENVIRONMENT === 'sandbox'
    ? 'https://connect.squareupsandbox.com'
    : 'https://connect.squareup.com'

export function getSquareAuthUrl(campgroundId: string): string {
  // The state carries which park this handshake belongs to, and the URL to come back to, through
  // the merchant's browser to the ONE shared callback at admin.myresonation.com (a Square app has
  // a single configured redirect URL, so the callback cannot be per-client).
  //
  // Security PR 7-4a: it is now SIGNED with this tenant's own secret. It used to be plain base64
  // JSON, which meant anyone could name someone else's campground_id and have the callback file
  // their Square tokens under that park — see lib/square-state.ts for the full attack and for why
  // the secret is per-tenant rather than platform-wide.
  //
  // signSquareState throws if SQUARE_STATE_SECRET is unset. That is deliberate: a connection this
  // server cannot sign is one the callback must refuse, and failing here — visibly, before the
  // owner leaves for Square — is far better than starting a handshake that dies on the way back.
  const state = signSquareState(process.env.SQUARE_STATE_SECRET || '', {
    campground_id: campgroundId,
    return_to: process.env.NEXT_PUBLIC_BASE_URL || '',
    // Which Square world this handshake is in. The shared callback cannot know it — it serves
    // every tenant — and it has to know, because sandbox and production are different Square
    // applications with different secrets and different hosts. Sending it inside the SIGNED
    // payload means a captured sandbox state cannot be edited into a production one.
    environment: SQUARE_OAUTH_ENVIRONMENT,
  })

  const params = new URLSearchParams({
    client_id: process.env.SQUARE_APPLICATION_ID!,
    scope: 'PAYMENTS_WRITE PAYMENTS_READ ORDERS_WRITE MERCHANT_PROFILE_READ',
    session: 'false',
    state,
  })

  return `${SQUARE_BASE_URL}/oauth2/authorize?${params.toString()}`
}

// exchangeCodeForTokens() USED TO LIVE HERE AND HAS BEEN DELETED. It was never called by
// anything, and its redirect_uri pointed at `${NEXT_PUBLIC_BASE_URL}/api/square/callback` — a
// per-client route that does not exist and is not how this works. The code exchange happens in
// the shared callback (resonation-admin app/api/square/callback), against the redirect URL the
// Square application is actually configured with.
//
// It is called out rather than silently removed because the wrong URL in it was read as evidence
// that the template was missing a callback route, which sent a previous review down the wrong
// path entirely. Do not reintroduce a per-client token exchange.

// Now accepts optional locationId parameter
export async function saveSquareConnection(
  campgroundId: string,
  accessToken: string,
  refreshToken: string,
  merchantId: string,
  expiresAt: string,
  locationId?: string | null
) {
  const { error } = await supabase
    .from('square_connections')
    .upsert({
      campground_id: campgroundId,
      access_token: accessToken,
      refresh_token: refreshToken,
      merchant_id: merchantId,
      token_expires_at: expiresAt,
      ...(locationId ? { location_id: locationId } : {}),
      updated_at: new Date().toISOString(),
    }, { onConflict: 'campground_id' })

  if (error) throw error
}

export async function getSquareConnection(campgroundId: string) {
  const { data, error } = await supabase
    .from('square_connections')
    .select('*')
    .eq('campground_id', campgroundId)
    .single()

  if (error) return null
  return data
}

/**
 * Ask the platform to revoke this park's authorization at Square.
 *
 * Deleting the row is not disconnecting. Until Square is told, the access token stays live: the
 * park believes it has disconnected while this platform remains authorised to charge their
 * customers, and any copy of that token — a database backup, a log line — is still a working
 * payment credential.
 *
 * It goes through resonation-admin because RevokeToken authenticates with the PLATFORM
 * application secret, which deliberately does not exist on this deployment. Proof of identity is
 * a state signed with this tenant's own SQUARE_STATE_SECRET — the same seal as the connect
 * handshake, so there is no second credential to manage and no second thing to get wrong.
 *
 * Never throws. A revoke that fails must not prevent the local disconnect: leaving a park unable
 * to disconnect because the platform is unreachable is the worse outcome, and a lingering
 * authorization is at least visible to the merchant in their own Square dashboard.
 */
async function revokeAtSquare(campgroundId: string): Promise<boolean> {
  try {
    const state = signSquareState(process.env.SQUARE_STATE_SECRET || '', {
      campground_id: campgroundId,
      return_to: process.env.NEXT_PUBLIC_BASE_URL || '',
      environment: SQUARE_OAUTH_ENVIRONMENT,
    })
    const res = await fetch('https://admin.myresonation.com/api/square/revoke', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ state }),
    })
    const data = await res.json().catch(() => ({}))
    if (!res.ok || !data?.revoked) {
      console.error('Square revoke did not complete:', res.status, data)
      return false
    }
    return true
  } catch (e) {
    console.error('Square revoke request failed:', e)
    return false
  }
}

export async function deleteSquareConnection(campgroundId: string) {
  // Revoke FIRST, while the row still holds the token the platform needs to look up. Deleting
  // first would leave nothing to revoke and strand a live authorization at Square permanently.
  const revoked = await revokeAtSquare(campgroundId)

  const { error } = await supabase
    .from('square_connections')
    .delete()
    .eq('campground_id', campgroundId)

  if (error) throw error
  return { revoked }
}
