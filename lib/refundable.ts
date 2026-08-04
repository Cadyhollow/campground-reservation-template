// How much of a payment is still refundable — one implementation, shared by the server routes
// that enforce it and the UI that offers it.
//
// This arithmetic used to live only inside /api/refund. The UI could not see it, so it
// approximated: "has this payment got status 'completed'?" That proxy is wrong in both
// directions. It hides the button on a payment that was partially refunded and still has
// headroom (money the server would happily return, unreachable), and it would happily offer a
// full refund on a payment whose FOLIO had already given everything back. The button and the
// cap have to be computed from the same numbers or the UI keeps lying about money.
//
// Lifted verbatim out of app/api/refund/route.ts rather than rewritten from the description of
// it. A second derivation is a second thing to keep in agreement, and the whole point is that
// there is now exactly one. refundable.test.ts pins the two together.
//
// Deliberately free of any Supabase import — like lib/cancellation-policy.ts, this is imported
// by admin pages running in the browser, and a module-scope service-role client would be
// dragged into the client bundle behind it. Callers pass the rows they already have.

// ── The reference_number tags ──────────────────────────────────────────────────────────────
// Defined here, and re-exported by lib/refund-refs.ts so every existing import path still
// works. They live beside the cap because the cap is the reason they exist: both refund legs
// land in folio_payments as negative rows, and without a tag the arithmetic below cannot tell
// which headroom a given refund consumed.
//
// Keeping them here also leaves this module import-free, which is what lets it run under
// `node --test` with type stripping and no build step — the same shape lib/electric-periods.ts
// uses. A money formula that is awkward to test is a money formula that stops being tested.

// Refund of the BOOKING leg: reservations.amount_paid + surcharge_amount. There is no
// folio_payments row for the original, so these are keyed to the reservation, not a payment.
export const BOOKING_REFUND_REF = 'booking-refund'

// Refund of a specific folio_payments row, keyed to the original payment's id so the cap can
// sum exactly what has already been handed back on that one payment.
export const FOLIO_REFUND_REF_PREFIX = 'refund-of:'
export function folioRefundRef(paymentId: string): string {
  return `${FOLIO_REFUND_REF_PREFIX}${paymentId}`
}

// The shape both callers already hold: a folio_payments row. Everything optional and nullable,
// because the pages select different column sets and Supabase hands back nulls.
export type RefundLedgerRow = {
  id?: string | null
  amount?: number | null
  surcharge_amount?: number | null
  reference_number?: string | null
  status?: string | null
}

// The same widened status filter revenue uses. 'voided' stays out: a voided payment never
// happened, so it neither adds headroom nor consumes it.
export const REFUNDABLE_STATUSES = ['completed', 'refunded', 'partially_refunded']

export function countsTowardRefundable(row: RefundLedgerRow | null | undefined): boolean {
  return !!row && REFUNDABLE_STATUSES.includes(row.status || '')
}

// Applied here rather than assumed of the caller. The three pages fetch this table with three
// different filters — the reports drawer selects every status, voided included — so a function
// that trusted its input would give that page a different cap from the other two.
function ledgerRows(rows: RefundLedgerRow[] | null | undefined): RefundLedgerRow[] {
  return (rows || []).filter(countsTowardRefundable)
}

export type FolioPaymentRefundable = {
  // What may actually be refunded: the lesser of the two limits below.
  remainingCents: number
  // This payment's own headroom: what it took, less what has been handed back against it.
  remainingOnPayment: number
  // The folio's headroom: money out cannot exceed money in, however it was attributed.
  remainingOnFolio: number
  // Refunds already recorded against this payment, as positive cents.
  priorOnPayment: number
  // How many of them. Feeds the Square idempotency key, so a retry of the same refund reaches
  // Square with the same key instead of issuing a second one.
  priorRefundCount: number
}

