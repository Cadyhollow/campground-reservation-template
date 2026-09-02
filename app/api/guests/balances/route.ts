import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { notVoided } from '@/lib/ledger'
import { requireRole } from '@/lib/require-role'

// POST /api/guests/balances  { guest_ids: string[] }
// → { balances: { [guest_id]: cents } }
//
// The SAME tab+electric balance the guest folio shows: a guest_account folio's
// charges (folio_line_items — electric already posts here) minus its completed
// folio_payments (net of card surcharge).
//
// Scoped to the passed ids only (the directory sends its FILTERED/visible set, not
// all guests) and done in one batched round-trip — three .in(...) queries total, no
// N+1 regardless of list size.
//
// AUTH: middleware.ts only guards /admin/* PAGES (matcher '/admin/:path*'), not /api/*, so this
// route enforces the admin session itself. That check is now lib/require-role.ts — this route
// was the original of it, and every other admin route uses the same helper. NOT summit-gated:
// payment mode is for everyone on the plan.
const svc = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

export async function POST(request: NextRequest) {
  const denied = await requireRole(request, 'staff')
  if (denied) return denied

  const body = await request.json().catch(() => ({}))
  const ids: string[] = Array.isArray(body.guest_ids)
    ? body.guest_ids.filter((x: any) => typeof x === 'string')
    : []
  if (ids.length === 0) return NextResponse.json({ balances: {}, seasonal: {} })

  // One guest_account folio per guest.
  const { data: folios } = await svc.from('folios')
    .select('id, guest_id').eq('folio_type', 'guest_account').in('guest_id', ids)
  const folioByGuest = new Map<string, string>()
  for (const f of folios || []) if (!folioByGuest.has(f.guest_id)) folioByGuest.set(f.guest_id, f.id)
  const folioIds = [...folioByGuest.values()]

  const balByFolio = new Map<string, number>()
  // ── THE SEASONAL HALF, FOR THE TWO CARDS ──────────────────────────────────────────────────
  //
  // Only the SEASONAL bucket is summed here. Camp is the account remainder, so the caller gets it
  // by subtraction — which is the same rule accountBuckets() applies, and the reason a directory
  // row can never show a camper owing more on one card than they owe in total.
  //
  // ⚠ NO LANE CLASSIFICATION IS NEEDED, and that is what keeps this a two-query endpoint. A
  // seasonal charge and a seasonal payment are both DECLARED — `lane = 'seasonal'` on the row —
  // never inferred, so no electric_readings lookup and no product_id inspection is involved. See
  // rule 0 in lib/ledger-lanes.ts.
  const seasonalByFolio = new Map<string, number>()
  if (folioIds.length) {
    const [{ data: items }, { data: pmts }] = await Promise.all([
      svc.from('folio_line_items').select('folio_id, line_total, voided, lane').in('folio_id', folioIds),
      svc.from('folio_payments').select('folio_id, amount, surcharge_amount, lane').in('folio_id', folioIds).eq('status', 'completed'),
    ])
    for (const it of (items || []).filter(notVoided)) {
      balByFolio.set(it.folio_id, (balByFolio.get(it.folio_id) || 0) + (it.line_total || 0))
      if (it.lane === 'seasonal') seasonalByFolio.set(it.folio_id, (seasonalByFolio.get(it.folio_id) || 0) + (it.line_total || 0))
    }
    for (const p of pmts || []) {
      const net = p.amount - (p.surcharge_amount || 0)
      balByFolio.set(p.folio_id, (balByFolio.get(p.folio_id) || 0) - net)
      if (p.lane === 'seasonal') seasonalByFolio.set(p.folio_id, (seasonalByFolio.get(p.folio_id) || 0) - net)
    }
  }

  const balances: Record<string, number> = {}
  const seasonal: Record<string, number> = {}
  for (const gid of ids) {
    const fid = folioByGuest.get(gid)
    balances[gid] = fid ? (balByFolio.get(fid) || 0) : 0
    seasonal[gid] = fid ? (seasonalByFolio.get(fid) || 0) : 0
  }
  // `balances` is unchanged in name, shape and value — a combined park's directory reads only
  // that key and is untouched. `seasonal` is purely additive.
  return NextResponse.json({ balances, seasonal })
}
