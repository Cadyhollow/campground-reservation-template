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
  electric_billing_enabled?: boolean | null
  email?: string | null
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
  for (const c of campers || []) {
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
 * ── THE RULE, AND THE ONE JUDGEMENT CALL IN IT ───────────────────────────────────────────────
 *
 * The decision was "a meter bills when its site currently has a seasonal camper, and a manual
 * override wins when set". Implementing "has a seasonal camper" needs a column, and there are two
 * candidates on `guests` that mean subtly different things:
 *
 *   is_seasonal               — this person is a seasonal camper
 *   electric_billing_enabled  — this person is billed for electric
 *
 * The Electric Billing page populates itself from `electric_billing_enabled` and nothing else. So
 * a draft staged against a camper who is `is_seasonal` but NOT `electric_billing_enabled` would
 * be written to a screen that never lists them — an invisible bill, which is worse than no bill.
 *
 * So the gate is `electric_billing_enabled`: a draft is only ever staged for a camper the owner
 * will actually see it on. But a seasonal camper with electric billing switched OFF is not
 * silently treated as an empty site either — that combination is reported as its own reason
 * ('billing-off'), and the walk screen says so on the meter. An owner who meant to bill them can
 * see why they are not being billed, on the spot, instead of discovering a missing bill later.
 *
 * ⚠ AN OVERRIDE WINS OVER ALL OF IT, in both directions — that is what "manual override" means.
 * Forcing a meter ON with nobody on the site is allowed and reported as such; the reading is
 * captured and the draft has no camper to attach to, which the caller surfaces rather than
 * guessing at a recipient.
 */
export type BillableReason =
  | 'override-on'      // the owner forced it on
  | 'override-off'     // the owner forced it off
  | 'seasonal'         // a camper on the site, billed for electric — the ordinary billable case
  | 'billing-off'      // a seasonal camper is here, but electric billing is switched off for them
  | 'no-camper'        // nobody on this site
  | 'not-a-site'       // a common-area meter: no site, so never an automatic bill

export function resolveBillable(
  meter: Meter,
  camper: MeterCamper | null
): { billable: boolean; reason: BillableReason } {
  const override = meter.billable_override
  if (override === true) return { billable: true, reason: 'override-on' }
  if (override === false) return { billable: false, reason: 'override-off' }
  if (!isSiteMeter(meter)) return { billable: false, reason: 'not-a-site' }
  if (!camper) return { billable: false, reason: 'no-camper' }
  if (camper.electric_billing_enabled === true) return { billable: true, reason: 'seasonal' }
  if (camper.is_seasonal === true) return { billable: false, reason: 'billing-off' }
  return { billable: false, reason: 'no-camper' }
}

/** What the walk screen says under the meter number. Short, because it sits on a phone. */
export function billableLabel(reason: BillableReason): string {
  switch (reason) {
    case 'override-on':  return 'Billed — set on by hand'
    case 'override-off': return 'Record only — set off by hand'
    case 'seasonal':     return 'Bills this camper'
    case 'billing-off':  return 'Record only — electric billing is off for this camper'
    case 'no-camper':    return 'Record only · kept in history'
    case 'not-a-site':   return 'Record only · kept in history'
  }
}

/** Meters in the order the park is walked: site number ascending, numerically where it can be. */
export function meterWalkOrder(meters: Meter[]): Meter[] {
  return [...meters].sort((a, b) => {
    const ao = a.display_order ?? 0, bo = b.display_order ?? 0
    if (ao !== bo) return ao - bo
    const an = parseInt(a.meter_number, 10), bn = parseInt(b.meter_number, 10)
    const aNum = Number.isFinite(an), bNum = Number.isFinite(bn)
    // A numbered meter sorts numerically; a named one ("Bathhouse") sorts after, alphabetically,
    // so the walk is 1,2,…,79 and then the odds and ends rather than 1,10,11,2.
    if (aNum && bNum && an !== bn) return an - bn
    if (aNum !== bNum) return aNum ? -1 : 1
    return String(a.meter_number).localeCompare(String(b.meter_number))
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
    const usage: MeterUsage = {
      meterId: r.meter_id,
      meterNumber: meter?.meter_number || '',
      previousReading: r.previous_value ?? 0,
      currentReading: r.reading_value,
      kwh,
      isReset: r.is_meter_reset === true,
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
