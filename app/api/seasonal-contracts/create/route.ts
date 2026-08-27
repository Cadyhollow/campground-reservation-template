import { NextRequest, NextResponse } from 'next/server'
import { svc, isSummit, errMessage, findOrCreateSeasonForYear } from '@/lib/contract-server'
import { requireRole } from '@/lib/require-role'



// POST /api/seasonal-contracts/create
// body: { guest_id, season_year, season_id? }
//
// Creates a draft, prefilled from the guest. Idempotent — returns the existing row rather than
// erroring.
//
// Phase 2b: when the caller names a SEASON, that is what the draft belongs to and what
// idempotency is keyed on — matching the (guest_id, season_id) unique constraint Phase 2a put on
// the table, so a camper can hold a Spring and a Fall in the same year. When it does not (the
// camper page's Review link still arrives with only a year), the year fallback from 2a applies.
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

    // Resolve the season FIRST — it decides what "already exists" even means. An explicit
    // season_id is used as given; otherwise fall back to the year's default season (2a).
    const requested_season_id: string | undefined = body.season_id || undefined
    let season_id: string
    if (requested_season_id) {
      season_id = requested_season_id
    } else {
      const season = await findOrCreateSeasonForYear(season_year)
      if (!season.ok) return NextResponse.json({ error: season.error }, { status: 500 })
      season_id = season.season_id
    }

    // Already exists? Return it (idempotent). Keyed on the SEASON, which is what the unique
    // constraint enforces — keying on the year here would wrongly hand back a camper's Spring
    // contract when they asked to start their Fall one.
    const { data: existing } = await svc
      .from('seasonal_contracts')
      .select('*')
      .eq('guest_id', guest_id)
      .eq('season_id', season_id)
      .maybeSingle()
    if (existing) return NextResponse.json({ contract: existing, created: false })

    // Prefill from the guest record. (season dates come from the guest — settings
    // has no park-wide season columns today.)
    const { data: guest } = await svc
      .from('guests')
      .select('id, name, site_number, camper_make, camper_model, camper_year, party')
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

    const draft = {
      guest_id,
      season_year,
      season_id,
      status: 'draft',
      site_number: guest.site_number || '',
      // ⚠ NOT SEEDED FROM THE GUEST ANY MORE (Phase 2b). These two columns are now the PER-CAMPER
      // OVERRIDE, and a draft left null INHERITS its season's dates — which is the whole point of
      // naming seasons. Copying guest.season_start/end in here would make every new draft an
      // override of the season it was just filed under, and the season's dates would never apply.
      // Staff set these only by explicitly choosing "use different dates for this camper".
      season_opens: null,
      season_closes: null,
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
        // Re-select by SEASON, matching the constraint that just fired — (guest_id, season_id)
        // since 2a. Looking it up by year could return a different season's contract.
        const { data: row } = await svc
          .from('seasonal_contracts')
          .select('*')
          .eq('guest_id', guest_id)
          .eq('season_id', season_id)
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
