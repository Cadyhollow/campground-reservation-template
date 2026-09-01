// The meter registry, and the two questions the meter walk asks of it:
//   "whose meter is this?"   -> camperForMeter()
//   "does it bill?"          -> resolveBillable()
//
// Pure functions over rows. No Supabase, no React — so the walk screen, the API routes and the
// Electric Billing page all get the same answers, and the tests can ask the awkward questions
// (a camper on two sites, a site number pointing at nothing, an override fighting the occupancy)
// without a database.

import { splitSiteNumbers } from './occupancy-report.ts'
import { computeMeterUsage, computeElectricBill, type ElectricRate, type MeterUsage } from './electric-billing.ts'

/** A row of `meters`. */
export type Meter = {
  id: string
  meter_number: string
  site_id?: string | null
  /** Free text for a meter that is not a site's — "Bathhouse", "Shop". Blank for a site meter. */
  label?: string | null
  active?: boolean | null
  /** NULL = decide from occupancy. true/false = the owner has forced it. See resolveBillable(). */
  billable_override?: boolean | null
  display_order?: number | null
}

/** The subset of a `guests` row the meter walk needs. */
export type MeterCamper = {
  id: string
  name: string
  site_number?: string | null
  is_seasonal?: boolean | null
  /** Monthly / long-term. Metered and billed exactly like a seasonal — see isMeteredTenure(). */
  is_monthly?: boolean | null
  electric_billing_enabled?: boolean | null
  email?: string | null
}

/**
 * Is this camper the kind the park meters at all?
 *
 * THE PARK'S POLICY, in one function: electric is billed to SEASONAL and MONTHLY/long-term
 * campers. A nightly camper's power is already inside their nightly rate, so metering them and
 * billing them again would charge twice for the same electricity.
 *
 * `is_seasonal` and `is_monthly` are the two tenure flags the Guests screen sets (it treats them
 * as mutually exclusive) and the Reports screen already pairs them the same way —
 * `.or('is_seasonal.eq.true,is_monthly.eq.true')`. This is that pair, named once.
 */
export function isMeteredTenure(camper: MeterCamper | null | undefined): boolean {
  return camper?.is_seasonal === true || camper?.is_monthly === true
}

const norm = (t: unknown): string => (typeof t === 'string' ? t.trim().toLowerCase() : '')

/**
 * Is this a SITE meter — the kind that can bill somebody — or a common-area one?
 *
 * `site_id` is the whole test. A bathhouse meter is created with no site and never matches a
 * camper, which is what makes "record only" its permanent, automatic state.
 *
 * ⚠ A DELETED SITE MAKES ITS METER RECORD-ONLY, and that is the safe direction. The foreign key
 * is ON DELETE SET NULL, so removing a site leaves its meter and its whole reading history intact
 * but unattached. A site that does not exist cannot have a camper on it, so a meter that kept
 * billing from a stale number would be billing nobody — or, worse, whoever later inherits that
 * number. The owner can point it at a site again, or force it on with the override.
 */
export function isSiteMeter(meter: Meter): boolean {
  return typeof meter.site_id === 'string' && meter.site_id.length > 0
}

/**
 * The site number a meter reads, normalised. Empty string for a common-area meter.
 *
 * Meter number IS site number — that decision is the whole reason this feature has no mapping
 * screen. The SITE ROW is nonetheless the authority when it is available: a park that renumbers
 * site 43 to 43A has one meter row pointing at one site, and reading the number through the link
 * keeps the camper match correct without anybody re-typing the meter number.
 */
export function meterSiteKey(meter: Meter, siteNumberById?: Map<string, string>): string {
  if (!isSiteMeter(meter)) return ''
  const fromSite = siteNumberById?.get(meter.site_id as string)
  return norm(fromSite) || norm(meter.meter_number)
}

