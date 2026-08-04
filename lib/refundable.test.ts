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
  reservationRefundable,
  allocateRefund,
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

// ── The whole reservation: reservationRefundable + allocateRefund ──────────────────────────
// The aggregate is where the two disjoint caps get composed, and composition is where an
// over-refund would hide. These tests exist to pin three things: that the aggregate never
// exceeds either underlying cap, that summing per-payment caps cannot outrun the shared folio
// budget, and that the allocation order returns as much as possible automatically.

const card = (id: string, amount: number, extra: Partial<RefundLedgerRow> = {}): RefundLedgerRow =>
  ({ id, amount, status: 'completed', reference_number: '', folio_id: 'F1', method: 'card', square_payment_id: `sq-${id}`, ...extra })
const cashRow = (id: string, amount: number, extra: Partial<RefundLedgerRow> = {}): RefundLedgerRow =>
  ({ id, amount, status: 'completed', reference_number: '', folio_id: 'F1', method: 'cash', square_payment_id: null, ...extra })
const bookingRefundRow = (amount: number, surcharge = 0): RefundLedgerRow =>
  ({ id: `bk-${amount}`, amount: -Math.abs(amount), surcharge_amount: -Math.abs(surcharge), status: 'refunded', reference_number: BOOKING_REFUND_REF, folio_id: 'F1' })

const RR = (over: Partial<Parameters<typeof reservationRefundable>[0]> = {}) =>
  reservationRefundable({
    bookingOriginalGrossCents: 0, bookingSurchargeCents: 0, bookingSquarePaymentId: null,
    folioRows: [], ...over,
  })

// The invariant every case must satisfy: the legs are the total, exactly.
function assertLegsReconcile(r: ReturnType<typeof reservationRefundable>, label: string) {
  const sum = r.legs.reduce((s, l) => s + l.remainingCents, 0)
  assert.equal(sum, r.totalRemainingCents, `${label}: legs sum ${sum} != total ${r.totalRemainingCents}`)
  assert.equal(r.autoRefundableCents + r.operatorHandledCents, r.totalRemainingCents,
    `${label}: auto + operator != total`)
  assert.equal(r.bookingRemainingCents + r.folioRemainingCents, r.totalRemainingCents,
    `${label}: booking + folio != total`)
}

test('aggregate: booking leg only', () => {
  const r = RR({ bookingOriginalGrossCents: 50000, bookingSurchargeCents: 1500, bookingSquarePaymentId: 'sq-res' })
  assert.equal(r.totalRemainingCents, 50000)
  assert.equal(r.bookingRemainingCents, 50000)
  assert.equal(r.folioRemainingCents, 0)
  assert.equal(r.originalGrossTotalCents, 50000)
  assert.equal(r.legs.length, 1)
  assert.equal(r.legs[0].kind, 'booking')
  assert.equal(r.legs[0].autoRefundable, true)
  assert.equal(r.legs[0].surchargeRemainingCents, 1500)
  assertLegsReconcile(r, 'booking only')
})

test('aggregate: folio only — the case that used to refund nothing on cancel', () => {
  // amount_paid = 0, money on the folio. This is the live defect C1 exposed and C2 fixes.
  const r = RR({ folioRows: [card('p1', 4140, { surcharge_amount: 140 })] })
  assert.equal(r.bookingRemainingCents, 0)
  assert.equal(r.folioRemainingCents, 4140)
  assert.equal(r.totalRemainingCents, 4140)
  assert.equal(r.originalGrossTotalCents, 4140)
  assert.equal(r.autoRefundableCents, 4140)
  assert.equal(r.operatorHandledCents, 0)
  assertLegsReconcile(r, 'folio only')
})

