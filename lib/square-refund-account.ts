import 'server-only'
import type { SquareCreds } from '@/lib/square-credentials'

// REFUNDING FROM THE ACCOUNT THE MONEY WAS TAKEN ON.
//
// Every refund path resolves credentials through lib/square-credentials.ts, which answers with
// the park's CURRENT Square connection. For a campground with one stable connection — which is
// every campground, nearly always — the current connection is also the one that took the
// original payment, and there is nothing to think about.
//
// The corner case is a campground that changed Square accounts between the charge and the
// refund: disconnected and reconnected a different merchant, or moved from the operator-managed
// env-var credentials onto their own connected account. The refund then resolves to account B
// while the payment lives in account A.
//
// ── The decision, stated ──────────────────────────────────────────────────────────────────
// The thorough fix is to STAMP the account onto the payment record at charge time — environment
// plus a merchant or connection reference on reservations and folio_payments — and resolve the
// refund against the stamp rather than against the current connection. That is the right
// long-term shape and it is recommended, but it is NOT what this file does, because it needs a
// schema change to the canonical tenant schema (locked, and mirrored across three repos) plus a
// backfill decision for every payment already recorded without a stamp. That is its own piece of
// work, not a rider on a credential migration.
//
// What is done instead is a pre-flight: ask the account we are about to refund FROM whether it
// has ever heard of this payment. Square scopes a payment id to the merchant that took it, so
// "not found" is the answer for a payment that belongs to somebody else — and it is the same
// answer for a sandbox payment id looked up against production, which covers the environment
// half of the corner case for free. It needs no stored state, so it works for every payment
// already in the database, which a stamp added today would not.
//
// ── Why this fails CLOSED, and only on a definite answer ──────────────────────────────────
// A definite "no such payment on this account" blocks the refund and says why. Anything else —
// a timeout, a 500, a network error, an unrecognised shape — lets the refund proceed, because
// Square is still the authority: it will reject a cross-account refund itself, and both refund
// callers write their negative folio row only AFTER Square returns success. Blocking on a
// transient failure would strand legitimate refunds behind an outage, which is the more likely
// harm by a wide margin.

export type PaymentAccountCheck =
  | { ok: true }
  | { ok: false; error: string }

/**
 * Confirm `paymentId` belongs to the Square account `creds` will refund from.
 *
 * Never throws. Blocks only on a definite not-found; every other outcome returns ok.
 */
export async function verifyPaymentOnAccount(
  creds: SquareCreds,
  paymentId: string,
): Promise<PaymentAccountCheck> {
  let res: Response
  try {
    res = await fetch(`${creds.apiBase}/v2/payments/${encodeURIComponent(paymentId)}`, {
      headers: {
        'Authorization': `Bearer ${creds.accessToken}`,
        'Square-Version': '2024-01-18',
      },
    })
  } catch (e) {
    console.error('Square payment lookup failed before a refund; proceeding:', e)
    return { ok: true }
  }

  if (res.ok) return { ok: true }

  if (res.status !== 404) {
    // 401, 429, 5xx — this says nothing about which account owns the payment.
    console.error(`Square payment lookup returned ${res.status} before a refund; proceeding.`)
    return { ok: true }
  }

  console.error(
    `Refund blocked: Square payment ${paymentId} is not on the ${creds.environment} account ` +
    `currently connected (credentials from ${creds.source}). It was almost certainly taken on a ` +
    'different Square account, and refunding here would draw from the wrong merchant balance.',
  )
  return {
    ok: false,
    error:
      'This payment was not taken on the Square account currently connected, so it cannot be ' +
      'refunded from here. Refund it from the Square dashboard of the account that took it, or ' +
      'reconnect that account first.',
  }
}
