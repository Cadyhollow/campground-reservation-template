import { createClient } from '@supabase/supabase-js'
import { signSquareState } from '@/lib/square-state'

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

const SQUARE_BASE_URL =
  process.env.SQUARE_ENVIRONMENT === 'production'
    ? 'https://connect.squareup.com'
    : 'https://connect.squareupsandbox.com'

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

export async function deleteSquareConnection(campgroundId: string) {
  const { error } = await supabase
    .from('square_connections')
    .delete()
    .eq('campground_id', campgroundId)

  if (error) throw error
}
