import { NextRequest, NextResponse } from 'next/server'
import { getSquareAuthUrl } from '@/lib/square-oauth'
import { requireRole } from '@/lib/require-role'

export async function GET(request: NextRequest) {
  const denied = await requireRole(request, 'owner')
  if (denied) return denied

  try {
    const campgroundId = process.env.CAMPGROUND_ID || 'default'
    const authUrl = getSquareAuthUrl(campgroundId)
    return NextResponse.redirect(authUrl)
  } catch (error) {
    console.error('Square connect error:', error)
    return NextResponse.json(
      { error: 'Failed to initiate Square connection' },
      { status: 500 }
    )
  }
}
