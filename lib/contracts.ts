// Pure template + variable helpers for Seasonal Contracts. No DB, no I/O — safe
// to unit-test in isolation.
//
// Substitution is token-replacement ONLY: {{token}} -> its value, and any unknown
// token -> '' (never left as a literal "{{...}}"). Everything else in the body is
// returned byte-for-byte — never trimmed, reflowed, whitespace-normalized, or
// HTML-sanitized. Contract wording (e.g. "This agreement is not a lease of real
// estate…", the unpaid-debt/securing-the-camper clause) is legally exact and must
// not be altered by rendering.
//
// Mirrors the existing simple substitution at app/book/BookingForm.tsx:346
// (waiver_text.replace(/\[CAMPGROUND NAME\]/g, …)), generalized to {{token}} form. That older
// form stays where it is: it is the PUBLIC booking waiver and uses a different placeholder
// vocabulary. This module is for the seasonal packet, and the two are deliberately not merged.
//
// PORTED FROM cady-hollow-reservations (lib/contracts.ts), which is where this feature was first
// built. Behaviour is unchanged; the file reference above is the only edit, because the public
// waiver lives at a different path in this repo. Cady carried NO tests for this module — the
// suite alongside this file is new, and pins the rules the comment above only asserted.

export type ContractVars = Record<string, string>

const TOKEN_RE = /\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g

/** Replace every {{token}} with its value; unknown tokens render as '' (never literal). */
export function renderTemplate(text: string | null | undefined, vars: ContractVars): string {
  if (!text) return ''
  return text.replace(TOKEN_RE, (_full, rawKey: string) => {
    const v = vars[rawKey.toLowerCase()]
    return v == null ? '' : String(v)
  })
}

/** Format a Postgres date ('YYYY-MM-DD') as 'Month D, YYYY'; '' if empty/invalid.
 *  Parses at noon to avoid timezone date-shifting. */
export function formatContractDate(d: string | null | undefined): string {
  if (!d) return ''
  const dt = new Date(d + 'T12:00:00')
  if (isNaN(dt.getTime())) return ''
  return dt.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })
}

/** Integer cents -> '$X.XX'; '' when null/undefined (so it never renders "$NaN"). */
export function formatCents(cents: number | null | undefined): string {
  if (cents == null) return ''
  return '$' + (cents / 100).toFixed(2)
}

type GuestLike = {
  name?: string | null
  site_number?: string | null
  season_start?: string | null
  season_end?: string | null
  camper_make?: string | null
  camper_model?: string | null
  camper_year?: number | null
  home_street?: string | null
  home_city?: string | null
  home_state?: string | null
  home_zip?: string | null
}
type OccupantLike = { name?: string | null; kind?: string | null }
type ContractLike = {
  season_year?: number | null
  site_number?: string | null
  season_opens?: string | null
  season_closes?: string | null
  occupants?: OccupantLike[] | null
  camper_make?: string | null
  camper_model?: string | null
  camper_year?: number | null
  total_due_cents?: number | null
  /** Phase 3 — DISPLAY ONLY, like total_due_cents. Prints; nothing is charged from it. */
  deposit_due_cents?: number | null
  /** Phase 2b PR 2b — DISPLAY ONLY, like the two above. An optional list of instalments that
   *  PRINTS on the agreement; nothing is charged from it. See lib/payment-schedule.ts. */
  payment_schedule?: unknown
  total_due_by?: string | null
  deposit_due_by?: string | null
  charge_note?: string | null
  /** Phase 2b. The season's name, passed in by renderPacketDocuments — see {{season_name}}. */
  season_name?: string | null
}
type SettingsLike = { season_opens?: string | null; season_closes?: string | null } | null | undefined

/** The rig/site fields the packet is frozen with. Copied from the GUEST record, never the draft. */
export type RigSiteSnapshot = {
  site_number: string
  camper_type: string | null
  camper_length: number | null
  camper_amperage: string | null
  camper_make: string | null
  camper_model: string | null
  camper_year: number | null
}

