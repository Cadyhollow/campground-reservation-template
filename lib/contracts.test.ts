import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  renderTemplate, formatContractDate, formatCents, buildContractVars,
} from './contracts.ts'

// The seasonal contract's rendering rules.
//
// WHY THIS SUITE EXISTS AT ALL. The module it covers carries a strong claim in its header — that
// contract wording is legally exact and is returned byte-for-byte, never trimmed, reflowed or
// sanitised. Cady, where this code has been running, has no tests for it: the claim was an
// assertion in a comment. These tests turn it into something a future edit has to actually break
// on purpose.

// ── renderTemplate ───────────────────────────────────────────────────────────────────────────

test('a known token is replaced by its value', () => {
  assert.equal(renderTemplate('Site {{site_number}} for {{name}}.', { site_number: '14', name: 'Ortiz' }),
    'Site 14 for Ortiz.')
})

test('an UNKNOWN token renders empty — never as a literal {{...}}', () => {
  // The failure this prevents is a camper receiving a legal agreement with "{{total_due}}"
  // printed in it.
  assert.equal(renderTemplate('Total: {{total_due}}.', {}), 'Total: .')
  assert.equal(renderTemplate('{{nope}}', { name: 'x' }), '')
  assert.doesNotMatch(renderTemplate('{{anything}}', {}), /\{\{|\}\}/)
})

test('a token whose value is empty string renders empty, same as unknown', () => {
  assert.equal(renderTemplate('[{{name}}]', { name: '' }), '[]')
})

test('token matching tolerates inner whitespace and is case-insensitive on the KEY', () => {
  // The regex allows {{ name }}, and the lookup lowercases the token before matching — so a
  // template written {{NAME}} or {{Name}} still finds the `name` var.
  assert.equal(renderTemplate('{{ name }}', { name: 'Ortiz' }), 'Ortiz')
  assert.equal(renderTemplate('{{NAME}}', { name: 'Ortiz' }), 'Ortiz')
  assert.equal(renderTemplate('{{Name}}', { name: 'Ortiz' }), 'Ortiz')
})

test('an UPPERCASE var key is therefore never reachable — pinned so it is a known limitation', () => {
  // Lookup lowercases the token, so vars must be keyed lowercase. buildContractVars only ever
  // emits lowercase keys; this pins the rule for anyone adding vars by hand.
  assert.equal(renderTemplate('{{name}}', { NAME: 'Ortiz' } as Record<string, string>), '')
})

test('EVERYTHING around the tokens is returned byte-for-byte', () => {
  // The legally-exact claim, made concrete: leading and trailing whitespace, blank lines, tabs,
  // double spaces and unicode all survive untouched.
  const body = '  \n\nThis agreement is not a lease of real estate.\n\n\tIndented clause  with  doubles.\n\n  '
  assert.equal(renderTemplate(body, {}), body)
})

test('HTML in the contract body is NOT escaped or stripped by this function', () => {
  // Deliberate: this returns text, and escaping is the RENDERER's job. Pinned because it is a
  // real obligation on every consumer — anything that injects this into HTML must escape it.
  assert.equal(renderTemplate('<b>{{name}}</b>', { name: '<script>' }), '<b><script></b>')
})

test('empty, null and undefined bodies render as empty string', () => {
  assert.equal(renderTemplate('', {}), '')
  assert.equal(renderTemplate(null, {}), '')
  assert.equal(renderTemplate(undefined, {}), '')
})

test('repeated tokens are all replaced', () => {
  assert.equal(renderTemplate('{{name}} and {{name}}', { name: 'A' }), 'A and A')
})

// ── formatContractDate ───────────────────────────────────────────────────────────────────────

test('a Postgres date formats as a long US date', () => {
  assert.equal(formatContractDate('2026-05-01'), 'May 1, 2026')
  assert.equal(formatContractDate('2026-12-31'), 'December 31, 2026')
})

test('the date does NOT shift by a day in a negative-offset timezone', () => {
  // The bug this guards: new Date('2026-05-01') is UTC midnight, which is 30 April in any
  // negative-offset zone. The implementation appends T12:00:00 for exactly this reason, and a
  // season opening date printed one day early on a signed agreement is a real-world problem.
  assert.match(formatContractDate('2026-05-01'), /^May 1, 2026$/)
  assert.match(formatContractDate('2026-01-01'), /^January 1, 2026$/)
})

test('empty and unparseable dates render empty, never "Invalid Date"', () => {
  assert.equal(formatContractDate(''), '')
  assert.equal(formatContractDate(null), '')
  assert.equal(formatContractDate(undefined), '')
  assert.equal(formatContractDate('not-a-date'), '')
})

// ── formatCents ──────────────────────────────────────────────────────────────────────────────

test('cents format as dollars with two decimal places', () => {
  assert.equal(formatCents(0), '$0.00')
  assert.equal(formatCents(12345), '$123.45')
  assert.equal(formatCents(5), '$0.05')
  assert.equal(formatCents(100000), '$1000.00')
})

