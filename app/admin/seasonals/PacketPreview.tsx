'use client'
// THE PACKET PREVIEW — the finished documents, exactly as the camper will receive them.
//
// Shared by the New Camper intake form (app/admin/seasonals/new/page.tsx) and the Phase 1.5
// review screen (app/admin/seasonals/[guestId]/review/page.tsx). It exists so those two screens
// cannot show different things, and so neither can drift from what is actually frozen:
// the rendering itself is renderPacketDocuments() in lib/contracts.ts, which freezePacket() in
// lib/contract-server.ts also calls. This component only DISPLAYS what that returns.
//
// Presentational and pure — no fetching, no writes, no state. The parent owns the data.
import { renderPacketDocuments } from '@/lib/contracts'

const paper: React.CSSProperties = {
  background: '#FBF8F1', border: '1px solid #F3EEE2', borderRadius: 10, padding: '1rem',
  overflowY: 'auto', fontSize: 13, lineHeight: 1.5, color: '#374151', whiteSpace: 'pre-wrap',
}

/** What the preview needs to render. Deliberately the same shapes renderPacketDocuments takes. */
export type PacketPreviewProps = {
  guest: Parameters<typeof renderPacketDocuments>[0]
  contract: Parameters<typeof renderPacketDocuments>[1]
  settings: Parameters<typeof renderPacketDocuments>[2]
  /** Phase 2b. The contract's season — supplies the inherited dates and {{season_name}}. */
  season?: Parameters<typeof renderPacketDocuments>[3]
  /** Height cap for each document box. The intake form uses 30vh; the review screen gives more. */
  maxHeight?: string
}

/**
 * Render the two documents.
 *
 * The empty-state strings are not decoration: an empty contract or waiver body is the one thing
 * freezePacket refuses outright ("Contract text is empty — set the seasonal contract body in
 * Settings before sending"), so the preview names the same fix in the same place the owner is
 * looking.
 */
export default function PacketPreview({ guest, contract, settings, season, maxHeight = '30vh' }: PacketPreviewProps) {
  const { contractTitle, contractText, waiverText } = renderPacketDocuments(guest, contract, settings, season)
  const box = { ...paper, maxHeight }
  return (
    <>
      <div className="mb-2">
        <p className="text-xs font-bold text-gray-700 mb-1">{contractTitle}</p>
        <div style={box}>{contractText.trim() || 'Contract text is not set in Settings.'}</div>
      </div>
      <div>
        <p className="text-xs font-bold text-gray-700 mb-1">Liability Waiver</p>
        <div style={box}>{waiverText.trim() || 'Waiver text is not set in Settings.'}</div>
      </div>
    </>
  )
}

/**
 * The contract-critical fields, as one list, so the intake form and the review screen block a
 * send on exactly the same conditions.
 *
 * The last two entries are the source-level twin of freezePacket's empty-document guard: the
 * server refuses a blank legal document regardless, and this is what stops the owner reaching
 * that refusal with a click.
 */
export function missingPacketFields(input: {
  name?: string | null
  siteNumber?: string | null
  /** Phase 2b: pass the EFFECTIVE dates (effectiveSeasonDates), not the raw override columns —
   *  a camper inheriting a dated season must pass, and one whose season has no dates must not. */
  seasonOpens?: string | null
  seasonCloses?: string | null
  homeStreet?: string | null
  homeCity?: string | null
  homeState?: string | null
  homeZip?: string | null
  contractText: string
  waiverText: string
}): string[] {
  const missing: string[] = []
  if (!(input.name || '').trim()) missing.push('name')
  if (!(input.siteNumber || '').trim()) missing.push('site')
  if (!input.seasonOpens) missing.push('season opens (set it on the season, or override it here)')
  if (!input.seasonCloses) missing.push('season closes (set it on the season, or override it here)')
  if (!(input.homeStreet && input.homeCity && input.homeState && input.homeZip)) missing.push('home address')
  if (!input.contractText.trim()) missing.push('contract text (set it in Settings)')
  if (!input.waiverText.trim()) missing.push('waiver text (set it in Settings)')
  return missing
}
