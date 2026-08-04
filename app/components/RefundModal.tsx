'use client'

// The one refund modal.
//
// There were three: the folio ledger, the reports transactions drawer, and the reservations
// "Issue Refund" panel. Same amount field, same percentage presets, same reason box, same
// Square/cash notice — three copies, which is three places for a money control to drift. They
// had already drifted: two prefilled 90% of the ORIGINAL payment while the third prefilled the
// full amount, and all three measured their maximum against the original rather than what was
// still refundable, so on a partially-refunded payment they offered amounts the server would
// reject.
//
// What this component does NOT do is move money. It collects an amount and a reason and posts
// to one of the two existing routes. Both recompute the cap server-side from the folio rows and
// refuse anything above it, so nothing here is load-bearing for correctness — `remainingCents`
// exists to stop the operator being offered a number that will bounce, not to authorise one.
//
// Guard patterns carried over from the Part 2 cancel modal, which is deliberately NOT reused —
// that one is cancellation-specific (policy box, deadline framing, "Keep reservation"). What is
// shared is the discipline: the server recomputes the ceiling, the submit button disables the
// moment it is pressed, and the Square idempotency key on both routes derives from stable
// inputs rather than the clock, so a double-submit cannot produce a second refund.

import { useState, useEffect } from 'react'

// Which leg is being refunded. The two have genuinely different money models — a folio payment
// is a row with its own headroom; the booking leg is reservations.amount_paid, which has no row
// at all — so they post to different routes. Everything the operator sees is identical.
export type RefundTarget =
  | {
      kind: 'folio-payment'
      paymentId: string
      folioId: string
      method: string
      squarePaymentId?: string | null
      // The ORIGINAL charge, shown for context only.
      originalCents: number
      // What may actually be handed back, from folioPaymentRefundable(). The field's max and
      // the presets are computed off this, never off originalCents.
      remainingCents: number
      note?: string | null
    }
  | {
      kind: 'booking-leg'
      reservationId: string
      squarePaymentId?: string | null
      originalCents: number
      remainingCents: number
      // Surcharge share of this refund, prorated by the caller via prorateSurcharge(). Sent
      // separately so the route records the negative surcharge that unwinds the revenue
      // breakout rather than inferring it.
      surchargeForCents: (grossCents: number) => number
      currentNotes?: string | null
      // Shown when the booking leg's own money is not the whole story.
      folioPaidCents?: number
    }

export type RefundModalProps = {
  target: RefundTarget | null
  onClose: () => void
  // Called after a refund lands, so the caller can re-read its rows.
  onRefunded: () => void | Promise<void>
  // Seed amount in cents, chosen by the caller. A booking-leg refund on a reservation with an
  // arrival date seeds the resolved cancellation policy's figure; a plain folio payment (an
  // add-on, a POS charge) seeds the full remaining, because no policy governs it. Clamped to
  // remainingCents here regardless.
  defaultAmountCents?: number
  // An extra preset, labelled — the resolved policy percentage where one applies. Without it
  // the presets are just fractions of what remains; a hardcoded 90% here would be the same
  // "one park's policy baked into shared code" that the cancellation default just shed.
  policyPreset?: { label: string; cents: number } | null
  // Free-text context shown under the heading (e.g. which rule produced the suggestion).
  hint?: string | null
  title?: string
}

const money = (c: number) => `$${(c / 100).toFixed(2)}`