test('aggregate: both legs, and the original total spans both', () => {
  const r = RR({
    bookingOriginalGrossCents: 20000, bookingSquarePaymentId: 'sq-res',
    folioRows: [card('p1', 5000), cashRow('p2', 3000)],
  })
  assert.equal(r.bookingRemainingCents, 20000)
  assert.equal(r.folioRemainingCents, 8000)
  assert.equal(r.totalRemainingCents, 28000)
  assert.equal(r.originalGrossTotalCents, 28000)
  assert.equal(r.autoRefundableCents, 25000, 'booking + card auto-refund')
  assert.equal(r.operatorHandledCents, 3000, 'the cash must be handed back')
  assertLegsReconcile(r, 'both legs')
})

test('aggregate: a prior BOOKING refund reduces the booking leg and not the folio', () => {
  // The disjointness, from the booking side. The negative booking-refund row must not eat the
  // folio's headroom — that exclusion is what keeps a legitimate folio refund from being blocked.
  const r = RR({
    bookingOriginalGrossCents: 20000, bookingSquarePaymentId: 'sq-res',
    folioRows: [card('p1', 5000), bookingRefundRow(15000)],
  })
  assert.equal(r.bookingRemainingCents, 5000, 'booking leg reduced by its own refund')
  assert.equal(r.folioRemainingCents, 5000, 'folio untouched by a booking refund')
  assert.equal(r.totalRemainingCents, 10000)
  assertLegsReconcile(r, 'prior booking refund')
})

test('aggregate: a partially-refunded folio row offers only its remainder', () => {
  const r = RR({
    folioRows: [
      card('p1', 4140, { status: 'partially_refunded' }),
      { id: 'r1', amount: -3726, status: 'refunded', reference_number: folioRefundRef('p1'), folio_id: 'F1' },
    ],
  })
  assert.equal(r.folioRemainingCents, 414)
  assert.equal(r.legs[0].priorRefundCount, 1, 'feeds the idempotency key')
  assertLegsReconcile(r, 'partially refunded')
})

test('aggregate: non-card rows are never auto-refundable', () => {
  for (const method of ['cash', 'check', 'venmo']) {
    const r = RR({ folioRows: [cashRow('p1', 5000, { method })] })
    assert.equal(r.legs[0].autoRefundable, false, `${method} must be operator-handled`)
    assert.equal(r.legs[0].tender, method)
    assert.equal(r.operatorHandledCents, 5000)
  }
  // A card row with no Square id cannot be credited either.
  const noSq = RR({ folioRows: [card('p1', 5000, { square_payment_id: null })] })
  assert.equal(noSq.legs[0].autoRefundable, false, 'card without a Square id is manual')
})

test('aggregate: per-payment caps CANNOT outrun the shared folio budget', () => {
  // Two $100 payments, one untagged $150 refund. Each payment's own cap computes $50 (the
  // untagged refund is invisible per-payment, so the FOLIO backstop is what binds) — and naively
  // summing them would offer $100 out of a $50 budget. This is the over-refund the aggregate
  // exists to prevent, and 55 live folios carry more than one payment.
  const rows: RefundLedgerRow[] = [
    card('pA', 10000),
    card('pB', 10000),
    { id: 'legacy', amount: -15000, status: 'refunded', reference_number: '', folio_id: 'F1' },
  ]
  assert.equal(folioPaymentRefundable({ id: 'pA', amount: 10000 }, rows).remainingCents, 5000)
  assert.equal(folioPaymentRefundable({ id: 'pB', amount: 10000 }, rows).remainingCents, 5000)

  const r = RR({ folioRows: rows })
  assert.equal(r.folioRemainingCents, 5000, 'the folio budget binds, not the sum of the caps')
  assert.equal(r.totalRemainingCents, 5000)
  assertLegsReconcile(r, 'shared folio budget')
})

