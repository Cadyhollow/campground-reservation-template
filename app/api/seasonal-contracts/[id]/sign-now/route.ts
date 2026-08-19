import { NextRequest, NextResponse } from 'next/server'
import { isSummit, freezePacket, errMessage } from '@/lib/contract-server'
import { requireRole } from '@/lib/require-role'



// POST /api/seasonal-contracts/[id]/sign-now — summit-gated. In-person signing:
// freeze the draft into a packet via freezePacket() (inherits the empty-doc guard,
// the rig/site snapshot, and compensation-on-failure) and return { packet_id } so
// the admin can open /packet/[packet_id] and hand the iPad to the camper.
// Does NOT email, and does NOT require the guest to have an email (a walk-up may
// have none) — no requireEmail passed.
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  // MANAGER, raised from Cady's 'staff' (decided 2026-08-19). Signing in person freezes the
  // draft into a packet and commits the agreement — the same act as sending, minus the email.
  const denied = await requireRole(request, 'manager')
  if (denied) return denied

  try {
    if (!(await isSummit())) {
      return NextResponse.json({ error: 'Not available on this plan.' }, { status: 403 })
    }
    const { id } = await params
    const result = await freezePacket(id)
    if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status })
    return NextResponse.json({ ok: true, packet_id: result.packet_id })
  } catch (e) {
    return NextResponse.json({ error: errMessage(e, 'Something went wrong') }, { status: 500 })
  }
}
