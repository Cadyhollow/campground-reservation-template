// Server-only helpers for the Seasonal Contracts routes. These routes are the
// trusted boundary: the admin UI and the public packet page never touch the
// signatures / seasonal_contracts / guest_notes tables via the anon client.
import type { NextRequest } from 'next/server'
import { randomBytes, randomUUID } from 'crypto'
import { createClient } from '@supabase/supabase-js'
import { Resend } from 'resend'
import { planAtLeast } from '@/lib/plan'
import { renderTemplate, buildContractVars } from '@/lib/contracts'

// Service-role client (bypasses RLS). Constructed at import is fine — createClient
// doesn't throw on missing env (unlike Resend, which we keep lazy below).
export const svc = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

// Lazy Resend so keyless builds (next build) don't construct — and throw — at import.
export function getResend() { return new Resend(process.env.RESEND_API_KEY) }

// Summit gate — reads settings.plan and fails CLOSED on missing/unknown plan.
export async function isSummit(): Promise<boolean> {
  const { data } = await svc.from('settings').select('plan').limit(1).single()
  return planAtLeast(data?.plan, 'summit')
}

// Client IP — identical logic to app/api/sign/[token]/route.ts:99
export function clientIp(request: NextRequest): string {
  return request.headers.get('x-forwarded-for')?.split(',')[0]?.trim()
    || request.headers.get('x-real-ip') || ''
}

// Absolute origin that works on localhost and in production.
export function originOf(request: NextRequest): string {
  return request.headers.get('origin')
    || (request.headers.get('host') ? `https://${request.headers.get('host')}` : '')
}

// The packet emails live in lib/contract-emails.ts — pure, and therefore unit-testable, which
// this module is not (it constructs a service-role client at import). Re-exported here so every
// caller keeps importing them from '@/lib/contract-server'.
export { packetEmailHtml, packetReceiptHtml } from '@/lib/contract-emails'

// THE FREEZE — the single place a draft becomes a signable packet. Renders both
// documents from settings, runs the empty-doc GUARD (so EVERY caller inherits it),
// snapshots the guest's rig/site onto the contract, inserts the two signature rows
// under one packet_id, and marks the contract 'sent'. Compensation-on-failure
// (delete partial writes) matches the original send route. Does NOT email — the
// caller owns that. Does NOT require the guest to have an email unless the caller
// asks (opts.requireEmail) — in-person signing has no email. Returns the packet_id
// plus the guest/contract/settings it already fetched, so a caller that emails
// doesn't re-read them.
// `select('*')` rows, so the honest type is an index signature rather than a hand-maintained
// column list that would silently rot against the schema. Cady declared these `any`; `unknown`
// values keep the shape open while still forcing callers to narrow before use, which is what the
// template's lint config asks for.
export type DbRow = Record<string, unknown>

export type FreezeResult =
  | { ok: true; packet_id: string; guest: DbRow; contract: DbRow; settings: DbRow | null }
  | { ok: false; status: number; error: string }

