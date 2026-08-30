import { NextRequest, NextResponse } from 'next/server'
import { svc, isSummit, errMessage, syncSeasonalCharge } from '@/lib/contract-server'
import { requireRole } from '@/lib/require-role'



// Fields staff may edit on a DRAFT contract.
//
// `charge_note` and `staff_notes` are BOTH here and are NOT interchangeable: staff_notes is the
// owner's private scratchpad, charge_note prints on the camper's contract under the total. See
// db/migrations/2026-08-27-seasonal-charge-note.sql.
const EDITABLE = [
  'occupants', 'total_due_cents', 'staff_notes', 'charge_note', 'site_number',
  // Phase 3 — display-only amounts and their due-by dates. They need no snapshot logic at send
  // (unlike the season dates): they are plain columns ON the contract, so the document renders
  // them as they stand, and this route already refuses any edit once the status leaves 'draft'.
  'deposit_due_cents', 'total_due_by', 'deposit_due_by',
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
    // ── KEEP THE BOOKS IN STEP WITH THE PRICE ────────────────────────────────────────────────
    //
    // If this edit changed total_due_cents AND a seasonal fee is already posted on the camper's
    // folio, adjust that charge to match. Through the EXISTING row — never a second charge —
    // so the folio keeps reconciling and the Phase 4 lane tag survives. A no-op when nothing is
    // posted yet, which is the normal case for a draft.
    //
    // Non-fatal: the contract edit above is committed and correct. A failure here is surfaced as
    // a warning rather than an error, because reporting failure would invite the owner to save
    // again and re-do an edit that already landed.
    let chargeWarning: string | undefined
    if ('total_due_cents' in patch) {
      const sync = await syncSeasonalCharge(id, patch.total_due_cents as number | null)
      if (sync.error) {
        console.error('Contract price saved but its folio charge could not be adjusted:', sync.error)
        chargeWarning = 'The price was saved, but the charge already on this camper\u2019s account could not be updated. Check their folio.'
      }
    }

    return NextResponse.json({ contract: data, warning: chargeWarning })
  } catch (e) {
    return NextResponse.json({ error: errMessage(e, 'Something went wrong') }, { status: 500 })
  }
}