test('a null amount renders empty — never "$NaN"', () => {
  // Zero and "not set" are different things on a contract: $0.00 is a stated amount, blank is
  // "no figure agreed". They must not collapse into each other.
  assert.equal(formatCents(null), '')
  assert.equal(formatCents(undefined), '')
  assert.notEqual(formatCents(0), formatCents(null))
})

// ── buildContractVars ────────────────────────────────────────────────────────────────────────

const guest = {
  name: 'Ortiz Family',
  site_number: '7',
  season_start: '2026-04-15',
  season_end: '2026-10-15',
  camper_make: 'Jayco',
  camper_model: 'Eagle',
  camper_year: 2019,
  home_street: '158 Cady Hollow Rd',
  home_city: 'Duluth',
  home_state: 'PA',
  home_zip: '19023',
}

test('the CONTRACT snapshot wins over the live guest record', () => {
  // The contract's fields are frozen when it is sent. If the guest later moves site, the signed
  // agreement must still say what was agreed — this preference is the whole mechanism.
  const vars = buildContractVars(guest, {
    season_year: 2027, site_number: '22',
    season_opens: '2027-05-01', season_closes: '2027-09-30',
    camper_make: 'Grand Design', camper_model: 'Reflection', camper_year: 2024,
    total_due_cents: 250000,
  })
  assert.equal(vars.site_number, '22')
  assert.equal(vars.year, '2027')
  assert.equal(vars.opens, 'May 1, 2027')
  assert.equal(vars.closes, 'September 30, 2027')
  assert.equal(vars.camper_make_year, '2024 Grand Design Reflection')
  // No thousands separator, deliberately — formatCents is toFixed(2), not a locale format.
  assert.equal(vars.total_due, '$2500.00')
})

test('it falls back to the guest record when the contract has no snapshot', () => {
  const vars = buildContractVars(guest, { season_year: 2026 })
  assert.equal(vars.site_number, '7')
  assert.equal(vars.opens, 'April 15, 2026')
  assert.equal(vars.closes, 'October 15, 2026')
  assert.equal(vars.camper_make_year, '2019 Jayco Eagle')
})

test('settings sit between the contract and the guest for the season dates', () => {
  // This is the FUNCTION's contract, and it holds. But note what step 2 found: no caller
  // actually supplies these fields. The `settings` table has season_start / season_end, not
  // season_opens / season_closes, so this middle tier has never fired in production — see the
  // long note in lib/contract-server.ts. Kept as a test of the function's own behaviour, not as
  // a claim about what the app does.
  const vars = buildContractVars(guest, { season_year: 2026 }, { season_opens: '2026-05-05', season_closes: '2026-09-05' })
  assert.equal(vars.opens, 'May 5, 2026', 'settings beat the guest record')
  assert.equal(vars.closes, 'September 5, 2026')
})

test('with no settings argument, the contract beats the guest and the guest is the fallback', () => {
  // The path that actually runs. Pinned so the dormant middle tier cannot be activated by
  // accident — activating it would change which dates print on a signed legal agreement.
  const fromContract = buildContractVars(guest, { season_year: 2026, season_opens: '2026-05-01', season_closes: '2026-09-30' })
  assert.equal(fromContract.opens, 'May 1, 2026')
  assert.equal(fromContract.closes, 'September 30, 2026')

  const fromGuest = buildContractVars(guest, { season_year: 2026 })
  assert.equal(fromGuest.opens, 'April 15, 2026', 'falls through to the guest record')
  assert.equal(fromGuest.closes, 'October 15, 2026')
})

test('the home address composes with no stray commas or blank lines', () => {
  // These three cases are called out by name in the implementation's comment; they are the ones
  // that produce "Duluth, , PA" if the composition is done naively.
  assert.equal(buildContractVars(guest, {}).home_address, '158 Cady Hollow Rd\nDuluth, PA 19023')

  const noState = buildContractVars({ ...guest, home_state: null }, {})
  assert.equal(noState.home_address, '158 Cady Hollow Rd\nDuluth 19023')
  assert.doesNotMatch(noState.home_address, /,\s*,|,\s*$/)

  assert.equal(
    buildContractVars({ home_city: 'Duluth' }, {}).home_address, 'Duluth')
  assert.equal(
    buildContractVars({}, {}).home_address, '', 'nothing on file renders nothing')
})

test('party names are joined, trimmed, and empties dropped', () => {
  const vars = buildContractVars(guest, {
    occupants: [{ name: ' Ana ' }, { name: '' }, { name: 'Luis' }, { name: null }],
  })
  assert.equal(vars.party_names, 'Ana, Luis')
  assert.equal(buildContractVars(guest, { occupants: [] }).party_names, '')
  assert.equal(buildContractVars(guest, { occupants: null }).party_names, '')
})

