// MONEY LANES — Phase 4, PR 1. Pure; no DB, no I/O; integer cents throughout.
//
// ⚠ THIS IS A NEW MODULE AND NOT AN ADDITION TO lib/ledger.ts, DELIBERATELY. ledger.ts is one of
// the three fee-model files the repo requires to show an EMPTY DIFF (with booking-quote.ts and
// pricing.ts) — its arithmetic is the thing a money bug hides in. Everything here builds on the
// one primitive it already exports, `notVoided`, and adds nothing to it.
//
// ── WHAT A LANE IS ───────────────────────────────────────────────────────────────────────────
//
// A park keeps ONE blended account per seasonal camper today: the electric bill, the store tab
// and (from the next PR) the seasonal fee all land in the same folio and net against each other.
// So a camper who is $300 ahead on their seasonal fee appears to owe nothing for electricity, and
// an electric bill built from the whole folio shows them their store tab.
//
// A LANE is that account sliced by what the money is FOR. Nothing here changes how a folio works;
// it reads the same rows and reports them grouped.
//
// ⚠ NOTHING IN THIS MODULE RUNS UNLESS A PARK IS EXPLICITLY SET TO 'separated'. Combined is the
// default and stays byte-identical to today.

// Relative, with the extension — the repo's convention for one lib module importing another
// (see booking-quote.ts / pricing.ts importing ./pet-fee.ts). The '@/lib/…' alias does NOT
// resolve under `node --test`, and this module is unit-tested, so the alias would have made it
// untestable — the same trap lib/contract-emails.ts was split out of contract-server.ts to avoid.
import { notVoided } from './ledger.ts'

export type Lane = 'electric' | 'store' | 'seasonal' | 'other'

/** Every lane, in the order a UI should show them. `other` last: it is the catch-all. */
export const LANES: readonly Lane[] = ['electric', 'store', 'seasonal', 'other'] as const

export type BillingMode = 'combined' | 'separated'

/**
 * Read settings.billing_mode, failing safe to today's behaviour.
 *
 * ⚠ ONLY THE EXACT STRING 'separated' TURNS LANES ON. NULL, '', a typo, a value from a future
 * version this deploy has never heard of — all read as 'combined'.
 *
 * The asymmetry is intentional and worth stating: guessing 'separated' wrongly means a camper is
 * sent an electric bill that omits money they actually owe. Guessing 'combined' wrongly means
 * they get the bill their park already sends today. Only one of those is a new problem.
 */
export function normalizeBillingMode(value: unknown): BillingMode {
  return typeof value === 'string' && value.trim().toLowerCase() === 'separated' ? 'separated' : 'combined'
}

/** As much of a folio_line_item as classification needs. */
export type LaneLineItem = {
  id: string
  line_total: number
  voided?: boolean | null
  product_id?: string | null
  category?: string | null
}

/** As much of a folio_payment as lane maths needs. `lane` is Phase 4's new column. */
export type LanePayment = {
  amount: number
  surcharge_amount?: number | null
  lane?: string | null
}

/** What classification needs from outside the row itself. */
export type LaneContext = {
  /**
   * The ids of folio_line_items that an `electric_readings` row points at, via
   * electric_readings.folio_line_item_id. THE ONLY TRUSTWORTHY ELECTRIC SIGNAL — see below.
   */
  electricLineItemIds: ReadonlySet<string>
}

/**
 * Which lane a folio line item belongs to.
 *
 * ── THE MAPPING, AND WHY IT IS THIS AND NOT THE OBVIOUS ONE ──────────────────────────────────
 *
 * Verified against the code that WRITES these rows and against the sandbox tenant's real data on
 * 2026-08-27, rather than assumed:
 *
 * 1. ELECTRIC — the item's id appears in electric_readings.folio_line_item_id.
 *
 *    ⚠ NOT `category`. The electric charge is written by app/admin/electric-billing/page.tsx with
 *    `category: 'Fees'` and `product_id: null`. But 'Fees' IS ALSO ONE OF THE POS'S FALLBACK
 *    STORE CATEGORIES — the literal list in walkin-booking, folio/[id] and folio/guest/[id] is
 *    ['Camping Supplies', 'Food & Drink', 'Rentals', 'Fees', 'General']. So a staff member
 *    selling a store item filed under "Fees" would produce a row indistinguishable, by category,
 *    from an electric charge. `category` is also FREE TEXT a park configures (the sandbox's own
 *    product categories are 'Candy', 'Firewood', 'Ice', 'Camping Supplies', …), so a park is free
 *    to create one called "Electric" tomorrow and it would mean nothing.
 *
 *    The electric_readings link is written in the same operation that creates the charge and is
 *    the only signal that actually says "this row IS an electric bill". Keying on it means an
 *    electric statement can never accidentally include a can of propane, and never accidentally
 *    omit a real electric charge because a park renamed a category.
 *
 * 2. STORE — the item has a product_id. Every POS sale sets it (walkin-booking, both folio pages,
 *    and the new-reservation cart); every manual/custom charge leaves it null. A reliable,
 *    park-independent signal that does not depend on any string.
 *
 * 3. OTHER — everything else. In practice today that is the manual "custom item" charge, written
 *    with `product_id: null, category: 'General'`. Note that nightly/lodging charges do NOT
 *    currently reach folio_line_items at all — neither app/api/payment/route.ts nor
 *    /api/manual-booking writes one — so `other` is smaller in practice than it sounds. It is the
 *    catch-all precisely so an unforeseen row lands somewhere honest rather than being
 *    misfiled into a lane a camper is billed for.
 *
 * 4. SEASONAL — RESERVED. Nothing classifies here yet; the seasonal fee is not posted to a folio
 *    until the next PR. The lane exists now so the UI, the payment tag and the balance shape are
 *    all in place before the money arrives, rather than being retrofitted around it.
 */
