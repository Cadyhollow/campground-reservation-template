// WHERE THE MONEY CAME FROM — Reports R2. Pure; no DB, no I/O; integer cents throughout.
//
// ⚠ A NEW MODULE, NOT AN ADDITION TO THE FEE MODEL. lib/ledger.ts, booking-quote.ts and
// pricing.ts must show an EMPTY DIFF. Everything here is built from primitives those modules and
// R1 already export — nothing is reimplemented.
//
// ── LANE vs SOURCE, AND WHY THIS IS A SECOND WORD ────────────────────────────────────────────
//
// A LANE (lib/ledger-lanes.ts) answers "what is this charge FOR?" on ONE seasonal camper's
// folio. It exists to slice a blended account so a camper can be sent an electric bill that is
// only electricity.
//
// A SOURCE answers a different question, for the owner: "which part of my business did this
// money come from?" It spans the whole park, and most of it never touches a lane at all — a
// nightly booking is not a lane, a walk-up candy bar is not on any camper's account. So the two
// vocabularies overlap on three names (seasonal / electric / store) and diverge elsewhere.
//
// Where they overlap they are DERIVED from the lane, never re-decided: SOURCE_COLOR below reads
// LANE_COLOR, and a seasonal camper's payment is sourced by the lane it was filed against. That
// is what keeps the dashboard and the folio speaking the same language.
import { LANE_COLOR } from './lane-display.ts'
import type { Segment } from './report-buckets.ts'

export type RevenueSource =
  | 'seasonal'    // seasonal site fees
  | 'nightly'     // nightly / transient reservations
  | 'long_term'   // weekly, monthly, and other long-term arrangements
  | 'electric'    // metered electricity billed to a camper
  | 'store'       // camp store — walk-up sales AND a camper's store tab
  | 'other'       // a guest-account charge that fits none of the above
  | 'unassigned'  // see below: NOT a source, an honest admission

/** Every source, in the order the dashboard ranks ties and renders legends. */
export const SOURCES: readonly RevenueSource[] = [
  'seasonal', 'nightly', 'long_term', 'electric', 'store', 'other', 'unassigned',
] as const

export const SOURCE_LABEL: Record<RevenueSource, string> = {
  seasonal: 'Seasonal fees',
  nightly: 'Nightly reservations',
  long_term: 'Long-term & monthly',
  electric: 'Electric',
  store: 'Store',
  other: 'Other charges',
  unassigned: 'Not yet assigned to a source',
}

/**
 * A one-line plain-English gloss, shown under the label so an owner never has to guess what a
 * bucket contains. `long_term` earns the longest one: it is the money R1 found was being dropped
 * entirely, so it is the bucket most likely to be unfamiliar.
 */
export const SOURCE_BLURB: Record<RevenueSource, string> = {
  seasonal: 'Site fees from seasonal campers',
  nightly: 'Transient bookings — cabins, tents, RV nights',
  long_term: 'Weekly, monthly and other long-term stays',
  electric: 'Metered electricity billed to campers',
  store: 'Camp store — walk-up sales and campers’ tabs',
  other: 'Guest-account charges outside the buckets above',
  // Retained as a value so a future caller can still say "genuinely un-sourceable", but
  // sourceOfPayment() no longer produces it: an untagged seasonal payment is Seasonal now.
  unassigned: 'Payments that name no source — file them from the folio',
}

/**
 * COLOURBLIND-SAFE, and never the only signal.
 *
 * The three sources that ARE lanes read their colour straight out of LANE_COLOR, so a park that
 * learns "orange means electric" on the folio sees the same orange on the dashboard, and the two
 * cannot drift apart in a later edit. The two that are not lanes take the remaining Okabe–Ito
 * hues, chosen from the same colourblind-safe set for the same reason.
 *
 * ⚠ EVERY USE MUST PRINT SOURCE_LABEL BESIDE THE SWATCH — see the legibility note on
 * `rankSources` about why that matters more here than anywhere else in the app.
 */
export const SOURCE_COLOR: Record<RevenueSource, string> = {
  seasonal: LANE_COLOR.seasonal,   // Okabe–Ito blue
  electric: LANE_COLOR.electric,   // Okabe–Ito orange
  store: LANE_COLOR.store,         // Okabe–Ito bluish green
  other: LANE_COLOR.other,         // neutral grey
  nightly: '#CC79A7',              // Okabe–Ito reddish purple
  long_term: '#56B4E9',            // Okabe–Ito sky blue
  unassigned: '#9CA3AF',           // lighter grey — deliberately not a peer of the real sources
}

