// Unit tests for the policy arithmetic. Framework-free — runs on Node's built-in runner:
//
//   node --test lib/cancellation-policy.test.ts
//
// These exist because of a bug C2's verification caught: the percentage was being re-applied to
// the full original charge on every pass, so a second refund against the same booking could
// take the total past what the policy ever allowed. The retained cancellation fee was silently
// lost. That path is reachable whenever a partial refund precedes a cancellation, and it became
// routine once a cancellation could refund several legs — any leg failing part-way leaves
// exactly that state, and the operator's retry would over-refund.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { computePolicyRefund, normalizePolicy } from './cancellation-policy.ts'

const RULE = { name: 'Standard Policy', refund_percent: 90, cancellation_deadline_days: 7, deposit_refundable: true, policy_text: '' }
const policy = normalizePolicy(RULE)
const OUTSIDE = { arrival: '2026-10-01', today: '2026-08-04' }  // well outside the 7-day deadline

const run = (over: any = {}) => computePolicyRefund({
  policy, ...OUTSIDE, originalGrossCents: 20000, refundableCents: 20000, paymentType: 'full', ...over,
})

test('policy: a first cancellation refunds the plain percentage', () => {
  const r = run()
  assert.equal(r.refundCents, 18000, '90% of $200')
  assert.equal(r.basis, 'policy-percent')
})

test('policy: alreadyRefunded is spent down, not ignored', () => {
  // THE BUG. $200 booking, 90% rule, $100 already handed back. Re-applying the percentage would
  // compute min($180, $100 remaining) = $100 and take the total to $200 — the full amount, on a
  // policy that allowed $180. It must offer only the $80 still owed.
  const r = run({ refundableCents: 10000, alreadyRefundedCents: 10000 })
  assert.equal(r.refundCents, 8000, 'only the $80 still owed under the policy')
  assert.ok(r.explanation.includes('less the $100.00 already refunded'), r.explanation)
})

test('policy: total across two passes never exceeds the percentage', () => {
  // The property that matters, stated directly.
  const original = 20000
  const first = run({ originalGrossCents: original, refundableCents: original }).refundCents
  const remaining = original - first
  const second = run({
    originalGrossCents: original, refundableCents: remaining, alreadyRefundedCents: first,
  }).refundCents
  assert.equal(first + second, 18000, 'two passes still total exactly 90%')
  assert.equal(second, 0, 'the first pass already satisfied the policy')
})

test('policy: over-refunded past the percentage owes nothing further', () => {
  // A guest refunded MORE than the rule allows (an earlier goodwill refund, say) is not owed
  // more on cancellation. The operator can still override — the modal keeps that box.
  const r = run({ refundableCents: 2000, alreadyRefundedCents: 19000 })
  assert.equal(r.refundCents, 0)
})

test('policy: still clamped to what is actually left', () => {
  // The other limit. Both are needed: the policy might still owe $180 while only $50 remains on
  // the payment, and handing back $180 would be an over-refund of a different kind.
  const r = run({ refundableCents: 5000, alreadyRefundedCents: 0 })
  assert.equal(r.refundCents, 5000)
  assert.ok(r.explanation.includes('held to the $50.00 still refundable'), r.explanation)
})

test('policy: alreadyRefunded defaults to 0 — existing callers unaffected', () => {
  assert.equal(run().refundCents, run({ alreadyRefundedCents: 0 }).refundCents)
  assert.equal(run().refundCents, run({ alreadyRefundedCents: undefined }).refundCents)
})

test('policy: the zero-refund branches still short-circuit', () => {
  // Inside the deadline, and nothing left, must stay $0 regardless of what has been refunded.
  const inside = computePolicyRefund({
    policy, arrival: '2026-08-06', today: '2026-08-04',
    originalGrossCents: 20000, refundableCents: 20000, alreadyRefundedCents: 0, paymentType: 'full',
  })
  assert.equal(inside.refundCents, 0)
  assert.equal(inside.basis, 'inside-deadline')

  const nothing = run({ refundableCents: 0, alreadyRefundedCents: 20000 })
  assert.equal(nothing.refundCents, 0)
  assert.equal(nothing.basis, 'nothing-refundable')
})

test('policy: a 100% rule refunded in two passes still totals 100%', () => {
  const full = normalizePolicy({ ...RULE, refund_percent: 100 })
  const a = computePolicyRefund({ policy: full, ...OUTSIDE, originalGrossCents: 10000, refundableCents: 10000, paymentType: 'full' }).refundCents
  const b = computePolicyRefund({ policy: full, ...OUTSIDE, originalGrossCents: 10000, refundableCents: 10000 - a, alreadyRefundedCents: a, paymentType: 'full' }).refundCents
  assert.equal(a + b, 10000)
})
