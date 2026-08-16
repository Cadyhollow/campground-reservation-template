import { NextRequest, NextResponse } from 'next/server'
import { getSquareConnection } from '@/lib/square-oauth'
import { requireRole } from '@/lib/require-role'

// What the Square settings screen renders from.
//
// STEP 9 ADDED THE HEALTH FIELDS, and they are the point of the endpoint now. A connection that
// has stopped being able to renew its access token is still "connected" in the only sense this
// route used to report — there is a row, there is a merchant id — and it will keep looking that
// way right up to the day the token expires and every charge starts failing at checkout. Reporting
// only `connected: true` is what makes that failure silent. The status and the failure timestamp
// are what let the screen say "reconnect required" a week early instead.
//
// NOTHING SECRET IS RETURNED. Not the access token, not the refresh token, not the service key —
// only the same public identifiers and health flags the owner is looking at the page to see. This
// endpoint is Owner-gated, but that is not a licence to widen it: the rule that a live payment
// credential never reaches a browser holds regardless of who is logged in.

export async function GET(request: NextRequest) {
  const denied = await requireRole(request, 'owner')
  if (denied) return denied

  try {
    const campgroundId = process.env.CAMPGROUND_ID || 'default'
    const connection = await getSquareConnection(campgroundId)

    return NextResponse.json({
      connected: !!connection,
      merchant_id: connection?.merchant_id || null,
      connected_at: connection?.connected_at || null,
      // 'connected' | 'location_pending' | 'reconnect_required'.
      status: connection?.status || null,
      // Set by the platform when a token refresh fails. Its presence is what turns the badge red.
      refresh_failed_at: connection?.refresh_failed_at || null,
      // Lets the screen say how long is left, rather than only that something is wrong.
      token_expires_at: connection?.token_expires_at || null,
      location_id: connection?.location_id || null,
    })
  } catch (error) {
    console.error('Square status error:', error)
    return NextResponse.json({ connected: false })
  }
}
