import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  enrollmentStatus, needsEnrolling, matchesCamperSearch, depositView, depositSummary,
  ENROLLMENT_LABEL, ENROLLMENT_TONE,
} from './seasonal-directory.ts'
import { laneBalances } from './ledger-lanes.ts'

// The Campers directory and the camper record.
//
// Two properties carry this file:
//   1. A SEASONAL CAMPER IS NEVER INVISIBLE. "No contract for this season" resolves to its own
//      loud state, never to blank and never folded into 'draft'. That is the bug this release
//      exists to fix, so it is pinned here rather than left to the screen.
//   2. NO MONEY IS RECOMPUTED. The deposit view only ARRANGES the lane totals ledger-lanes
//      produced; the tests below build those with the real laneBalances() and assert the
//      deposit block agrees with it to the cent.

// ── 1. enrollment status ──────────────────────────────────────────────────────────────────────

test('no contract at all is its own state — never blank, never draft', () => {
  assert.equal(enrollmentStatus(null), 'not_enrolled')
  assert.equal(enrollmentStatus(undefined), 'not_enrolled')
  assert.equal(needsEnrolling(null), true)
  // The label an owner reads has to say what to do about it.
  assert.equal(ENROLLMENT_LABEL.not_enrolled, 'Not in this season')
})

test('a contract that exists is never "not enrolled", however odd its status', () => {
  for (const status of ['draft', 'sent', 'signed', 'cancelled', '', 'nonsense']) {
    assert.notEqual(enrollmentStatus({ status }), 'not_enrolled',
      `status "${status}" collapsed into not_enrolled`)
    assert.equal(needsEnrolling({ status }), false)
  }
})

test('facts beat labels: signed_at and sent_at win over a stale status string', () => {
  // A cancel or a hand-edit can leave `status` behind; a signature is a fact.
  assert.equal(enrollmentStatus({ status: 'draft', signed_at: '2026-03-01' }), 'signed')
  assert.equal(enrollmentStatus({ status: 'draft', sent_at: '2026-03-01' }), 'sent')
  // signed outranks sent when both are present
  assert.equal(enrollmentStatus({ status: 'sent', signed_at: '2026-03-02', sent_at: '2026-03-01' }), 'signed')
})

test('a bare draft stays a draft', () => {
  assert.equal(enrollmentStatus({ status: 'draft' }), 'draft')
  assert.equal(enrollmentStatus({}), 'draft')
})

test('every state has a label and a tone', () => {
  for (const s of ['signed', 'sent', 'draft', 'not_enrolled'] as const) {
    assert.ok(ENROLLMENT_LABEL[s], `${s} has no label`)
    assert.ok(ENROLLMENT_TONE[s], `${s} has no tone`)
  }
})

// ── 2. search ─────────────────────────────────────────────────────────────────────────────────

test('name search is a case-insensitive substring, like the Guest Directory', () => {
  const row = { name: 'Thompson Family', site_number: '12' }
  assert.equal(matchesCamperSearch(row, 'thomp'), true)
  assert.equal(matchesCamperSearch(row, 'FAMILY'), true)
  assert.equal(matchesCamperSearch(row, 'nguyen'), false)
})

test('an empty search matches everything', () => {
  assert.equal(matchesCamperSearch({ name: 'A', site_number: '1' }, ''), true)
  assert.equal(matchesCamperSearch({ name: 'A', site_number: '1' }, '   '), true)
})

test('site search matches a WHOLE site, so "1" does not drag in 10, 11 and 21', () => {
  const s10 = { name: 'Okafor', site_number: '10' }
  const s1 = { name: 'Barnes', site_number: '1' }
  assert.equal(matchesCamperSearch(s1, '1'), true)
  assert.equal(matchesCamperSearch(s10, '1'), false, 'site 10 matched a search for site 1')
  assert.equal(matchesCamperSearch(s10, '10'), true)
})

test('a double-site camper is found by EITHER of their sites', () => {
  // The comma list is how a two-site camper is stored, and both halves must be findable.
  const both = { name: 'Thompson Family', site_number: '2, 3' }
  assert.equal(matchesCamperSearch(both, '2'), true)
  assert.equal(matchesCamperSearch(both, '3'), true)
  assert.equal(matchesCamperSearch(both, '23'), false, 'the comma was ignored and the sites ran together')
})

test('search survives missing fields', () => {
  assert.equal(matchesCamperSearch({}, 'x'), false)
  assert.equal(matchesCamperSearch({ name: null, site_number: null }, 'x'), false)
  assert.equal(matchesCamperSearch({ name: null, site_number: null }, ''), true)
})

// ── 3. deposit + balance, tied to the real lane maths ─────────────────────────────────────────

