import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

export async function POST(request: NextRequest) {
  try {
    const { deviceName } = await request.json()

    // Generate a device code from Square
    const squareResponse = await fetch('https://connect.squareup.com/v2/devices/codes', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.SQUARE_ACCESS_TOKEN}`,
        'Square-Version': '2024-01-18',
      },
      body: JSON.stringify({
        idempotency_key: `pair-${Date.now()}`,
        device_code: {
          name: deviceName || 'ResoNation Terminal',
          product_type: 'TERMINAL_API',
          location_id: process.env.SQUARE_LOCATION_ID,
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
  try {
    const { searchParams } = new URL(request.url)
    const deviceCodeId = searchParams.get('deviceCodeId')

    if (!deviceCodeId) {
      return NextResponse.json({ error: 'Missing deviceCodeId' }, { status: 400 })
    }

    // Check pairing status
    const squareResponse = await fetch(
      `https://connect.squareup.com/v2/devices/codes/${deviceCodeId}`,
      {
        headers: {
          'Authorization': `Bearer ${process.env.SQUARE_ACCESS_TOKEN}`,
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