type RigGuestLike = GuestLike & {
  site_number?: string | null
  camper_type?: string | null
  camper_length?: number | null
  camper_amperage?: string | null
}
type SnapshotContractLike = ContractLike & { site_number?: string | null }

/** A row of `seasons`, as much of it as the renderer needs. */
export type SeasonLike = {
  name?: string | null
  opens?: string | null
  closes?: string | null
} | null | undefined

/** The dates a contract actually runs on, after the override/inherit rule. */
export type EffectiveSeasonDates = { opens: string | null; closes: string | null }

/** The two document bodies a packet is made of, plus the contract's title. */
export type PacketDocuments = {
  contractTitle: string
  contractText: string
  waiverText: string
}

const pick = (...vals: Array<string | null | undefined>): string =>
  (vals.find(v => v != null && v !== '') ?? '') as string

/** Assemble the merge-field vars for a contract. Prefers the contract's own
 *  snapshot fields (frozen at send) and falls back to the live guest record. */
/** One instalment as stored on the contract. Mirrored in lib/payment-schedule.ts. */
export type ScheduleRow = {
  label?: string | null
  amount_cents?: number | null
  due_by?: string | null
}

/**
 * The block that prints on the agreement.
 *
 * Returns '' for an empty or missing schedule, which is what keeps every existing contract
 * byte-identical: renderTemplate substitutes '' and the paragraph simply is not there.
 *
 * A row prints what it knows and nothing more — no "$0.00" standing in for an amount nobody
 * stated, no "Invalid Date" for a date nobody chose.
 */
/** True when the contract body places the block itself, so it must not also be appended. */
export const bodyPlacesSchedule = (body: string | null | undefined): boolean =>
  (body || '').includes('{{payment_schedule}}')

export function renderSchedule(stored: unknown): string {
  if (!Array.isArray(stored) || stored.length === 0) return ''
  const lines = stored.map(r => {
    const row = (r ?? {}) as ScheduleRow
    const label = (row.label ?? '').toString().trim()
    const amount = row.amount_cents == null ? '' : formatCents(row.amount_cents)
    const due = formatContractDate(row.due_by)
    const parts: string[] = []
    if (label) parts.push(label)
    if (amount) parts.push(amount)
    if (due) parts.push(`due by ${due}`)
    return parts.length ? `  ${parts.join(' · ')}` : ''
  }).filter(Boolean)
  if (lines.length === 0) return ''
  return `Payment Schedule\n${lines.join('\n')}`
}


export function buildContractVars(guest: GuestLike, contract: ContractLike, settings?: SettingsLike): ContractVars {
  const party_names = (contract.occupants || [])
    .map(o => (o?.name || '').trim())
    .filter(Boolean)
    .join(', ')

  const year = contract.camper_year ?? guest.camper_year
  const camper_make_year = [
    year != null ? String(year) : '',
    pick(contract.camper_make, guest.camper_make),
    pick(contract.camper_model, guest.camper_model),
  ].filter(Boolean).join(' ')

  // Home address — structured on the guest, composed into a clean block with NO
  // stray commas or empty lines when parts are missing. filter(Boolean) drops any
  // null/'' part. Renders as multi-line in the packet's white-space:pre-wrap body.
  //   full            -> "158 Cady Hollow Rd\nDuluth, PA 19023"
  //   no state        -> "158 Cady Hollow Rd\nDuluth 19023"   (never "Duluth, , PA")
  //   city only       -> "Duluth"
  //   nothing on file -> ""
  const cityState = [guest.home_city, guest.home_state].filter(Boolean).join(', ')
  const cityStateZip = [cityState, guest.home_zip].filter(Boolean).join(' ')
  const home_address = [guest.home_street, cityStateZip].filter(Boolean).join('\n')

  return {
    name: pick(guest.name),
    site_number: pick(contract.site_number, guest.site_number),
    year: contract.season_year != null ? String(contract.season_year) : '',
    opens: formatContractDate(pick(contract.season_opens, settings?.season_opens, guest.season_start)),
    closes: formatContractDate(pick(contract.season_closes, settings?.season_closes, guest.season_end)),
    party_names,
    camper_make_year,
    // Phase 2b. The season's NAME ("2027 Spring"), so a contract can say which season it is for
    // rather than only which year. Null-safe like every other var: unset renders '', never the
    // literal token and never the word "null".
    season_name: pick(contract.season_name),
    total_due: formatCents(contract.total_due_cents),
    // Phase 3. DISPLAY ONLY — these three print on the agreement and nothing is charged from
    // them. Null-safe like every other var, and the null/zero distinction matters here more than
    // most: formatCents(null) is '' ("no deposit stated") while formatCents(0) is '$0.00' (a
    // stated deposit of nothing). A contract must not claim the second when the park meant the
    // first, which is why the columns are nullable with no default.
    deposit_due: formatCents(contract.deposit_due_cents),
    // The instalment block. '' for an empty or absent schedule, which is what keeps every
    // existing contract byte-identical — renderTemplate substitutes '' and nothing prints.
    payment_schedule: renderSchedule(contract.payment_schedule),
    total_due_by: formatContractDate(contract.total_due_by),
    deposit_due_by: formatContractDate(contract.deposit_due_by),
    // The owner's CUSTOMER-FACING explanation of the total ("includes 2 extra family members,
    // golf cart, second site"). Same null-safe treatment as every other var: null/undefined
    // renders '', never the literal "null" and never a leftover {{charge_note}}. Deliberately NOT
    // staff_notes, which is private and must never reach a camper's contract.
    charge_note: pick(contract.charge_note),
    home_address,
  }
}


