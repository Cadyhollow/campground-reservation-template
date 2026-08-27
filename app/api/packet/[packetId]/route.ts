import { NextRequest, NextResponse } from 'next/server'
import { svc } from '@/lib/contract-server'

// GET /api/packet/[packetId] — public. Returns the packet's documents in
// sign_order, each rendered FROM ITS OWN ROW (document_text). Never re-reads
// settings.contract_text / settings.waiver_text — the frozen bytes live on the row.
export async function GET(_request: NextRequest, { params }: { params: Promise<{ packetId: string }> }) {
  const { packetId } = await params
  if (!packetId) return NextResponse.json({ status: 'not_found' }, { status: 400 })

  const { data: rows, error } = await svc
    .from('signatures')
    .select('id, doc_type, document_title, document_text, status, signed_at, sign_order')
    .eq('packet_id', packetId)
    .order('sign_order', { ascending: true })

  if (error || !rows || rows.length === 0) {
    return NextResponse.json({ status: 'not_found' }, { status: 404 })
  }

  const { data: settings } = await svc.from('settings').select('park_name').limit(1).single()
  const allSigned = rows.every(r => r.status === 'signed')
  // CANCELED PACKET. /api/seasonal-contracts/[id]/cancel voids this packet's rows and reverts the
  // contract to draft; from that moment the emailed link must stop working. `signed` is checked
  // FIRST so an already-executed packet still renders its signed copy — cancel cannot reach a
  // signed row, so a mix can only mean the packet was retracted mid-way.
  //
  // This mirrors app/api/sign/[token]/route.ts, which has always returned `status: 'voided'` for
  // a voided row. The per-token route and this per-packet route now agree.
  const anyVoided = rows.some(r => r.status === 'voided')

  if (!allSigned && anyVoided) {
    return NextResponse.json({ status: 'voided' })
  }

  return NextResponse.json({
    status: allSigned ? 'signed' : 'pending',
    parkName: settings?.park_name || 'Campground',
    documents: rows.map(r => ({
      id: r.id,
      docType: r.doc_type,
      documentTitle: r.document_title,
      documentText: r.document_text || '',
      status: r.status,
      signedAt: r.signed_at,
    })),
  })
}
