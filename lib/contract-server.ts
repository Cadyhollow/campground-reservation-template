// Server-only helpers for the Seasonal Contracts routes. These routes are the
// trusted boundary: the admin UI and the public packet page never touch the
// signatures / seasonal_contracts / guest_notes tables via the anon client.
import type { NextRequest } from 'next/server'
import { randomBytes, randomUUID } from 'crypto'
import { createClient } from '@supabase/supabase-js'
import { Resend } from 'resend'
import { planAtLeast } from '@/lib/plan'
import {
  guestRigSnapshot, renderPacketDocuments, effectiveSeasonDates,
  buildContractVars, renderTemplate,
} from '@/lib/contracts'
import { normalizeBillingMode, type BillingMode } from '@/lib/ledger-lanes'
import { bucketLabels, type BucketLabels } from '@/lib/bucket-labels'

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
 * Keep a POSTED seasonal charge in step with the contract's price.
 *
 * The fee is posted to the folio when a packet is sent (postSeasonalCharge). If the price then
 * changes — a camper moves to a dearer site — the charge already on their account would otherwise
 * still say the old figure, and the books would disagree with the agreement.
 *
 * ⚠ IT ADJUSTS THE EXISTING ROW. It never inserts a second charge, so a price edited five times
 * leaves ONE seasonal charge, not a stack of them, and postSeasonalCharge's idempotency gate
 * ("no non-voided charge for this contract") keeps holding. The row keeps its lane:'seasonal' tag
 * and its seasonal_contract_id, so every Phase 4 guarantee survives: the lanes still sum to the
 * account, and a voided row is still excluded.
 *
 * ⚠ NOTHING IS POSTED HERE. If no charge exists yet — the packet has not been sent — this does
 * nothing at all, and the new price posts correctly at send. Creating one early would put a fee
 * on a camper's account for an agreement they have not been given.
 *
 * A price cleared or set to zero VOIDS the charge rather than writing a $0 line: zero owed and
 * "no fee agreed" are the same thing on a folio, and a voided row keeps the audit trail.
 */
export async function syncSeasonalCharge(
  contractId: string,
  newTotalCents: number | null,
): Promise<{ changed: boolean; error?: string }> {
  try {
    const { data: charge } = await svc
      .from('folio_line_items')
      .select('id, line_total')
      .eq('seasonal_contract_id', contractId)
      .neq('voided', true)
      .limit(1)
      .maybeSingle()
    if (!charge) return { changed: false }   // nothing posted yet — send will post the new price

    const total = Number(newTotalCents ?? 0)
    if (!Number.isFinite(total) || total <= 0) {
      const { error } = await svc.from('folio_line_items')
        .update({ voided: true, voided_at: new Date().toISOString(), reason: 'Seasonal fee removed' })
        .eq('id', charge.id)
      return error ? { changed: false, error: error.message } : { changed: true }
    }
    if (Number(charge.line_total) === total) return { changed: false }   // already in step

    const { error } = await svc.from('folio_line_items')
      .update({ unit_price: total, line_total: total })
      .eq('id', charge.id)
    return error ? { changed: false, error: error.message } : { changed: true }
  } catch (e) {
    return { changed: false, error: errMessage(e, 'Could not update the seasonal charge.') }
  }
}

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

/**
 * The invitation email's message, rendered for one contract — Phase 3.
 *
 * The park's own text from settings.packet_email_intro, with the SAME merge tokens the contract
 * body supports, substituted against the SAME inputs the document used: the guest, the contract,
 * and the contract's season (effective dates included). So "your deposit of {{deposit_due}} is due
 * by {{deposit_due_by}}" in the email says exactly what the agreement says.
 *
 * Returns '' when the park has set nothing — packetEmailHtml then renders its built-in default.
 *
 * ⚠ THIS IS A COVER NOTE, NOT PART OF THE SIGNED DOCUMENT, and the difference is the whole reason
 * it can be rendered late. The packet's two documents were frozen onto signature rows at send and
 * are never re-read. This text is rendered FRESH every time an email goes out — so editing it
 * between a send and a resend changes what the covering email says and CANNOT change what the
 * camper signs. The resent link still points at the same frozen packet.
 *
 * Shared by /send and /resend so the two cannot drift apart.
 */
export function renderPacketIntro(
  guest: DbRow | null | undefined,
  contract: DbRow | null | undefined,
  season: DbRow | null | undefined,
  settings: { packet_email_intro?: string | null } | null | undefined,
): string {
  const raw = (settings?.packet_email_intro || '').trim()
  if (!raw) return ''
  const dates = effectiveSeasonDates(contract as never, season as never)
  const vars = buildContractVars(
    (guest || {}) as never,
    {
      ...(contract || {}),
      season_opens: dates.opens,
      season_closes: dates.closes,
      season_name: (season?.name as string | undefined) ?? null,
    } as never,
    undefined,
  )
  return renderTemplate(raw, vars)
}

