import { NextRequest, NextResponse } from 'next/server'
import { svc, isSummit, errMessage } from '@/lib/contract-server'
import { requireRole } from '@/lib/require-role'

// /api/seasons — the park's named seasons ("2027 Spring"), Phase 2a.
//
// MANAGER + SUMMIT, the same pair every seasonal-contract route carries. A season is park
// configuration that decides what contracts can exist, so it sits with create/send/cancel rather
// than with the staff-level reads.
//
// Service-role client, like the rest of the seasonal feature: the admin browser never touches
// this table directly. The RLS on `seasons` (select=staff, write=owner) is the independent second
// lock for anything that reaches the database as `authenticated` — see the migration.
//
// NO DELETE ROUTE, deliberately. A season may already have contracts hanging off it, and what
// should happen to them — refuse, reassign, cascade — is a product decision rather than a
// technical one. Leaving it out is the honest answer until that decision is made; the RLS policy
// for delete exists so the posture is complete, not because anything exercises it.

/** Trim to a string, or null when there is nothing there. */
const str = (v: unknown): string | null => {
  const s = (v ?? '').toString().trim()
  return s || null
}
/** A 'YYYY-MM-DD' date, or null. Empty string means "cleared", which is a legitimate edit. */
const dateOrNull = (v: unknown): string | null => str(v)

// GET /api/seasons — every season, newest year first, then by name.
export async function GET(request: NextRequest) {
  const denied = await requireRole(request, 'manager')
  if (denied) return denied

  try {
    if (!(await isSummit())) {
      return NextResponse.json({ error: 'Not available on this plan.' }, { status: 403 })
    }
    const { data, error } = await svc
      .from('seasons')
      .select('id, name, year, opens, closes, created_at')
      .order('year', { ascending: false })
      .order('name', { ascending: true })
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    return NextResponse.json({ seasons: data || [] })
  } catch (e) {
    return NextResponse.json({ error: errMessage(e, 'Something went wrong') }, { status: 500 })
  }
}

// POST /api/seasons  { name, year, opens?, closes? }
export async function POST(request: NextRequest) {
  const denied = await requireRole(request, 'manager')
  if (denied) return denied

  try {
    if (!(await isSummit())) {
      return NextResponse.json({ error: 'Not available on this plan.' }, { status: 403 })
    }
    const body = await request.json()
    const name = str(body.name)
    const year = parseInt(body.year, 10)
    if (!name) return NextResponse.json({ error: 'A season name is required.' }, { status: 400 })
    if (!Number.isFinite(year)) return NextResponse.json({ error: 'A season year is required.' }, { status: 400 })

    const { data, error } = await svc
      .from('seasons')
      .insert({ name, year, opens: dateOrNull(body.opens), closes: dateOrNull(body.closes) })
      .select('id, name, year, opens, closes, created_at')
      .single()
    if (error || !data) {
      return NextResponse.json({ error: error?.message || 'Could not create the season.' }, { status: 500 })
    }
    return NextResponse.json({ season: data })
  } catch (e) {
    return NextResponse.json({ error: errMessage(e, 'Something went wrong') }, { status: 500 })
  }
}
