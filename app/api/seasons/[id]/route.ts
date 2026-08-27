import { NextRequest, NextResponse } from 'next/server'
import { svc, isSummit, errMessage } from '@/lib/contract-server'
import { requireRole } from '@/lib/require-role'

// PATCH /api/seasons/[id]  — edit a season's name, year, or dates. Phase 2a.
//
// Same gates as POST /api/seasons: manager + Summit, service-role client.
//
// ⚠ A SEASON IS EDITABLE EVEN ONCE CONTRACTS HANG OFF IT, AND THAT IS SAFE — because a SENT
// contract carries its own FROZEN season_opens/season_closes, copied at send time. Renaming
// "2027 Season" to "2027 Spring", or correcting its dates, therefore cannot alter a legal
// document a camper has already signed. It changes what NEW drafts inherit, which is the point.
// (Phase 2b is what starts seeding a draft's dates from its season; today the dates here are
// stored and displayed only.)
//
// `season_year` on seasonal_contracts is a denormalised mirror of seasons.year. Editing a
// season's YEAR here does NOT rewrite that mirror on existing contracts — deliberately: those
// rows record which year each contract was actually created for, and several routes still read
// them. Changing a season's year is expected to be a correction made before contracts exist.

const str = (v: unknown): string | null => {
  const s = (v ?? '').toString().trim()
  return s || null
}

/** Fields an owner may edit on a season. */
const EDITABLE = ['name', 'year', 'opens', 'closes'] as const

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const denied = await requireRole(request, 'manager')
  if (denied) return denied

  try {
    if (!(await isSummit())) {
      return NextResponse.json({ error: 'Not available on this plan.' }, { status: 403 })
    }
    const { id } = await params
    const body = await request.json()

    // `unknown` rather than `any`: this object is handed straight to PostgREST, so nothing here
    // dereferences the values — it only carries them.
    const patch: Record<string, unknown> = {}
    for (const k of EDITABLE) {
      if (!(k in body)) continue
      if (k === 'year') {
        const year = parseInt(body.year, 10)
        if (!Number.isFinite(year)) return NextResponse.json({ error: 'That season year is not valid.' }, { status: 400 })
        patch.year = year
      } else if (k === 'name') {
        const name = str(body.name)
        // A season with no name is the one edit that must be refused: the name is the whole
        // feature, and a blank one makes the season unpickable in Phase 2b's dropdown.
        if (!name) return NextResponse.json({ error: 'A season name is required.' }, { status: 400 })
        patch.name = name
      } else {
        // Dates: an empty string clears the date, which is a legitimate edit.
        patch[k] = str(body[k])
      }
    }
    if (Object.keys(patch).length === 0) {
      return NextResponse.json({ error: 'No editable fields provided.' }, { status: 400 })
    }

    const { data, error } = await svc
      .from('seasons')
      .update(patch)
      .eq('id', id)
      .select('id, name, year, opens, closes, created_at')
      .single()
    if (error || !data) {
      return NextResponse.json({ error: error?.message || 'Season not found.' }, { status: 404 })
    }
    return NextResponse.json({ season: data })
  } catch (e) {
    return NextResponse.json({ error: errMessage(e, 'Something went wrong') }, { status: 500 })
  }
}
