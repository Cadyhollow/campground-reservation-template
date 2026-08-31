import { NextRequest, NextResponse } from 'next/server'
import { svc, isSummit } from '@/lib/contract-server'
import { notVoided } from '@/lib/ledger'
import { currentSeasonYear } from '@/lib/season'
import { requireRole } from '@/lib/require-role'

// GET /api/seasonals/campers?season_id=…  — summit-gated. The CAMPERS DIRECTORY: every seasonal
// camper the park has, regardless of season.
//
// ⚠ THIS IS THE DELIBERATE COMPLEMENT OF /api/seasonals/list, NOT A DUPLICATE OF IT.
//
// That route answers "who is in THIS season's paperwork", and it is right to: it derives its
// roster from the season's contracts, so a park working through 2027 is not shown campers who
// have never had a 2027 contract. Read its own comment — the season-scoping was a deliberate fix.
//
// But that scoping has a consequence, and the consequence is the bug this release exists to fix.
// Flagging somebody `is_seasonal` in the Guest Directory does NOT enroll them in a season, so
// they hold no contract, so they appear on NO season's list — and a seasonal camper silently
// becomes invisible. The owner's only clue is a camper they remember who is not on any screen.
//
// So this route is the PEOPLE view: start from the guests, not from the contracts. Every
// is_seasonal guest appears here, and the ones with no contract for the selected season are the
// most important rows on it — they are marked `not_enrolled` and are one click from being fixed.
// The two routes disagreeing about who is listed is the point, not a defect.
export async function GET(request: NextRequest) {
  const denied = await requireRole(request, 'staff')
  if (denied) return denied

  if (!(await isSummit())) return NextResponse.json({ error: 'Not available on this plan.' }, { status: 403 })

  const url = new URL(request.url)
  const season_id = url.searchParams.get('season_id') || ''
  let year = parseInt(url.searchParams.get('year') || '', 10) || currentSeasonYear()
  let seasonName = ''
  if (season_id) {
    const { data: season } = await svc.from('seasons').select('year, name').eq('id', season_id).maybeSingle()
    if (season?.year) year = season.year
    if (season?.name) seasonName = season.name
  }

  // select('*') rather than a column list, so a park that has not run the seasonal_active
  // migration yet still gets a working directory. Naming a missing column in the select fails
  // the WHOLE query, and "the directory is empty" is a worse failure than "everyone reads as
  // active", which is exactly what the column's default says anyway.
  const { data: guestRows, error } = await svc
    .from('guests').select('*').eq('is_seasonal', true)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  const guests = guestRows || []
  const ids = guests.map(g => g.id as string)
  // Whether the column exists at all, read off a loaded row — the same guard the Settings screen
  // uses. Reported to the client so the UI can hide the active/inactive control rather than
  // offering a toggle whose write would fail.
  const hasActiveColumn = guests.length > 0 && 'seasonal_active' in guests[0]

  if (ids.length === 0) {
    return NextResponse.json({ year, season_name: seasonName, rows: [], total: 0, not_enrolled: 0, has_active_column: hasActiveColumn })
  }

  // This season's contracts, for the enrollment status. A guest missing from this map is the
  // `not_enrolled` case — the row the directory exists to surface.
  const scope = svc.from('seasonal_contracts')
    .select('id, guest_id, status, sent_at, signed_at, total_due_cents, deposit_due_cents')
    .in('guest_id', ids)
  const { data: contracts } = await (season_id ? scope.eq('season_id', season_id) : scope.eq('season_year', year))
  const byGuest = new Map((contracts || []).map(c => [c.guest_id as string, c]))

  // Every season a camper has EVER been part of — the "member since" and "seasons" facts on the
  // record. One query for the whole page rather than one per camper.
  const { data: allContracts } = await svc
    .from('seasonal_contracts').select('guest_id, season_year').in('guest_id', ids)
  const seasonsByGuest = new Map<string, number[]>()
  for (const c of allContracts || []) {
    const list = seasonsByGuest.get(c.guest_id as string) || []
    if (!list.includes(c.season_year as number)) list.push(c.season_year as number)
    seasonsByGuest.set(c.guest_id as string, list)
  }

  // Balances — the same guest_account walk /api/seasonals/list does, so the two screens can
  // never disagree about what a camper owes.
  const { data: folios } = await svc.from('folios')
    .select('id, guest_id').eq('folio_type', 'guest_account').in('guest_id', ids)
  const folioByGuest = new Map<string, string>()
  for (const f of folios || []) if (!folioByGuest.has(f.guest_id)) folioByGuest.set(f.guest_id, f.id)
  const folioIds = [...folioByGuest.values()]
  const balByFolio = new Map<string, number>()
  if (folioIds.length) {
    const [{ data: items }, { data: pmts }] = await Promise.all([
      svc.from('folio_line_items').select('folio_id, line_total, voided').in('folio_id', folioIds),
      svc.from('folio_payments').select('folio_id, amount, surcharge_amount').in('folio_id', folioIds).eq('status', 'completed'),
    ])
    for (const it of (items || []).filter(notVoided)) balByFolio.set(it.folio_id, (balByFolio.get(it.folio_id) || 0) + it.line_total)
    for (const p of pmts || []) balByFolio.set(p.folio_id, (balByFolio.get(p.folio_id) || 0) - (p.amount - (p.surcharge_amount || 0)))
  }

  let notEnrolled = 0
  const rows = guests.map(g => {
    const c = byGuest.get(g.id as string) || null
    if (!c) notEnrolled++
    const folioId = folioByGuest.get(g.id as string)
    const years = (seasonsByGuest.get(g.id as string) || []).sort((a, b) => a - b)
    return {
      guest_id: g.id as string,
      name: (g.name as string) || '',
      site_number: (g.site_number as string) || '',
      // Absent column ⇒ active, matching the migration's DEFAULT true.
      active: hasActiveColumn ? g.seasonal_active !== false : true,
      contract: c && {
        id: c.id, status: c.status, sent_at: c.sent_at, signed_at: c.signed_at,
        total_due_cents: c.total_due_cents, deposit_due_cents: c.deposit_due_cents,
      },
      season_years: years,
      member_since: years.length ? years[0] : null,
      balance_cents: folioId ? (balByFolio.get(folioId) || 0) : 0,
    }
  }).sort((a, b) => {
    // Campers who need adding float to the top of their site order — they are the work.
    if (!a.contract !== !b.contract) return a.contract ? 1 : -1
    if (a.active !== b.active) return a.active ? -1 : 1
    return (a.site_number || '').localeCompare(b.site_number || '', undefined, { numeric: true })
  })

  return NextResponse.json({
    year, season_name: seasonName, rows, total: rows.length,
    not_enrolled: notEnrolled, has_active_column: hasActiveColumn,
  })
}

