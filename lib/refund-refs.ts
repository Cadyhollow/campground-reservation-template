// Tags written into folio_payments.reference_number so a negative (refund) row can be
// traced back to what it refunded. Both refund legs land in folio_payments as negative
// rows, so without a tag they are indistinguishable — and each leg's over-refund cap has
// to count only its own kind or it will either double-count or miss refunds entirely.
//
// reference_number is an existing text column (default '') that nothing else writes or
// reads, so tagging needs no schema change.
//
// The definitions moved to lib/refundable.ts, which is the code that actually reads them: the
// over-refund cap is the reason the tags exist. That module deliberately imports nothing so it
// can run under `node --test`, so the dependency points that way rather than this way.
// Re-exported here because the API routes import them from this path, and a tag string is
// exactly the kind of thing that must have one definition.

export {
  BOOKING_REFUND_REF,
  FOLIO_REFUND_REF_PREFIX,
  folioRefundRef,
} from './refundable'