export default function RefundModal({
  target, onClose, onRefunded, defaultAmountCents, policyPreset, hint, title,
}: RefundModalProps) {
  const [amount, setAmount] = useState('')
  const [reason, setReason] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')
  const [success, setSuccess] = useState(false)

  const remaining = target?.remainingCents ?? 0

  // Re-seeded whenever the target changes. Selecting a different payment used to leave the
  // previous one's amount sitting in the box under a button now pointing somewhere else.
  useEffect(() => {
    if (!target) return
    const seed = Math.max(0, Math.min(defaultAmountCents ?? remaining, remaining))
    setAmount((seed / 100).toFixed(2))
    setReason('')
    setError('')
    setSuccess(false)
    setSubmitting(false)
  }, [target?.kind, (target as any)?.paymentId, (target as any)?.reservationId, defaultAmountCents, remaining])

  if (!target) return null

  const cents = Math.round(parseFloat(amount || '0') * 100)
  const overCap = cents > remaining
  const invalid = !Number.isFinite(cents) || cents <= 0 || overCap

  const isCard = target.kind === 'folio-payment' ? target.method === 'card' : !!target.squarePaymentId
  const willHitSquare = !!target.squarePaymentId

  // Presets as fractions of what REMAINS, plus the policy figure when one applies. Measuring
  // these off the original is what let a partially-refunded payment propose more than it had.
  const presets: { label: string; cents: number }[] = [
    { label: '100%', cents: remaining },
    ...(policyPreset && policyPreset.cents > 0 && policyPreset.cents <= remaining
      ? [{ label: policyPreset.label, cents: policyPreset.cents }] : []),
    { label: '50%', cents: Math.round(remaining / 2) },
  ]

  async function submit() {
    // Disabled the moment it is pressed. The idempotency keys on both routes are derived from
    // the payment/reservation, the amount and the refunds already recorded — not from the clock
    // — so even a double-submit that beats this cannot produce a second refund.
    if (!target || submitting || invalid) return
    setSubmitting(true)
    setError('')

    const body = target.kind === 'folio-payment'
      ? {
          url: '/api/refund',
          payload: {
            paymentId: target.paymentId,
            folioId: target.folioId,
            refundAmount: cents / 100,
            reason,
          },
        }
      : {
          url: '/api/reservation-refund',
          payload: {
            reservationId: target.reservationId,
            squarePaymentId: target.squarePaymentId,
            refundAmount: cents / 100,
            refundSurchargeAmount: target.surchargeForCents(cents) / 100,
            reason: reason || 'Refund',
            currentNotes: target.currentNotes,
          },
        }

    try {
      const res = await fetch(body.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body.payload),
      })
      const data = await res.json()
      if (!data.success) {
        // The server recomputed the cap and disagreed, or Square refused. Either way no money
        // moved; re-enable so the operator can adjust and retry.
        setError(data.error || 'Refund failed. Please try again.')
        setSubmitting(false)
        return
      }
      setSuccess(true)
      await onRefunded()
      setTimeout(() => { onClose() }, 2200)
    } catch {
      setError('Could not reach the server. No refund was issued.')
      setSubmitting(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40">
      <div className="bg-white rounded-xl shadow-xl w-full max-w-md max-h-[90vh] overflow-y-auto p-5 space-y-3">
        <div className="flex items-center justify-between">
          <h3 className="text-lg font-semibold text-gray-900">{title || 'Issue Refund'}</h3>
          <button
            onClick={onClose}
            disabled={submitting}
            className="text-gray-400 hover:text-gray-600 text-xl font-bold leading-none disabled:opacity-40"
          >
            ×
          </button>
        </div>

        {success ? (
          <div className="text-center py-6">
            <div className="text-4xl mb-2">✅</div>
            <p className="font-bold text-green-700">Refund recorded</p>
            <p className="text-sm text-gray-500 mt-1">
              {money(cents)} {willHitSquare ? 'refunded to the card' : '— return the funds to the guest manually'}
            </p>
          </div>
        ) : (
          <>
            {/* What is being refunded, and what is left of it. Naming both is the whole point:
                the original is what the operator remembers, the remainder is what they can
                actually give back. */}
            <div className="bg-gray-50 border border-gray-200 rounded-lg p-3 text-sm space-y-1">
              <div className="text-gray-600">
                {target.kind === 'folio-payment' ? (
                  <>Payment of <strong>{money(target.originalCents)}</strong> · {target.method}</>
                ) : (
                  <>Booking charge of <strong>{money(target.originalCents)}</strong></>
                )}
              </div>
              {remaining !== target.originalCents && (
                <div className="text-gray-600">
                  Still refundable: <strong>{money(remaining)}</strong> — the rest has already been refunded.
                </div>
              )}
              {target.kind === 'booking-leg' && (target.folioPaidCents || 0) > 0 && (
                <div className="text-xs text-gray-500">
                  The {money(target.folioPaidCents!)} taken on the folio is refunded from the folio page.
                </div>
              )}
              {target.kind === 'folio-payment' && target.note && (
                <div className="text-xs text-gray-400 italic">{target.note}</div>
              )}
            </div>

            {hint && <p className="text-xs text-gray-500">{hint}</p>}

            {remaining <= 0 ? (
              <p className="text-sm text-gray-600">Nothing left to refund here.</p>
            ) : (
              <>
                <label className="block text-xs font-semibold text-gray-700">Refund amount</label>
                <div className="relative">
                  <span className="absolute left-2 top-1/2 -translate-y-1/2 text-gray-400">$</span>
                  <input
                    type="number" step="0.01" min="0"
                    // Capped at what REMAINS, not the original.
                    max={(remaining / 100).toFixed(2)}
                    className="w-full border border-gray-200 rounded pl-6 pr-2 py-2 text-lg font-bold"
                    value={amount}
                    onChange={e => setAmount(e.target.value)}
                    disabled={submitting}
                  />
                </div>

                <div className="flex gap-2">
                  {presets.map(p => (
                    <button
                      key={p.label}
                      onClick={() => setAmount((p.cents / 100).toFixed(2))}
                      disabled={submitting}
                      className="flex-1 bg-white border border-gray-200 rounded py-1.5 text-xs font-semibold text-gray-700 hover:bg-gray-50 disabled:opacity-50"
                    >
                      {p.label}
                    </button>
                  ))}
                </div>

                {overCap && (
                  <p className="text-xs text-red-600">
                    More than the {money(remaining)} still refundable — the server will refuse this.
                  </p>
                )}

                <input
                  type="text"
                  placeholder="Reason (saved to the folio and the notes)"
                  className="w-full border border-gray-200 rounded px-2 py-1.5 text-sm"
                  value={reason}
                  onChange={e => setReason(e.target.value)}
                  disabled={submitting}
                />

                {willHitSquare
                  ? <p className="text-xs text-green-700">✓ Will refund to the card via Square</p>
                  : isCard
                    ? <p className="text-xs text-amber-700">⚠ Card payment with no Square ID — recorded here, refund the card manually.</p>
                    : <p className="text-xs text-gray-500">Cash/check — return the funds manually; the refund is still recorded.</p>}

                {error && <p className="text-sm text-red-600">{error}</p>}

                <div className="flex gap-2 pt-1">
                  <button
                    onClick={onClose}
                    disabled={submitting}
                    className="flex-1 bg-white border border-gray-200 text-gray-700 rounded-lg py-2 text-sm font-medium hover:bg-gray-50 disabled:opacity-50"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={submit}
                    disabled={submitting || invalid}
                    className="flex-1 bg-red-600 text-white rounded-lg py-2 text-sm font-semibold hover:bg-red-700 disabled:opacity-50"
                  >
                    {submitting ? 'Processing…' : `Refund ${money(Math.max(0, cents))}`}
                  </button>
                </div>
              </>
            )}
          </>
        )}
      </div>
    </div>
  )
}
