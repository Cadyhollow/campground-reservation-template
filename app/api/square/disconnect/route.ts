import { NextRequest, NextResponse } from 'next/server'
import { deleteSquareConnection } from '@/lib/square-oauth'
import { requireRole } from '@/lib/require-role'

export async function POST(request: NextRequest) {
  const denied = await requireRole(request, 'owner')
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
