import { NextRequest, NextResponse } from 'next/server'
import { svc, isSummit, errMessage, findOrCreateSeasonForYear } from '@/lib/contract-server'
import { requireRole } from '@/lib/require-role'



// POST /api/seasonal-contracts/clone  { from_year, to_year, preview? }
//
// Summit-gated. For every is_seasonal guest who had a from_year contract, create a
// to_year DRAFT. occupants + total_due_cents carry FORWARD from last year's row;
// site_number, season dates, and all six rig fields are re-read FRESH from the
// guest record (a camper who changed rig or site gets the new values). Never reads
// rig/site from last year's row.
//
// Idempotent: skips any guest that already has a to_year row, and survives a
// unique-constraint race per guest without failing the batch — mirroring the create
// route's 23505 handling. (Phase 2a swapped that constraint from (guest_id,
// season_year) to (guest_id, season_id); the 23505 handling is unchanged and still
// correct, because every row in a batch shares one season.) Never creates or modifies
// guest rows. Never sends, never issues tokens; status stays 'draft'.
//
// preview:true returns { would_create, would_skip } and writes NOTHING — used by
// the confirm dialog to show the count before the staff commits.
export async function POST(request: NextRequest) {
  const denied = await requireRole(request, 'manager')
  if (denied) return denied

  try {
    if (!(await isSummit())) {
      return NextResponse.json({ error: 'Not available on this plan.' }, { status: 403 })
    }
    const body = await request.json()
    const from_year = parseInt(body.from_year, 10)
    const to_year = parseInt(body.to_year, 10)
    const preview = body.preview === true
    if (!from_year || !to_year) {
      return NextResponse.json({ error: 'Missing from_year or to_year' }, { status: 400 })
    }
    if (from_year === to_year) {
      return NextResponse.json({ error: 'from_year and to_year must differ' }, { status: 400 })
    }

    // Last year's contracts are the source set (occupants + total_due carry forward).
    const { data: fromRows, error: fErr } = await svc
      .from('seasonal_contracts')
      .select('guest_id, occupants, total_due_cents')
      .eq('season_year', from_year)
    if (fErr) return NextResponse.json({ error: fErr.message }, { status: 500 })
    const sources = fromRows || []
    if (sources.length === 0) {
      return preview
        ? NextResponse.json({ preview: true, from_year, to_year, would_create: 0, would_skip: 0 })
        : NextResponse.json({ from_year, to_year, created: 0, skipped: 0, errors: [] })
    }

    const guestIds = [...new Set(sources.map(r => r.guest_id))]

    // Fresh guest truth — site + all six rig fields + current is_seasonal flag.
    const { data: guests } = await svc
      .from('guests')
      .select('id, is_seasonal, site_number, season_start, season_end, camper_make, camper_model, camper_year, camper_type, camper_length, camper_amperage')
      .in('id', guestIds)
    const guestById = new Map((guests || []).map(g => [g.id, g]))

    // Guests already holding a to_year row → skip (idempotent).
    const { data: existing } = await svc
      .from('seasonal_contracts')
      .select('guest_id')
      .eq('season_year', to_year)
      .in('guest_id', guestIds)
    const alreadyHave = new Set((existing || []).map(r => r.guest_id))

    // Decide per guest (one source row each — guard against dup source rows).
    // Rows from select('*'), so an index signature is the honest shape — see DbRow in
    // lib/contract-server.ts for the same reasoning.
    const toCreate: { src: Record<string, unknown>; guest: Record<string, unknown> }[] = []
    let skipped = 0
    const errors: { guest_id: string; reason: string }[] = []
    const seen = new Set<string>()
    for (const src of sources) {
      const gid = src.guest_id
      if (seen.has(gid)) continue
      seen.add(gid)
      const guest = guestById.get(gid)
      if (!guest || !guest.is_seasonal) { skipped++; continue } // no longer seasonal → skip
      if (alreadyHave.has(gid)) { skipped++; continue }         // already has to_year → skip
      toCreate.push({ src, guest })
    }

    if (preview) {
      return NextResponse.json({ preview: true, from_year, to_year, would_create: toCreate.length, would_skip: skipped })
    }

    // Phase 2a: season_id is NOT NULL. Resolved ONCE for the batch rather than per guest — every
    // row here is for the same to_year, and doing it once means a batch cannot end up split
    // across two seasons if a concurrent request creates one midway.
    //
    // Deliberately AFTER the preview early-return above, so `preview: true` still writes nothing
    // at all — including no auto-created season.
    const season = await findOrCreateSeasonForYear(to_year)
    if (!season.ok) return NextResponse.json({ error: season.error }, { status: 500 })

    let created = 0
    for (const { src, guest } of toCreate) {
      const draft = {
        guest_id: guest.id,
        season_year: to_year,
        season_id: season.season_id,
        status: 'draft',
        // FRESH from the guest record:
        site_number: guest.site_number || '',
        season_opens: guest.season_start ?? null,
        season_closes: guest.season_end ?? null,
        camper_type: guest.camper_type ?? null,
        camper_length: guest.camper_length ?? null,
        camper_amperage: guest.camper_amperage ?? null,
        camper_make: guest.camper_make ?? null,
        camper_model: guest.camper_model ?? null,
        camper_year: guest.camper_year ?? null,
        // COPIED FORWARD from last year's row:
        occupants: src.occupants ?? [],
        total_due_cents: src.total_due_cents ?? null,
      }
      const { error } = await svc.from('seasonal_contracts').insert(draft)
      if (error) {
        if ((error as { code?: string }).code === '23505') { skipped++; continue } // lost the unique-constraint race → skip
        errors.push({ guest_id: String(guest.id ?? ''), reason: error.message })
        continue
      }
      created++
    }

    return NextResponse.json({ from_year, to_year, created, skipped, errors })
  } catch (e) {
    return NextResponse.json({ error: errMessage(e, 'Something went wrong') }, { status: 500 })
  }
}
