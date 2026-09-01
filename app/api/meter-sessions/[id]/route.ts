import { NextRequest, NextResponse } from 'next/server'
import { svc, isSummit } from '@/lib/contract-server'
import { requireRole } from '@/lib/require-role'
import { loadMeterContext, getElectricRate } from '@/lib/meters-server'

// GET /api/meter-sessions/[id] — the walk queue: this session, every active meter in walking
// order, and for each one whose it is, whether it bills, what it read last, and this session's
// reading if it has already been taken.
//
// That last part is what makes the walk resumable. The phone can be closed at meter 12 of 79 and
// reopened an hour later on a different device, and the queue comes back with the same 12 filled
// in — progress lives in the database, not in the browser.
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const denied = await requireRole(request, 'staff')
  if (denied) return denied
  if (!(await isSummit())) return NextResponse.json({ error: 'Not available on this plan.' }, { status: 403 })

  const { id } = await params
  const { data: session } = await svc.from('meter_reading_sessions').select('*').eq('id', id).maybeSingle()
  if (!session) return NextResponse.json({ error: 'Session not found' }, { status: 404 })

  const [{ meters, conflicts }, rate] = await Promise.all([loadMeterContext(id), getElectricRate()])

  const read = meters.filter(m => m.reading !== null).length
  return NextResponse.json({
    session, meters, conflicts, rate,
    progress: { read, total: meters.length, remaining: meters.length - read },
  })
}
