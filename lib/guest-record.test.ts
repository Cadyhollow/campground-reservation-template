import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  emptyGuestForm, guestFormFrom, guestPatchFrom, normalizeParty,
  GUEST_FIELD_GROUPS, type GuestRecordForm,
} from './guest-record.ts'

// The shared guest-edit piece.
//
// The property that carries this file: THE CAMPER RECORD AND THE GUEST DIRECTORY WRITE THE SAME
// FIELDS THE SAME WAY. They are two views of one `guests` row, so the patch one builds and the
// patch the other builds must be identical for identical input — otherwise "they are the same
// record" is only true until the two forms disagree about a column.

const filled = (): GuestRecordForm => ({
  name: '  Thompson Family ', email: ' a@b.test ', phone: ' 555-1234 ', site_number: ' 2, 3 ',
  home_street: ' 1 Elm ', home_city: ' Duluth ', home_state: ' PA ', home_zip: ' 19023 ',
  camper_type: ' Fifth wheel ', camper_length: ' 32 ', camper_amperage: ' 50 ',
  camper_make: ' Jayco ', camper_model: ' Eagle ', camper_year: ' 2019 ',
})

test('a round trip through the form does not change the record', () => {
  const row = {
    name: 'Thompson Family', email: 'a@b.test', phone: '555-1234', site_number: '2, 3',
    home_street: '1 Elm', home_city: 'Duluth', home_state: 'PA', home_zip: '19023',
    camper_type: 'Fifth wheel', camper_length: 32, camper_amperage: '50',
    camper_make: 'Jayco', camper_model: 'Eagle', camper_year: 2019,
  }
  const patch = guestPatchFrom(guestFormFrom(row))
  for (const [k, v] of Object.entries(row)) assert.deepEqual(patch[k], v, `${k} changed on a round trip`)
})

test('every editable field is reachable from the grouped UI list', () => {
  // A column added to the form but not to a group would be silently uneditable on the record page.
  const inGroups = new Set(GUEST_FIELD_GROUPS.flatMap(g => g.fields.map(f => f.key)))
  for (const key of Object.keys(emptyGuestForm())) {
    assert.ok(inGroups.has(key as keyof GuestRecordForm), `${key} is in the form but in no group`)
  }
})

test('values are trimmed, and blank becomes NULL — not an empty string', () => {
  const p = guestPatchFrom(filled())
  assert.equal(p.name, 'Thompson Family')
  assert.equal(p.email, 'a@b.test')
  const blank = guestPatchFrom({ ...emptyGuestForm(), name: 'Keep' })
  assert.equal(blank.email, null)
  assert.equal(blank.home_street, null)
  assert.equal(blank.camper_make, null)
})

test('site_number is the exception: it stays a string, matching its schema default', () => {
  assert.equal(guestPatchFrom({ ...emptyGuestForm(), name: 'X' }).site_number, '')
  assert.equal(guestPatchFrom(filled()).site_number, '2, 3')
})

test('numbers that will not parse become NULL, never NaN', () => {
  const p = guestPatchFrom({ ...emptyGuestForm(), name: 'X', camper_length: 'thirty', camper_year: '' })
  assert.equal(p.camper_length, null)
  assert.equal(p.camper_year, null)
  assert.ok(!Number.isNaN(p.camper_length as number))
})

test('an empty name is DROPPED, so a save can never blank the row out of every list', () => {
  const p = guestPatchFrom({ ...emptyGuestForm(), email: 'a@b.test' })
  assert.equal('name' in p, false, 'an empty name would have overwritten the real one')
  assert.equal(p.email, 'a@b.test', 'the rest of the patch still applies')
})

test('a null column reads as an empty string, so the inputs stay controlled', () => {
  const f = guestFormFrom({ name: 'X', email: null, camper_year: null })
  assert.equal(f.email, '')
  assert.equal(f.camper_year, '')
  assert.equal(f.name, 'X')
})

