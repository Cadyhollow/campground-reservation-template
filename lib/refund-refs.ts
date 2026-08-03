// Tags written into folio_payments.reference_number so a negative (refund) row can be
// traced back to what it refunded. Both refund legs land in folio_payments as negative
// rows, so without a tag they are indistinguishable — and each leg's over-refund cap has
// to count only its own kind or it will either double-count or miss refunds entirely.
//
// reference_number is an existing text column (default '') that nothing else writes or
// reads, so tagging needs no schema change.

// Refund of the BOOKING leg: reservations.amount_paid + surcharge_amount. There is no
// folio_payments row for the original, so these are keyed to the reservation, not a payment.
export const BOOKING_REFUND_REF = 'booking-refund'

// Refund of a specific folio_payments row. Keyed to the original payment's id so the cap
// can sum exactly what has already been handed back on that one payment.
export const FOLIO_REFUND_REF_PREFIX = 'refund-of:'
export function folioRefundRef(paymentId: string): string {
  return `${FOLIO_REFUND_REF_PREFIX}${paymentId}`
}
