import { NextRequest, NextResponse } from 'next/server'
import { svc, isSummit } from '@/lib/contract-server'
import { requireRole } from '@/lib/require-role'
import { loadMeterContext, restageDraftsForSession, getElectricRate } from '@/lib/meters-server'
import { computeMeterUsage, computeElectricCharge } from '@/lib/electric-billing'

// POST /api/meter-readings — save ONE meter's reading.
//
// This is the write the whole field screen exists to make, and it does two things:
//   1. records the reading permanently, for every meter, billable or not;
//   2. for a billable meter, re-derives that camper's DRAFT bill.
//
// ⚠ IT POSTS NOTHING. No folio, no folio_line_items row, no email, no charge of any kind. See the
// long note over restageDraftsForSession() in lib/meters-server.ts for why a draft cannot be
// mistaken for money even by a consumer that forgets to filter on status.
//
// ⚠ THE SERVER RESOLVES `guest_id` AND `billable`, NEVER THE CLIENT. The phone sends a meter and
// a number. Who is on that site and whether it bills are decided here, from the registry and the
// guest list, so a crafted request cannot bill a camper who is not on the meter or bypass an
// owner's override. The client's own copy of those facts is UX.

export async function POST(request: NextRequest) {
  const denied = await requireRole(request, 'staff')
  if (denied) return denied
  if (!(await isSummit())) return NextResponse.json({ error: 'Not available on this plan.' }, { status: 403 })

  const body = await request.json().catch(() => ({}))
  const meterId = typeof body.meter_id === 'string' ? body.meter_id : ''
  const sessionId = typeof body.session_id === 'string' && body.session_id ? body.session_id : null
  if (!meterId) return NextResponse.json({ error: 'A meter id is required.' }, { status: 400 })

  const value = typeof body.reading_value === 'number' ? body.reading_value : parseFloat(body.reading_value)
  if (!Number.isFinite(value) || value < 0) {
    return NextResponse.json({ error: 'Enter the number on the meter.' }, { status: 400 })
  }

  const isReset = body.is_meter_reset === true
  const rawStart = typeof body.reset_start_value === 'number' ? body.reset_start_value : parseFloat(body.reset_start_value)
  const resetStart = isReset ? (Number.isFinite(rawStart) && rawStart >= 0 ? rawStart : 0) : null

  // A session must exist before its readings do; an ad-hoc read (session_id null) is a valid,
  // expected state — a move-out on the 14th belongs to no walk.
  let readAt = typeof body.read_at === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(body.read_at) ? body.read_at : ''
  if (sessionId) {
    const { data: session } = await svc.from('meter_reading_sessions')
      .select('id, read_date').eq('id', sessionId).maybeSingle()
    if (!session) return NextResponse.json({ error: 'Session not found' }, { status: 404 })
    if (!readAt) readAt = session.read_date
  }
  if (!readAt) readAt = new Date().toISOString().slice(0, 10)

  // THE SERVER'S OWN VIEW of this meter: who is on it, whether it bills, what it read last.
  const { meters } = await loadMeterContext(sessionId)
  const ctx = meters.find(m => m.meter.id === meterId)
  if (!ctx) return NextResponse.json({ error: 'Meter not found, or retired.' }, { status: 404 })

  // ⚠ `previous_value` IS SNAPSHOTTED, not recomputed later. It is what this reading carried from
  // at the moment it was taken; re-deriving it afterwards would quietly change a past reading's
  // meaning every time an earlier one was corrected.
  const previous = ctx.previousValue

  const row = {
    meter_id: meterId,
    session_id: sessionId,
    reading_value: value,
    previous_value: previous,
    read_at: readAt,
    is_meter_reset: isReset,
    reset_start_value: resetStart,
    guest_id: ctx.billable ? ctx.camper?.id ?? null : null,
    billable: ctx.billable && !!ctx.camper,
    notes: typeof body.notes === 'string' ? body.notes : '',
  }

  // One reading per meter per walk — going Prev and correcting a digit must UPDATE, not add a
  // second reading that would double this meter's usage into the draft bill. The unique index
  // (session_id, meter_id) is the guarantee; this is the path that respects it.
  let saved
  if (sessionId && ctx.reading) {
    const { data, error } = await svc.from('meter_readings')
      .update(row).eq('id', ctx.reading.id).select().single()
    if (error) return NextResponse.json({ error: error.message }, { status: 400 })
    saved = data
  } else {
    const { data, error } = await svc.from('meter_readings').insert(row).select().single()
    if (error) return NextResponse.json({ error: error.message }, { status: 400 })
    saved = data
  }

  // Re-derive this walk's drafts. Whole-session rather than one camper, because a double-site
  // camper's bill changes when EITHER of their meters is read.
  let staged: { drafts: number; skippedAlreadyPosted: string[] } | null = null
  if (sessionId) staged = await restageDraftsForSession(sessionId)

  // What the screen shows back: this meter's own usage and its share of the money, from the same
  // engine the bill uses.
  const rate = await getElectricRate()
  const kwh = computeMeterUsage(previous ?? 0, value, { isReset, resetStartValue: resetStart ?? 0 })
  const preview = computeElectricCharge(kwh, rate)

  return NextResponse.json({
    reading: saved,
    billable: row.billable,
    camper: ctx.camper,
    kwh,
    // ⚠ A PREVIEW, NOT THE BILL. For a camper on two sites the real bill sums both meters and
    // meets the minimum charge once, so this figure is this meter's contribution priced alone.
    approxAmountCents: preview.calculatedAmountCents,
    staged,
  })
}
