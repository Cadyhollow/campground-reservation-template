import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { notVoided } from '@/lib/ledger'
import { requireAdmin } from '@/lib/require-admin'

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
// route enforces the admin session itself. That check is now lib/require-admin.ts — this route
// was the original of it, and every other admin route uses the same helper. NOT summit-gated:
// payment mode is for everyone on the plan.
const svc = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

export async function POST(request: NextRequest) {
  const denied = await requireAdmin(request)
  if (denied) return denied

  const body = await request.json().catch(() => ({}))
  const ids: string[] = Array.isArray(body.guest_ids)
    ? body.guest_ids.filter((x: any) => typeof x === 'string')
    : []
  if (ids.length === 0) return NextResponse.json({ balances: {} })

  // One guest_account folio per guest.
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
    for (const it of (items || []).filter(notVoided)) balByFolio.set(it.folio_id, (balByFolio.get(it.folio_id) || 0) + (it.line_total || 0))
    for (const p of pmts || []) balByFolio.set(p.folio_id, (balByFolio.get(p.folio_id) || 0) - (p.amount - (p.surcharge_amount || 0)))
  }

  const balances: Record<string, number> = {}
  for (const gid of ids) {
    const fid = folioByGuest.get(gid)
    balances[gid] = fid ? (balByFolio.get(fid) || 0) : 0
  }
  return NextResponse.json({ balances })
}
