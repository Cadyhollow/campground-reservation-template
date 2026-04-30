import { NextRequest, NextResponse } from 'next/server'
import { exchangeCodeForTokens, saveSquareConnection } from '@/lib/square-oauth'

async function fetchSquareLocationId(accessToken: string): Promise<string | null> {
  try {
    const response = await fetch('https://connect.squareup.com/v2/locations', {
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Square-Version': '2024-01-18',
      },
    })
    const data = await response.json()
    if (data.locations && data.locations.length > 0) {
      return data.locations[0].id
    }
    return null
  } catch {
    return null
  }
}

export async function GET(request: NextRequest) {
  const searchParams = request.nextUrl.searchParams
  const code = searchParams.get('code')
  const state = searchParams.get('state')
  const error = searchParams.get('error')

  if (error) {
    return NextResponse.redirect(
      `${process.env.NEXT_PUBLIC_BASE_URL}/admin/settings/square?error=access_denied`
    )
  }

  if (!code || !state) {
    return NextResponse.redirect(
      `${process.env.NEXT_PUBLIC_BASE_URL}/admin/settings/square?error=missing_params`
    )
  }

  try {
    const tokens = await exchangeCodeForTokens(code)

    if (tokens.error) {
      console.error('Square token exchange error:', tokens)
      return NextResponse.redirect(
        `${process.env.NEXT_PUBLIC_BASE_URL}/admin/settings/square?error=token_exchange_failed`
      )
    }

    // Auto-fetch the location ID so we don't have to do it manually
    const locationId = await fetchSquareLocationId(tokens.access_token)

    await saveSquareConnection(
      state,
      tokens.access_token,
      tokens.refresh_token,
      tokens.merchant_id,
      tokens.expires_at,
      locationId
    )

    return NextResponse.redirect(
      `${process.env.NEXT_PUBLIC_BASE_URL}/admin/settings/square?success=true`
    )
  } catch (err) {
    console.error('Square callback error:', err)
    return NextResponse.redirect(
      `${process.env.NEXT_PUBLIC_BASE_URL}/admin/settings/square?error=server_error`
    )
  }
}
