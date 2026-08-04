// Unit tests for the refund cap. Framework-free — runs on Node's built-in runner with type
// stripping, no dependencies:
//
//   node --test lib/refundable.test.ts
//
// The point of this file is not that the arithmetic is plausible. It is that ONE arithmetic is
// used by both the server route that enforces the cap and the UI that decides whether to offer
// a Refund button. When those two drifted, the UI hid the button on payments the server would
// happily refund — money the operator could not reach — and that is exactly the class of bug a
// test can pin shut.
//
// `apiFormula` below is a transcription of app/api/refund/route.ts as it stood BEFORE the
// extraction. Every case asserts the shared function agrees with it. If someone edits
// lib/refundable.ts and this file goes red, the shared cap has drifted from the cap the money
// path used to apply, and that is the bug — not the test.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  folioPaymentRefundable,
  bookingLegRefundable,
  prorateSurcharge,
  countsTowardRefundable,
  type RefundLedgerRow,
} from './refundable.ts'
import { BOOKING_REFUND_REF, folioRefundRef } from './refundable.ts'

// ── The original, transcribed ──────────────────────────────────────────────────────────────
// app/api/refund/route.ts lines 49–84 at commit 5d83c0d, with the Supabase query replaced by
// its already-filtered result. Nothing else changed.
function apiFormula(payment: { id: string; amount: number }, allRows: RefundLedgerRow[]): number {
  const rows = allRows.filter(r =>
    ['completed', 'refunded', 'partially_refunded'].includes(r.status || ''))

  const thisPaymentRef = folioRefundRef(payment.id)
  const priorOnPayment = rows
    .filter((r: any) => r.reference_number === thisPaymentRef)
    .reduce((sum: number, r: any) => sum + Math.abs(r.amount || 0), 0)
  const remainingOnPayment = Math.max(0, payment.amount - priorOnPayment)

  const folioTaken = rows
    .filter((r: any) => (r.amount || 0) > 0)
    .reduce((sum: number, r: any) => sum + r.amount, 0)
  const folioReturned = rows
    .filter((r: any) => (r.amount || 0) < 0 && r.reference_number !== BOOKING_REFUND_REF)
    .reduce((sum: number, r: any) => sum + Math.abs(r.amount), 0)
  const remainingOnFolio = Math.max(0, folioTaken - folioReturned)

  return Math.min(remainingOnPayment, remainingOnFolio)
}

// Asserts the shared function and the transcribed original produce the same number, and
// returns it so the caller can also assert the expected value.
function agree(payment: { id: string; amount: number }, rows: RefundLedgerRow[], label: string): number {
  const shared = folioPaymentRefundable(payment, rows).remainingCents
  const original = apiFormula(payment, rows)
  assert.equal(shared, original, `${label}: shared=${shared} but /api/refund formula=${original}`)
  return shared
}

const pay = (id: string, amount: number, extra: Partial<RefundLedgerRow> = {}): RefundLedgerRow =>
  ({ id, amount, status: 'completed', reference_number: '', ...extra })
const refundOf = (paymentId: string, amount: number, extra: Partial<RefundLedgerRow> = {}): RefundLedgerRow =>
  ({ id: `r-${paymentId}-${amount}`, amount: -Math.abs(amount), status: 'refunded', reference_number: folioRefundRef(paymentId), ...extra })

// ── The straightforward cases ──────────────────────────────────────────────────────────────

test('untouched payment: the whole amount is refundable', () => {
  const P = { id: 'p1', amount: 10000 }
  assert.equal(agree(P, [pay('p1', 10000)], 'untouched'), 10000)
})

test('fully refunded payment: nothing left', () => {
  const P = { id: 'p1', amount: 10000 }
  const rows = [pay('p1', 10000, { status: 'refunded' }), refundOf('p1', 10000)]
  assert.equal(agree(P, rows, 'fully refunded'), 0)
})

test('partially refunded payment: the remainder is still refundable', () => {
  // The dead end this whole change exists to fix. The row's status is 'partially_refunded',
  // which the old UI guard treated as "no button" — but the cap says money is still there.
  const P = { id: 'p1', amount: 10000 }
  const rows = [pay('p1', 10000, { status: 'partially_refunded' }), refundOf('p1', 3000)]
  assert.equal(agree(P, rows, 'partially refunded'), 7000)
})

