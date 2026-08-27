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
  charge_note?: string | null
}
type SettingsLike = { season_opens?: string | null; season_closes?: string | null } | null | undefined

const pick = (...vals: Array<string | null | undefined>): string =>
  (vals.find(v => v != null && v !== '') ?? '') as string

/** Assemble the merge-field vars for a contract. Prefers the contract's own
 *  snapshot fields (frozen at send) and falls back to the live guest record. */
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
    total_due: formatCents(contract.total_due_cents),
    // The owner's CUSTOMER-FACING explanation of the total ("includes 2 extra family members,
    // golf cart, second site"). Same null-safe treatment as every other var: null/undefined
    // renders '', never the literal "null" and never a leftover {{charge_note}}. Deliberately NOT
    // staff_notes, which is private and must never reach a camper's contract.
    charge_note: pick(contract.charge_note),
    home_address,
  }
}
