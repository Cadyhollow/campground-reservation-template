// REPORTING BUCKETS — Reports R1. Pure; no DB, no I/O; integer cents throughout.
//
// ⚠ A NEW MODULE, NOT AN ADDITION TO lib/ledger.ts OR lib/ledger-lanes.ts, for the same reason
// ledger-lanes.ts was split out: ledger.ts is one of the three fee-model files that must show an
// EMPTY DIFF (with booking-quote.ts and pricing.ts). Everything here is built from the two
// primitives those modules already export — `notVoided` and `classifyLineItem` — and adds
// nothing to either.
//
// ── THE PROBLEM THIS EXISTS TO SOLVE ─────────────────────────────────────────────────────────
//
// The reports page counted guest-account charges by asking, separately, "what did seasonal
// campers spend?" and "what did monthly campers spend?". Two overlapping questions against one
// table, with no statement of what the answers add up to. Three things went wrong:
//
//   1. A guest flagged BOTH seasonal and monthly was counted twice across the two figures.
//   2. A guest flagged ONLY monthly was in the Monthly Revenue card but in NO total — the card
//      was never added to Total Revenue.
//   3. A guest_account folio for a guest who is NEITHER — an ordinary guest with a house tab —
//      was in no figure at all, and was also excluded from store revenue (which drops every
//      guest_account folio), so that money was simply invisible.
//
// The fix is to stop asking overlapping questions. Every guest_account charge is assigned to
// EXACTLY ONE segment here, and `total` is the arithmetic proof of it: it is summed
// independently of the segments and must equal them. A test pins that.
import { notVoided } from './ledger.ts'
import { classifyLineItem, LANES, type Lane, type LaneLineItem, type LaneContext } from './ledger-lanes.ts'

/**
 * Which reporting bucket a guest_account folio's money belongs to.
 *
 * - `seasonal`   — a seasonal camper's account. Broken down further, by lane.
 * - `long_term`  — a monthly / weekly / other long-term arrangement. Neither a nightly booking
 *                  nor a seasonal fee, and historically the money most at risk of being dropped.
 * - `other`      — a guest_account folio belonging to neither. Rare, but real, and it must land
 *                  somewhere honest rather than nowhere.
 */
export type Segment = 'seasonal' | 'long_term' | 'other'

export const SEGMENTS: readonly Segment[] = ['seasonal', 'long_term', 'other'] as const

/**
 * ⚠ SEASONAL WINS A TIE, DELIBERATELY. A guest flagged both `is_seasonal` and `is_monthly` has
 * ONE folio and ONE balance, and that balance is already reconciled against their seasonal
 * contract and shown on the Seasonal report. Counting them as long-term as well is exactly the
 * double-count this module exists to remove; counting them as long-term INSTEAD would make the
 * Seasonal report disagree with the folio it is built from. So: one guest, one segment, and the
 * segment is the one their folio is already reported under.
 */
export function segmentOf(guest: { is_seasonal?: boolean | null; is_monthly?: boolean | null }): Segment {
  if (guest?.is_seasonal) return 'seasonal'
  if (guest?.is_monthly) return 'long_term'
  return 'other'
}

const zeroLanes = (): Record<Lane, number> => ({ electric: 0, store: 0, seasonal: 0, other: 0 })

export type GuestAccountBuckets = {
  /** Non-voided charges per segment. The three are disjoint and sum to `total`. */
  bySegment: Record<Segment, number>
  /** The `seasonal` segment sliced by lane. Sums to `bySegment.seasonal`. */
  seasonalByLane: Record<Lane, number>
  /** Every non-voided charge, summed WITHOUT reference to the segments — the cross-check. */
  total: number
  /** Charges on a folio this caller supplied no segment for. Counted in `other` and in `total`
   *  (money is never dropped for want of a label), and surfaced so a caller can tell the
   *  difference between "an ordinary house tab" and "a folio I failed to look up". */
  unattributed: number
}

