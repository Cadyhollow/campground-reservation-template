// THE ONE PLACE A CARD PAYMENT IS RECORDED ON A FOLIO.
//
// Two paths take a card in this app — the manual key-entry route (/api/admin-card-payment) and
// the Square Terminal, whose COMPLETED event arrives later at a different request. Both end here.
// That is the whole point: a second way to write a payment is exactly where a money bug hides,
// and these two would drift the first time one of them learned something the other did not.
//
// ⚠ ISOLATED FROM BOTH ENDS ON PURPOSE. This module knows nothing about Square (no token, no
// host, no credential resolution — that is lib/square-credentials.ts) and nothing about how the
// charge was taken. It is the RECORDING SINK. Another repo adopting the terminal flow swaps only
// how credentials resolve; the mechanics and this sink are account-agnostic.
import 'server-only'
import type { SupabaseClient } from '@supabase/supabase-js'

/** One lane's share of a card charge. `amount` is GROSS — the base plus that lane's own fee. */
/**
 * One row of a split payment.
 *
 * ⚠ `lane: null` MEANS UNTAGGED ON PURPOSE — a whole-account row — and it is not the same thing
 * as a missing or empty lane. Two-bucket parks need this: a "Pay both" tender settles Seasonal
 * (tagged) and the Camp Account (untagged, exactly as every ordinary payment is) in one charge,
 * so one of the two rows must legitimately carry no lane. See normalizeLaneSplit().
 */
export type LaneSplitRow = { lane: string | null; amount: number; surchargeAmount: number }

/**
 * Normalise whatever a caller (or a stored jsonb column) hands over. Rows with no positive amount
 * are dropped rather than written as zero-value payments.
 *
 * ⚠ AN EXPLICIT `lane: null` SURVIVES; A MISSING OR EMPTY LANE IS STILL DROPPED. That distinction
 * is deliberate and it is the whole change here. A row that names no lane because the caller
 * never set one is malformed — dropping it is what has always happened and what keeps a garbled
 * request from being charged. A row whose lane is *explicitly* null is a caller saying "this part
 * is a whole-account payment", which is what the Camp Account half of a "Pay both" tender is.
 *
 * Nothing existing changes shape: every current caller sends a real lane string, so this is
 * additive. The dropped-row fallback in the card routes (`split.length ? total : amount`) is why
 * getting this wrong would be quiet rather than loud — a silently dropped Camp row would charge
 * the card the Seasonal amount alone while the screen showed the total.
 */
export function normalizeLaneSplit(input: unknown): LaneSplitRow[] {
  if (!Array.isArray(input)) return []
  return input
    .map((l) => {
      const r = (l ?? {}) as { lane?: unknown; amount?: unknown; surchargeAmount?: unknown }
      const untagged = r.lane === null
      return {
        lane: untagged ? null : String(r.lane ?? ''),
        amount: Math.round(Number(r.amount ?? 0)),
        surchargeAmount: Math.round(Number(r.surchargeAmount ?? 0)) || 0,
      }
    })
    .filter(l => (l.lane === null || l.lane !== '') && Number.isFinite(l.amount) && l.amount > 0)
}

/**
 * The amount a card must be charged for a given split.
 *
 * ⚠ ALWAYS THE SUM OF THE ROWS THAT WILL BE WRITTEN, never a separately-supplied total. Trusting
 * both would let the card be charged one figure while the ledger recorded another — the worst
 * money bug available here, and one that would reconcile perfectly on every screen.
 */
export const laneSplitTotal = (split: LaneSplitRow[]): number =>
  split.reduce((sum, l) => sum + l.amount, 0)

export type RecordResult = { recorded: boolean; alreadyRecorded: boolean; error?: string }

/**
 * Write a completed card payment onto a folio, once.
 *
 * ⚠ IDEMPOTENT ON THE SQUARE PAYMENT ID, and that guard is not decoration. A Terminal completion
 * can reach us more than once — Square retries a webhook that did not 200, and the counter screen
 * polls the same checkout while it waits. Without this, a customer who tapped once could be
 * recorded as having paid twice. The guard makes "record it" safe to call from every one of those
 * paths, which is what lets the poll and the webhook coexist instead of one having to stay
 * read-only and hope the other arrives.
 *
 * With a split: ONE ROW PER LANE, all sharing the same square_payment_id, so each lane settles
 * exactly while a refund or a reconciliation can still see it was a single charge. Written in one
 * insert so a multi-lane payment cannot land half-applied.
 *
 * Without a split: one plain untagged row — a whole-account payment, exactly as before Phase 4.
 */
export async function recordCardPayment(
  supabase: SupabaseClient,
  opts: {
    folioId: string
    squarePaymentId: string
    split: LaneSplitRow[]
    /** Used only when `split` is empty. */
    amount?: number
    surchargeAmount?: number
    note?: string
  },
): Promise<RecordResult> {
  const { folioId, squarePaymentId, split, note = '' } = opts
  if (!folioId || !squarePaymentId) {
    return { recorded: false, alreadyRecorded: false, error: 'Missing folio or payment id' }
  }

  // Already in the books? Then this is a retry, a re-poll, or the other path getting there first.
  const { data: existing, error: lookupErr } = await supabase
    .from('folio_payments')
    .select('id')
    .eq('square_payment_id', squarePaymentId)
    .limit(1)
  if (lookupErr) return { recorded: false, alreadyRecorded: false, error: lookupErr.message }
  if (existing && existing.length > 0) return { recorded: false, alreadyRecorded: true }

  const base = {
    folio_id: folioId,
    method: 'card',
    status: 'completed',
    square_payment_id: squarePaymentId,
    note,
  }

  // An untagged split row writes `lane: null` — the same thing the no-split branch below records
  // by omitting the column, and the same thing every pre-Phase-4 payment already is.
  const rows = split.length
    ? split.map(l => ({ ...base, amount: l.amount, surcharge_amount: l.surchargeAmount, lane: l.lane ?? null }))
    : [{ ...base, amount: opts.amount ?? 0, surcharge_amount: opts.surchargeAmount ?? 0 }]

  const { error } = await supabase.from('folio_payments').insert(rows)
  if (error) return { recorded: false, alreadyRecorded: false, error: error.message }
  return { recorded: true, alreadyRecorded: false }
}