/**
 * Every camper currently on a site, keyed by normalised site number.
 *
 * ⚠ A DOUBLE-SITE CAMPER IS INDEXED UNDER BOTH NUMBERS. `site_number` is free text and a camper
 * who rents a second site has it recorded as "43, 44" — read whole, that matches no site at all.
 * splitSiteNumbers() is the same helper the Occupancy report uses, so the two screens cannot
 * disagree about who is where.
 *
 * When two campers claim one site the FIRST wins and the second is reported in `conflicts` rather
 * than silently dropped. Two people on one meter is a data error an owner needs to see — usually
 * a departed camper whose site number was never cleared — and quietly picking one would bill the
 * wrong person.
 */
export function campersBySite(campers: MeterCamper[] | null | undefined): {
  bySite: Map<string, MeterCamper>
  conflicts: { siteNumber: string; campers: MeterCamper[] }[]
} {
  const bySite = new Map<string, MeterCamper>()
  const clashes = new Map<string, MeterCamper[]>()
  // ⚠ SORTED BEFORE INDEXING, so "the first one wins" is a STABLE answer rather than whatever
  // order the database happened to return. Without this, two campers on one site resolve
  // differently between page loads, and "who is billed for this meter" is not a question the
  // software should answer differently each time you ask it.
  //
  // The tiebreak itself (by id) is arbitrary and deliberately so — there is no principled reason
  // to prefer either camper, which is exactly why the collision is REPORTED rather than resolved.
  // Stability is the property worth having; correctness here belongs to whoever fixes the site
  // numbers on the Guests screen.
  //
  // This became reachable when monthly campers joined the walk: before, an unflagged monthly
  // camper was filtered out and could not collide with anybody.
  const ordered = [...(campers || [])].sort((a, b) => String(a.id).localeCompare(String(b.id)))
  for (const c of ordered) {
    for (const site of splitSiteNumbers(c.site_number)) {
      const existing = bySite.get(site)
      if (!existing) { bySite.set(site, c); continue }
      if (existing.id === c.id) continue
      const list = clashes.get(site) || [existing]
      list.push(c)
      clashes.set(site, list)
    }
  }
  return {
    bySite,
    conflicts: [...clashes.entries()].map(([siteNumber, list]) => ({ siteNumber, campers: list })),
  }
}

/** The camper on a meter's site, or null. */
export function camperForMeter(
  meter: Meter,
  bySite: Map<string, MeterCamper>,
  siteNumberById?: Map<string, string>
): MeterCamper | null {
  const key = meterSiteKey(meter, siteNumberById)
  return key ? bySite.get(key) || null : null
}

/**
 * Why a meter does or does not feed a bill.
 *
 * ── THE CONTROL IS TWO STATES, NOT THREE ─────────────────────────────────────────────────────
 *
 * It was Auto / Always / Never. "Always" is gone, and its removal is the point rather than a
 * tidy-up: it read as "always bill", but a bill is a charge on a CAMPER'S FOLIO, so a meter with
 * nobody on it has nothing to bill and no amount of forcing changes that. It only ever looked
 * useful because Auto appeared to check seasonal alone — so a monthly camper seemed to need
 * forcing. That was the real gap, and widening Auto is the fix; "Always" was papering over it.
 *
 * ⚠ `billable_override === true` IS TREATED AS AUTO, deliberately, rather than as force-on. The
 * migration rewrites any surviving `true` to NULL, and the API refuses to write a new one — but
 * a value that has been removed from a product must not be able to resurrect a removed behaviour
 * from an old row, a restored backup, or a park whose migration has not run yet.
 *
 * ── WHAT AUTO NOW CHECKS ─────────────────────────────────────────────────────────────────────
 *
 *   1. "Don't bill" on the meter wins over everything. That is the deliberate opt-out — a work
 *      camper with free electric, a meter feeding something the park pays for.
 *   2. A common-area meter (no site) can never bill anybody.
 *   3. An empty site bills nobody. Recorded, not an error.
 *   4. TENURE: the camper must be SEASONAL OR MONTHLY. This is the widening. A nightly camper's
 *      power is inside their nightly rate, so billing a meter on them charges twice.
 *   5. Their electric billing must be switched on.
 *
 * ── ⚠ WHY STEP 5 IS STILL REQUIRED, AND WHAT IT COSTS ────────────────────────────────────────
 *
 * `guests.electric_billing_enabled` is what the Electric Billing page populates itself from, and
 * from nothing else. A draft staged against a camper who lacks it would be written to a screen
 * that never lists them — an invisible bill, which is worse than no bill.
 *
 * The cost is that the column is `NOT NULL DEFAULT false`, so "switched off on purpose" and
 * "nobody ever set it" are the same value. A monthly camper nobody has flagged therefore does not
 * bill. That is the safe direction (a missing draft is visible on the walk; an invisible one is
 * not), and the walk now NAMES them with 'billing-off' instead of showing "No seasonal camper",
 * so the fix is one toggle away and discoverable from the field.
 *
 * On the live park this costs nothing today: all 49 seasonal and both monthly campers already
 * have it on, and no transient does. Checked 2026-09-01.
 */