/** Where a source row drills to. '' means "no page owns this one". */
export const SOURCE_DESTINATION: Record<RevenueSource, string> = {
  seasonal: 'tab:seasonal',
  nightly: 'tab:reservations',
  store: 'tab:store',
  electric: '/admin/electric-billing',
  long_term: '/admin/guests',
  other: 'tab:transactions',
  unassigned: 'tab:transactions',
}

/** As much of a folio as sourcing needs. */
export type SourceFolio = {
  folio_type?: string | null
  reservation_id?: string | null
  /** Which reporting segment the folio's guest is in — see lib/report-buckets.ts. */
  segment?: Segment | null
}

/** As much of a folio_payments row as sourcing needs. */
export type SourcePayment = {
  amount?: number | null
  surcharge_amount?: number | null
  lane?: string | null
  paid_at?: string | null
  folio_id?: string | null
}

const LANE_TO_SOURCE: Record<string, RevenueSource> = {
  seasonal: 'seasonal', electric: 'electric', store: 'store', other: 'other',
}

/**
 * Which part of the business a payment came from.
 *
 * ── THE RULES, AND WHY THEY ARE IN THIS ORDER ────────────────────────────────────────────────
 *
 * 1. A payment on a RESERVATION folio is nightly money. Decided by the folio, not by any string.
 * 2. A walk-in / walk-up folio is the camp store. That is what those folio types ARE.
 * 3. A guest account is sourced by WHOSE account it is first, and only then by lane:
 *      • a long-term guest's account is long-term money whatever the lane says — their rent is
 *        not a seasonal fee, and the lane column was never designed to say so;
 *      • a SEASONAL camper's account is split by the lane the payment was filed against, which is
 *        the same lane their folio shows;
 *      • anyone else's house tab is `other`.
 *
 * ⚠ RULE 4: AN UNTAGGED PAYMENT ON A SEASONAL CAMPER'S FOLIO IS SEASONAL REVENUE.
 *
 * This is an INFERENCE, in the same spirit as the three above it, and it is the last one tried.
 * Money a seasonal camper paid into their own account is seasonal money — that is what the
 * account is for — so reporting it as "not yet assigned to a source" described the tagging, not
 * the money, and left a park's largest revenue stream looking orphaned. On a real park that was
 * most of the seasonal income sitting in a bucket labelled as if nobody knew where it came from.
 *
 * ⚠ IT CANNOT SWALLOW A TRUER SOURCE, because it is only ever reached when every sharper signal
 * has already been tried. An explicit lane wins first, so a camper's store tab stays Store and
 * their electric stays Electric. A reservation-linked folio was claimed as nightly two rules
 * earlier. What is left is a payment into a seasonal account with nothing more specific to say
 * about it — and for a PAYMENT there is nothing more specific available: unlike a charge, a
 * payment has no product_id and no electric reading, so its lane tag is the only sharper signal
 * that exists, and it is checked first.
 *
 * ⚠ THIS IS THE DISPLAY LAYER ONLY. lib/ledger-lanes.ts still refuses to infer a seasonal LANE,
 * and must keep refusing: a lane drives what a camper is BILLED for on a separated park, where
 * guessing would put money on an invoice nobody agreed to. Attributing revenue on an owner's own
 * dashboard carries no such risk — nothing is billed from it, and the total is unchanged either
 * way. Two layers, two rules, deliberately.
 */
export function sourceOfPayment(folio: SourceFolio | null | undefined, payment: SourcePayment): RevenueSource {
  const type = (folio?.folio_type || '').trim().toLowerCase()
  if (type === 'reservation' || folio?.reservation_id) return 'nightly'
  if (type === 'walkin' || type === 'walkup') return 'store'
  if (folio?.segment === 'long_term') return 'long_term'
  if (folio?.segment === 'seasonal') {
    const lane = (payment.lane || '').trim().toLowerCase()
    // The explicit tag wins; otherwise it is seasonal money. See RULE 4 above.
    return LANE_TO_SOURCE[lane] || 'seasonal'
  }
  return 'other'
}

export type SourceTotals = {
  bySource: Record<RevenueSource, number>
  /** Summed independently of the buckets — the cross-check that nothing was dropped. */
  total: number
}

