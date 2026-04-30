import { NextResponse } from 'next/server'
import { getSquareConnection } from '@/lib/square-oauth'

export async function GET() {
  try {
    const campgroundId = process.env.CAMPGROUND_ID || 'default'
    const connection = await getSquareConnection(campgroundId)

    return NextResponse.json({
      connected: !!connection,
      merchant_id: connection?.merchant_id || null,
      connected_at: connection?.connected_at || null,
    })
  } catch (error) {
    console.error('Square status error:', error)
    return NextResponse.json({ connected: false })
  }
}
