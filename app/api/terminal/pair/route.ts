import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { requireRole } from '@/lib/require-role'
import { getSquareCredentials, SquareCredentialsError } from '@/lib/square-credentials'

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

// A device is paired to a Square LOCATION, and that location belongs to a Square ACCOUNT. Both
// handlers therefore resolve credentials the same way every charging path does, so the terminal
// a park pairs is a terminal that park's own account can charge on. Pairing against one account
// and charging on another would hand back a device code that never completes.
function credentialsDenied(e: unknown) {
  const problem = e instanceof SquareCredentialsError ? e.problem : 'not_connected'
  console.error('Square credentials unavailable for Terminal pairing:', problem, e)
  return NextResponse.json({
    error: problem === 'location_pending'
      ? 'Square is connected but no location has been chosen yet. Choose one in Settings before pairing a Terminal.'
      : 'Square is not connected. Connect a Square account in Settings before pairing a Terminal.',
  }, { status: 503 })
}

export async function POST(request: NextRequest) {
  const denied = await requireRole(request, 'owner')
  if (denied) return denied

  try {
    const { deviceName } = await request.json()

    let square
    try {
      square = await getSquareCredentials()
    } catch (e) {
      return credentialsDenied(e)
    }

    // Generate a device code from Square
    const squareResponse = await fetch(`${square.apiBase}/v2/devices/codes`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${square.accessToken}`,
        'Square-Version': '2024-01-18',
      },
      body: JSON.stringify({
        idempotency_key: `pair-${Date.now()}`,
        device_code: {
          name: deviceName || 'ResoNation Terminal',
          product_type: 'TERMINAL_API',
          location_id: square.locationId,
        },
      }),
    })

    const squareData = await squareResponse.json()

    if (!squareResponse.ok || !squareData.device_code) {
      console.error('Square pairing error:', squareData)
      return NextResponse.json(
        { error: squareData.errors?.[0]?.detail || 'Failed to generate device code' },
        { status: 400 }
      )
    }

    const deviceCode = squareData.device_code

    return NextResponse.json({
      success: true,
      code: deviceCode.code,
      deviceCodeId: deviceCode.id,
      status: deviceCode.status,
      expiresAt: deviceCode.pair_by,
    })

  } catch (error: any) {
    console.error('Terminal pair error:', error)
    return NextResponse.json({ error: error.message || 'Unexpected error' }, { status: 500 })
  }
}

export async function GET(request: NextRequest) {
  const denied = await requireRole(request, 'owner')
  if (denied) return denied

  try {
    const { searchParams } = new URL(request.url)
    const deviceCodeId = searchParams.get('deviceCodeId')

    if (!deviceCodeId) {
      return NextResponse.json({ error: 'Missing deviceCodeId' }, { status: 400 })
    }

    let square
    try {
      square = await getSquareCredentials()
    } catch (e) {
      return credentialsDenied(e)
    }

    // Check pairing status
    const squareResponse = await fetch(
      `${square.apiBase}/v2/devices/codes/${deviceCodeId}`,
      {
        headers: {
          'Authorization': `Bearer ${square.accessToken}`,
          'Square-Version': '2024-01-18',
        },
      }
    )

    const squareData = await squareResponse.json()

    if (!squareResponse.ok) {
      return NextResponse.json({ error: 'Failed to check pairing status' }, { status: 400 })
    }

    const deviceCode = squareData.device_code
    const isPaired = deviceCode.status === 'PAIRED'
    const deviceId = deviceCode.device_id || ''

    // If paired, save device ID to settings
    if (isPaired && deviceId) {
      await supabase
        .from('settings')
        .update({
          square_terminal_device_id: deviceId,
          square_terminal_name: deviceCode.name || 'ResoNation Terminal',
        })
        .neq('id', '00000000-0000-0000-0000-000000000000')
    }

    return NextResponse.json({
      status: deviceCode.status,
      isPaired,
      deviceId,
    })

  } catch (error: any) {
    console.error('Terminal status error:', error)
    return NextResponse.json({ error: error.message || 'Unexpected error' }, { status: 500 })
  }
}
