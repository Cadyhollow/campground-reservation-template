import { NextRequest, NextResponse } from 'next/server'
import { svc, isSummit } from '@/lib/contract-server'
import { currentSeasonYear, pickCurrentSeason, todayISO } from '@/lib/season'
import { requireRole } from '@/lib/require-role'

// GET /api/seasonals/unsigned-count?season_id=… — summit-gated (fail closed).
//
// One lightweight aggregate for the owner dashboard card. Mirrors the
// /api/seasonals/list headline ("signed of total"):
//   total  = current is_seasonal campers
//   signed = this season's seasonal_contracts with status 'signed'
//   unsigned = total − signed  (clamped ≥ 0)
// Two COUNT-only queries (head:true — no rows transferred), run in parallel.
//
// Phase 2c: counts a SEASON, not a year. This route powers a dashboard card with no season
// chosen, so when none is named it resolves "the current season" through pickCurrentSeason() —
// THE SAME PURE FUNCTION the screens' season picker uses for its default (lib/season.ts). That
// sharing is the point: two different "which season is current" rules would make the badge count
// a different season than the list shows, and nothing would look wrong.
//
// A park with no seasons at all (pre-2a data) falls back to the year, so the card never breaks.
export async function GET(request: NextRequest) {
  const denied = await requireRole(request, 'staff')
  if (denied) return denied

  if (!(await isSummit())) {
    return NextResponse.json({ error: 'Not available on this plan.' }, { status: 403 })
  }
  const url = new URL(request.url)
  let season_id = url.searchParams.get('season_id') || ''
  let year = parseInt(url.searchParams.get('year') || '', 10) || currentSeasonYear()

  if (!season_id) {
    const { data: seasons } = await svc.from('seasons').select('id, name, year, opens, closes')
    const current = pickCurrentSeason(seasons || [], todayISO())
    if (current) { season_id = current.id; year = current.year }
  } else {
    const { data: season } = await svc.from('seasons').select('year').eq('id', season_id).maybeSingle()
    if (season?.year) year = season.year
  }

  const signedQuery = svc.from('seasonal_contracts')
    .select('*', { count: 'exact', head: true }).eq('status', 'signed')
  const [{ count: total }, { count: signed }] = await Promise.all([
    svc.from('guests').select('*', { count: 'exact', head: true }).eq('is_seasonal', true),
    season_id ? signedQuery.eq('season_id', season_id) : signedQuery.eq('season_year', year),
  ])

  const t = total || 0
  const s = signed || 0
  return NextResponse.json({ season_year: year, total: t, signed: s, unsigned: Math.max(0, t - s) })
}
