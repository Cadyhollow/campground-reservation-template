// The Campers directory and the camper record — the reading, not the writing.
//
// Everything here is PURE and DISPLAY-ONLY. No money is computed a new way: the deposit view
// below is handed the lane totals that lib/ledger-lanes.ts already produced and only arranges
// them. Nothing in this file writes, and nothing in it is imported by the ledger.

import { splitSiteNumbers } from './occupancy-report.ts'
import type { LaneBalances } from './ledger-lanes.ts'

/**
 * Where a camper stands with THIS season's paperwork.
 *
 * `not_enrolled` is the state this release exists to make visible. It is not an error and not a
 * lapsed camper — it is the overwhelmingly common case of somebody flagged seasonal in the Guest
 * Directory whom nobody has added to a season yet. Before this, they simply did not appear.
 */
export type EnrollmentStatus = 'signed' | 'sent' | 'draft' | 'not_enrolled'

export const ENROLLMENT_LABEL: Record<EnrollmentStatus, string> = {
  signed: 'Signed',
  sent: 'Sent · unsigned',
  draft: 'Draft',
  not_enrolled: 'Not in this season',
}

/** Which token tone each state wears. Mirrors the roster's existing pill vocabulary. */
export const ENROLLMENT_TONE: Record<EnrollmentStatus, 'good' | 'watch' | 'draft' | 'muted'> = {
  signed: 'good',
  sent: 'watch',
  draft: 'draft',
  not_enrolled: 'muted',
}

type ContractLike = {
  status?: string | null
  signed_at?: string | null
  sent_at?: string | null
} | null | undefined

/**
 * A camper's standing for one season.
 *
 * NO CONTRACT AT ALL is `not_enrolled` — deliberately a state of its own rather than being folded
 * into 'draft' or shown as blank. A blank cell reads as "nothing to do here", which is exactly
 * the misreading that let campers vanish.
 *
 * `signed_at` and `sent_at` are trusted over `status` when they are present, because they are
 * facts (a signature exists / an email went out) where status is a label that a cancel or a
 * hand-edit can leave behind.
 */
export function enrollmentStatus(contract: ContractLike): EnrollmentStatus {
  if (!contract) return 'not_enrolled'
  if (contract.signed_at) return 'signed'
  const s = (contract.status || '').trim().toLowerCase()
  if (s === 'signed') return 'signed'
  if (contract.sent_at || s === 'sent') return 'sent'
  return 'draft'
}

/** True when the camper needs the one-click add — the whole point of the directory. */
export const needsEnrolling = (contract: ContractLike): boolean =>
  enrollmentStatus(contract) === 'not_enrolled'

/**
 * Directory search: by name, or by site number.
 *
 * SITE MATCHING IS PER SITE, NOT SUBSTRING, because a double-site camper's `site_number` is a
 * comma list ("2, 3") and because a substring match on "1" would return sites 1, 10, 11, 12, 21
 * and 31 — which is not a search, it is a shrug. splitSiteNumbers is the same splitter the
 * occupancy report uses, so "2, 3" means two sites here exactly as it does there.
 *
 * Name matching stays a substring, case-insensitive, matching the Guest Directory's existing
 * behaviour so the two searches do not feel like different products.
 */
export function matchesCamperSearch(
  row: { name?: string | null; site_number?: string | null },
  query: string,
): boolean {
  const q = (query || '').trim().toLowerCase()
  if (!q) return true
  if ((row.name || '').toLowerCase().includes(q)) return true
  return splitSiteNumbers(row.site_number).some(s => s.toLowerCase() === q)
}

/**
 * What a camper owes on the SEASONAL FEE alone, arranged the way they actually pay it.
 *
 * Cady's campers pay a deposit in the fall and the balance in the spring, usually in
 * instalments. So the four numbers an owner wants at the counter are: what the season costs,
 * what the deposit was, what has come in, and what is still out.
 *
 * ⚠ NOTHING IS RECOMPUTED. `paid` and `balance` come from the seasonal LANE that
 * lib/ledger-lanes.ts already produced; this only reads them. `fee` and `depositDue` are the
 * contract's own display-only columns. There is no schedule invented here — a deposit is a
 * number that was stated on the agreement, not an instalment plan this code knows about.
 *
 * `depositDue` stays NULL when the contract states none. Null and 0 are different facts — "no
 * deposit was asked for" versus "a deposit of $0.00 was stated" — and the UI says so.
 *
 * On a COMBINED park (every park by default) there is no seasonal lane, so `lanes` is null; the
 * fee and deposit still show, and `paid`/`balance` come back null rather than borrowing the
 * whole-account figure, which would silently count a store purchase as a fee payment.
 */
export type DepositView = {
  feeCents: number | null
  depositDueCents: number | null
  paidCents: number | null
  balanceCents: number | null
  /** True once payments cover the stated deposit — the "deposit paid, balance due in spring" read. */
  depositCovered: boolean
}

export function depositView(
  contract: { total_due_cents?: number | null; deposit_due_cents?: number | null } | null | undefined,
  lanes: LaneBalances | null | undefined,
): DepositView {
  const feeCents = contract?.total_due_cents ?? null
  const depositDueCents = contract?.deposit_due_cents ?? null
  const seasonal = lanes?.byLane?.seasonal ?? null
  const paidCents = seasonal ? seasonal.payments : null
  const balanceCents = seasonal ? seasonal.balance : null
  const depositCovered =
    depositDueCents != null && paidCents != null && depositDueCents > 0 && paidCents >= depositDueCents
  return { feeCents, depositDueCents, paidCents, balanceCents, depositCovered }
}

/** One line of plain English for the deposit block, so the screen never has to assemble it. */
export function depositSummary(v: DepositView): string {
  if (v.feeCents == null) return 'No seasonal fee set for this season yet.'
  if (v.paidCents == null) return 'Lane totals are not available on this park’s billing mode.'
  if (v.balanceCents != null && v.balanceCents <= 0) return 'Paid in full.'
  if (v.depositCovered) return 'Deposit paid — balance due in the spring.'
  if (v.depositDueCents != null && v.depositDueCents > 0 && v.paidCents > 0) return 'Part-paid toward the deposit.'
  if (v.paidCents > 0) return 'Part-paid.'
  return 'Nothing paid yet.'
}