export type BillableReason =
  | 'override-off'     // the owner set this meter to "Don't bill"
  | 'metered'          // a seasonal or monthly camper, billed for electric — the ordinary case
  | 'billing-off'      // that camper is here, but electric billing is switched off for them
  | 'transient'        // somebody is on the site, but nightly — their power is in the rate
  | 'no-camper'        // nobody on this site
  | 'not-a-site'       // a common-area meter: no site, so never an automatic bill

export function resolveBillable(
  meter: Meter,
  camper: MeterCamper | null
): { billable: boolean; reason: BillableReason } {
  // "Don't bill" wins over everything. NOTE the absence of a `=== true` branch: see the header.
  if (meter.billable_override === false) return { billable: false, reason: 'override-off' }
  if (!isSiteMeter(meter)) return { billable: false, reason: 'not-a-site' }
  if (!camper) return { billable: false, reason: 'no-camper' }
  if (!isMeteredTenure(camper)) return { billable: false, reason: 'transient' }
  if (camper.electric_billing_enabled !== true) return { billable: false, reason: 'billing-off' }
  return { billable: true, reason: 'metered' }
}

/** What the walk screen says under the meter number. Short, because it sits on a phone. */
export function billableLabel(reason: BillableReason): string {
  switch (reason) {
    case 'override-off': return 'Record only — this meter is set to Don\u2019t bill'
    case 'metered':      return 'Bills this camper'
    case 'billing-off':  return 'Record only — electric billing is off for this camper'
    // Named rather than lumped in with an empty site: somebody IS on the site, and the reason
    // they are not billed is a policy the reader should be able to see standing at the meter.
    case 'transient':    return 'Record only — nightly camper, power is in their rate'
    case 'no-camper':    return 'Record only \u00b7 kept in history'
    case 'not-a-site':   return 'Record only \u00b7 kept in history'
  }
}

/**
 * Meters in the order the park is walked: SITE NUMBER ASCENDING, numerically.
 *
 * ⚠ `sites.display_order` IS DELIBERATELY NOT USED, and this was a bug before it was a decision.
 * An earlier version sorted by display_order first, on the theory that a park's own arrangement
 * of its sites should win. It does not survive contact with real data: the column DEFAULTS TO 0
 * and parks populate it partially or not at all. On the test tenant, sites 10-14 sat at 0 while
 * 1-6 had 1-6, so the walk opened on meter 10 and ran 10, 11, 12, 13, 14, 1, 2, 3 — which is
 * exactly the kind of order that makes somebody walk the park twice.
 *
 * Numeric site order is what was decided, it is what the numbers on the posts say, and it cannot
 * be broken by a column nobody has filled in. A park whose physical walking route genuinely
 * differs from its numbering would need a route of its own, deliberately entered — not a default
 * of 0 quietly deciding it.
 *
 * A named meter ("Bathhouse") sorts AFTER the numbered ones, alphabetically, so the site walk is
 * never interrupted by the odds and ends. And numerically, so it is 1, 2, 3, 10 — not 1, 10, 2.
 */
