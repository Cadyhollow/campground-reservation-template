import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  emptyDraft, isBlank, toStored, toDrafts, renderSchedule, bodyPlacesSchedule,
} from './payment-schedule.ts'
import { renderPacketDocuments } from './contracts.ts'

// The optional payment schedule.
//
// Two properties carry this file:
//   1. AN EMPTY SCHEDULE CHANGES NOTHING. Every contract that has no instalments must render byte
//      for byte as it did before this feature existed — that is what makes it safe to ship to
//      parks that will never use it.
//   2. A SCHEDULE THE OWNER TYPED ALWAYS PRINTS. It is display-only, so the only way it can fail
//      is by not appearing, on a document somebody signs. Both placements are pinned below.

const SETTINGS = { contract_text: 'Site {{site_number}}. Total {{total_due}}.', waiver_text: 'W' }
const GUEST = { name: 'Pat Camper', site_number: '12' }

// ── 1. drafts ↔ stored ────────────────────────────────────────────────────────────────────────

test('a completely empty row is dropped; a partly-filled one is kept', () => {
  assert.equal(isBlank(emptyDraft()), true)
  assert.equal(isBlank({ label: '', amount: '', due_by: '2026-09-15' }), false)
  const stored = toStored([
    emptyDraft(),
    { label: 'First', amount: '500.00', due_by: '2026-09-15' },
    { label: '', amount: '', due_by: '2027-01-15' },
  ])
  assert.equal(stored.length, 2, 'the blank row survived, or a real one was dropped')
})

test('EVERY field is optional — a date-only and an amount-only row both store', () => {
  const stored = toStored([
    { label: '', amount: '', due_by: '2027-01-15' },
    { label: '', amount: '250', due_by: '' },
    { label: 'Just a name', amount: '', due_by: '' },
  ])
  assert.deepEqual(stored, [
    { label: null, amount_cents: null, due_by: '2027-01-15' },
    { label: null, amount_cents: 25000, due_by: null },
    { label: 'Just a name', amount_cents: null, due_by: null },
  ])
})

test('an unparseable amount becomes NULL, never NaN — "$NaN" must not reach a contract', () => {
  const stored = toStored([{ label: 'TBC', amount: 'we will agree it', due_by: '' }])
  assert.equal(stored[0].amount_cents, null)
  assert.ok(!Number.isNaN(stored[0].amount_cents as number))
})

test('ORDER IS PRESERVED — instalments are a sequence, not a set', () => {
  const stored = toStored([
    { label: 'Third', amount: '100', due_by: '2027-05-01' },
    { label: 'First', amount: '100', due_by: '2026-09-01' },
  ])
  assert.deepEqual(stored.map(r => r.label), ['Third', 'First'],
    'the rows were re-sorted, silently rewriting what the owner typed')
})

test('a round trip through the form does not change the schedule', () => {
  const stored = [{ label: 'First', amount_cents: 50000, due_by: '2026-09-15' }]
  assert.deepEqual(toStored(toDrafts(stored)), stored)
})

test('anything hand-edited into the jsonb is survived, not thrown on', () => {
  assert.deepEqual(toDrafts(null), [])
  assert.deepEqual(toDrafts('three payments'), [])
  assert.deepEqual(toDrafts({ label: 'x' }), [])
})

// ── 2. what prints ────────────────────────────────────────────────────────────────────────────

test('an empty schedule prints NOTHING', () => {
  assert.equal(renderSchedule([]), '')
  assert.equal(renderSchedule(null), '')
  assert.equal(renderSchedule(undefined), '')
  // …and a schedule whose every row is empty is still nothing.
  assert.equal(renderSchedule([{}, { label: null, amount_cents: null, due_by: null }]), '')
})

test('three instalments print in order, as label · amount · due by', () => {
  const out = renderSchedule([
    { label: 'Deposit', amount_cents: 50000, due_by: '2026-09-15' },
    { label: 'Second', amount_cents: 75000, due_by: '2027-01-15' },
    { label: 'Balance', amount_cents: 75000, due_by: '2027-05-01' },
  ])
  assert.match(out, /^Payment Schedule\n/)
  const lines = out.split('\n').slice(1)
  assert.equal(lines.length, 3)
  assert.match(lines[0], /Deposit · \$500\.00 · due by September 15, 2026/)
  assert.match(lines[2], /Balance · \$750\.00 · due by May 1, 2027/)
})

test('a row prints only what it knows — no "$0.00" and no "Invalid Date"', () => {
  const out = renderSchedule([
    { label: 'January', amount_cents: null, due_by: '2027-01-15' },
    { label: null, amount_cents: 25000, due_by: null },
  ])
  assert.doesNotMatch(out, /\$0\.00/, 'an unstated amount printed as zero')
  assert.doesNotMatch(out, /Invalid Date/)
  assert.match(out, /January · due by January 15, 2027/)
  assert.match(out, /\$250\.00/)
})

// ── 3. placement on the document ──────────────────────────────────────────────────────────────

test('NO schedule ⇒ the contract is byte-identical to before this feature', () => {
  const without = renderPacketDocuments(GUEST, { season_year: 2027 }, SETTINGS)
  const withEmpty = renderPacketDocuments(GUEST, { season_year: 2027, payment_schedule: [] }, SETTINGS)
  assert.equal(withEmpty.contractText, without.contractText)
  assert.doesNotMatch(without.contractText, /Payment Schedule/)
})

test('a schedule PRINTS even though no existing contract body contains the token', () => {
  // Every park's body predates the token, so relying on it alone would mean the owner types three
  // instalments, sends the packet, and the agreement silently has no schedule on it.
  const doc = renderPacketDocuments(
    GUEST,
    { season_year: 2027, payment_schedule: [{ label: 'First', amount_cents: 50000, due_by: '2026-09-15' }] },
    SETTINGS,
  )
  assert.match(doc.contractText, /Payment Schedule/)
  assert.match(doc.contractText, /First · \$500\.00 · due by September 15, 2026/)
  assert.match(doc.contractText, /^Site 12\. Total \./, 'the existing body was disturbed')
})

test('a body that places the token keeps control, and the block is NOT also appended', () => {
  const body = { contract_text: 'Before.\n{{payment_schedule}}\nAfter.', waiver_text: 'W' }
  assert.equal(bodyPlacesSchedule(body.contract_text), true)
  const doc = renderPacketDocuments(
    GUEST,
    { season_year: 2027, payment_schedule: [{ label: 'First', amount_cents: 50000, due_by: '2026-09-15' }] },
    body,
  )
  assert.equal((doc.contractText.match(/Payment Schedule/g) || []).length, 1,
    'the block printed twice — once in place and once appended')
  assert.match(doc.contractText, /Before\.\nPayment Schedule/)
  assert.match(doc.contractText, /After\.$/)
})

test('a body with the token but NO schedule leaves no gap and no stray heading', () => {
  const body = { contract_text: 'Before.\n{{payment_schedule}}\nAfter.', waiver_text: 'W' }
  const doc = renderPacketDocuments(GUEST, { season_year: 2027, payment_schedule: [] }, body)
  assert.doesNotMatch(doc.contractText, /Payment Schedule/)
  assert.match(doc.contractText, /Before\.\n\nAfter\./)
})
