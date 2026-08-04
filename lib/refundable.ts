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
  // Needed only by reservationRefundable, to say which tender a leg is and whether it can be
  // handed back automatically. The per-payment and booking-leg caps ignore them.
  folio_id?: string | null
  method?: string | null
  square_payment_id?: string | null
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

// ── The whole reservation ──────────────────────────────────────────────────────────────────
// Everything still refundable on a reservation, across BOTH legs, broken down per leg.
//
// A reservation holds money in two places: reservations.amount_paid (taken at booking) and
// folio_payments rows (taken at the desk or on the terminal). The cancel flow only ever knew
// about the first, so cancelling a booking paid on the folio returned nothing and said so.
// This is the figure that lets it return the rest.
//
// Pure over rows rather than taking a reservationId and querying: the same reason the two
// functions above are. It keeps this module import-free and `node --test`-able, and it means
// the route and any UI compute from identical inputs instead of two queries that can disagree.
//
// ALL AMOUNTS GROSS. A refund credits the card what the card was charged, surcharge included,
// so every cap and every allocation here is gross. The NET figures (amount less surcharge) are
// display-only — what the folio's "Paid" line and the cancel modal's "Paid" show. Do not feed
// a net figure into an allocation.

export type RefundLegKind = 'booking' | 'folio-payment'

export type RefundLeg = {
  kind: RefundLegKind
  // folio-payment legs only.
  paymentId?: string
  folioId?: string
  // 'booking' for the booking leg, otherwise the folio row's method (card/cash/check/venmo…).
  tender: string
  // GROSS, and already clamped to every cap that binds it — see the folio budget below.
  remainingCents: number
  // Can the software hand this back on its own? Card with a Square payment id. Everything else
  // — cash, check, Venmo, a card row with no Square id — is recorded but must be physically
  // returned by the operator, so the UI has to say so before anyone commits.
  autoRefundable: boolean
  // Feeds the Square idempotency key so a retried cancel cannot double-refund this leg.
  priorRefundCount: number
  // Booking leg only: the context prorateSurcharge needs.
  originalGrossCents?: number
  surchargeRemainingCents?: number
}

export type ReservationRefundable = {
  // Booking leg first, then folio rows in the order given. Only legs with money left.
  legs: RefundLeg[]
  bookingRemainingCents: number
  folioRemainingCents: number
  totalRemainingCents: number
  // The ORIGINAL charge across both legs — what a cancellation percentage applies to. Not the
  // remaining: a booking already half refunded is still governed by a policy written against
  // what the guest originally paid.
  originalGrossTotalCents: number
  autoRefundableCents: number
  operatorHandledCents: number
}

