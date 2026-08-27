// Server-only helpers for the Seasonal Contracts routes. These routes are the
// trusted boundary: the admin UI and the public packet page never touch the
// signatures / seasonal_contracts / guest_notes tables via the anon client.
import type { NextRequest } from 'next/server'
import { randomBytes, randomUUID } from 'crypto'
import { createClient } from '@supabase/supabase-js'
import { Resend } from 'resend'
import { planAtLeast } from '@/lib/plan'
import { guestRigSnapshot, renderPacketDocuments } from '@/lib/contracts'

// Service-role client (bypasses RLS). Constructed at import is fine — createClient
// doesn't throw on missing env (unlike Resend, which we keep lazy below).
export const svc = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

// Lazy Resend so keyless builds (next build) don't construct — and throw — at import.
export function getResend() { return new Resend(process.env.RESEND_API_KEY) }

/**
 * Is outbound email actually configured on this deployment?
 *
 * ⚠ THIS GUARDS A DOCUMENTED SILENT-FAILURE MODE, not a hypothetical one.
 *
 * Onboarding provisions a new client's key from the shared ResoNation one:
 *
 *     RESEND_API_KEY: resend_api_key || process.env.RESEND_API_KEY || ''
 *
 * Note the final `|| ''`. If the shared key were ever missing from the admin system, a client
 * would still onboard "successfully" and simply send no email — the onboarding runbook names this
 * as its single most dangerous failure mode, with an end-of-setup test booking as the tripwire.
 *
 * A test booking catches it for confirmations. It does NOT catch it for seasonal contracts, which
 * are sent months later by a park owner with no reason to suspect anything. Without this check
 * "Send" would report success and the camper would simply never receive their agreement — and the
 * park would discover it at the start of the season.
 *
 * So every route that sends mail calls this FIRST and refuses with a message a park owner can act
 * on, turning a silent failure into a visible one. Checked at call time rather than at import: the
 * key is an environment variable, and a deployment can be fixed without a code change.
 */
export function emailConfigured(): boolean {
  return !!(process.env.RESEND_API_KEY || '').trim()
}

/** What a park owner sees when email is not set up. Shared so it reads identically wherever it
 *  surfaces, and it names ResoNation because the fix is ours, not the park's. */
export const EMAIL_NOT_CONFIGURED =
  'Email is not set up for this site yet, so the packet could not be sent. ' +
  'Nothing has been changed — please contact ResoNation support, then try again.'

// Summit gate — reads settings.plan and fails CLOSED on missing/unknown plan.
export async function isSummit(): Promise<boolean> {
  const { data } = await svc.from('settings').select('plan').limit(1).single()
  return planAtLeast(data?.plan, 'summit')
}

/**
 * The message from a thrown value.
 *
 * Cady's seasonal routes all wrote `catch (e: any) { e?.message }`. This repo's lint config
 * forbids `any`, and `unknown` is the honest type for a caught value anyway — a throw can be any
 * value at all, not only an Error. Same output as before, without the escape hatch, and in one
 * place rather than repeated in every route.
 */
export function errMessage(e: unknown, fallback = 'Something went wrong'): string {
  return e instanceof Error && e.message ? e.message : fallback
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

/**
 * The season a new contract for `year` belongs to — reused if one exists, created if not.
 *
 * Phase 2a made seasonal_contracts.season_id NOT NULL, so EVERY path that inserts a contract has
 * to supply one. Both of them (the create route and the clone route) go through here so the
 * "which season?" answer is defined once.
 *
 * ⚠ THIS IS A TRANSITIONAL RULE, AND IT IS INTENDED RATHER THAN A BUG.
 *
 * Creation still goes BY YEAR — the screens have no season picker until Phase 2b. So if a park
 * has defined two seasons in one year (a Spring and a Fall, which is the whole point of the
 * feature), a contract created today attaches to the year's DEFAULT season: the earliest-created
 * one. Phase 2b replaces this call with an explicit choice made by the owner.
 *
 * "Earliest-created" is the same rule the Phase 2a migration's backfill used, with the same
 * created_at/id ordering, so a season chosen here and a season chosen by the backfill agree.
 *
 * The auto-created season's name and null dates also match the backfill exactly, so a season the
 * app makes and a season the migration made are indistinguishable.
 */
export async function findOrCreateSeasonForYear(year: number): Promise<
  { ok: true; season_id: string } | { ok: false; error: string }
> {
  const findExisting = async () => {
    const { data } = await svc
      .from('seasons')
      .select('id')
      .eq('year', year)
      .order('created_at', { ascending: true })
      .order('id', { ascending: true })
      .limit(1)
      .maybeSingle()
    return data?.id as string | undefined
  }

  const existing = await findExisting()
  if (existing) return { ok: true, season_id: existing }

  const { data: created, error } = await svc
    .from('seasons')
    .insert({ name: `${year} Season`, year, opens: null, closes: null })
    .select('id')
    .single()
  if (created?.id) return { ok: true, season_id: created.id as string }

  // Lost a race with a concurrent create (or the insert failed for another reason): look again
  // before giving up, so two simultaneous "New Seasonal Camper" saves don't both fail.
  const raced = await findExisting()
  if (raced) return { ok: true, season_id: raced }
  return { ok: false, error: error?.message || 'Could not resolve a season for this year.' }
}

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
  const snapshot = guestRigSnapshot(guest, contract)

  // Typed rather than cast: this row is fetched with a NAMED column list a few lines up, so its
  // shape is known and the three `as any` casts Cady carried here were never necessary.
  const st = settings as {
    park_name?: string | null; park_email?: string | null
    contract_text?: string | null; waiver_text?: string | null
  } | null

  // ⚠ THE RENDERING NOW LIVES IN lib/contracts.ts AND THIS IS NOT A REFACTOR FOR TIDINESS.
  //
  // Phase 1.5 added a full-page review screen that shows the owner the finished documents before
  // anything is frozen. A preview that renders through its own copy of this logic is a screen
  // that promises "this is what they will sign" and is free to be wrong. So the snapshot and the
  // rendering were lifted into renderPacketDocuments()/guestRigSnapshot() in lib/contracts.ts —
  // a pure module the browser can import — and THE FREEZE CALLS THE SAME FUNCTIONS. There is no
  // second renderer left to drift.
  //
  // The behaviour is unchanged, including the one subtlety worth restating here because it is
  // load-bearing and easy to "fix" by accident:
  //
  //   THE SETTINGS ARGUMENT TO buildContractVars IS DELIBERATELY OMITTED. buildContractVars
  //   documents a three-tier fallback for the season dates:
  //       contract.season_opens  ->  settings.season_opens  ->  guest.season_start
  //   The middle tier has never fired, on Cady or anywhere. `settings` HAS NO season_opens OR
  //   season_closes COLUMN — the table's columns are season_start / season_end — so the lookup
  //   was always undefined. Cady passed the row through `as any`, which silenced the type error
  //   that would have said so. Passing the row with its columns remapped would ACTIVATE a dormant
  //   tier and could change which dates print on a legal agreement — a product decision, not a
  //   refactoring one. renderPacketDocuments preserves the omission and says so in its own note.
  const { contractTitle, contractText, waiverText } = renderPacketDocuments(guest, contract, st)

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