test('cumulative partial refunds cannot exceed the original', () => {
  // Three $50 refunds against a $100 payment: each passed on its own before Part 1.
  const P = { id: 'p1', amount: 10000 }
  const rows = [
    pay('p1', 10000, { status: 'partially_refunded' }),
    refundOf('p1', 5000), refundOf('p1', 5000),
  ]
  assert.equal(agree(P, rows, 'cumulative'), 0)
})

// ── Legacy untagged rows: the folio backstop ───────────────────────────────────────────────

test('legacy untagged refund is invisible per-payment but caught by the folio backstop', () => {
  // Refunds written before reference_number tagging carry ''. The per-payment sum cannot see
  // them, so without the folio-wide backstop this payment would offer its full $110 again.
  // This is Cady's real row a9543373: $110 taken, $55 handed back untagged.
  const P = { id: 'a9543373', amount: 11000 }
  const rows = [
    pay('a9543373', 11000, { status: 'partially_refunded' }),
    { id: 'legacy', amount: -5500, status: 'refunded', reference_number: '' },
  ]
  const r = folioPaymentRefundable(P, rows)
  assert.equal(r.remainingOnPayment, 11000, 'per-payment sum cannot see an untagged refund')
  assert.equal(r.remainingOnFolio, 5500, 'the folio backstop can')
  assert.equal(agree(P, rows, 'legacy untagged'), 5500)
})

test('folio backstop binds across sibling payments', () => {
  // Two payments on one folio; the refund is attributed to the sibling. This payment still
  // cannot return more than the folio has left.
  const P = { id: 'p1', amount: 10000 }
  const rows = [pay('p1', 10000), pay('p2', 2000), refundOf('p2', 9000)]
  assert.equal(agree(P, rows, 'sibling drain'), 3000)
})

// ── The booking-leg exclusion (route.ts line 80) ───────────────────────────────────────────

test('booking-leg refunds do NOT consume the folio backstop', () => {
  // The exclusion that keeps a booking refund from wrongly blocking a folio refund. A booking
  // refund hands back reservations.amount_paid, which is not a folio_payments row at all, so
  // counting it here would eat headroom belonging to the folio's own payments.
  const P = { id: 'p1', amount: 10000 }
  const withBookingRefund = [
    pay('p1', 10000),
    { id: 'bk', amount: -50000, status: 'refunded', reference_number: BOOKING_REFUND_REF },
  ]
  assert.equal(agree(P, withBookingRefund, 'booking-leg excluded'), 10000)

  // Same magnitude, but tagged as an ordinary folio refund — now it DOES bind.
  const asFolioRefund = [
    pay('p1', 10000),
    { id: 'x', amount: -50000, status: 'refunded', reference_number: '' },
  ]
  assert.equal(agree(P, asFolioRefund, 'ordinary refund binds'), 0)
})

// ── Status filtering ───────────────────────────────────────────────────────────────────────

test('voided rows are ignored on both sides of the ledger', () => {
  // A voided payment never happened: it neither adds headroom nor consumes it.
  const P = { id: 'p1', amount: 10000 }
  const rows = [
    pay('p1', 10000),
    pay('p-void', 99999, { status: 'voided' }),
    { id: 'r-void', amount: -9999, status: 'voided', reference_number: '' },
  ]
  assert.equal(agree(P, rows, 'voided ignored'), 10000)
})

test('the function filters status itself, so an unfiltered caller matches a filtered one', () => {
  // The reports drawer selects every status; the folio page pre-filters. Both must get the
  // same cap or the same payment offers different money on different screens.
  const P = { id: 'p1', amount: 10000 }
  const raw: RefundLedgerRow[] = [
    pay('p1', 10000, { status: 'partially_refunded' }),
    refundOf('p1', 2500),
    pay('junk', 4000, { status: 'voided' }),
  ]
  const preFiltered = raw.filter(r => r.status !== 'voided')
  assert.equal(
    folioPaymentRefundable(P, raw).remainingCents,
    folioPaymentRefundable(P, preFiltered).remainingCents,
  )
  assert.equal(agree(P, raw, 'unfiltered caller'), 7500)
})