test('aggregate: the folio budget is spent per folio, not pooled across folios', () => {
  const rows: RefundLedgerRow[] = [
    card('pA', 10000, { folio_id: 'F1' }),
    { id: 'legacyF1', amount: -10000, status: 'refunded', reference_number: '', folio_id: 'F1' },
    card('pB', 7000, { folio_id: 'F2' }),
  ]
  const r = RR({ folioRows: rows })
  assert.equal(r.folioRemainingCents, 7000, 'F1 exhausted, F2 intact')
  assert.equal(r.legs.length, 1)
  assert.equal(r.legs[0].paymentId, 'pB')
  assertLegsReconcile(r, 'per-folio budget')
})

test('aggregate: voided rows neither add nor consume headroom', () => {
  const r = RR({
    folioRows: [card('p1', 5000), card('pv', 99999, { status: 'voided' })],
  })
  assert.equal(r.totalRemainingCents, 5000)
  assert.equal(r.originalGrossTotalCents, 5000)
  assertLegsReconcile(r, 'voided')
})

test('aggregate: nothing left produces no legs and no NaN', () => {
  const r = RR({
    bookingOriginalGrossCents: 10000, bookingSquarePaymentId: 'sq',
    folioRows: [bookingRefundRow(10000)],
  })
  assert.equal(r.totalRemainingCents, 0)
  assert.equal(r.legs.length, 0)
  assert.equal(Number.isFinite(r.originalGrossTotalCents), true)
  assertLegsReconcile(r, 'nothing left')
})

// ── Allocation ─────────────────────────────────────────────────────────────────────────────

test('allocate: fills booking, then auto-refundable card, then manual tenders', () => {
  const r = RR({
    bookingOriginalGrossCents: 10000, bookingSquarePaymentId: 'sq-res',
    folioRows: [cashRow('pCash', 8000), card('pCard', 5000)],
  })
  // Target of $180 on $230 available: everything auto first, then $30 of the cash.
  const alloc = allocateRefund(18000, r.legs)
  assert.deepEqual(alloc.map(a => [a.leg.tender, a.amountCents]), [
    ['booking', 10000],
    ['card', 5000],
    ['cash', 3000],
  ])
  assert.equal(alloc.reduce((s, a) => s + a.amountCents, 0), 18000)
})

test('allocate: a retained fee is left on the MANUAL tender, not the card', () => {
  // The point of the ordering. A 90% policy on $100 card + $100 cash retains $20; the operator
  // should be counting out $80 of cash, not $180 of mixed change.
  const r = RR({ folioRows: [cashRow('pCash', 10000), card('pCard', 10000)] })
  const alloc = allocateRefund(18000, r.legs)
  const byTender = Object.fromEntries(alloc.map(a => [a.leg.tender, a.amountCents]))
  assert.equal(byTender.card, 10000, 'the card is made whole first')
  assert.equal(byTender.cash, 8000, 'the retained $20 comes off the cash')
})

test('allocate: never exceeds a leg cap or the total available', () => {
  const r = RR({ folioRows: [card('p1', 5000)] })
  const alloc = allocateRefund(999999, r.legs)
  assert.equal(alloc.length, 1)
  assert.equal(alloc[0].amountCents, 5000, 'clamped to the leg, not the target')
  assert.equal(alloc.reduce((s, a) => s + a.amountCents, 0), r.totalRemainingCents)
})

test('allocate: a zero or negative target moves nothing', () => {
  const r = RR({ bookingOriginalGrossCents: 10000, folioRows: [card('p1', 5000)] })
  assert.deepEqual(allocateRefund(0, r.legs), [])
  assert.deepEqual(allocateRefund(-500, r.legs), [])
})

test('allocate: deterministic — same inputs, same split', () => {
  const r = RR({ folioRows: [card('p1', 3000), cashRow('p2', 3000), card('p3', 3000)] })
  const a = allocateRefund(5000, r.legs)
  const b = allocateRefund(5000, r.legs)
  assert.deepEqual(a.map(x => [x.leg.paymentId, x.amountCents]), b.map(x => [x.leg.paymentId, x.amountCents]))
})