// ── charge_note ──────────────────────────────────────────────────────────────────────────────
// Phase 1 (B). The owner's CUSTOMER-FACING explanation of the total, printed under Total Due.
// It is a merge var like any other, and these pin the three rules that matter for a legal
// document: it renders when set, it renders EMPTY (not "null") when not set, and a body written
// with {{charge_note}} against an older contract row never shows the raw token.

test('charge_note renders the contract note when one is set', () => {
  const vars = buildContractVars(guest, { charge_note: 'Includes 2 extra family members and a golf cart.' })
  assert.equal(vars.charge_note, 'Includes 2 extra family members and a golf cart.')
  assert.equal(renderTemplate('Total: {{total_due}}\n{{charge_note}}', buildContractVars(guest, {
    total_due_cents: 250000, charge_note: 'Includes the second site.',
  })), 'Total: $2500.00\nIncludes the second site.')
})

test('charge_note renders EMPTY when null, undefined or blank — never "null"', () => {
  // A nullable column on rows that predate it: every existing contract has NULL here, and a
  // contract body that already uses {{charge_note}} must print nothing rather than the word null.
  assert.equal(buildContractVars(guest, { charge_note: null }).charge_note, '')
  assert.equal(buildContractVars(guest, { charge_note: undefined }).charge_note, '')
  assert.equal(buildContractVars(guest, {}).charge_note, '')
  assert.equal(renderTemplate('[{{charge_note}}]', buildContractVars(guest, { charge_note: null })), '[]')
})

test('charge_note is byte-for-byte — multi-line notes are not reflowed', () => {
  // The note prints inside the contract's white-space:pre-wrap body, so the owner's line breaks
  // are part of what the camper reads and agrees to.
  const note = 'Includes:\n  · 2 extra family members\n  · golf cart'
  assert.equal(renderTemplate('{{charge_note}}', buildContractVars(guest, { charge_note: note })), note)
})

test('charge_note is NOT fed by staff_notes — the private column stays private', () => {
  // The failure this prevents is an owner's internal remark about a camper being printed on the
  // agreement that camper signs. buildContractVars reads charge_note and nothing else.
  const vars = buildContractVars(guest, {
    charge_note: null,
    // Deliberately shaped like a contract row that carries a private note.
    ...({ staff_notes: 'Chases the neighbours. Watch the balance.' } as Record<string, unknown>),
  })
  assert.equal(vars.charge_note, '')
  assert.equal(renderTemplate('{{staff_notes}}|{{charge_note}}', vars), '|',
    'neither the private column nor an unset note reaches the document')
})

test('camper description drops missing parts instead of leaving gaps', () => {
  const bare = { ...guest, camper_make: null, camper_model: null, camper_year: null }
  assert.equal(buildContractVars(bare, {}).camper_make_year, '')
  assert.equal(buildContractVars({ ...bare, camper_make: 'Jayco' }, {}).camper_make_year, 'Jayco')
  assert.doesNotMatch(buildContractVars({ ...bare, camper_year: 2019 }, {}).camper_make_year, /\s\s/)
})

test('every var is a string, so no token can ever render "undefined"', () => {
  // renderTemplate stringifies whatever it is given; this makes sure nothing arrives as a number
  // or null in the first place, on a completely empty guest and contract.
  const vars = buildContractVars({}, {})
  for (const [key, value] of Object.entries(vars)) {
    assert.equal(typeof value, 'string', `${key} should be a string`)
  }
  const rendered = renderTemplate(Object.keys(vars).map(k => `{{${k}}}`).join('|'), vars)
  assert.doesNotMatch(rendered, /undefined|null|NaN/)
})

test('a full contract body renders end to end with nothing left unresolved', () => {
  const body = [
    'SEASONAL ADMISSION AGREEMENT — {{year}}',
    '',
    'Between the campground and {{name}} of:',
    '{{home_address}}',
    '',
    'Site {{site_number}}, from {{opens}} to {{closes}}.',
    'Party: {{party_names}}',
    'Unit: {{camper_make_year}}',
    'Total due: {{total_due}}',
    '{{charge_note}}',
    '',
    'This agreement is not a lease of real estate.',
  ].join('\n')

  const out = renderTemplate(body, buildContractVars(guest, {
    season_year: 2026, occupants: [{ name: 'Ana' }, { name: 'Luis' }], total_due_cents: 250000,
    charge_note: 'Includes 2 extra family members and a golf cart.',
  }))

  assert.doesNotMatch(out, /\{\{|\}\}/, 'no token survived')
  assert.match(out, /SEASONAL ADMISSION AGREEMENT — 2026/)
  assert.match(out, /158 Cady Hollow Rd\nDuluth, PA 19023/)
  assert.match(out, /Party: Ana, Luis/)
  assert.match(out, /Total due: \$2500\.00/)
  assert.match(out, /Includes 2 extra family members and a golf cart\./)
  assert.match(out, /This agreement is not a lease of real estate\.$/,
    'the legally-exact closing clause is untouched, including its position')
})
