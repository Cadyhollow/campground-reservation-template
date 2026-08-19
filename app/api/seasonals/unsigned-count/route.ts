import { NextRequest, NextResponse } from 'next/server'
import { svc, isSummit } from '@/lib/contract-server'
import { currentSeasonYear } from '@/lib/season'
import { requireRole } from '@/lib/require-role'

// GET /api/seasonals/unsigned-count?year=YYYY — summit-gated (fail closed).
//
// One lightweight aggregate for the owner dashboard card. Mirrors the
// /api/seasonals/list headline ("signed of total"):
//   total  = current is_seasonal campers
//   signed = this season's seasonal_contracts with status 'signed'
//   unsigned = total − signed  (clamped ≥ 0)
// Two COUNT-only queries (head:true — no rows transferred), run in parallel.
//
// "Current season" defaults to new Date().getFullYear() — exactly how the list
// route (…/seasonals/list) and the /admin/seasonals page derive it. Never hardcoded.
export async function GET(request: NextRequest) {
  const denied = await requireRole(request, 'staff')
  if (denied) return denied

  if (!(await isSummit())) {
    return NextResponse.json({ error: 'Not available on this plan.' }, { status: 403 })
  }
  const url = new URL(request.url)
  const year = parseInt(url.searchParams.get('year') || '', 10) || currentSeasonYear()

  const [{ count: total }, { count: signed }] = await Promise.all([
    svc.from('guests').select('*', { count: 'exact', head: true }).eq('is_seasonal', true),
    svc.from('seasonal_contracts').select('*', { count: 'exact', head: true })
      .eq('season_year', year).eq('status', 'signed'),
  ])

  const t = total || 0
  const s = signed || 0
  return NextResponse.json({ season_year: year, total: t, signed: s, unsigned: Math.max(0, t - s) })
}
