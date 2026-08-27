import { NextRequest, NextResponse } from 'next/server'
import { svc, isSummit, errMessage } from '@/lib/contract-server'
import { requireRole } from '@/lib/require-role'

// POST /api/seasonal-contracts/[id]/cancel  — RETRACT A SENT-BUT-UNSIGNED PACKET.
//
// Until now a sent packet could only be re-emailed. There was no way to pull one back after a
// wrong site number, a wrong total, or a party that changed after the envelope went out. This
// route is the undo: it invalidates the camper's signing link and puts the contract back to a
// draft the owner can edit and send fresh.
//
// WHAT IT DOES, IN ORDER
//   1. Voids the packet's signature rows (status != 'signed' only — see the race note below).
//      The rows are NOT deleted: they are the audit trail of what was sent and when.
//   2. Reverts the contract to 'draft' and clears packet_id, the two signature ids, and sent_at.
//   3. Voids any seasonal fee the contract posted to the camper's account (Phase 4 PR 2), so a
//      retracted agreement leaves no phantom debt behind it.
//
// WHY RE-SENDING AFTERWARDS IS CLEAN. freezePacket() refuses anything not in 'draft', and mints a
// NEW packet_id with NEW signature rows and NEW sign tokens every time it runs. So a cancel
// followed by a send produces a genuinely new packet — the retracted one cannot be revived, and
// the old link stays dead.
//
// ⚠ A SIGNED PACKET IS NEVER CANCELABLE. An executed agreement is final; the only status that can
// be retracted is 'sent'.
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  // MANAGER — the same gate as create/PATCH/send/resend. Cancelling retracts a legal agreement a
  // camper has already received, which is squarely "changing a seasonal contract".
  const denied = await requireRole(request, 'manager')
  if (denied) return denied

  try {
    if (!(await isSummit())) {
      return NextResponse.json({ error: 'Not available on this plan.' }, { status: 403 })
    }
    const { id } = await params

    const { data: contract, error: loadErr } = await svc
      .from('seasonal_contracts')
      .select('id, status, packet_id')
      .eq('id', id)
      .single()
    if (loadErr || !contract) return NextResponse.json({ error: 'Contract not found' }, { status: 404 })

    if (contract.status === 'draft') {
      return NextResponse.json({ error: "This packet hasn't been sent yet." }, { status: 409 })
    }
    if (contract.status === 'signed') {
      return NextResponse.json({ error: "This packet has already been signed and can't be canceled." }, { status: 409 })
    }
    if (contract.status !== 'sent') {
      return NextResponse.json({ error: 'This packet can no longer be canceled.' }, { status: 409 })
    }

    // 1) Void the packet's signature rows. `.neq('status', 'signed')` is the race guard the spec
    //    asks for: if a camper signed a document in the moment between the read above and this
    //    write, that row is left exactly as it is. Voided rows are KEPT — deleting them would
    //    destroy the record that a packet was ever sent.
    if (contract.packet_id) {
      const { error: voidErr } = await svc
        .from('signatures')
        .update({ status: 'voided' })
        .eq('packet_id', contract.packet_id)
        .neq('status', 'signed')
      if (voidErr) {
        // Nothing has been reverted yet, so the packet is still intact and still signable.
        return NextResponse.json({ error: 'Could not cancel this packet. Please try again.' }, { status: 500 })
      }
    }

    // 2) Back to a fresh draft. `.eq('status', 'sent')` is re-asserted in the WHERE clause — the
    //    same defensive pattern the PATCH route and freezePacket use — so a sign that landed
    //    while this request was in flight cannot be clobbered by the revert.
    const { data: reverted, error: revertErr } = await svc
      .from('seasonal_contracts')
      .update({
        status: 'draft',
        packet_id: null,
        contract_signature_id: null,
        waiver_signature_id: null,
        sent_at: null,
      })
      .eq('id', id)
      .eq('status', 'sent')
      .select('id')
      .maybeSingle()

    if (revertErr) {
      return NextResponse.json({ error: 'Could not cancel this packet. Please try again.' }, { status: 500 })
    }
    if (!reverted) {
      // The status moved out from under us — in practice, the camper signed. Say so plainly
      // rather than reporting a success that did not happen.
      return NextResponse.json(
        { error: 'This packet was signed while you were canceling it, so it was left in place.' },
        { status: 409 },
      )
    }

    // 3) Void any seasonal fee this contract posted (Phase 4 PR 2). A retracted agreement must
    //    leave no phantom debt: the camper no longer has a contract, so they no longer owe the
    //    fee it stated. Voided rather than deleted — the ledger keeps its audit trail, and
    //    laneBalances excludes voided charges from every total.
    //
    //    NOT gated on billing_mode, on purpose. A park that posted charges while separated and
    //    later switched back to combined would otherwise leave live seasonal charges behind on
    //    cancelled contracts. Where no such charge exists this matches nothing and is a no-op,
    //    which is every combined park and every contract predating this feature.
    //
    //    `.neq('voided', true)` keeps it idempotent and stops a second cancel rewriting
    //    voided_at on a row that was already voided.
    const { error: voidErr } = await svc
      .from('folio_line_items')
      .update({ voided: true, voided_at: new Date().toISOString(), reason: 'Seasonal packet canceled' })
      .eq('seasonal_contract_id', id)
      .neq('voided', true)
    if (voidErr) {
      // The packet IS canceled — the link is dead and the contract is a draft again. Say so
      // rather than reporting a failure that would invite a second cancel, but make the leftover
      // charge visible so it can be voided by hand.
      console.error('Packet canceled but its seasonal charge could not be voided:', voidErr.message)
      return NextResponse.json({
        ok: true,
        warning: 'The packet was canceled, but the seasonal fee on this camper\u2019s account could not be removed. Please void it on their folio.',
      })
    }

    return NextResponse.json({ ok: true })
  } catch (e) {
    return NextResponse.json({ error: errMessage(e, 'Something went wrong') }, { status: 500 })
  }
}
