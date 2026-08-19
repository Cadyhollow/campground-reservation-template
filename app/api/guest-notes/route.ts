import { NextRequest, NextResponse } from 'next/server'
import { svc, isSummit } from '@/lib/contract-server'
import { requireRole } from '@/lib/require-role'

// POST /api/guest-notes — summit-gated. Append a note. No edit, no delete route.
export async function POST(request: NextRequest) {
  const denied = await requireRole(request, 'staff')
  if (denied) return denied

  if (!(await isSummit())) return NextResponse.json({ error: 'Not available on this plan.' }, { status: 403 })
  const body = await request.json()
  const guest_id: string | undefined = body.guest_id
  const text: string = (body.body || '').trim()
  const author: string = (body.author || 'Staff').trim() || 'Staff'
  if (!guest_id || !text) return NextResponse.json({ error: 'Missing guest_id or note text.' }, { status: 400 })

  const { data, error } = await svc.from('guest_notes')
    .insert({ guest_id, author, body: text })
    .select('id, created_at, author, body')
    .single()
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ note: data })
}
