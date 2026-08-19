import { NextRequest, NextResponse } from 'next/server'
import { svc, isSummit, errMessage } from '@/lib/contract-server'
import { requireRole } from '@/lib/require-role'



// Fields staff may edit on a DRAFT contract.
const EDITABLE = [
  'occupants', 'total_due_cents', 'staff_notes', 'site_number',
  'season_opens', 'season_closes',
  'camper_type', 'camper_length', 'camper_amperage',
  'camper_make', 'camper_model', 'camper_year',
]

// PATCH /api/seasonal-contracts/[id]
// Staff edits a draft. A sent or signed contract is frozen — reject the edit.
export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const denied = await requireRole(request, 'manager')
  if (denied) return denied

  try {
    if (!(await isSummit())) {
      return NextResponse.json({ error: 'Not available on this plan.' }, { status: 403 })
    }
    const { id } = await params
    const body = await request.json()

    const { data: cur, error: loadErr } = await svc
      .from('seasonal_contracts')
      .select('id, status')
      .eq('id', id)
      .single()
    if (loadErr || !cur) return NextResponse.json({ error: 'Contract not found' }, { status: 404 })
    if (cur.status !== 'draft') {
      return NextResponse.json({ error: 'This contract has been sent and can no longer be edited.' }, { status: 409 })
    }

    // `unknown` rather than `any`: this object is handed straight to PostgREST, so nothing here
    // needs to dereference the values — it only needs to carry them.
    const patch: Record<string, unknown> = {}
    for (const k of EDITABLE) if (k in body) patch[k] = body[k]
    if (Object.keys(patch).length === 0) {
      return NextResponse.json({ error: 'No editable fields provided.' }, { status: 400 })
    }

    // Re-assert draft in the WHERE clause so a concurrent send can't be clobbered.
    const { data, error } = await svc
      .from('seasonal_contracts')
      .update(patch)
      .eq('id', id)
      .eq('status', 'draft')
      .select('*')
      .single()
    if (error || !data) {
      return NextResponse.json({ error: error?.message || 'Could not save (contract may have just been sent).' }, { status: 409 })
    }
    return NextResponse.json({ contract: data })
  } catch (e) {
    return NextResponse.json({ error: errMessage(e, 'Something went wrong') }, { status: 500 })
  }
}