// PATCH /api/seasonals/campers — mark a seasonal camper active or inactive.
//
// ⚠ THE ONLY COLUMN THIS TOUCHES IS seasonal_active. It is deliberately its own endpoint rather
// than a field on the personal-info save, because "has left the programme" is a decision, not a
// typo correction — it should never ride along on someone fixing a phone number.
//
// Inactive is NOT a delete and NOT `is_seasonal = false`. The camper stays seasonal, stays in
// this directory, and keeps every contract, payment and reading they ever had; they are marked.
// Clearing is_seasonal was the old way to say "they left" and it removed them from every seasonal
// screen at once — the record you need is the record that disappeared.
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

    // Guard on the column, the same way the read does. A park that has not run the migration gets
    // a clear message instead of a PostgREST error about an unknown column.
    const { data: probe } = await svc.from('guests').select('*').eq('id', guest_id).maybeSingle()
    if (!probe) return NextResponse.json({ error: 'Camper not found.' }, { status: 404 })
    if (!('seasonal_active' in probe)) {
      return NextResponse.json(
        { error: 'This park has not run the seasonal_active migration yet.' }, { status: 409 })
    }

    const { data, error } = await svc
      .from('guests').update({ seasonal_active: body.active }).eq('id', guest_id).select('id, seasonal_active').single()
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    return NextResponse.json({ guest_id: data.id, active: data.seasonal_active !== false })
  } catch {
    return NextResponse.json({ error: 'Something went wrong' }, { status: 500 })
  }
}
