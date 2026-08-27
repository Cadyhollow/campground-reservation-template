// The shapes the seasonal screens receive from /api/seasonals/*.
//
// WHY THESE EXIST. Cady's seasonal components type all of this as `any` — `data: any`,
// `(c: any) =>`, `useState<any>(null)`. This repo's lint forbids that, and the usual escape hatch
// (`Record<string, unknown>`) is the wrong tool here: these objects are dereferenced dozens of
// times in JSX (`c.status`, `r.voided`, `o.name`), so an index signature would push a narrowing
// cast onto every one of those and make the markup unreadable.
//
// So they are typed properly instead, and the types are deliberately LOOSE about what is optional:
// every field the screens actually read is listed, everything is nullable where the database
// allows null, and nothing is invented. They describe the JSON these routes return today — if a
// route's select list changes, the compiler is the thing that notices.
//
// Kept in lib/ rather than beside the components because the API routes are the source of the
// shape and three separate screens consume it.

/** One occupant on a seasonal contract's party list. */
export type SeasonalOccupant = {
  name?: string | null
  kind?: string | null
}

/** A row of `seasonal_contracts`, as the seasonal routes return it. */
export type SeasonalContract = {
  id: string
  season_year: number
  status: string
  packet_id?: string | null
  site_number?: string | null
  season_opens?: string | null
  season_closes?: string | null
  occupants?: SeasonalOccupant[] | null
  camper_type?: string | null
  camper_length?: number | null
  camper_amperage?: string | null
  camper_make?: string | null
  camper_model?: string | null
  camper_year?: number | null
  total_due_cents?: number | null
  /** PRIVATE owner scratchpad. Never shown to the camper. Not to be confused with charge_note. */
  staff_notes?: string | null
  /** CUSTOMER-FACING explanation of the total. Rendered into the contract body as {{charge_note}}. */
  charge_note?: string | null
  sent_at?: string | null
  signed_at?: string | null
  contract_signature_id?: string | null
  waiver_signature_id?: string | null
  /**
   * The two signature rows, JOINED ON by GET /api/seasonals/guest/[guestId] — the screen shows a
   * per-document badge (signed / pending) rather than one status for the whole packet, so it
   * needs each row's own state, not just its id.
   */
  contract_signature?: SeasonalSignature | null
  waiver_signature?: SeasonalSignature | null
}

/** A row of `signatures`, as joined onto a contract for the status badges. */
export type SeasonalSignature = {
  id: string
  status?: string | null
  doc_type?: string | null
  document_title?: string | null
  signed_at?: string | null
  signed_name?: string | null
}

/** A row of `guests`, as the seasonal routes return it. */
export type SeasonalGuest = {
  id: string
  name?: string | null
  email?: string | null
  phone?: string | null
  site_number?: string | null
  is_seasonal?: boolean | null
  season_start?: string | null
  season_end?: string | null
  home_street?: string | null
  home_city?: string | null
  home_state?: string | null
  home_zip?: string | null
  camper_type?: string | null
  camper_length?: number | null
  camper_amperage?: string | null
  camper_make?: string | null
  camper_model?: string | null
  camper_year?: number | null
  /**
   * The STANDING party roster — who lives in this camper, as camper info rather than as one
   * year's contract. Seeds a new draft's `occupants`; NOT NULL '[]' in the schema, but typed
   * optional here because every other field on this type is, and older cached payloads predate
   * the column.
   */
  party?: SeasonalOccupant[] | null
}

/** A staff note against a guest. Append-only — there is no edit or delete route. */
export type SeasonalNote = {
  id: string
  created_at: string
  author: string
  body: string
}

/**
 * An electric reading, as the seasonal panel shows it.
 *
 * `voided` matters: the admin view shows voided readings STRUCK THROUGH as an audit trail, and
 * the camper view hides them entirely. That is why the flag is part of the shape rather than
 * filtered away server-side.
 */
export type SeasonalElectricReading = {
  id: string
  created_at?: string | null
  billing_month?: string | null
  kwh_used?: number | null
  final_amount?: number | null
  voided?: boolean | null
}

/** The last completed payment on the guest's folio, shown as a single line. */
export type SeasonalLastPayment = {
  amount: number
  surcharge_amount?: number | null
  method?: string | null
  paid_at?: string | null
}

/** The whole payload of GET /api/seasonals/guest/[guestId]. */
export type SeasonalGuestData = {
  year: number
  guest: SeasonalGuest
  contracts: SeasonalContract[]
  currentContract: SeasonalContract | null
  notes: SeasonalNote[]
  electric: SeasonalElectricReading[]
  /** Display only — the folio balance beside a seasonal camper. Nothing is charged from it. */
  balance_cents: number
  lastPayment: SeasonalLastPayment | null
  /** '' when the guest has no folio yet. Its only use is deciding whether to show the
   *  "Open folio →" link, which is admin-only. */
  folioId: string
}

// SeasonalListRow WAS HERE AND HAS BEEN REMOVED (2026-08-19), because it was both unused and
// wrong — the worst combination for a type in a shared file.
//
// It was written from expectation rather than from the route, and the end-to-end run on the
// sandbox showed the real payload has `contract_status`, `contract_doc_status`,
// `waiver_doc_status` and `last_note_at`, not the `status` / `email` / `season_year` /
// `contract_id` it claimed. Nothing imported it, so nothing broke — but the next person to reach
// for it would have been misled by a definition that looked authoritative.
//
// The list page declares its own accurate `Row` beside the component that consumes it, which is
// the right home for a shape with exactly one consumer. Everything left in this file IS imported,
// and every field in it was verified against a real response.
