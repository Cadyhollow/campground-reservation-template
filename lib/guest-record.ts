// ONE CANONICAL GUEST RECORD, MANY VIEWS.
//
// A seasonal camper IS a `guests` row with is_seasonal = true. The Guest Directory, the Campers
// directory and the camper record page are three views of that one row — never copies of it.
// Editing a phone number on the camper record and editing it in the Guest Directory are the same
// write to the same row, so there is nothing to reconcile and no sync job to go wrong.
//
// WHAT THIS FILE IS FOR. Before it, that promise was held together by two screens happening to
// build the same object by hand:
//     app/admin/guests/page.tsx          .from('guests').update(form)
//     app/admin/seasonals/[guestId]      .from('guests').update({ ...rig }) / ({ ...address })
// Same table, same row, two hand-rolled field lists that could drift the moment one of them
// learned about a column the other did not. This is the minimum shared piece: the editable field
// set, and the normalisation applied before the write. Both screens now build their patch here.
//
// ⚠ WHAT THIS FILE IS NOT. It is not a write layer and it holds no Supabase client — each screen
// still issues its own update, under its own session and its own RLS. Normalising in one place is
// the whole job; centralising the transport as well would have meant rewriting the auth path of
// two working screens for no gain.

/** The one editable shape. Every field here is a column on `guests`. */
export type GuestRecordForm = {
  name: string
  email: string
  phone: string
  site_number: string
  home_street: string
  home_city: string
  home_state: string
  home_zip: string
  camper_type: string
  camper_length: string
  camper_amperage: string
  camper_make: string
  camper_model: string
  camper_year: string
}

/**
 * The fields grouped the way a person reads them at the counter. The record page renders from
 * this rather than hardcoding an order, so a new column shows up in both screens' forms at once.
 */
export const GUEST_FIELD_GROUPS: { title: string; fields: { key: keyof GuestRecordForm; label: string; type?: 'number'; wide?: boolean }[] }[] = [
  {
    title: 'Who',
    fields: [
      { key: 'name', label: 'Name', wide: true },
      { key: 'email', label: 'Email' },
      { key: 'phone', label: 'Phone' },
      { key: 'site_number', label: 'Site number(s)' },
    ],
  },
  {
    title: 'Home address',
    fields: [
      { key: 'home_street', label: 'Street', wide: true },
      { key: 'home_city', label: 'City' },
      { key: 'home_state', label: 'State' },
      { key: 'home_zip', label: 'ZIP' },
    ],
  },
  {
    title: 'Rig',
    fields: [
      { key: 'camper_type', label: 'Type' },
      { key: 'camper_length', label: 'Length (ft)', type: 'number' },
      { key: 'camper_amperage', label: 'Amperage' },
      { key: 'camper_make', label: 'Make' },
      { key: 'camper_model', label: 'Model' },
      { key: 'camper_year', label: 'Year', type: 'number' },
    ],
  },
]

export const emptyGuestForm = (): GuestRecordForm => ({
  name: '', email: '', phone: '', site_number: '',
  home_street: '', home_city: '', home_state: '', home_zip: '',
  camper_type: '', camper_length: '', camper_amperage: '',
  camper_make: '', camper_model: '', camper_year: '',
})

/** A DB row (or a partial one) read into the form. Null becomes '' so the inputs stay controlled. */
export function guestFormFrom(row: Record<string, unknown> | null | undefined): GuestRecordForm {
  const f = emptyGuestForm()
  if (!row) return f
  for (const key of Object.keys(f) as (keyof GuestRecordForm)[]) {
    const v = row[key]
    f[key] = v === null || v === undefined ? '' : String(v)
  }
  return f
}

/**
 * The form turned into the patch that is written.
 *
 * TRIMMED, AND EMPTY BECOMES NULL — except `site_number`, whose schema default is '' and which
 * every screen already reads as a string. Numbers that will not parse become null rather than
 * NaN, which PostgREST would reject with a message nobody can act on.
 *
 * ⚠ `name` IS NEVER BLANKED. A row with no name is unusable in every list in the app, so an empty
 * name is dropped from the patch entirely and the existing name stands. Callers should refuse to
 * save an empty name in the UI; this is the backstop for when one does not.
 */
export function guestPatchFrom(form: GuestRecordForm): Record<string, unknown> {
  const str = (v: string) => { const s = (v ?? '').trim(); return s || null }
  const int = (v: string) => { const n = parseInt((v ?? '').trim(), 10); return Number.isFinite(n) ? n : null }
  const patch: Record<string, unknown> = {
    email: str(form.email),
    phone: str(form.phone),
    site_number: (form.site_number ?? '').trim(),
    home_street: str(form.home_street),
    home_city: str(form.home_city),
    home_state: str(form.home_state),
    home_zip: str(form.home_zip),
    camper_type: str(form.camper_type),
    camper_length: int(form.camper_length),
    camper_amperage: str(form.camper_amperage),
    camper_make: str(form.camper_make),
    camper_model: str(form.camper_model),
    camper_year: int(form.camper_year),
  }
  const name = (form.name ?? '').trim()
  if (name) patch.name = name
  return patch
}

/** The one occupant shape, shared by the standing roster and a contract's party list. */
export type PartyMember = { name: string; kind: 'adult' | 'child' }

/**
 * The standing party roster, cleaned.
 *
 * An unnamed occupant is a half-typed row, not a person, so it is dropped — the same rule
 * POST /api/seasonals/guest applies server-side. Anything that is not 'child' is an adult, so a
 * hand-edited jsonb value cannot produce a third kind the renderer has never seen.
 */
export function normalizeParty(rows: unknown): PartyMember[] {
  if (!Array.isArray(rows)) return []
  return rows
    .map(o => {
      const p = (o ?? {}) as { name?: unknown; kind?: unknown }
      return { name: (p.name ?? '').toString().trim(), kind: p.kind === 'child' ? 'child' as const : 'adult' as const }
    })
    .filter(p => p.name)
}

/**
 * Attributes that ask the browser NOT to treat these as a checkout address.
 *
 * ⚠ THE "SAVE ADDRESS?" POPUP IS THE BROWSER'S, NOT OURS. Chrome offers to save an address to the
 * signed-in Google account whenever a page's fields look like a shipping/billing form — which
 * ours legitimately do: street, city, state, ZIP, name, phone. Nothing in this app asks for it and
 * nothing in this app can switch it off outright.
 *
 * What is available is discouragement, and these are the levers that actually move it:
 *   · autoComplete="off"  — necessary, and on its own routinely IGNORED by Chrome for address
 *                           fields, which is why it is not the whole answer.
 *   · a non-semantic `name` — the heuristic reads field names as much as labels. A field called
 *                           `gr-home_street` is not `street-address`.
 *   · data-1p-ignore / data-lpignore — 1Password and LastPass respect these.
 *
 * ⚠ SO THIS IS BEST-EFFORT AND BROWSER-CONTROLLED. It should stop the prompt in normal use in
 * Chrome; a different browser, or a Chrome release that changes its heuristic, may still offer.
 * The only complete fix is on the viewer's side (Chrome → Autofill → Addresses → off).
 */
export const noAutofill = (key: string) => ({
  autoComplete: 'off' as const,
  name: `gr-${key}`,
  'data-1p-ignore': true,
  'data-lpignore': true,
})
