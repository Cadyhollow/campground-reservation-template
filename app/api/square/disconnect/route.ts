import { NextResponse } from 'next/server'
import { deleteSquareConnection } from '@/lib/square-oauth'

export async function POST() {
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
