import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  renderTemplate, formatContractDate, formatCents, buildContractVars,
  guestRigSnapshot, renderPacketDocuments, effectiveSeasonDates,
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


// ── guestRigSnapshot / renderPacketDocuments ─────────────────────────────────────────────────
//
// Phase 1.5. These two functions are the ONE renderer: freezePacket() calls them to produce the
// documents a camper signs, and the New Camper form and the review screen call them to show the
// owner what is about to be sent. The tests below pin the properties that make a preview
// trustworthy — if any of them break, a screen that says "this is what they will sign" starts
// lying, which is worse than having no preview.

const settingsText = {
  contract_text: 'Site {{site_number}} — {{camper_make_year}} — {{opens}} to {{closes}}\n{{charge_note}}',
  waiver_text: 'I assume all risk.',
}

test('the rig snapshot comes from the GUEST, overriding a stale draft copy', () => {
  // The asymmetry freezePacket has always had: the guest record is current truth about the rig,
  // the draft carries the staff-edited party/dates/total. A camper who changed rigs since the
  // draft was created must be sent the rig they actually have.
  const snap = guestRigSnapshot(
    { site_number: '7', camper_make: 'Jayco', camper_model: 'Eagle', camper_year: 2019, camper_type: 'TT', camper_length: 30, camper_amperage: '50' },
    { site_number: '22', camper_make: 'STALE', camper_model: 'STALE', camper_year: 1999 },
  )
  assert.equal(snap.site_number, '7')
  assert.equal(snap.camper_make, 'Jayco')
  assert.equal(snap.camper_year, 2019)
  assert.equal(snap.camper_length, 30)
})

test('site_number falls back guest -> contract -> empty string', () => {
  assert.equal(guestRigSnapshot({ site_number: '7' }, { site_number: '22' }).site_number, '7')
  assert.equal(guestRigSnapshot({ site_number: '' }, { site_number: '22' }).site_number, '22')
  assert.equal(guestRigSnapshot({}, {}).site_number, '', 'never undefined — the column is NOT NULL')
})

test('missing rig fields snapshot as null, never undefined', () => {
  // They are written straight onto the contract row by the freeze, so undefined would drop the
  // column from the UPDATE rather than clear it.
  const snap = guestRigSnapshot({}, {})
  for (const [k, v] of Object.entries(snap)) {
    if (k === 'site_number') continue
    assert.equal(v, null, `${k} should be null`)
  }
})

test('renderPacketDocuments renders the rig from the guest, not the draft', () => {
  const { contractText } = renderPacketDocuments(
    { site_number: '7', camper_make: 'Jayco', camper_model: 'Eagle', camper_year: 2019 },
    { season_year: 2026, site_number: '22', camper_make: 'STALE', camper_model: 'STALE', camper_year: 1999,
      season_opens: '2026-05-01', season_closes: '2026-09-30' },
    settingsText,
  )
  assert.match(contractText, /Site 7/)
  assert.match(contractText, /2019 Jayco Eagle/)
  assert.doesNotMatch(contractText, /STALE|Site 22/)
})

test('THE DORMANT SEASON-DATES TIER STAYS DORMANT — a settings row cannot change the dates', () => {
  // The single most load-bearing property here. buildContractVars supports
  //     contract.season_opens -> settings.season_opens -> guest.season_start
  // but `settings` has season_start/season_end, NOT season_opens/season_closes, so tier 2 has
  // never fired. renderPacketDocuments passes `undefined` for settings exactly as the freeze
  // does. Activating that tier would change which dates print on a signed legal agreement.
  const guestOnly = { season_start: '2026-04-15', season_end: '2026-10-15' }
  const withSeasonyLookingSettings = {
    ...settingsText,
    // Deliberately shaped like the trap: if these were ever forwarded, the dates would change.
    season_opens: '1999-01-01', season_closes: '1999-12-31',
  } as Record<string, unknown> as typeof settingsText

  const { contractText } = renderPacketDocuments(guestOnly, { season_year: 2026 }, withSeasonyLookingSettings)
  assert.match(contractText, /April 15, 2026 to October 15, 2026/)
  assert.doesNotMatch(contractText, /1999/, 'the settings tier must stay dormant')
})

test('the contract title is the season year, and the waiver is returned unrendered', () => {
  const docs = renderPacketDocuments({}, { season_year: 2026 }, {
    contract_text: 'x', waiver_text: 'Waiver with a {{token}} that must NOT be substituted.',
  })
  assert.equal(docs.contractTitle, '2026 Seasonal Admission Agreement')
  // The freeze assigns settings.waiver_text verbatim — no merge fields today. Pinned so a preview
  // cannot start rendering it while the freeze does not.
  assert.equal(docs.waiverText, 'Waiver with a {{token}} that must NOT be substituted.')
})

test('absent contract/waiver text render as empty strings — the empty-document guard is what refuses', () => {
  // renderPacketDocuments never throws on missing settings; freezePacket's own guard is what
  // blocks the send, and the screens use the same emptiness to build their "still needed" list.
  const docs = renderPacketDocuments({}, { season_year: 2026 }, null)
  assert.equal(docs.contractText, '')
  assert.equal(docs.waiverText, '')
  assert.equal(renderPacketDocuments({}, { season_year: 2026 }, undefined).contractText, '')
})

test('the charge note reaches the rendered document through this path too', () => {
  const { contractText } = renderPacketDocuments(
    {}, { season_year: 2026, charge_note: 'Includes the golf cart.' }, settingsText)
  assert.match(contractText, /Includes the golf cart\./)
})


// ── Phase 2b: seasons drive the dates and the name ───────────────────────────────────────────