test('countsTowardRefundable admits exactly the three revenue statuses', () => {
  assert.equal(countsTowardRefundable({ status: 'completed' }), true)
  assert.equal(countsTowardRefundable({ status: 'refunded' }), true)
  assert.equal(countsTowardRefundable({ status: 'partially_refunded' }), true)
  assert.equal(countsTowardRefundable({ status: 'voided' }), false)
  assert.equal(countsTowardRefundable({ status: null }), false)
  assert.equal(countsTowardRefundable(null), false)
})

// ── Degenerate input ───────────────────────────────────────────────────────────────────────

test('nulls and empties resolve to zero, never NaN', () => {
  const P = { id: 'p1', amount: 0 }
  assert.equal(agree(P, [], 'no rows'), 0)
  assert.equal(folioPaymentRefundable({ id: 'p1' }, null).remainingCents, 0)
  const withNulls: RefundLedgerRow[] = [{ id: 'x', amount: null, status: 'completed', reference_number: null }]
  assert.equal(Number.isFinite(folioPaymentRefundable({ id: 'p1', amount: 100 }, withNulls).remainingCents), true)
})

test('priorRefundCount feeds the Square idempotency key', () => {
  // The key is `refund-<paymentId>-<amountCents>-<priorRefundCount>`. It must be stable across
  // a retry of the SAME refund (so Square returns the original instead of issuing a second),
  // and must differ once a refund has actually landed (so a genuine second refund is allowed).
  const P = { id: 'p1', amount: 10000 }
  assert.equal(folioPaymentRefundable(P, [pay('p1', 10000)]).priorRefundCount, 0)
  assert.equal(folioPaymentRefundable(P, [pay('p1', 10000), refundOf('p1', 1000)]).priorRefundCount, 1)
  assert.equal(
    folioPaymentRefundable(P, [pay('p1', 10000), refundOf('p1', 1000), refundOf('p1', 2000)]).priorRefundCount, 2)
})

// ── The booking leg ────────────────────────────────────────────────────────────────────────

test('booking leg: original gross less the booking refunds already recorded', () => {
  // amount_paid + surcharge_amount are immutable, so headroom comes from the refund rows.
  const rows = [{ id: 'bk1', amount: -20000, surcharge_amount: -600, status: 'refunded', reference_number: BOOKING_REFUND_REF }]
  const r = bookingLegRefundable(50000, 1500, rows)
  assert.equal(r.remainingCents, 30000)
  assert.equal(r.priorRefundCents, -20000)
  assert.equal(r.remainingSurchargeCents, 900)
  assert.equal(r.priorRefundCount, 1)
})

test('booking leg ignores folio-side refunds', () => {
  // The mirror of the exclusion above: an ordinary folio refund must not reduce what the
  // BOOKING charge can still hand back.
  const rows = [
    { id: 'f1', amount: -9999, status: 'refunded', reference_number: folioRefundRef('some-payment') },
    { id: 'f2', amount: -8888, status: 'refunded', reference_number: '' },
  ]
  assert.equal(bookingLegRefundable(50000, 0, rows).remainingCents, 50000)
})

test('booking leg clamps at zero when fully refunded', () => {
  const rows = [{ id: 'bk', amount: -50000, status: 'refunded', reference_number: BOOKING_REFUND_REF }]
  assert.equal(bookingLegRefundable(50000, 0, rows).remainingCents, 0)
})

// ── Surcharge proration ────────────────────────────────────────────────────────────────────

test('prorateSurcharge: proportional to the ORIGINAL charge, not the remainder', () => {
  // $500 charge carrying $15 surcharge. A half refund returns half the surcharge.
  assert.equal(prorateSurcharge(25000, 50000, 1500, 0), 750)
  // After that, a second half refund returns the other half — NOT half of what is left,
  // which is what dividing by the remainder would give.
  assert.equal(prorateSurcharge(25000, 50000, 1500, -750), 750)
})

test('prorateSurcharge: never returns more surcharge than remains', () => {
  assert.equal(prorateSurcharge(50000, 50000, 1500, -1200), 300)
  assert.equal(prorateSurcharge(50000, 50000, 1500, -1500), 0)
})

test('prorateSurcharge: no surcharge, no proration', () => {
  assert.equal(prorateSurcharge(25000, 50000, 0, 0), 0)
  assert.equal(prorateSurcharge(25000, 0, 1500, 0), 0)
})
