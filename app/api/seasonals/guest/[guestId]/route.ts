import { NextRequest, NextResponse } from 'next/server'
import { svc, isSummit } from '@/lib/contract-server'
import { notVoided } from '@/lib/ledger'
import { requireRole } from '@/lib/require-role'

// GET /api/seasonals/guest/[guestId]?season_id=…  (or ?year=YYYY) — summit-gated. Everything the
// camper page needs (service-role: reads the RLS-zero-policy tables).
//
// Phase 2c: `currentContract` is selected by SEASON when one is named — that is what lets a
// camper hold a Spring and a Fall and the screen show the right one. `?year=` still works.
//
// THE FULL CONTRACT HISTORY IS UNCHANGED: `contracts` still carries every year, so the camper
// page's "Prior years" panel keeps working exactly as it did. Only the CURRENT SELECTION moved
// onto seasons. The response shape is otherwise identical, `year` included.
export async function GET(request: NextRequest, { params }: { params: Promise<{ guestId: string }> }) {
  const denied = await requireRole(request, 'staff')
  if (denied) return denied

  if (!(await isSummit())) return NextResponse.json({ error: 'Not available on this plan.' }, { status: 403 })
  const { guestId } = await params
  const url = new URL(request.url)
  const season_id = url.searchParams.get('season_id') || ''
  let year = parseInt(url.searchParams.get('year') || '', 10) || new Date().getFullYear()
  if (season_id) {
    const { data: season } = await svc.from('seasons').select('year').eq('id', season_id).maybeSingle()
    if (season?.year) year = season.year
  }

  const { data: guest, error } = await svc.from('guests').select('*').eq('id', guestId).single()
  if (error || !guest) return NextResponse.json({ error: 'Guest not found' }, { status: 404 })

  // Contracts (all years) + linked signature statuses/snapshots.
  const { data: contractsRaw } = await svc.from('seasonal_contracts')
    .select('*').eq('guest_id', guestId).order('season_year', { ascending: false })
  const contracts = contractsRaw || []
  const sigIds = contracts.flatMap(c => [c.contract_signature_id, c.waiver_signature_id]).filter(Boolean)
  const sigById = new Map<string, Record<string, unknown>>()
  if (sigIds.length) {
    const { data: sigs } = await svc.from('signatures')
      .select('id, status, signed_at, signed_name, sign_token').in('id', sigIds)
    for (const s of sigs || []) sigById.set(s.id, s)
  }
  const contractsOut = contracts.map(c => ({
    ...c,
    contract_signature: c.contract_signature_id ? sigById.get(c.contract_signature_id) || null : null,
    waiver_signature: c.waiver_signature_id ? sigById.get(c.waiver_signature_id) || null : null,
  }))
  const currentContract = season_id
    ? (contractsOut.find(c => c.season_id === season_id) || null)
    : (contractsOut.find(c => c.season_year === year) || null)

  // Notes (append-only).
  const { data: notes } = await svc.from('guest_notes')
    .select('id, created_at, author, body').eq('guest_id', guestId).order('created_at', { ascending: false })

  // Electric readings (recent).
  const { data: electric } = await svc.from('electric_readings')
    .select('*').eq('guest_id', guestId).order('created_at', { ascending: false }).limit(6)

  // Balance + last payment from the guest_account folio.
  const { data: folio } = await svc.from('folios')
    .select('id').eq('folio_type', 'guest_account').eq('guest_id', guestId).limit(1).maybeSingle()
  let balance_cents = 0
  let lastPayment: Record<string, unknown> | null = null
  const folioId = folio?.id || ''
  if (folioId) {
    const [{ data: items }, { data: pmts }] = await Promise.all([
      svc.from('folio_line_items').select('line_total, voided').eq('folio_id', folioId),
      svc.from('folio_payments').select('amount, surcharge_amount, method, paid_at, status').eq('folio_id', folioId).eq('status', 'completed').order('paid_at', { ascending: false }),
    ])
    // ⚠ INLINED RATHER THAN IMPORTED, AND lib/ledger.ts IS NOT TOUCHED.
    //
    // Cady has a one-line `sumLineTotals` helper in its ledger; this repo does not. lib/ledger.ts
    // is one of the three fee-model files that must show an EMPTY DIFF — the two repos' money
    // arithmetic differs deliberately, and "sync the helper across" is exactly the change that
    // turns into a money bug.
    //
    // The template already exports `notVoided`, the primitive that helper is built from, so the
    // arithmetic here is identical to Cady's without adding anything to the fee model:
    //     sum(line_total) over non-voided items.
    //
    // This figure is DISPLAY ONLY — the balance shown beside a seasonal camper. Nothing is
    // charged from it.
    const itemsTotal = (items || []).filter(notVoided).reduce((s, i) => s + (i.line_total || 0), 0)
    const paymentsTotal = (pmts || []).reduce((s, p) => s + p.amount - (p.surcharge_amount || 0), 0)
    balance_cents = itemsTotal - paymentsTotal
    lastPayment = (pmts || [])[0] || null
  }

  return NextResponse.json({
    year,
    guest,
    contracts: contractsOut,
    currentContract,
    notes: notes || [],
    electric: electric || [],
    balance_cents,
    folioId,
    lastPayment,
  })
}