const CTX = { billingMode: 'separated' as const, electricLineItemIds: new Set<string>() }
const charge = (id: string, lane: string, cents: number) =>
  ({ id, line_total: cents, lane, voided: false })
const payment = (lane: string | null, cents: number) =>
  ({ amount: cents, surcharge_amount: 0, lane, status: 'completed' })

test('deposit view reads the seasonal LANE — it does not re-add anything', () => {
  const lanes = laneBalances(
    [charge('a', 'seasonal', 200000), charge('b', 'store', 5000)],
    [payment('seasonal', 50000), payment('store', 5000)],
    CTX,
  )
  const v = depositView({ total_due_cents: 200000, deposit_due_cents: 50000 }, lanes)
  assert.equal(v.feeCents, 200000)
  assert.equal(v.depositDueCents, 50000)
  // The store payment must NOT count toward the seasonal fee.
  assert.equal(v.paidCents, 50000)
  assert.equal(v.balanceCents, 150000)
  // ...and it agrees with the lane it came from, to the cent.
  assert.equal(v.paidCents, lanes.byLane.seasonal.payments)
  assert.equal(v.balanceCents, lanes.byLane.seasonal.balance)
})

test('the deposit-paid, balance-due-in-spring read — the way these campers actually pay', () => {
  const lanes = laneBalances([charge('a', 'seasonal', 200000)], [payment('seasonal', 50000)], CTX)
  const v = depositView({ total_due_cents: 200000, deposit_due_cents: 50000 }, lanes)
  assert.equal(v.depositCovered, true)
  assert.equal(depositSummary(v), 'Deposit paid — balance due in the spring.')
  assert.equal(v.balanceCents, 150000)
})

test('part-way to the deposit is not "deposit paid"', () => {
  const lanes = laneBalances([charge('a', 'seasonal', 200000)], [payment('seasonal', 20000)], CTX)
  const v = depositView({ total_due_cents: 200000, deposit_due_cents: 50000 }, lanes)
  assert.equal(v.depositCovered, false)
  assert.equal(depositSummary(v), 'Part-paid toward the deposit.')
})

test('paid in full says so, and outranks the deposit line', () => {
  const lanes = laneBalances([charge('a', 'seasonal', 200000)], [payment('seasonal', 200000)], CTX)
  const v = depositView({ total_due_cents: 200000, deposit_due_cents: 50000 }, lanes)
  assert.equal(v.balanceCents, 0)
  assert.equal(depositSummary(v), 'Paid in full.')
})

test('NULL deposit and a stated deposit of zero are different facts', () => {
  const lanes = laneBalances([charge('a', 'seasonal', 100000)], [payment('seasonal', 1)], CTX)
  assert.equal(depositView({ total_due_cents: 100000, deposit_due_cents: null }, lanes).depositDueCents, null)
  assert.equal(depositView({ total_due_cents: 100000, deposit_due_cents: 0 }, lanes).depositDueCents, 0)
  // A stated deposit of £0 is never "covered" — there was nothing to cover.
  assert.equal(depositView({ total_due_cents: 100000, deposit_due_cents: 0 }, lanes).depositCovered, false)
})

test('a COMBINED park sends no lanes at all, and the view says so rather than borrowing', () => {
  // On a combined park GET /api/seasonals/guest returns `lanes: null` — see SeasonalGuestData.
  // The whole-account balance must NOT be presented as the seasonal fee balance, or a store
  // purchase would read as a fee payment.
  const v = depositView({ total_due_cents: 200000, deposit_due_cents: 50000 }, null)
  assert.equal(v.feeCents, 200000, 'the fee still shows on a combined park')
  assert.equal(v.depositDueCents, 50000)
  assert.equal(v.paidCents, null)
  assert.equal(v.balanceCents, null)
  assert.equal(v.depositCovered, false)
  assert.equal(depositSummary(v), 'Lane totals are not available on this park\u2019s billing mode.')
})

test('an UNTAGGED payment never leaks into the seasonal lane', () => {
  // Every payment predating Phase 4 is untagged. It applies to the whole account and must not
  // be counted as money toward the fee.
  const lanes = laneBalances([charge('a', 'seasonal', 200000)], [payment(null, 90000)], CTX)
  const v = depositView({ total_due_cents: 200000, deposit_due_cents: 50000 }, lanes)
  assert.equal(v.paidCents, 0, 'an untagged payment was counted toward the seasonal fee')
  assert.equal(v.balanceCents, 200000)
  assert.equal(lanes.untaggedPayments, 90000, 'the money is still on the account, just not in the lane')
})

test('no contract, no fee — and the summary says that rather than showing $0.00 owed', () => {
  const v = depositView(null, null)
  assert.equal(v.feeCents, null)
  assert.equal(depositSummary(v), 'No seasonal fee set for this season yet.')
})
