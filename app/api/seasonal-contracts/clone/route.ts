import { NextRequest, NextResponse } from 'next/server'
import { svc, isSummit, errMessage, findOrCreateSeasonForYear } from '@/lib/contract-server'
import { requireRole } from '@/lib/require-role'



// POST /api/seasonal-contracts/clone
//   { from_season_id, to_season_id, preview? }   ← Phase 2c, what the UI sends
//   { from_year, to_year, preview? }             ← pre-2c, still accepted
//
// Phase 2c: the clone runs SEASON → SEASON, so a park can roll its Spring roster into next
// year's Spring without touching the Fall. The year form is kept working (it resolves each year
// to that year's default season, the same earliest-created rule everything else uses), because
// the cost is one resolve and it keeps any older caller correct rather than silently wrong.
//
// Summit-gated. For every is_seasonal guest who had a contract in the FROM season, create a
// DRAFT in the TO season. occupants + total_due_cents carry FORWARD from the source row;
// site_number and all six rig fields are re-read FRESH from the guest record (a camper who
// changed rig or site gets the new values). Never reads rig/site from the old row. The season
// DATES are neither carried nor seeded — the draft inherits the to season's (Phase 2b).
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
    const preview = body.preview === true

    // Resolve both ends to SEASON IDS, whichever form the caller used.
    let from_season_id: string = body.from_season_id || ''
    let to_season_id: string = body.to_season_id || ''
    if (!from_season_id || !to_season_id) {
      const from_year = parseInt(body.from_year, 10)
      const to_year = parseInt(body.to_year, 10)
      if (!from_year || !to_year) {
        return NextResponse.json({ error: 'Missing from_season_id or to_season_id' }, { status: 400 })
      }
      if (from_year === to_year) {
        return NextResponse.json({ error: 'The two seasons must differ' }, { status: 400 })
      }
      const [fromSeason, toSeason] = await Promise.all([
        findOrCreateSeasonForYear(from_year),
        findOrCreateSeasonForYear(to_year),
      ])
      if (!fromSeason.ok) return NextResponse.json({ error: fromSeason.error }, { status: 500 })
      if (!toSeason.ok) return NextResponse.json({ error: toSeason.error }, { status: 500 })
      from_season_id = fromSeason.season_id
      to_season_id = toSeason.season_id
    }
    if (from_season_id === to_season_id) {
      return NextResponse.json({ error: 'The two seasons must differ' }, { status: 400 })
    }

    // The years still travel in the response — the confirm dialog shows them — so read them off
    // the seasons rather than trusting whatever the caller sent.
    const { data: seasonRows } = await svc.from('seasons').select('id, year').in('id', [from_season_id, to_season_id])
    const yearOf = new Map((seasonRows || []).map(r => [r.id, r.year as number]))
    const from_year = yearOf.get(from_season_id) ?? 0
    const to_year = yearOf.get(to_season_id) ?? 0
    if (!from_year || !to_year) {
      return NextResponse.json({ error: 'One of those seasons no longer exists.' }, { status: 404 })
    }

    // The FROM season's contracts are the source set (occupants + total_due carry forward).
    const { data: fromRows, error: fErr } = await svc
      .from('seasonal_contracts')
      .select('guest_id, occupants, total_due_cents')
      .eq('season_id', from_season_id)
    if (fErr) return NextResponse.json({ error: fErr.message }, { status: 500 })
    const sources = fromRows || []
    if (sources.length === 0) {
      return preview
        ? NextResponse.json({ preview: true, from_year, to_year, from_season_id, to_season_id, would_create: 0, would_skip: 0 })
        : NextResponse.json({ from_year, to_year, from_season_id, to_season_id, created: 0, skipped: 0, errors: [] })
    }

    const guestIds = [...new Set(sources.map(r => r.guest_id))]

    // Fresh guest truth — site + all six rig fields + current is_seasonal flag.
    const { data: guests } = await svc
      .from('guests')
      .select('id, is_seasonal, site_number, camper_make, camper_model, camper_year, camper_type, camper_length, camper_amperage')
      .in('id', guestIds)
    const guestById = new Map((guests || []).map(g => [g.id, g]))

    // Guests already holding a contract in the TO SEASON → skip (idempotent). Keyed on the
    // season, matching the (guest_id, season_id) constraint Phase 2a installed — keying on the
    // year here would wrongly skip a camper who has a Spring when we are cloning into the Fall.
    const { data: existing } = await svc
      .from('seasonal_contracts')
      .select('guest_id')
      .eq('season_id', to_season_id)
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
      if (alreadyHave.has(gid)) { skipped++; continue }         // already in the to season → skip
      toCreate.push({ src, guest })
    }

    if (preview) {
      return NextResponse.json({ preview: true, from_year, to_year, from_season_id, to_season_id, would_create: toCreate.length, would_skip: skipped })
    }

    let created = 0
    for (const { src, guest } of toCreate) {
      const draft = {
        guest_id: guest.id,
        season_year: to_year,
        season_id: to_season_id,
        status: 'draft',
        // FRESH from the guest record:
        site_number: guest.site_number || '',
        // ⚠ NOT seeded from the guest (Phase 2b): these are the per-camper OVERRIDE columns, and
        // a null pair is what makes the new draft INHERIT the season it is being cloned into.
        // Copying the guest's dates would silently override every cloned contract.
        season_opens: null,
        season_closes: null,
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

    return NextResponse.json({ from_year, to_year, from_season_id, to_season_id, created, skipped, errors })
  } catch (e) {
    return NextResponse.json({ error: errMessage(e, 'Something went wrong') }, { status: 500 })
  }
}