export function reservationRefundable(input: {
  bookingOriginalGrossCents: number
  bookingSurchargeCents: number
  bookingSquarePaymentId?: string | null
  // Every folio_payments row on every folio of the reservation, any status (filtered here).
  // Order is significant only for tie-breaking the folio-budget clamp below; callers should
  // pass them in paid_at order so the result is stable between calls.
  folioRows: RefundLedgerRow[] | null | undefined
}): ReservationRefundable {
  const { bookingOriginalGrossCents, bookingSurchargeCents, bookingSquarePaymentId } = input
  const scoped = ledgerRows(input.folioRows)

  const booking = bookingLegRefundable(bookingOriginalGrossCents, bookingSurchargeCents, scoped)

  const legs: RefundLeg[] = []
  if (booking.remainingCents > 0) {
    legs.push({
      kind: 'booking',
      tender: 'booking',
      remainingCents: booking.remainingCents,
      autoRefundable: !!bookingSquarePaymentId,
      priorRefundCount: booking.priorRefundCount,
      originalGrossCents: bookingOriginalGrossCents,
      surchargeRemainingCents: booking.remainingSurchargeCents,
    })
  }

  // Grouped by folio because the backstop is a per-folio fact. A reservation has one folio in
  // practice, but nothing in the schema says so, and a cap that silently assumes otherwise is
  // the kind of assumption that only shows up as an over-refund.
  const byFolio = new Map<string, RefundLedgerRow[]>()
  for (const r of scoped) {
    const key = r.folio_id || ''
    if (!byFolio.has(key)) byFolio.set(key, [])
    byFolio.get(key)!.push(r)
  }

  let folioTakenTotal = 0
  let folioRemainingTotal = 0

  for (const [, rows] of byFolio) {
    const taken = rows.filter(r => (r.amount || 0) > 0).reduce((s, r) => s + (r.amount || 0), 0)
    const returned = rows
      .filter(r => (r.amount || 0) < 0 && r.reference_number !== BOOKING_REFUND_REF)
      .reduce((s, r) => s + Math.abs(r.amount || 0), 0)
    folioTakenTotal += taken

    // ── The clamp that matters ──────────────────────────────────────────────────────────
    // Per-payment caps CANNOT simply be summed. Each one is `min(its own headroom, the
    // FOLIO's headroom)`, and that second term is shared: two $100 payments on a folio that
    // has already returned $150 each compute a $50 cap, and adding them offers $100 of a $50
    // budget. That is not hypothetical — 55 folios here carry more than one payment, and the
    // legacy untagged refunds that make the per-payment sum blind are exactly what pushes the
    // folio backstop into play.
    //
    // So the folio budget is spent down as the legs are built. Each leg is capped at what its
    // own payment allows AND what the folio has left, in the order rows were passed.
    let budget = Math.max(0, taken - returned)

    for (const row of rows) {
      if ((row.amount || 0) <= 0) continue
      if (budget <= 0) break
      const id = row.id
      if (!id) continue

      const perPayment = folioPaymentRefundable({ id, amount: row.amount }, rows)
      const allowed = Math.min(perPayment.remainingOnPayment, budget)
      if (allowed <= 0) continue

      budget -= allowed
      folioRemainingTotal += allowed

      legs.push({
        kind: 'folio-payment',
        paymentId: id,
        folioId: row.folio_id || undefined,
        tender: row.method || 'unknown',
        remainingCents: allowed,
        autoRefundable: row.method === 'card' && !!row.square_payment_id,
        priorRefundCount: perPayment.priorRefundCount,
      })
    }
  }

  const autoRefundableCents = legs.filter(l => l.autoRefundable).reduce((s, l) => s + l.remainingCents, 0)
  const totalRemainingCents = booking.remainingCents + folioRemainingTotal

  return {
    legs,
    bookingRemainingCents: booking.remainingCents,
    folioRemainingCents: folioRemainingTotal,
    totalRemainingCents,
    originalGrossTotalCents: bookingOriginalGrossCents + folioTakenTotal,
    autoRefundableCents,
    operatorHandledCents: totalRemainingCents - autoRefundableCents,
  }
}

export type RefundAllocation = {
  leg: RefundLeg
  amountCents: number
}

// Spend a refund target across the legs, in the order that returns the most money
// automatically: the booking leg first (it has no per-row structure to reason about), then
// folio card rows that Square can credit, then everything a human has to hand back.
//
// The order is a deliberate money decision, not a tidiness one. When a policy retains part of
// the payment, whatever is NOT refunded should be the awkward tender — the cash the operator
// would otherwise have to count out, the Venmo they would have to send back by hand. Filling
// the auto-refundable legs first leaves the retained portion sitting on the manual ones.
//
// Never exceeds a leg's own remaining, and never exceeds the target in total. If the target is
// larger than everything available (a policy figure bigger than what is left after earlier
// refunds), the shortfall is simply not allocated — the caller reports what it could return.
export function allocateRefund(targetCents: number, legs: RefundLeg[]): RefundAllocation[] {
  const rank = (l: RefundLeg) => (l.kind === 'booking' ? 0 : l.autoRefundable ? 1 : 2)
  const ordered = legs
    .map((leg, i) => ({ leg, i }))
    .sort((a, b) => rank(a.leg) - rank(b.leg) || a.i - b.i)
    .map(x => x.leg)

  let left = Math.max(0, targetCents)
  const out: RefundAllocation[] = []
  for (const leg of ordered) {
    if (left <= 0) break
    const amountCents = Math.min(leg.remainingCents, left)
    if (amountCents <= 0) continue
    left -= amountCents
    out.push({ leg, amountCents })
  }
  return out
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
