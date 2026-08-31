import { NextRequest, NextResponse } from 'next/server'
import { svc, isSummit } from '@/lib/contract-server'
import { requireRole } from '@/lib/require-role'

// GET /api/seasonals/campers — summit-gated. THE PEOPLE, and only the people.
//
// ⚠ THIS ROUTE IS DELIBERATELY SEASON-BLIND, AND THAT IS THE WHOLE DESIGN.
//
// The Campers list is a list of names. The paperwork — who is enrolled, what they owe, what has
// been sent, what is signed — belongs to /api/seasonals/list and the Contracts page, which are
// per-season by nature. An earlier cut of this route joined the season's contracts onto every row
// so the list could show enrolment status inline; that made Campers a second, worse Contracts
// page, and it also meant the list had to know which season it was looking at, which introduced a
// race between the no-season first render and the real one.
//
// So it takes no season, joins no contracts, and returns no money. A camper is a person here.
// Enrolment lives on that person's own page, where choosing a season is an explicit act.
export async function GET(request: NextRequest) {
  const denied = await requireRole(request, 'staff')
  if (denied) return denied

  if (!(await isSummit())) return NextResponse.json({ error: 'Not available on this plan.' }, { status: 403 })

  // select('*') rather than a column list, so a park that has not run the seasonal_active
  // migration yet still gets a working list. Naming a missing column fails the WHOLE query, and
  // an empty directory is a far worse failure than everyone reading as active — which is exactly
  // what the column's default says anyway.
  const { data, error } = await svc.from('guests').select('*').eq('is_seasonal', true)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  const guests = data || []
  const hasActiveColumn = guests.length > 0 && 'seasonal_active' in guests[0]

  const rows = guests.map(g => ({
    guest_id: g.id as string,
    name: (g.name as string) || '',
    site_number: (g.site_number as string) || '',
    // Absent column ⇒ active, matching the migration's DEFAULT true.
    active: hasActiveColumn ? g.seasonal_active !== false : true,
  })).sort((a, b) => {
    if (a.active !== b.active) return a.active ? -1 : 1
    return (a.site_number || '').localeCompare(b.site_number || '', undefined, { numeric: true })
      || a.name.localeCompare(b.name)
  })

  return NextResponse.json({ rows, total: rows.length, has_active_column: hasActiveColumn })
}

// PATCH /api/seasonals/campers — mark a seasonal camper active or inactive.
//
// ⚠ THE ONLY COLUMN THIS TOUCHES IS seasonal_active. It is its own endpoint rather than a field on
// the personal-info save, because "has left the programme" is a decision, not a typo correction —
// it must never ride along on somebody fixing a phone number.
//
// Inactive is NOT a delete and NOT `is_seasonal = false`. The camper stays seasonal, stays on this
// list, and keeps every contract, payment and reading they ever had; they are marked. Clearing
// is_seasonal was the old way to say "they left", and it removed them from every seasonal screen
// at once — the record you need is the record that disappeared.
export async function PATCH(request: NextRequest) {
  const denied = await requireRole(request, 'manager')
  if (denied) return denied

  if (!(await isSummit())) return NextResponse.json({ error: 'Not available on this plan.' }, { status: 403 })

  try {
    const body = await request.json()
    const guest_id: string | undefined = body.guest_id
    if (!guest_id) return NextResponse.json({ error: 'Missing guest_id' }, { status: 400 })
    if (typeof body.active !== 'boolean') {
      return NextResponse.json({ error: 'active must be true or false' }, { status: 400 })
    }

    // Guard on the column the same way the read does, so a park without the migration gets a
    // clear sentence instead of a PostgREST error about an unknown column.
    const { data: probe } = await svc.from('guests').select('*').eq('id', guest_id).maybeSingle()
    if (!probe) return NextResponse.json({ error: 'Camper not found.' }, { status: 404 })
    if (!('seasonal_active' in probe)) {
      return NextResponse.json(
        { error: 'This park has not run the seasonal_active migration yet.' }, { status: 409 })
    }

    const { data, error } = await svc
      .from('guests').update({ seasonal_active: body.active }).eq('id', guest_id)
      .select('id, seasonal_active').single()
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    return NextResponse.json({ guest_id: data.id, active: data.seasonal_active !== false })
  } catch {
    return NextResponse.json({ error: 'Something went wrong' }, { status: 500 })
  }
}