const seasonBody = {
  contract_text: '{{season_name}} | {{opens}} to {{closes}} | Site {{site_number}}',
  waiver_text: 'I assume all risk.',
}
const spring = { name: '2027 Spring', opens: '2027-05-01', closes: '2027-06-30' }

test('effective dates INHERIT the season when the contract has no override', () => {
  assert.deepEqual(effectiveSeasonDates({}, spring), { opens: '2027-05-01', closes: '2027-06-30' })
  assert.deepEqual(effectiveSeasonDates({ season_opens: null, season_closes: null }, spring),
    { opens: '2027-05-01', closes: '2027-06-30' })
})

test('a contract OVERRIDE beats the season', () => {
  assert.deepEqual(
    effectiveSeasonDates({ season_opens: '2027-05-15', season_closes: '2027-06-15' }, spring),
    { opens: '2027-05-15', closes: '2027-06-15' })
  // Half an override is legal: one date overridden, the other inherited.
  assert.deepEqual(effectiveSeasonDates({ season_opens: '2027-05-15' }, spring),
    { opens: '2027-05-15', closes: '2027-06-30' })
})

test('THE PRE-2b TRANSITION: a contract that already carries dates keeps them exactly', () => {
  // Every contract created before 2b had season_opens/closes seeded from the guest record. Under
  // the override rule those read as overrides, so a park mid-season sees NOTHING shift — even if
  // the season it was backfilled into has different dates, or none.
  const legacy = { season_opens: '2027-04-15', season_closes: '2027-10-15' }
  assert.deepEqual(effectiveSeasonDates(legacy, spring), { opens: '2027-04-15', closes: '2027-10-15' })
  assert.deepEqual(effectiveSeasonDates(legacy, { name: '2027 Season' }), { opens: '2027-04-15', closes: '2027-10-15' })
})

test('empty strings are treated as unset, not as a blank date', () => {
  // A cleared date input posts '', which must fall through to the season rather than blanking the
  // contract's dates on the printed agreement.
  assert.deepEqual(effectiveSeasonDates({ season_opens: '', season_closes: '  ' }, spring),
    { opens: '2027-05-01', closes: '2027-06-30' })
})

test('no override and no season dates is null — the send gate is what refuses it', () => {
  assert.deepEqual(effectiveSeasonDates({}, { name: '2027 Season' }), { opens: null, closes: null })
  assert.deepEqual(effectiveSeasonDates({}, null), { opens: null, closes: null })
  assert.deepEqual(effectiveSeasonDates(null, undefined), { opens: null, closes: null })
})

test('{{season_name}} renders the season name, and empty when there is none', () => {
  assert.match(renderPacketDocuments({}, { season_year: 2027 }, seasonBody, spring).contractText,
    /^2027 Spring \|/)
  // Null-safe like every other token: never the literal {{season_name}}, never "null".
  const none = renderPacketDocuments({}, { season_year: 2027 }, seasonBody, null).contractText
  assert.match(none, /^ \|/)
  assert.doesNotMatch(none, /\{\{|null/)
  assert.equal(buildContractVars({}, {}).season_name, '')
})

test('the printed dates are the EFFECTIVE dates', () => {
  const inherited = renderPacketDocuments({}, { season_year: 2027 }, seasonBody, spring).contractText
  assert.match(inherited, /May 1, 2027 to June 30, 2027/)

  const overridden = renderPacketDocuments(
    {}, { season_year: 2027, season_opens: '2027-05-15', season_closes: '2027-06-15' }, seasonBody, spring).contractText
  assert.match(overridden, /May 15, 2027 to June 15, 2027/)
  assert.doesNotMatch(overridden, /May 1, 2027/)
})

test('THE FAITHFULNESS GUARANTEE HOLDS ACROSS SEASONS: preview and freeze render identically', () => {
  // The property Phase 1.5 exists to protect, re-asserted now that a season feeds the render.
  // The preview screens call renderPacketDocuments with the LIVE contract + its season; the
  // freeze calls it with the same contract + the same season, immediately before writing the
  // document text. If those two ever diverged, a screen that says "this is what they will sign"
  // would be lying. Both cases below — inheriting and overridden — must match byte for byte.
  const guest = { site_number: '7', camper_make: 'Jayco', camper_model: 'Eagle', camper_year: 2019 }

  for (const contract of [
    { season_year: 2027, occupants: [{ name: 'Ana' }], total_due_cents: 250000 },                  // inherits
    { season_year: 2027, season_opens: '2027-05-15', season_closes: '2027-06-15' },                // overrides
  ]) {
    const preview = renderPacketDocuments(guest, contract, seasonBody, spring)
    const freeze = renderPacketDocuments(guest, contract, seasonBody, spring)
    assert.deepEqual(preview, freeze)
    assert.doesNotMatch(preview.contractText, /\{\{|undefined|null|NaN/)
  }
})

test('the freeze snapshot pattern: once dates are written down, editing the season cannot move them', () => {
  // freezePacket resolves the inheritance and writes the answer onto the contract. This models
  // that: a contract holding resolved dates renders the same no matter what the season later says.
  const frozen = { season_year: 2027, season_opens: '2027-05-01', season_closes: '2027-06-30' }
  const before = renderPacketDocuments({}, frozen, seasonBody, spring).contractText
  const seasonLaterEdited = { name: '2027 Spring', opens: '2030-01-01', closes: '2030-12-31' }
  const after = renderPacketDocuments({}, frozen, seasonBody, seasonLaterEdited).contractText
  assert.equal(before, after, 'a sent agreement must not move when the season is edited')
  assert.match(after, /May 1, 2027 to June 30, 2027/)
})
