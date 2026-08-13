import { NextResponse } from 'next/server'
import {
  getSquareCredentials,
  publicConfig,
  SquareCredentialsError,
  type PublicSquareConfig,
} from '@/lib/square-credentials'

// What the browser needs to draw a Square card form, and nothing else.
//
// PUBLIC ON PURPOSE. /book is a public page — a camper paying for a site is not logged in — so
// this cannot be gated. That is safe because all three fields are public identifiers: the
// application id and location id are visible in any Square checkout on the open web, and the
// environment is not a secret either. The access token is the thing that must never travel this
// path, and it does not: publicConfig() names its three fields one at a time and the credentials
// object is never spread into a response. lib/square-credentials.test.ts pins that key set.
//
// WHY IT EXISTS. The card form used to initialise from NEXT_PUBLIC_SQUARE_APP_ID and
// NEXT_PUBLIC_SQUARE_LOCATION_ID. NEXT_PUBLIC_* values are baked into the bundle at BUILD time,
// so a value that only becomes known when an owner connects Square — after the build, from a
// different service — cannot live there at all. Reading it at request time from the same resolver
// the charge uses also means the form and the charge cannot drift onto different accounts: they
// are answering the same question with the same code.

export const dynamic = 'force-dynamic'

export async function GET() {
  try {
    const creds = await getSquareCredentials()
    const config: PublicSquareConfig = publicConfig(creds)
    return NextResponse.json(config, {
      // Never cached, at any layer. A cached config would keep serving the old account after a
      // park reconnects or switches location — which is a charge landing somewhere stale.
      headers: { 'Cache-Control': 'no-store' },
    })
  } catch (e) {
    const problem = e instanceof SquareCredentialsError ? e.problem : 'not_connected'
    // 503, not 500: the service is fine, this campground simply has no usable Square account yet.
    // The card form turns this into an honest "online payments aren't set up" message instead of
    // the empty box the SDK leaves behind when it cannot initialise.
    return NextResponse.json({ error: problem }, { status: 503, headers: { 'Cache-Control': 'no-store' } })
  }
}
