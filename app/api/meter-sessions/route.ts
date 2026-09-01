import { NextRequest, NextResponse } from 'next/server'
import { svc, isSummit } from '@/lib/contract-server'
import { requireRole } from '@/lib/require-role'
import { restageDraftsForSession } from '@/lib/meters-server'

// Reading sessions — a dated walk of the park.
//
//   GET   — recent walks, newest first, with how far each got.
//   POST  — start one.
//   PATCH — rename it, or mark it complete.
//
// ⚠ THE BILLING MONTH IS A LABEL THE OWNER PICKS AND NOTHING HERE CHECKS IT AGAINST THE DATE.
// Parks read the meters in the last days of August and call it the September bill; that is normal
// practice, not an error, and month arithmetic here would reject the park's own workflow.

export async function GET(request: NextRequest) {
  const denied = await requireRole(request, 'staff')
  if (denied) return denied
  if (!(await isSummit())) return NextResponse.json({ error: 'Not available on this plan.' }, { status: 403 })

  const { data: sessions } = await svc.from('meter_reading_sessions')
    .select('*').order('read_date', { ascending: false }).order('created_at', { ascending: false }).limit(24)

  const ids = (sessions || []).map(s => s.id)
  const counts = new Map<string, number>()
  if (ids.length) {
    const { data: readings } = await svc.from('meter_readings').select('session_id').in('session_id', ids)
    for (const r of readings || []) {
      const k = r.session_id as string
      counts.set(k, (counts.get(k) || 0) + 1)
    }
  }
  const { count: activeMeters } = await svc.from('meters')
    .select('id', { count: 'exact', head: true }).eq('active', true)

  return NextResponse.json({
    sessions: (sessions || []).map(s => ({ ...s, readings_taken: counts.get(s.id) || 0 })),
    activeMeters: activeMeters || 0,
  })
}

export async function POST(request: NextRequest) {
  const denied = await requireRole(request, 'staff')
  if (denied) return denied
  if (!(await isSummit())) return NextResponse.json({ error: 'Not available on this plan.' }, { status: 403 })

  const body = await request.json().catch(() => ({}))
  const billing_month = typeof body.billing_month === 'string' ? body.billing_month.trim() : ''
  if (!billing_month) return NextResponse.json({ error: 'Pick a billing month.' }, { status: 400 })

  const read_date = typeof body.read_date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(body.read_date)
    ? body.read_date
    : new Date().toISOString().slice(0, 10)

  const { data, error } = await svc.from('meter_reading_sessions').insert({
    label: typeof body.label === 'string' && body.label.trim() ? body.label.trim() : billing_month,
    billing_month,
    read_date,
    status: 'in_progress',
    notes: typeof body.notes === 'string' ? body.notes : '',
  }).select().single()

  if (error) return NextResponse.json({ error: error.message }, { status: 400 })
  return NextResponse.json({ session: data })
}

export async function PATCH(request: NextRequest) {
  const denied = await requireRole(request, 'staff')
  if (denied) return denied
  if (!(await isSummit())) return NextResponse.json({ error: 'Not available on this plan.' }, { status: 403 })

  const body = await request.json().catch(() => ({}))
  const id = typeof body.id === 'string' ? body.id : ''
  if (!id) return NextResponse.json({ error: 'A session id is required.' }, { status: 400 })

  const patch: Record<string, unknown> = {}
  if (body.status === 'complete' || body.status === 'in_progress') {
    patch.status = body.status
    patch.completed_at = body.status === 'complete' ? new Date().toISOString() : null
  }
  if (typeof body.label === 'string') patch.label = body.label
  if (typeof body.notes === 'string') patch.notes = body.notes
  if (typeof body.billing_month === 'string' && body.billing_month.trim()) patch.billing_month = body.billing_month.trim()
  if (!Object.keys(patch).length) return NextResponse.json({ error: 'Nothing to change.' }, { status: 400 })

  const { data, error } = await svc.from('meter_reading_sessions')
    .update(patch).eq('id', id).select().maybeSingle()
  if (error) return NextResponse.json({ error: error.message }, { status: 400 })

  // Moving the walk to a different billing month moves its drafts with it — otherwise they would
  // sit forever on a month the owner is no longer looking at. Restaging is idempotent.
  if (patch.billing_month) await restageDraftsForSession(id)

  return NextResponse.json({ session: data })
}