test('a missing row gives an empty form rather than throwing', () => {
  assert.deepEqual(guestFormFrom(null), emptyGuestForm())
  assert.deepEqual(guestFormFrom(undefined), emptyGuestForm())
})

test('the patch touches ONLY known guest columns — never is_seasonal or seasonal_active', () => {
  // Membership and active/inactive are deliberate, separate actions. A personal-info save must
  // never carry them along, or editing a phone number could quietly un-flag a camper.
  const p = guestPatchFrom(filled())
  for (const forbidden of ['is_seasonal', 'seasonal_active', 'is_monthly', 'party', 'id']) {
    assert.equal(forbidden in p, false, `${forbidden} rode along on a personal-info save`)
  }
})

test('the party roster drops half-typed rows and cannot invent a third kind', () => {
  assert.deepEqual(
    normalizeParty([{ name: ' Ann ', kind: 'child' }, { name: '  ' }, { name: 'Bob', kind: 'wombat' }]),
    [{ name: 'Ann', kind: 'child' }, { name: 'Bob', kind: 'adult' }],
  )
})

test('a hand-edited jsonb party that is not an array is survived, not thrown on', () => {
  // The column is jsonb; the renderer's .map would throw at send time on anything else.
  assert.deepEqual(normalizeParty(null), [])
  assert.deepEqual(normalizeParty('two adults'), [])
  assert.deepEqual(normalizeParty({ name: 'Ann' }), [])
})

// ── The frozen-contract boundary ──────────────────────────────────────────────────────────────
//
// The rule the paperwork depends on: editing a camper updates the live record and anything that
// renders FROM it (a draft), but can never alter a contract that has already been sent or signed.
//
// That holds structurally rather than by anyone remembering it. freezePacket() RENDERS the two
// documents at send time and INSERTS the result into `signatures.document_text`; the packet route
// then serves that stored column and never re-renders. So a sent agreement is a string in a row,
// and a guest edit — which writes only `guests` — has no path to it.
//
// The tests below pin both halves: a draft re-renders with the edit, and a document already
// rendered is a value that a later edit cannot reach.
import { renderPacketDocuments } from './contracts.ts'

const SETTINGS = { contract_text: 'Site {{site_number}} for {{name}}.', waiver_text: 'Waiver.' }

test('a DRAFT renders from the LIVE guest, so an edit shows up in it', () => {
  const contract = { season_year: 2028 }
  const before = renderPacketDocuments({ name: 'Nguyen Family', site_number: '2' }, contract, SETTINGS)
  assert.match(before.contractText, /Site 2 for Nguyen Family\./)

  // The same edit the record page makes — moved to site 9.
  const after = renderPacketDocuments({ name: 'Nguyen Family', site_number: '9' }, contract, SETTINGS)
  assert.match(after.contractText, /Site 9 for Nguyen Family\./, 'a draft did not pick up the edit')
})

test('a SENT document is a stored string — a later edit cannot reach it', () => {
  const contract = { season_year: 2028 }
  // What freezePacket wrote into signatures.document_text at send time.
  const frozen = renderPacketDocuments({ name: 'Nguyen Family', site_number: '2' }, contract, SETTINGS).contractText

  // The camper is edited afterwards. The live record changes...
  const live = renderPacketDocuments({ name: 'Nguyen Family', site_number: '9' }, contract, SETTINGS).contractText
  assert.notEqual(live, frozen)

  // ...and the document that was already stored still says what the camper agreed to.
  assert.match(frozen, /Site 2 for Nguyen Family\./)
  assert.doesNotMatch(frozen, /Site 9/, 'the frozen agreement changed under the camper')
})

test('a guest patch names no contract or signature column, so it has no route to a sent packet', () => {
  const p = guestPatchFrom(filled())
  for (const forbidden of ['document_text', 'document_title', 'status', 'sent_at', 'signed_at',
                           'season_year', 'season_id', 'occupants', 'total_due_cents']) {
    assert.equal(forbidden in p, false, `${forbidden} — a guest edit could reach the paperwork`)
  }
})
