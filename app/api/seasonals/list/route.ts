import { NextRequest, NextResponse } from 'next/server'
import { svc, isSummit } from '@/lib/contract-server'
import { notVoided } from '@/lib/ledger'
import { currentSeasonYear } from '@/lib/season'
import { requireRole } from '@/lib/require-role'

// GET /api/seasonals/list?season_id=…  (or ?year=YYYY) — summit-gated. One aggregated payload
// for the /admin/seasonals list (seasonal_contracts + guest_notes are RLS-zero-policy, so the
// admin anon client can't read them; this service-role route does).
//
// Phase 2c: the list filters by SEASON. `season_id` is what the screen sends now, so a park with
// a Spring and a Fall in one year can tell them apart. `?year=` is kept working — it is the
// pre-2c contract of this route and costs one branch — and the RESPONSE SHAPE IS UNCHANGED,
// including the `year` field, which is now the selected season's year.
export async function GET(request: NextRequest) {
  const denied = await requireRole(request, 'staff')
  if (denied) return denied

  if (!(await isSummit())) return NextResponse.json({ error: 'Not available on this plan.' }, { status: 403 })

  const url = new URL(request.url)
  const season_id = url.searchParams.get('season_id') || ''
  // `year` still travels in the response, so resolve it from the season when one is named.
  let year = parseInt(url.searchParams.get('year') || '', 10) || currentSeasonYear()
  if (season_id) {
    const { data: season } = await svc.from('seasons').select('year').eq('id', season_id).maybeSingle()
    if (season?.year) year = season.year
  }

  const { data: guests } = await svc.from('guests')
    .select('id, name, site_number')
    .eq('is_seasonal', true)
  const seasonal = guests || []
  const ids = seasonal.map(g => g.id)
  if (ids.length === 0) {
    return NextResponse.json({ year, rows: [], signed_count: 0, total: 0 })
  }

  // Contracts for the year + their linked signatures.
  // Filter by season when one is named, else by year (the pre-2c behaviour).
  const contractQuery = svc.from('seasonal_contracts')
    .select('id, guest_id, status, packet_id, contract_signature_id, waiver_signature_id')
    .in('guest_id', ids)
  const { data: contracts } = await (season_id
    ? contractQuery.eq('season_id', season_id)
    : contractQuery.eq('season_year', year))
  const byGuest = new Map((contracts || []).map(c => [c.guest_id, c]))
  const sigIds = (contracts || []).flatMap(c => [c.contract_signature_id, c.waiver_signature_id]).filter(Boolean)
  const sigStatus = new Map<string, string>()
  if (sigIds.length) {
    const { data: sigs } = await svc.from('signatures').select('id, status').in('id', sigIds)
    for (const s of sigs || []) sigStatus.set(s.id, s.status)
  }

  // Balances (guest_account folios → line_items − payments).
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

  // Last note per guest.
  const { data: notes } = await svc.from('guest_notes')
    .select('guest_id, created_at').in('guest_id', ids).order('created_at', { ascending: false })
  const lastNote = new Map<string, string>()
  for (const n of notes || []) if (!lastNote.has(n.guest_id)) lastNote.set(n.guest_id, n.created_at)

  let signed = 0
  const rows = seasonal.map(g => {
    const c = byGuest.get(g.id)
    const contractDoc = c?.contract_signature_id ? sigStatus.get(c.contract_signature_id) || null : null
    const waiverDoc = c?.waiver_signature_id ? sigStatus.get(c.waiver_signature_id) || null : null
    if (c?.status === 'signed') signed++
    const folioId = folioByGuest.get(g.id)
    return {
      guest_id: g.id,
      name: g.name,
      site_number: g.site_number || '',
      contract_status: c?.status || 'none', // none|draft|sent|signed
      contract_doc_status: contractDoc,      // pending|signed|null
      waiver_doc_status: waiverDoc,
      balance_cents: folioId ? (balByFolio.get(folioId) || 0) : 0,
      last_note_at: lastNote.get(g.id) || null,
    }
  }).sort((a, b) => (a.site_number || '').localeCompare(b.site_number || '', undefined, { numeric: true }))

  return NextResponse.json({ year, rows, signed_count: signed, total: seasonal.length })
}
