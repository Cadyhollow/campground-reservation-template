import { NextResponse } from 'next/server'
import { getSquareAuthUrl } from '@/lib/square-oauth'

export async function GET() {
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