export async function freezePacket(contractId: string, opts?: { requireEmail?: boolean }): Promise<FreezeResult> {
  const { data: contract, error: cErr } = await svc.from('seasonal_contracts').select('*').eq('id', contractId).single()
  if (cErr || !contract) return { ok: false, status: 404, error: 'Contract not found' }
  if (contract.status !== 'draft') return { ok: false, status: 409, error: 'This contract has already been sent.' }

  const { data: guest } = await svc.from('guests').select('*').eq('id', contract.guest_id).single()
  if (!guest) return { ok: false, status: 404, error: 'Guest not found' }
  // Send needs an email to send the invite to — reject BEFORE freezing (unchanged
  // send behavior). In-person signing passes no requireEmail, so it can freeze.
  if (opts?.requireEmail && !guest.email) {
    return { ok: false, status: 400, error: 'This guest has no email on file to send the packet to.' }
  }

  const { data: settings } = await svc
    .from('settings')
    .select('park_name, park_email, contract_text, waiver_text')
    .limit(1).single()

  // The guest record is current truth; the contract is a frozen copy. Snapshot ALL
  // SIX rig fields + site_number from the guest, and render from that. (Occupants,
  // season dates, and total_due stay as the staff-edited draft.)
  const snapshot = {
    site_number: guest.site_number || contract.site_number || '',
    camper_type: guest.camper_type ?? null,
    camper_length: guest.camper_length ?? null,
    camper_amperage: guest.camper_amperage ?? null,
    camper_make: guest.camper_make ?? null,
    camper_model: guest.camper_model ?? null,
    camper_year: guest.camper_year ?? null,
  }

  // Typed rather than cast: this row is fetched with a NAMED column list a few lines up, so its
  // shape is known and the three `as any` casts Cady carried here were never necessary.
  const st = settings as {
    park_name?: string | null; park_email?: string | null
    contract_text?: string | null; waiver_text?: string | null
  } | null

  // ⚠ THE SETTINGS ARGUMENT IS DELIBERATELY OMITTED, AND THAT IS NOT A REGRESSION.
  //
  // buildContractVars documents a three-tier fallback for the season dates:
  //     contract.season_opens  ->  settings.season_opens  ->  guest.season_start
  //
  // The middle tier has never fired, on Cady or anywhere. `settings` HAS NO season_opens OR
  // season_closes COLUMN — the table's columns are season_start / season_end — so the lookup was
  // always undefined. Cady passed the row through `as any`, which silenced the type error that
  // would have said so; removing the cast during this port is what surfaced it.
  //
  // Passing `undefined` here is therefore BYTE-IDENTICAL to the behaviour that has been running
  // against real seasonal campers: the contract's own dates win, and the guest record is the
  // fallback. Passing the row with its columns remapped (season_start -> season_opens) would
  // ACTIVATE a dormant tier and could change which dates print on a legal agreement — that is a
  // product decision, not a porting decision, and it is flagged for Charissa rather than taken
  // here.
  const vars = buildContractVars(guest, { ...contract, ...snapshot }, undefined)
  const contractText = renderTemplate(st?.contract_text || '', vars)
  const waiverText = st?.waiver_text || '' // no merge fields today; rendered as-is
  const contractTitle = `${contract.season_year} Seasonal Admission Agreement`

  // GUARD: never freeze an empty legal document. Blocks BEFORE any rows are written.
  if (!contractText.trim()) {
    return { ok: false, status: 400, error: 'Contract text is empty — set the seasonal contract body in Settings before sending.' }
  }
  if (!waiverText.trim()) {
    return { ok: false, status: 400, error: 'Waiver text is empty — set the liability waiver in Settings before sending.' }
  }

  const packet_id = randomUUID()

  // Row A — the contract (sign_order 1)
  const { data: rowA, error: eA } = await svc.from('signatures').insert({
    doc_type: 'seasonal_contract', guest_id: guest.id, packet_id, sign_order: 1,
    sign_token: randomBytes(24).toString('base64url'), status: 'pending',
    document_title: contractTitle, document_text: contractText,
    signer_name: guest.name || '', signer_email: guest.email || '',
  }).select('id').single()
  if (eA || !rowA) return { ok: false, status: 500, error: eA?.message || 'Could not create contract document.' }

  // Row B — the waiver (sign_order 2)
  const { data: rowB, error: eB } = await svc.from('signatures').insert({
    doc_type: 'seasonal_waiver', guest_id: guest.id, packet_id, sign_order: 2,
    sign_token: randomBytes(24).toString('base64url'), status: 'pending',
    document_title: 'Liability Waiver', document_text: waiverText,
    signer_name: guest.name || '', signer_email: guest.email || '',
  }).select('id').single()
  if (eB || !rowB) {
    await svc.from('signatures').delete().eq('id', rowA.id)
    return { ok: false, status: 500, error: eB?.message || 'Could not create waiver document.' }
  }

  // Snapshot onto the contract + link + mark sent. On failure roll the rows back.
  const { error: eC } = await svc.from('seasonal_contracts').update({
    status: 'sent',
    packet_id,
    contract_signature_id: rowA.id,
    waiver_signature_id: rowB.id,
    ...snapshot,
    sent_at: new Date().toISOString(),
  }).eq('id', contractId).eq('status', 'draft')
  if (eC) {
    await svc.from('signatures').delete().in('id', [rowA.id, rowB.id])
    return { ok: false, status: 500, error: eC.message }
  }

  return { ok: true, packet_id, guest, contract, settings }
}
