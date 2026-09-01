import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  ELECTRIC_TOKENS, buildElectricVars, renderElectricMessage, renderElectricMessageFor,
  unknownTokensIn,
} from './electric-bill-tokens.ts'

// ⚠ CHIPS AND SUBSTITUTION ARE ONE FEATURE. Before this the electric bill email inserted the
// owner's message RAW. Adding clickable merge fields without a renderer would mean an owner
// clicks "First name" and the camper receives "Hi {{first_name}},". These tests hold both halves
// together.

const INPUT = {
  guestName: 'Ryan & Jamie Boysha', siteNumber: '2', billingMonth: 'September 2026',
  kwhUsed: 43, amountCents: 1500, balanceCents: 3000,
}

test('⚠ every offered token is actually filled — an offered-but-empty token is the silent bug', () => {
  const vars = buildElectricVars(INPUT)
  for (const t of ELECTRIC_TOKENS) {
    assert.ok(Object.prototype.hasOwnProperty.call(vars, t.key), `${t.key} is offered but never filled`)
  }
  // And nothing is filled that is not offered — an owner cannot discover a token from the code.
  assert.deepEqual(Object.keys(vars).sort(), ELECTRIC_TOKENS.map(t => t.key).sort())
})

test('every token has a plain-language label, never the raw key', () => {
  for (const t of ELECTRIC_TOKENS) {
    assert.ok(t.label.trim().length > 0)
    assert.ok(!t.label.includes('{{'), `${t.key} shows braces to the owner`)
    assert.notEqual(t.label, t.key)
  }
})

test('the whole sentence renders the way an owner would expect', () => {
  const out = renderElectricMessageFor(
    'Hi {{first_name}}, your reading for {{billing_month}} at site {{site_number}} used {{kwh}} kWh, for {{amount}}. Your balance is {{balance}}.',
    INPUT)
  assert.equal(out,
    'Hi Ryan, your reading for September 2026 at site 2 used 43 kWh, for $15.00. Your balance is $30.00.')
})

test('a credit reads as a credit, not as a negative in a sentence', () => {
  const out = renderElectricMessageFor('Your balance is {{balance}}.', { ...INPUT, balanceCents: -2500 })
  assert.equal(out, 'Your balance is $25.00 credit.')
})

test('a blank name yields a blank, never the word undefined in somebody\'s bill', () => {
  assert.equal(renderElectricMessageFor('Hi {{first_name}}.', { guestName: '' }), 'Hi .')
  assert.equal(renderElectricMessageFor('Hi {{first_name}}.', {}), 'Hi .')
})

test('⚠ AN UNKNOWN TOKEN IS LEFT ALONE, NOT DELETED', () => {
  // The contract renderer blanks what it does not recognise, which is right for a body the app
  // controls. This input is free text a park may have written years ago. Silently deleting a
  // stretch of an existing bill email on the day this ships would be indefensible.
  assert.equal(
    renderElectricMessage('Hi {{first_name}}, ref {{their_own_code}}.', buildElectricVars(INPUT)),
    'Hi Ryan, ref {{their_own_code}}.')
  assert.deepEqual(unknownTokensIn('{{first_name}} {{nope}} {{amount}}'), ['nope'])
})

test('a message with no tokens at all is returned untouched — the case every park starts from', () => {
  const plain = "Please find your monthly electric statement below. If you have any questions, don't hesitate to reach out."
  assert.equal(renderElectricMessageFor(plain, INPUT), plain)
})

test('spacing and casing inside the braces are tolerated', () => {
  assert.equal(renderElectricMessageFor('{{ first_name }} / {{FIRST_NAME}}', INPUT), 'Ryan / Ryan')
})

test('an empty template stays empty rather than becoming "undefined"', () => {
  assert.equal(renderElectricMessage('', buildElectricVars(INPUT)), '')
})

test('zero is rendered, not treated as missing', () => {
  // A camper who used nothing still gets a bill, and "0 kWh" is the true sentence.
  const out = renderElectricMessageFor('{{kwh}} kWh for {{amount}}', { kwhUsed: 0, amountCents: 0 })
  assert.equal(out, '0 kWh for $0.00')
})
