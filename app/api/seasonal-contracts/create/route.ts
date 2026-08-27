import { NextRequest, NextResponse } from 'next/server'
import { svc, isSummit, errMessage, findOrCreateSeasonForYear } from '@/lib/contract-server'
import { requireRole } from '@/lib/require-role'



// POST /api/seasonal-contracts/create
// body: { guest_id, season_year }
// Creates a draft, prefilled from the guest. Idempotent on the
// (guest_id, season_year) unique constraint — returns the existing row, no error.
export async function POST(request: NextRequest) {
  const denied = await requireRole(request, 'manager')
  if (denied) return denied

  try {
    if (!(await isSummit())) {
      return NextResponse.json({ error: 'Not available on this plan.' }, { status: 403 })
    }
    const body = await request.json()
    const guest_id: string | undefined = body.guest_id
    const season_year = parseInt(body.season_year, 10)
    if (!guest_id || !season_year) {
      return NextResponse.json({ error: 'Missing guest_id or season_year' }, { status: 400 })
    }

    // Already exists? Return it (idempotent).
    const { data: existing } = await svc
      .from('seasonal_contracts')
      .select('*')
      .eq('guest_id', guest_id)
      .eq('season_year', season_year)
      .maybeSingle()
    if (existing) return NextResponse.json({ contract: existing, created: false })

    // Prefill from the guest record. (season dates come from the guest — settings
    // has no park-wide season columns today.)
    const { data: guest } = await svc
      .from('guests')
      .select('id, name, site_number, season_start, season_end, camper_make, camper_model, camper_year, party')
      .eq('id', guest_id)
      .single()
    if (!guest) return NextResponse.json({ error: 'Guest not found' }, { status: 404 })

    // The STANDING party roster (guests.party) seeds this draft's occupants, the same way
    // site/season/rig above are seeded from the guest record. The draft is then freely editable —
    // the send modal still tweaks occupants per contract, and those tweaks stay on the contract.
    // Defensive Array.isArray rather than a bare `|| []`: the column is jsonb, so a hand-edited
    // row could hold an object or a string, and `occupants` must be an array or the contract
    // renderer's `.map` throws at send time.
    const roster = Array.isArray(guest.party) ? guest.party : []

    // Phase 2a: season_id is NOT NULL, so resolve it before inserting. Reuses the year's season
    // if the park has one, creates the default otherwise. Until Phase 2b's picker, a year with
    // two seasons attaches here to the earliest-created one — see the helper's note.
    const season = await findOrCreateSeasonForYear(season_year)
    if (!season.ok) return NextResponse.json({ error: season.error }, { status: 500 })

    const draft = {
      guest_id,
      season_year,
      season_id: season.season_id,
      status: 'draft',
      site_number: guest.site_number || '',
      season_opens: guest.season_start ?? null,
      season_closes: guest.season_end ?? null,
      camper_make: guest.camper_make ?? null,
      camper_model: guest.camper_model ?? null,
      camper_year: guest.camper_year ?? null,
      occupants: roster,
    }

    const { data: created, error } = await svc
      .from('seasonal_contracts')
      .insert(draft)
      .select('*')
      .single()

    if (error) {
      // Lost a race on the unique constraint → return the row that won.
      if ((error as { code?: string }).code === '23505') {
        const { data: row } = await svc
          .from('seasonal_contracts')
          .select('*')
          .eq('guest_id', guest_id)
          .eq('season_year', season_year)
          .maybeSingle()
        return NextResponse.json({ contract: row, created: false })
      }
      return NextResponse.json({ error: error.message }, { status: 500 })
    }
    return NextResponse.json({ contract: created, created: true })
  } catch (e) {
    return NextResponse.json({ error: errMessage(e, 'Something went wrong') }, { status: 500 })
  }
}
