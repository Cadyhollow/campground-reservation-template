import { NextRequest, NextResponse } from 'next/server'
import { svc, isSummit, errMessage } from '@/lib/contract-server'
import { requireRole } from '@/lib/require-role'



// POST /api/seasonals/guest — summit-gated. The SINGLE writer for seasonal guest
// data: upsert ALL guest fields in one call — create a new guest, or update by id.
// ALWAYS is_seasonal=true (this is seasonal intake). Replaces the three scattered
// anon writes (guests-directory save, camper-page saveRig, camper-page saveAddr).
//
// body: { id?, name, email, phone, site_number, season_start, season_end,
//         home_street, home_city, home_state, home_zip,
//         camper_type, camper_length, camper_amperage,
//         camper_make, camper_model, camper_year, party? }
export async function POST(request: NextRequest) {
  const denied = await requireRole(request, 'staff')
  if (denied) return denied

  try {
    if (!(await isSummit())) {
      return NextResponse.json({ error: 'Not available on this plan.' }, { status: 403 })
    }
    const b = await request.json()
    const name = (b.name || '').toString().trim()
    if (!name) return NextResponse.json({ error: 'Name is required.' }, { status: 400 })

    // These normalise arbitrary JSON body values, so `unknown` is exactly right — the whole job
    // of both is to turn something of unknown shape into a string-or-null / number-or-null.
    const str = (v: unknown) => { const s = (v ?? '').toString().trim(); return s || null }
    const int = (v: unknown) => { const n = parseInt(String(v), 10); return Number.isFinite(n) ? n : null }

    const fields = {
      name,
      email: str(b.email),
      phone: str(b.phone),
      site_number: str(b.site_number) || '', // schema default is ''
      is_seasonal: true,                      // always — seasonal intake
      season_start: str(b.season_start),
      season_end: str(b.season_end),
      home_street: str(b.home_street),
      home_city: str(b.home_city),
      home_state: str(b.home_state),
      home_zip: str(b.home_zip),
      camper_type: str(b.camper_type),
      camper_length: int(b.camper_length),
      camper_amperage: str(b.camper_amperage),
      camper_make: str(b.camper_make),
      camper_model: str(b.camper_model),
      camper_year: int(b.camper_year),
    }

    // The STANDING party roster. OMITTED FROM `fields` WHEN THE CALLER DOES NOT SEND IT, and that
    // conditional is load-bearing: this route is a full-row upsert, so an unconditional
    // `party: […]` would let any caller that doesn't know about the roster silently WIPE it.
    // Absent key ⇒ column untouched.
    const patch: Record<string, unknown> = { ...fields }
    if (Array.isArray(b.party)) {
      patch.party = (b.party as unknown[])
        .map(o => {
          const p = (o ?? {}) as { name?: unknown; kind?: unknown }
          return { name: (p.name ?? '').toString().trim(), kind: p.kind === 'child' ? 'child' : 'adult' }
        })
        .filter(p => p.name)   // an unnamed occupant is a half-typed row, not a person
    }

    if (b.id) {
      const { data, error } = await svc.from('guests').update(patch).eq('id', b.id).select('*').single()
      if (error || !data) return NextResponse.json({ error: error?.message || 'Could not update guest.' }, { status: 500 })
      return NextResponse.json({ guest: data, created: false })
    }
    const { data, error } = await svc.from('guests').insert(patch).select('*').single()
    if (error || !data) return NextResponse.json({ error: error?.message || 'Could not create guest.' }, { status: 500 })
    return NextResponse.json({ guest: data, created: true })
  } catch (e) {
    return NextResponse.json({ error: errMessage(e, 'Something went wrong') }, { status: 500 })
  }
}