// ── THE PACKET RENDERER — ONE IMPLEMENTATION, USED BY THE FREEZE AND BY EVERY PREVIEW ─────────
//
// WHY THESE TWO FUNCTIONS EXIST. freezePacket() in lib/contract-server.ts turns a draft into the
// legal documents a camper signs. Two admin screens show the owner what that will produce BEFORE
// it happens — the New Camper intake form and the Phase 1.5 review screen. A preview whose output
// differs from the freeze, in any byte, is worse than no preview at all: it is a screen that says
// "this is what they will sign" and is wrong.
//
// The only way to guarantee they agree is for there to be nothing to keep in agreement. So the
// rendering lives here, once, and the freeze calls it too. There is no second renderer to drift.
//
// Kept in this module, not in contract-server.ts, deliberately: contract-server.ts constructs a
// service-role Supabase client at import and can never be pulled into a browser bundle. This file
// is pure, so the client screens can import it.

/**
 * The rig/site snapshot a packet freezes with.
 *
 * ⚠ THESE COME FROM THE GUEST RECORD, NOT FROM THE DRAFT, and that asymmetry is intentional
 * rather than an oversight. The guest record is current truth about the camper's rig; the draft
 * carries the staff-edited party, season dates, total and charge note. freezePacket has always
 * snapshotted all seven of these off the guest at send time, so a preview that rendered the
 * draft's stale copy would show a different unit than the camper is about to be sent.
 *
 * `site_number` falls back to the contract and then to '' — matching the schema default and the
 * behaviour freeze has always had.
 */
export function guestRigSnapshot(guest: RigGuestLike, contract?: SnapshotContractLike): RigSiteSnapshot {
  return {
    site_number: guest.site_number || contract?.site_number || '',
    camper_type: guest.camper_type ?? null,
    camper_length: guest.camper_length ?? null,
    camper_amperage: guest.camper_amperage ?? null,
    camper_make: guest.camper_make ?? null,
    camper_model: guest.camper_model ?? null,
    camper_year: guest.camper_year ?? null,
  }
}

/**
 * Render a packet's two documents exactly as freezePacket will write them.
 *
 * ⚠ THE SETTINGS ARGUMENT TO buildContractVars IS DELIBERATELY OMITTED. See the long note in
 * lib/contract-server.ts: `settings` has season_start / season_end, NOT season_opens /
 * season_closes, so that middle fallback tier has never fired anywhere. Passing the row here
 * would ACTIVATE a dormant tier and could change which dates print on a signed legal agreement.
 * Preserving the omission is what keeps this function byte-identical to the freeze.
 *
 * `waiverText` is returned as-is: the waiver carries no merge fields today, and freeze renders it
 * unrendered for that reason. Do not "fix" that here without changing the freeze in the same
 * commit — they are the same code path now.
 */
