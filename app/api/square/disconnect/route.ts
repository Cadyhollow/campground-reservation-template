import { NextRequest, NextResponse } from 'next/server'
import { deleteSquareConnection } from '@/lib/square-oauth'
import { requireAdmin } from '@/lib/require-admin'

export async function POST(request: NextRequest) {
  const denied = await requireAdmin(request)
  if (denied) return denied

  try {
    const campgroundId = process.env.CAMPGROUND_ID || 'default'
    await deleteSquareConnection(campgroundId)

    return NextResponse.json({ success: true })
  } catch (error) {
    console.error('Square disconnect error:', error)
    return NextResponse.json(
      { error: 'Failed to disconnect Square account' },
      { status: 500 }
    )
  }
}
