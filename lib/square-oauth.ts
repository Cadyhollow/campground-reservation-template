import { createClient } from '@supabase/supabase-js'

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

const SQUARE_BASE_URL =
  process.env.SQUARE_ENVIRONMENT === 'production'
    ? 'https://connect.squareup.com'
    : 'https://connect.squareupsandbox.com'

export function getSquareAuthUrl(campgroundId: string): string {
  const params = new URLSearchParams({
    client_id: process.env.SQUARE_APPLICATION_ID!,
    scope: 'PAYMENTS_WRITE PAYMENTS_READ ORDERS_WRITE MERCHANT_PROFILE_READ',
    session: 'false',
    state: campgroundId,
  })

  return `${SQUARE_BASE_URL}/oauth2/authorize?${params.toString()}`
}

export async function exchangeCodeForTokens(code: string) {
  const response = await fetch(`${SQUARE_BASE_URL}/oauth2/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: process.env.SQUARE_APPLICATION_ID,
      client_secret: process.env.SQUARE_APPLICATION_SECRET,
      code,
      grant_type: 'authorization_code',
      redirect_uri: `${process.env.NEXT_PUBLIC_BASE_URL}/api/square/callback`,
    }),
  })

  return response.json()
}

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