/**
 * The dates a contract actually runs on — Phase 2b.
 *
 * THE MODEL: a season's dates are the DEFAULT; a contract's own season_opens/season_closes are a
 * PER-CAMPER OVERRIDE. Set → they win. Null → the contract inherits its season's dates. Null on
 * both → null, and the "still needed" gate on the send screens is what refuses that.
 *
 * Everything downstream reads through here: the on-screen dates, the preview, the printed
 * contract, the missing-fields check, and the snapshot the freeze writes. One rule, one place.
 *
 * ⚠ THE TRANSITION IS GRACEFUL BY CONSTRUCTION, AND THAT IS WHY THE OVERRIDE WINS RATHER THAN THE
 * SEASON. Every contract created before Phase 2b already has season_opens/season_closes filled in
 * (the create route seeded them from the guest record). Under this rule those read as overrides,
 * so those contracts keep the exact dates they already had — nothing shifts under a park mid-
 * season. Contracts created from 2b onward leave the columns null and inherit instead.
 *
 * Empty string is treated as unset, not as a date: a cleared date input posts '' and must fall
 * through to the season rather than blanking the contract.
 */
export function effectiveSeasonDates(
  contract: { season_opens?: string | null; season_closes?: string | null } | null | undefined,
  season: SeasonLike,
): EffectiveSeasonDates {
  const use = (override?: string | null, fallback?: string | null): string | null =>
    (override && override.trim()) || (fallback && fallback.trim()) || null
  return {
    opens: use(contract?.season_opens, season?.opens),
    closes: use(contract?.season_closes, season?.closes),
  }
}

export function renderPacketDocuments(
  guest: RigGuestLike,
  contract: SnapshotContractLike,
  settings: { contract_text?: string | null; waiver_text?: string | null } | null | undefined,
  /** Phase 2b. The contract's season — supplies the fallback dates and {{season_name}}. Optional
   *  so a caller with no season yet still renders, exactly as it did before 2b. */
  season?: SeasonLike,
): PacketDocuments {
  const snapshot = guestRigSnapshot(guest, contract)
  const dates = effectiveSeasonDates(contract, season)
  // The EFFECTIVE dates and the season name are folded into the contract object the vars are
  // built from, so {{opens}}/{{closes}}/{{season_name}} all resolve through the one builder.
  const vars = buildContractVars(guest, {
    ...contract,
    ...snapshot,
    season_opens: dates.opens,
    season_closes: dates.closes,
    season_name: season?.name ?? contract.season_name ?? null,
  }, undefined)
  // ⚠ THE SCHEDULE MUST NOT SILENTLY FAIL TO PRINT.
  //
  // {{payment_schedule}} is a normal merge token, so an owner places it wherever they want in the
  // body. But every park's contract body was written BEFORE this token existed, so none of them
  // contain it — and an owner who fills in three instalments and sends the packet would get an
  // agreement with no schedule on it and no indication why. Typed data that quietly does not
  // appear is the worst kind of bug on a document somebody signs.
  //
  // So: if the contract HAS a schedule and the body does NOT place the token, the block is
  // appended. Placement stays under the owner's control the moment they add the token.
  //
  // A contract with NO schedule appends nothing, so every existing agreement renders byte for
  // byte as it does today.
  const body = settings?.contract_text || ''
  const scheduleBlock = renderSchedule(contract.payment_schedule)
  const rendered = renderTemplate(body, vars)
  const contractText = scheduleBlock && !bodyPlacesSchedule(body)
    ? `${rendered}\n\n${scheduleBlock}`
    : rendered

  return {
    contractTitle: `${contract.season_year ?? ''} Seasonal Admission Agreement`,
    contractText,
    waiverText: settings?.waiver_text || '',
  }
}
