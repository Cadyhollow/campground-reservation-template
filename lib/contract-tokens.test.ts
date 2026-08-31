import { test } from 'node:test'
import assert from 'node:assert/strict'
import { CONTRACT_TOKENS, tokenText, insertAtCursor, stripTagsForDisplay } from './contract-tokens.ts'
import { buildContractVars, renderTemplate } from './contracts.ts'
import { defaultPacketIntro } from './contract-emails.ts'

// The merge-token catalog.
//
// The load-bearing test is the FIRST one: the catalog must match buildContractVars key for key.
// Drift there is silent and lands in a camper's email — renderTemplate turns an unknown token
// into '' rather than an error, so a token the catalog forgot renders as nothing at all and
// nobody finds out until somebody phones.

const guest = {
  name: 'Pat Camper', site_number: '12', camper_year: 2019, camper_make: 'Jayco', camper_model: 'Jay Flight',
  home_street: '1 Lane', home_city: 'Duluth', home_state: 'PA', home_zip: '19023',
  season_start: '2027-05-01', season_end: '2027-10-01',
}
const contract = {
  site_number: '12', season_year: 2027, season_opens: '2027-05-01', season_closes: '2027-10-01',
  season_name: '2027 Season', occupants: [{ name: 'Pat' }, { name: 'Sam' }],
  total_due_cents: 200000, deposit_due_cents: 50000,
  total_due_by: '2027-04-01', deposit_due_by: '2027-02-01', charge_note: 'includes golf cart',
}

test('THE CATALOG MATCHES buildContractVars KEY FOR KEY', () => {
  // Add a var without adding a label (or vice versa) and this fails — which is the entire reason
  // the catalog is a module rather than a hand-kept list in the Settings page.
  const actual = Object.keys(buildContractVars(guest as never, contract as never)).sort()
  const catalog = CONTRACT_TOKENS.map(t => t.key).sort()
  assert.deepEqual(catalog, actual,
    'lib/contract-tokens.ts and buildContractVars() have drifted — add the missing entry to CONTRACT_TOKENS')
})

test('every token actually renders — no entry is a typo', () => {
  // A misspelled key in the catalog would offer an owner a chip that silently produces nothing.
  const vars = buildContractVars(guest as never, contract as never)
  for (const t of CONTRACT_TOKENS) {
    assert.ok(t.key in vars, `${t.key} is offered to owners but is not a real variable`)
    assert.ok(t.label && t.label !== t.key, `${t.key} needs a plain-language label, not the raw key`)
  }
})

test('labels are unique and human — an owner picks from these', () => {
  const labels = CONTRACT_TOKENS.map(t => t.label)
  assert.equal(new Set(labels).size, labels.length, 'two chips with the same label are unpickable')
  assert.ok(!labels.some(l => l.includes('{{') || l.includes('_')), 'labels must not leak the raw key')
})

test('a chip inserts a token the renderer actually substitutes', () => {
  // End to end: what the button puts in the box is what renderTemplate replaces.
  const vars = buildContractVars(guest as never, contract as never)
  const inserted = tokenText('deposit_due')
  assert.equal(inserted, '{{deposit_due}}')
  assert.equal(renderTemplate(inserted, vars), '$500.00')
  for (const t of CONTRACT_TOKENS) {
    assert.notEqual(renderTemplate(tokenText(t.key), vars), tokenText(t.key),
      `${t.key} rendered as its own literal — it is not a recognised token`)
  }
})

// ── insertion ────────────────────────────────────────────────────────────────────────────────

test('inserting at the cursor puts the token where the caret is', () => {
  const r = insertAtCursor('Deposit of  is due', 11, 11, '{{deposit_due}}')
  assert.equal(r.value, 'Deposit of {{deposit_due}} is due')
  assert.equal(r.cursor, 'Deposit of {{deposit_due}}'.length)
})

test('inserting REPLACES a selection rather than duplicating it', () => {
  const r = insertAtCursor('Hello NAME there', 6, 10, '{{name}}')
  assert.equal(r.value, 'Hello {{name}} there')
})

test('spacing is handled so two chips in a row do not jam together', () => {
  const a = insertAtCursor('', 0, 0, '{{name}}')
  assert.equal(a.value, '{{name}}', 'no leading space at the very start')
  const b = insertAtCursor(a.value, a.cursor, a.cursor, '{{site_number}}')
  assert.equal(b.value, '{{name}} {{site_number}}', 'a space is added between them')
  assert.equal(insertAtCursor('Hi ', 3, 3, '{{name}}').value, 'Hi {{name}}', 'no double space after whitespace')
  assert.equal(insertAtCursor('(', 1, 1, '{{name}}').value, '({{name}}', 'and none after an opening bracket')
})

test('a cursor outside the text cannot corrupt the value', () => {
  assert.equal(insertAtCursor('abc', 99, 99, 'X').value, 'abc X')
  assert.equal(insertAtCursor('abc', -5, -5, 'X').value, 'Xabc')
})

// ── the default shown as a placeholder ───────────────────────────────────────────────────────

test('THE DEFAULT IS SHOWN WITHOUT ITS HTML', () => {
  // The default carries <strong> because it is trusted code going straight into an email body.
  // A park's own text is escaped instead, so showing raw tags in the placeholder would teach an
  // owner to write HTML that would then render as literal angle brackets.
  const raw = defaultPacketIntro(2027)
  assert.ok(raw.includes('<strong>'), 'the real default does contain markup')
  const shown = stripTagsForDisplay(raw)
  assert.ok(!shown.includes('<'), 'the placeholder shows none of it')
  assert.ok(shown.includes('2027 seasonal packet is ready'), 'but the words survive intact')
  assert.ok(shown.includes('two documents'), 'including the words that were inside the tags')
})
