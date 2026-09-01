import { NextRequest, NextResponse } from 'next/server'
import { svc, isSummit } from '@/lib/contract-server'
import { requireRole } from '@/lib/require-role'
import { loadMeterContext, getElectricRate } from '@/lib/meters-server'

// The meter registry.
//
//   GET   — every active meter, resolved: whose it is, whether it bills, what it last read.
//   PATCH — retire a meter, or force it on/off. OWNER: these decide who gets billed.
//   POST  — sync the registry from the sites list. OWNER, same reason.
//
// Summit-gated like the rest of the seasonal area, and role-gated per method.

export async function GET(request: NextRequest) {
  const denied = await requireRole(request, 'staff')
  if (denied) return denied
  if (!(await isSummit())) return NextResponse.json({ error: 'Not available on this plan.' }, { status: 403 })

  const sessionId = new URL(request.url).searchParams.get('session_id')
  const [{ meters, conflicts }, rate] = await Promise.all([
    loadMeterContext(sessionId || null),
    getElectricRate(),
  ])
  return NextResponse.json({ meters, conflicts, rate })
}

export async function PATCH(request: NextRequest) {
  const denied = await requireRole(request, 'owner')
  if (denied) return denied
  if (!(await isSummit())) return NextResponse.json({ error: 'Not available on this plan.' }, { status: 403 })

  const body = await request.json().catch(() => ({}))
  const id = typeof body.id === 'string' ? body.id : ''
  if (!id) return NextResponse.json({ error: 'A meter id is required.' }, { status: 400 })

  const patch: Record<string, unknown> = {}
  // ⚠ TWO STATES NOW: null = Auto, false = "Don't bill". `true` (the removed "Always") is
  // REFUSED rather than quietly mapped to null — a request carrying it is either an old client or
  // a mistake, and both are worth telling the caller about instead of silently doing something
  // else. resolveBillable() separately treats any surviving `true` row as Auto, so a stale value
  // cannot resurrect the removed behaviour; this is the half that stops new ones being written.
  if ('billable_override' in body) {
    const v = body.billable_override
    if (v !== null && v !== false) {
      return NextResponse.json({
        error: 'billable_override must be null (Auto) or false (Don\u2019t bill). "Always" was removed: a bill is a charge on a camper\u2019s folio, so a meter with nobody on it has nothing to bill.',
      }, { status: 400 })
    }
    patch.billable_override = v
  }
  if (typeof body.active === 'boolean') patch.active = body.active
  if (typeof body.label === 'string') patch.label = body.label
  if (typeof body.notes === 'string') patch.notes = body.notes
  if (!Object.keys(patch).length) return NextResponse.json({ error: 'Nothing to change.' }, { status: 400 })

  const { data, error } = await svc.from('meters').update(patch).eq('id', id).select().maybeSingle()
  if (error) return NextResponse.json({ error: error.message }, { status: 400 })
  return NextResponse.json({ meter: data })
}

// Sync from sites: give every site without one a meter, numbered as the site.
//
// ⚠ ADDITIVE ONLY. It never deletes, renumbers or retires a meter — a site removed from the park
// leaves its meter and its whole reading history in place (unattached, and therefore record-only).
// Re-running when nothing has changed creates nothing.
export async function POST(request: NextRequest) {
  const denied = await requireRole(request, 'owner')
  if (denied) return denied
  if (!(await isSummit())) return NextResponse.json({ error: 'Not available on this plan.' }, { status: 403 })

  const [{ data: sites }, { data: meters }] = await Promise.all([
    svc.from('sites').select('id, site_number, display_order'),
    svc.from('meters').select('id, meter_number'),
  ])
  const norm = (t: unknown) => (typeof t === 'string' ? t.trim().toLowerCase() : '')
  const have = new Set((meters || []).map(m => norm(m.meter_number)))

  const toCreate: { meter_number: string; site_id: string; label: string; active: boolean; display_order: number }[] = []
  for (const s of sites || []) {
    const key = norm(s.site_number)
    // A blank site number gives a meter nothing to be identified by; skipped rather than named ''.
    if (!key || have.has(key)) continue
    have.add(key) // two site rows sharing a number must not produce two meters
    toCreate.push({
      meter_number: String(s.site_number).trim(), site_id: s.id, label: '',
      active: true, display_order: s.display_order ?? 0,
    })
  }

  if (toCreate.length) {
    const { error } = await svc.from('meters').insert(toCreate)
    if (error) return NextResponse.json({ error: error.message }, { status: 400 })
  }
  return NextResponse.json({ created: toCreate.length, total: (meters?.length || 0) + toCreate.length })
}