/**
 * The park's billing mode, read server-side and failing safe to 'combined'.
 *
 * Shared so every lane decision on the server answers the question the same way. A park that has
 * not run the Phase 4 migration has no such column, and that select fails — which lands here on
 * 'combined', i.e. exactly today's behaviour.
 */
export async function getBillingMode(): Promise<BillingMode> {
  try {
    const { data } = await svc.from('settings').select('billing_mode').limit(1).single()
    return normalizeBillingMode(data?.billing_mode)
  } catch {
    return 'combined'
  }
}

/**
 * The park's wording for the two money buckets, defaults where they have chosen nothing.
 *
 * ⚠ ITS OWN GUARDED SELECT, like getBillingMode() above and for the same reason: a park that has
 * not run db/migrations/2026-09-02-bucket-labels.sql has neither column, and widening an existing
 * settings select to include them would fail that whole query and take the screen with it. A
 * failure here is not an error state — it is a park that has not configured this — so it falls
 * back to the built-in labels rather than surfacing anything.
 */
export async function getBucketLabels(): Promise<BucketLabels> {
  try {
    const { data } = await svc.from('settings').select('bucket_label_camp, bucket_label_seasonal').limit(1).single()
    return bucketLabels(data)
  } catch {
    return bucketLabels(null)
  }
}

/**
 * Post the seasonal fee as a real charge in the seasonal lane — Phase 4, PR 2.
 *
 * Until now `total_due_cents` was display-only: a number printed on the agreement that the books
 * never saw. This puts it on the camper's account, so what they owe for the season is tracked
 * separately from their store tab and their electric.
 *
 * ⚠ POSTED IN BOTH BILLING MODES. TRACKING A FEE MUST NOT DEPEND ON HOW IT IS DISPLAYED.
 * billing_mode decides PRESENTATION — whether the camper's account is shown as separate lanes or
 * as one blended balance, and whether the electric bill is lane-isolated. It does not decide
 * whether the money is on the books. A combined park gets the same charge; it simply appears in
 * its single blended balance, which is exactly what "everything together" should mean.
 *
 * ⚠ THE TRIGGER IS total_due_cents > 0, AND THAT IS THE REAL SAFETY GATE. A park that does not put
 * an amount on its contracts posts nothing at all, so this can never surprise a park that tracks
 * seasonal money somewhere else entirely.
 *
 * ⚠ IDEMPOTENT, AND THAT IS THE POINT OF seasonal_contract_id. The gate is "no NON-VOIDED charge
 * already exists for this contract". So:
 *   send                     → posts once
 *   cancel                   → voids it
 *   edit and send again      → the old one is voided, so a fresh charge posts — correct, because
 *                              the re-sent agreement may state a different amount
 *   any repeat of the above  → never a second live charge
 *
 * ⚠ NEVER FAILS THE SEND. By the time this runs the packet is COMMITTED — signature rows written,
 * contract marked sent, and the camper about to receive a link. Throwing here would leave a real
 * packet reported as a failure. So every error is captured and returned for the caller to surface,
 * not raised.
 *
 * ⚠ GOING FORWARD ONLY. Nothing backfills historical contracts, deliberately — see the migration.
 */
export async function postSeasonalCharge(
  contract: DbRow,
  guest: DbRow,
  season: DbRow | null,
): Promise<{ posted: boolean; error?: string }> {
  try {
    const total = Number(contract.total_due_cents ?? 0)
    // Zero or unset is not a charge. A contract with no stated fee should put nothing on the
    // books — the same reason deposit_due_cents distinguishes NULL from 0 on the document.
    if (!Number.isFinite(total) || total <= 0) return { posted: false }

    const contractId = String(contract.id || '')
    const guestId = String(guest.id || '')
    if (!contractId || !guestId) return { posted: false }

    // Already charged for this contract? Voided ones do not count — a cancel voids, and the
    // re-send that follows is entitled to post the (possibly amended) fee again.
    const { data: existing } = await svc
      .from('folio_line_items')
      .select('id')
      .eq('seasonal_contract_id', contractId)
      .neq('voided', true)
      .limit(1)
      .maybeSingle()
    if (existing) return { posted: false }

    // The camper's standing account folio, created if they have none — same shape the electric
    // billing screen and the guest folio page already use, so all three find the same folio.
    const { data: folio } = await svc
      .from('folios')
      .select('id')
      .eq('folio_type', 'guest_account')
      .eq('guest_id', guestId)
      .limit(1)
      .maybeSingle()
    let folioId = folio?.id as string | undefined
    if (!folioId) {
      const { data: created, error: fErr } = await svc.from('folios').insert({
        guest_id: guestId,
        guest_name: (guest.name as string) || '',
        guest_email: (guest.email as string) || '',
        folio_type: 'guest_account', status: 'open', label: 'Seasonal Account',
      }).select('id').single()
      if (fErr || !created) return { posted: false, error: fErr?.message || 'Could not open an account for this camper.' }
      folioId = created.id as string
    }

    const seasonName = (season?.name as string | undefined)?.trim()
    const description = `${seasonName || `${contract.season_year ?? ''} Season`} — Seasonal Fee`.trim()

    const { error } = await svc.from('folio_line_items').insert({
      folio_id: folioId,
      product_id: null,
      description,
      quantity: 1,
      unit_price: total,
      tax_amount: 0,
      line_total: total,
      // The explicit lane. Without it this row has no product_id and no electric reading, so it
      // would be inferred as `other` — indistinguishable from a manual custom charge.
      lane: 'seasonal',
      seasonal_contract_id: contractId,
    })
    if (error) return { posted: false, error: error.message }
    return { posted: true }
  } catch (e) {
    return { posted: false, error: errMessage(e, 'Could not post the seasonal fee.') }
  }
}