/**
 * Split guest_account charges into disjoint reporting buckets.
 *
 * VOIDED CHARGES ARE EXCLUDED, via the same `notVoided` idiom every folio balance in this app
 * already uses, applied at the SUM step. A canceled packet is wrong to count anywhere — a report
 * that still counts it disagrees with the folio it was built from, which is the fastest way to
 * lose an owner's trust in the numbers.
 *
 * @param items            guest_account folio_line_items (any mix of folios).
 * @param segmentByFolioId folio id → segment. A folio missing from the map lands in `other`.
 * @param ctx              the lane classifier's context — see lib/ledger-lanes.ts.
 */
export function bucketGuestAccountCharges(
  items: (LaneLineItem & { folio_id: string })[] | null | undefined,
  segmentByFolioId: ReadonlyMap<string, Segment>,
  ctx: LaneContext,
): GuestAccountBuckets {
  const bySegment: Record<Segment, number> = { seasonal: 0, long_term: 0, other: 0 }
  const seasonalByLane = zeroLanes()
  let total = 0
  let unattributed = 0

  for (const item of (items || []).filter(notVoided)) {
    const amount = item.line_total || 0
    total += amount
    const known = segmentByFolioId.get(item.folio_id)
    const segment = known ?? 'other'
    if (!known) unattributed += amount
    bySegment[segment] += amount
    if (segment === 'seasonal') seasonalByLane[classifyLineItem(item, ctx)] += amount
  }

  return { bySegment, seasonalByLane, total, unattributed }
}

/** One lane's money rolled up across many campers. Mirrors LaneTotals in lib/ledger-lanes.ts. */
export type RolledLane = { charges: number; payments: number; balance: number }

export type LaneRollup = {
  byLane: Record<Lane, RolledLane>
  /**
   * Payments that name no lane, summed across campers. NOT distributed across the lanes and NOT
   * guessed at — every payment predating Phase 4 is untagged. They apply to the whole account,
   * so they are reported as their own line and subtracted once from the total.
   */
  untaggedPayments: number
  totalCharges: number
  totalPayments: number
  /**
   * ⚠ THE INVARIANT, AND THE WHOLE POINT OF THE ROLL-UP.
   *
   *     netBalance === sum over lanes of (charges − payments) − untaggedPayments
   *
   * It is also, by construction, the sum of every camper's own account balance — the figure their
   * folio prints. That equality is what lets the Seasonal report show a lane split WITHOUT the
   * split ever implying more or less money than the folios it came from. A test pins it.
   */
  netBalance: number
}

/** The per-camper shape this roll-up consumes — structurally `LaneBalances` from ledger-lanes.ts. */
type CamperLanes = {
  byLane: Record<Lane, { charges: number; payments: number; balance: number }>
  untaggedPayments: number
  totalCharges: number
  totalPayments: number
}

/**
 * Add up many campers' lane splits into one park-wide view.
 *
 * Takes `laneBalances()` output verbatim rather than re-deriving anything, so the report and the
 * camper's own folio cannot drift: whatever the classifier decided per camper is what is summed.
 */
export function rollUpLanes(campers: CamperLanes[] | null | undefined): LaneRollup {
  const byLane = zeroLanes() as unknown as Record<Lane, RolledLane>
  for (const lane of LANES) byLane[lane] = { charges: 0, payments: 0, balance: 0 }

  let untaggedPayments = 0
  let totalCharges = 0
  let totalPayments = 0

  for (const c of campers || []) {
    for (const lane of LANES) {
      byLane[lane].charges += c.byLane[lane].charges
      byLane[lane].payments += c.byLane[lane].payments
    }
    untaggedPayments += c.untaggedPayments
    totalCharges += c.totalCharges
    totalPayments += c.totalPayments
  }
  for (const lane of LANES) byLane[lane].balance = byLane[lane].charges - byLane[lane].payments

  return { byLane, untaggedPayments, totalCharges, totalPayments, netBalance: totalCharges - totalPayments }
}