// The cap on refunding one folio payment. `rows` is every folio_payments row on that payment's
// folio (any status — filtered here).
export function folioPaymentRefundable(
  payment: { id: string; amount?: number | null },
  rows: RefundLedgerRow[] | null | undefined
): FolioPaymentRefundable {
  const scoped = ledgerRows(rows)
  const original = payment?.amount || 0

  // Refunds already recorded against THIS payment, as positive cents. Exact for every row
  // written since refunds started carrying the tag.
  const thisPaymentRef = folioRefundRef(payment.id)
  const own = scoped.filter(r => r.reference_number === thisPaymentRef)
  const priorOnPayment = own.reduce((sum, r) => sum + Math.abs(r.amount || 0), 0)
  const remainingOnPayment = Math.max(0, original - priorOnPayment)

  // Folio-wide backstop. Refunds issued before the tag existed carry reference_number '' and
  // so are invisible to the per-payment sum above — without this, a payment already partially
  // refunded under the old code would still offer its full original amount.
  //
  // Booking-leg refunds are excluded: they hand back reservations.amount_paid, which is NOT a
  // folio_payments row, so counting them here would eat headroom belonging to the folio's own
  // payments and wrongly block a legitimate refund.
  const folioTaken = scoped
    .filter(r => (r.amount || 0) > 0)
    .reduce((sum, r) => sum + (r.amount || 0), 0)
  const folioReturned = scoped
    .filter(r => (r.amount || 0) < 0 && r.reference_number !== BOOKING_REFUND_REF)
    .reduce((sum, r) => sum + Math.abs(r.amount || 0), 0)
  const remainingOnFolio = Math.max(0, folioTaken - folioReturned)

  return {
    remainingCents: Math.min(remainingOnPayment, remainingOnFolio),
    remainingOnPayment,
    remainingOnFolio,
    priorOnPayment,
    priorRefundCount: own.length,
  }
}

export type BookingLegRefundable = {
  // Still refundable against the booking charge.
  remainingCents: number
  // Booking-leg refunds already recorded, as NEGATIVE cents (they are stored negative, and
  // callers add rather than subtract them).
  priorRefundCents: number
  priorRefundSurchargeCents: number
  // Card surcharge not yet handed back — the ceiling on the surcharge share of a new refund.
  remainingSurchargeCents: number
  priorRefundCount: number
}

// The cap on refunding the BOOKING leg — reservations.amount_paid + surcharge_amount, which is
// not a folio_payments row at all. Its refunds are, though, tagged BOOKING_REFUND_REF, so the
// headroom is the original charge less those.
//
// amount_paid and surcharge_amount are immutable: a refund no longer decrements them. So
// `originalGrossCents` stays the ORIGINAL charge for the life of the reservation and must never
// be offered as the refundable amount on its own, or a second partial refund would hand back
// money already returned.
export function bookingLegRefundable(
  originalGrossCents: number,
  surchargeCents: number,
  rows: RefundLedgerRow[] | null | undefined
): BookingLegRefundable {
  const own = ledgerRows(rows).filter(r => r.reference_number === BOOKING_REFUND_REF)
  const priorRefundCents = own.reduce((sum, r) => sum + (r.amount || 0), 0)
  const priorRefundSurchargeCents = own.reduce((sum, r) => sum + (r.surcharge_amount || 0), 0)

  return {
    remainingCents: Math.max(0, originalGrossCents + priorRefundCents),
    priorRefundCents,
    priorRefundSurchargeCents,
    remainingSurchargeCents: Math.max(0, surchargeCents + priorRefundSurchargeCents),
    priorRefundCount: own.length,
  }
}

// Surcharge share of an arbitrary gross refund, prorated on the ORIGINAL charge and capped at
// the surcharge not yet returned.
//
// Prorated on the original, not on what is left: the surcharge's share of the payment is a
// fixed ratio, and dividing by the shrinking remainder would inflate the surcharge portion of
// each successive partial refund.
//
// Moved here from lib/reservation-refund.ts (which re-exports it) so the browser can use it —
// that module holds a service-role client and must never reach the client bundle.
export function prorateSurcharge(
  grossCents: number,
  originalGrossCents: number,
  surchargeCents: number,
  alreadyRefundedSurchargeCents: number
): number {
  if (originalGrossCents <= 0 || surchargeCents <= 0) return 0
  const remaining = Math.max(0, surchargeCents + alreadyRefundedSurchargeCents)
  return Math.min(remaining, Math.round(grossCents * surchargeCents / originalGrossCents))
}