// THE FREEZE — the single place a draft becomes a signable packet. Renders both
// documents from settings, runs the empty-doc GUARD (so EVERY caller inherits it),
// snapshots the guest's rig/site AND the resolved season dates onto the contract,
// inserts the two signature rows
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
  | {
      ok: true; packet_id: string; guest: DbRow; contract: DbRow; settings: DbRow | null; season: DbRow | null
      /** Phase 4 PR 2. Whether the seasonal fee was posted to the camper's account, and why not
       *  if it failed. Never fatal — the packet is already committed by the time it runs. */
      seasonalCharge: { posted: boolean; error?: string }
    }
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
    .select('park_name, park_email, contract_text, waiver_text, packet_email_intro')
    .limit(1).single()

  // The guest record is current truth; the contract is a frozen copy. Snapshot ALL
  // SIX rig fields + site_number from the guest, and render from that. (Occupants,
  // season dates, and total_due stay as the staff-edited draft.)
  const snapshot = guestRigSnapshot(guest, contract)

  // Phase 2b — THE SEASON, AND WHY ITS DATES ARE SNAPSHOTTED HERE.
  //
  // A contract inherits its season's dates unless it carries its own override. That inheritance
  // is LIVE: change the season and every inheriting draft changes with it. That is right for a
  // draft and catastrophic for a sent agreement — an owner correcting next year's season dates
  // must not silently rewrite the dates a camper signed months ago.
  //
  // So the freeze RESOLVES the inheritance and writes the answer down. From this moment the
  // contract carries concrete dates of its own, and later edits to the season cannot reach it.
  // Same principle as the rig snapshot above, and as document_text on the signature rows.
  const { data: season } = contract.season_id
    ? await svc.from('seasons').select('name, opens, closes').eq('id', contract.season_id).single()
    : { data: null }
  const dates = effectiveSeasonDates(contract, season)
  const seasonSnapshot = { season_opens: dates.opens, season_closes: dates.closes }

  // Typed rather than cast: this row is fetched with a NAMED column list a few lines up, so its
  // shape is known and the three `as any` casts Cady carried here were never necessary.
  const st = settings as {
    park_name?: string | null; park_email?: string | null
    contract_text?: string | null; waiver_text?: string | null
    packet_email_intro?: string | null
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
  const { contractTitle, contractText, waiverText } = renderPacketDocuments(guest, contract, st, season)

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
    // The resolved season dates, written down so the sent packet carries immutable dates of its
    // own rather than a live pointer at a season somebody may later edit.
    ...seasonSnapshot,
    sent_at: new Date().toISOString(),
  }).eq('id', contractId).eq('status', 'draft')
  if (eC) {
    await svc.from('signatures').delete().in('id', [rowA.id, rowB.id])
    return { ok: false, status: 500, error: eC.message }
  }

  // Phase 4 PR 2 — the fee goes on the books, AFTER the packet is committed. BOTH billing modes:
  // tracking does not depend on display. A no-op when the contract states no amount. Deliberately
  // last and deliberately non-fatal: everything above this line is already real and the camper is
  // about to be sent a link.
  const seasonalCharge = await postSeasonalCharge(contract, guest, season ?? null)
  if (seasonalCharge.error) {
    console.error('Seasonal fee not posted for contract', contractId, '—', seasonalCharge.error)
  }

  // The season travels back so /send can render the invitation email's intro against the same
  // inputs the document used, without a second query.
  return { ok: true, packet_id, guest, contract, settings, season: season ?? null, seasonalCharge }
}