const zero = (): Record<RevenueSource, number> =>
  ({ seasonal: 0, nightly: 0, long_term: 0, electric: 0, store: 0, other: 0, unassigned: 0 })

/**
 * A booking payment recorded on the reservation itself (a deposit or an online payment).
 *
 * These are DISJOINT from folio_payments — there is no folio row for them — so they are added
 * rather than de-duplicated. They are always nightly money. Dated by `created_at`: a reservation
 * has no payment timestamp, and `amount_paid` is written in the request that creates the row, so
 * creation IS the payment moment. The reports page has always dated them this way.
 */
export type BookingPayment = { amount_paid?: number | null; surcharge_amount?: number | null; created_at?: string | null }

/**
 * Total revenue by source, over one time window.
 *
 * ⚠ GROSS OF THE CARD SURCHARGE, because every other revenue figure on this page always has
 * been, and the "Transaction fees collected" card explicitly describes itself as a breakout of
 * money already counted in revenue rather than an addition to it. `folio_payments.amount` is
 * stored gross; a booking payment is gross once its surcharge is added back. Changing this to a
 * net basis would silently restate Total Revenue, which is exactly the kind of quiet change an
 * owner is entitled to not have made for them.
 *
 * Refund rows are INCLUDED and net themselves out: /api/refund writes a negative amount, so a
 * full refund cancels its original and a partial one leaves exactly what the business kept. The
 * caller is responsible for passing only rows whose status counts (REFUNDABLE_STATUSES) — the
 * same set the folio, the receipt and every R1 balance use.
 */
export function sumBySource(
  payments: SourcePayment[] | null | undefined,
  folioById: ReadonlyMap<string, SourceFolio>,
  bookings: BookingPayment[] | null | undefined,
  window: { startISO: string; endISO: string },
): SourceTotals {
  const bySource = zero()
  let total = 0

  for (const p of payments || []) {
    if (!p.paid_at || p.paid_at < window.startISO || p.paid_at > window.endISO) continue
    const gross = p.amount || 0
    bySource[sourceOfPayment(folioById.get(p.folio_id || ''), p)] += gross
    total += gross
  }

  for (const b of bookings || []) {
    if (!b.created_at || b.created_at < window.startISO || b.created_at > window.endISO) continue
    const gross = (b.amount_paid || 0) + (b.surcharge_amount || 0)
    bySource.nightly += gross
    total += gross
  }

  return { bySource, total }
}

export type RankedSource = {
  source: RevenueSource
  amount: number
  /** Share of the window's total, 0–1. Zero when the total is zero. */
  share: number
  /** Same source in the comparison window; null when there is no comparison. */
  priorAmount: number | null
}

/**
 * The breakdown, biggest first, with the empty sources dropped.
 *
 * ── PART D: SMALL SOURCES HAVE TO STAY LEGIBLE ───────────────────────────────────────────────
 *
 * On a real park seasonal fees can be ~85% of revenue, which leaves a $48 store month as a bar
 * roughly one pixel wide — present, and unreadable. Three things answer that, and the first two
 * are the important ones:
 *
 *   1. EVERY ROW PRINTS ITS LABEL AND ITS AMOUNT, always, beside the bar. The bar is the
 *      at-a-glance shape; the text is the actual answer. A source is never communicated by
 *      length or colour alone.
 *   2. Rows are ranked and full-width, so a small source occupies a full line of the page and
 *      cannot be crowded out by a large one.
 *   3. `minShare` floors the DRAWN width so a non-zero source is always visibly non-zero. It
 *      changes only the bar; the printed percentage stays truthful.
 *
 * A zero source is dropped entirely rather than floored — a bar for money that does not exist
 * would be a lie, and the floor exists to keep real money visible, not to invent any.
 */
export function rankSources(
  totals: SourceTotals,
  prior: SourceTotals | null,
): RankedSource[] {
  return SOURCES
    .filter(s => totals.bySource[s] !== 0)
    .map(s => ({
      source: s,
      amount: totals.bySource[s],
      share: totals.total !== 0 ? totals.bySource[s] / totals.total : 0,
      priorAmount: prior ? prior.bySource[s] : null,
    }))
    .sort((a, b) => b.amount - a.amount)
}

/** The drawn width of a share bar, floored so a real source is never invisible. Display only. */
export function barWidthPct(share: number, minShare = 0.02): number {
  if (share <= 0) return 0
  return Math.max(minShare, Math.min(1, share)) * 100
}