export function meterWalkOrder(meters: Meter[]): Meter[] {
  return [...meters].sort((a, b) => {
    const an = parseInt(a.meter_number, 10), bn = parseInt(b.meter_number, 10)
    const aNum = Number.isFinite(an), bNum = Number.isFinite(bn)
    if (aNum && bNum && an !== bn) return an - bn
    if (aNum !== bNum) return aNum ? -1 : 1
    return String(a.meter_number).localeCompare(String(b.meter_number), undefined, { numeric: true })
  })
}

// ── READINGS -> DRAFT BILLS ──────────────────────────────────────────────────────────────────

/** A saved reading, as the draft builder needs it. */
export type ReadingRow = {
  meter_id: string
  reading_value: number
  previous_value?: number | null
  is_meter_reset?: boolean | null
  reset_start_value?: number | null
  guest_id?: string | null
}

export type DraftBill = {
  guestId: string
  kwhUsed: number
  calculatedAmountCents: number
  meters: MeterUsage[]
}

/**
 * Group this session's billable readings into ONE draft per camper.
 *
 * ⚠ THIS IS WHERE THE DOUBLE-SITE CAMPER BECOMES ONE BILL. Two meters, two readings, two lines
 * the owner can verify — and a single summed total, priced once. Grouping on `guest_id` (which the
 * reading recorded at the moment it was taken) rather than re-deriving occupancy at bill time is
 * deliberate: a camper who moved out mid-month is still billed for the electricity they used,
 * against the site they were on when the meter was read.
 *
 * A reading with no camper is not a bill and is not an error — it is the permanent record every
 * meter gets. It is simply absent from the output.
 */
export function buildDraftBills(
  readings: ReadingRow[],
  metersById: Map<string, Meter>,
  rate: ElectricRate
): DraftBill[] {
  const byGuest = new Map<string, MeterUsage[]>()
  for (const r of readings) {
    if (!r.guest_id) continue
    const meter = metersById.get(r.meter_id)
    const kwh = computeMeterUsage(r.previous_value ?? 0, r.reading_value, {
      isReset: r.is_meter_reset === true,
      resetStartValue: r.reset_start_value ?? 0,
    })
    const isReset = r.is_meter_reset === true
    const usage: MeterUsage = {
      meterId: r.meter_id,
      meterNumber: meter?.meter_number || '',
      // See MeterUsage.previousReading: on a reset this is the NEW meter's start, so that
      // current - previous == kwh holds on every line of every bill.
      previousReading: isReset ? (r.reset_start_value ?? 0) : (r.previous_value ?? 0),
      currentReading: r.reading_value,
      kwh,
      isReset,
      replacedMeterFinal: isReset ? (r.previous_value ?? null) : null,
    }
    const list = byGuest.get(r.guest_id)
    if (list) list.push(usage); else byGuest.set(r.guest_id, [usage])
  }
  return [...byGuest.entries()].map(([guestId, meters]) => {
    // Stable, so a two-meter bill lists 43 before 44 every time it is rendered.
    const ordered = [...meters].sort((a, b) => {
      const an = parseInt(a.meterNumber, 10), bn = parseInt(b.meterNumber, 10)
      if (Number.isFinite(an) && Number.isFinite(bn) && an !== bn) return an - bn
      return a.meterNumber.localeCompare(b.meterNumber)
    })
    const bill = computeElectricBill(ordered, rate)
    return { guestId, kwhUsed: bill.kwhUsed, calculatedAmountCents: bill.calculatedAmountCents, meters: ordered }
  })
}