export function classifyLineItem(item: LaneLineItem, ctx: LaneContext): Lane {
  if (ctx.electricLineItemIds.has(item.id)) return 'electric'
  if (item.product_id) return 'store'
  return 'other'
}

/** One lane's money. `balance` is charges − payments; negative means the lane is in credit. */
export type LaneTotals = { charges: number; payments: number; balance: number }

export type LaneBalances = {
  byLane: Record<Lane, LaneTotals>
  /**
   * Payments that name no lane. NOT distributed across the lanes and NOT guessed at — every
   * payment predating Phase 4 is untagged, and inventing a lane for them would rewrite a park's
   * financial history. They apply to the whole account, exactly as they always have.
   */
  untaggedPayments: number
  totalCharges: number
  totalPayments: number
  /** The whole-account balance — IDENTICAL to what the folio shows today, lanes or no lanes. */
  accountBalance: number
}

const emptyTotals = (): LaneTotals => ({ charges: 0, payments: 0, balance: 0 })

/** A payment's value to the account: the amount NET of any card surcharge, matching
 *  buildLedger() in lib/ledger.ts, so lane maths and the folio agree to the cent. */
const netOf = (p: LanePayment): number => p.amount - (p.surcharge_amount || 0)

/** Is this string one of our lanes? Anything else counts as untagged. */
const asLane = (v: unknown): Lane | null =>
  typeof v === 'string' && (LANES as readonly string[]).includes(v) ? (v as Lane) : null

/**
 * Split a camper's folio into lanes.
 *
 * Charges are filtered with `notVoided` — the same idiom lib/ledger.ts exports and every balance
 * in this app already uses, applied at the SUM step so a voided row can still be DISPLAYED as an
 * audit trail while being excluded from every total.
 *
 * ⚠ `accountBalance` IS THE INVARIANT. Whatever the lanes say, it equals today's whole-account
 * figure — total charges minus total payments including untagged ones. A test pins that, because
 * it is what proves separating the lanes has not lost or invented money.
 */
export function laneBalances(
  items: LaneLineItem[] | null | undefined,
  payments: LanePayment[] | null | undefined,
  ctx: LaneContext,
): LaneBalances {
  const byLane = {
    electric: emptyTotals(), store: emptyTotals(),
    seasonal: emptyTotals(), other: emptyTotals(),
  } as Record<Lane, LaneTotals>

  let totalCharges = 0
  for (const item of (items || []).filter(notVoided)) {
    const lane = classifyLineItem(item, ctx)
    byLane[lane].charges += item.line_total
    totalCharges += item.line_total
  }

  let totalPayments = 0
  let untaggedPayments = 0
  for (const p of payments || []) {
    const net = netOf(p)
    totalPayments += net
    const lane = asLane(p.lane)
    if (lane) byLane[lane].payments += net
    else untaggedPayments += net
  }

  for (const lane of LANES) byLane[lane].balance = byLane[lane].charges - byLane[lane].payments

  return {
    byLane,
    untaggedPayments,
    totalCharges,
    totalPayments,
    accountBalance: totalCharges - totalPayments,
  }
}

/**
 * The line items and payments belonging to ONE lane — what a lane-isolated statement is built
 * from. Voided items are KEPT here (the caller may want to display them); every total that
 * matters still runs through notVoided.
 */
export function filterToLane<I extends LaneLineItem, P extends LanePayment>(
  lane: Lane,
  items: I[] | null | undefined,
  payments: P[] | null | undefined,
  ctx: LaneContext,
): { items: I[]; payments: P[] } {
  return {
    items: (items || []).filter(i => classifyLineItem(i, ctx) === lane),
    // Only payments explicitly tagged to this lane. An untagged payment is a whole-account
    // payment and must NOT be pulled into a lane statement — doing so would show a camper a
    // credit against their electricity that was never made against it.
    payments: (payments || []).filter(p => asLane(p.lane) === lane),
  }
}
