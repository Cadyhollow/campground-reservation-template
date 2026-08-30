// OCCUPANCY BY SITE TYPE — Reports R4. Pure; no DB, no I/O; integer cents throughout.
//
// ⚠ ONE OCCUPANCY DEFINITION, AND IT IS R3'S. `occupiesNight` from lib/occupancy.ts is imported,
// never restated: a guest who checks out this morning does NOT occupy tonight. R3 collapsed two
// competing definitions into that one; adding a third here would undo the whole point.
//
// ── WHAT THIS ANSWERS THAT NOTHING ELSE DOES ─────────────────────────────────────────────────
//
// The dashboard says how full the park is TONIGHT. This says how full each KIND of site runs
// over a window, and how the weekend compares with the midweek — which is the number an owner
// actually prices and markets against.
import { occupiesNight, isLiveStay, addDays, type StayRow } from './occupancy.ts'

// ── SITE TYPES ARE DISCOVERED, NEVER CONFIGURED ──────────────────────────────────────────────
//
// `sites.site_type` is free text. A park with yurts, treehouses or glamping domes gets those
// automatically, with nothing to set up, because the types are read out of the rows themselves.
// Hard-coding the list would silently drop a park's whole inventory of anything unforeseen.

/** Where an occupant lands when their site cannot be resolved. See resolveSiteType(). */
export const UNRESOLVED_TYPE = 'unresolved'

export type RentableSite = {
  id?: string | null
  site_number?: string | null
  site_type?: string | null
  /** The flag the booking screens already use to decide a site can be sold. */
  is_available?: boolean | null
}

const norm = (t: unknown): string => (typeof t === 'string' ? t.trim().toLowerCase() : '')

/** A site is countable in the denominator when the park can actually sell it. */
export const isRentable = (s: RentableSite): boolean => s?.is_available !== false

/**
 * The distinct site types a park actually has, in a stable order.
 *
 * A row with no type at all still counts as inventory — it is a real site somebody can sleep on —
 * so it lands under `UNRESOLVED_TYPE` rather than being dropped for want of a label.
 */
export function siteTypesFrom(sites: RentableSite[] | null | undefined): string[] {
  const seen = new Set<string>()
  for (const s of sites || []) {
    if (!isRentable(s)) continue
    seen.add(norm(s.site_type) || UNRESOLVED_TYPE)
  }
  return [...seen].sort()
}

const KNOWN_LABELS: Record<string, string> = {
  rv_site: 'RV Sites', rv: 'RV Sites', cabin: 'Cabins', tent: 'Tent Sites',
  [UNRESOLVED_TYPE]: 'Unassigned',
}

/** 'rv_site' → 'RV Sites'; anything a park invented → Title Case of its own words. */
export function typeLabel(type: string): string {
  if (KNOWN_LABELS[type]) return KNOWN_LABELS[type]
  return type.split(/[_\s-]+/).filter(Boolean)
    .map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ') || 'Unassigned'
}

// ── OCCUPANTS ────────────────────────────────────────────────────────────────────────────────

/**
 * Somebody holding a site for a range of nights.
 *
 * Nightly stays arrive with a site_id and resolve cleanly. Seasonal and monthly campers reference
 * a site NUMBER as free text — see resolveSiteType() for why that is the fragile one.
 */
export type Occupant = {
  key: string
  type: string
  /** First night held. */
  from: string
  /** ⚠ EXCLUSIVE, exactly like departure_date — the night they leave is not a night they held. */
  to: string
  /** Total money attributable to the whole stay/season, prorated per night by the caller. */
  totalCents: number
  /** True when no revenue figure exists for this occupant — surfaced, never silently zeroed. */
  revenueUnknown?: boolean
}

/**
 * Resolve a free-text site number to a site type.
 *
 * ⚠ A MISS IS BUCKETED, NEVER DROPPED. Seasonal campers and monthly campers carry
 * `site_number` as text rather than a foreign key, so a typo, a renumbered site or a bad import
 * leaves a real camper pointing at a site that does not exist. Losing them would understate
 * occupancy and quietly change the average nightly rate; crashing would take the page down. They
 * land in `unresolved`, are counted, and the caller reports how many there were.
 *
 * Matching is trimmed and case-insensitive because "A1", "a1" and " A1 " are one site to
 * everyone except a string comparison.
 */
export function resolveSiteType(
  siteNumber: string | null | undefined,
  byNumber: ReadonlyMap<string, string>,
): string {
  const key = norm(siteNumber)
  if (!key) return UNRESOLVED_TYPE
  return byNumber.get(key) || UNRESOLVED_TYPE
}

/** site_number → site_type, for the lookup above. */
export function siteTypeByNumber(sites: RentableSite[] | null | undefined): Map<string, string> {
  const m = new Map<string, string>()
  for (const s of sites || []) {
    const n = norm(s.site_number)
    if (n) m.set(n, norm(s.site_type) || UNRESOLVED_TYPE)
  }
  return m
}

// ── BUILDING OCCUPANTS FROM WHAT THE DATABASE ACTUALLY HAS ───────────────────────────────────

export type ContractRow = {
  guest_id?: string | null
  site_number?: string | null
  total_due_cents?: number | null
  season_opens?: string | null
  season_closes?: string | null
  season_id?: string | null
  season_year?: number | null
  status?: string | null
}
export type SeasonRow = { id?: string | null; opens?: string | null; closes?: string | null }
export type CamperRow = {
  id?: string | null
  name?: string | null
  site_number?: string | null
  is_seasonal?: boolean | null
  is_monthly?: boolean | null
  season_start?: string | null
  season_end?: string | null
}

/** A contract that was withdrawn holds no site. Anything else counts, signed or not yet signed. */
const CONTRACT_DEAD_STATUSES = new Set(['cancelled', 'canceled', 'void', 'voided', 'declined'])

/**
 * The nights a season covers, resolved from the most specific source available.
 *
 * THE PRIORITY IS DELIBERATE: a contract may override its season's dates for one camper, so it
 * wins; the season row is the park-wide truth; the guest's own dates are the last resort because
 * they are the oldest and least maintained of the three.
 *
 * ⚠ `closes` IS INCLUSIVE AND `to` IS EXCLUSIVE. A season closing 30 September includes the night
 * of the 30th — the camper leaves on 1 October. Getting this off by one would silently drop a
 * night from every seasonal site and nudge every blended rate upward.
 */
export function seasonRange(
  contract: ContractRow | null,
  season: SeasonRow | null,
  camper: CamperRow | null,
): { from: string; to: string } | null {
  const pick = (a?: string | null, b?: string | null) => (a && b ? { opens: a, closes: b } : null)
  const r = pick(contract?.season_opens, contract?.season_closes)
       || pick(season?.opens, season?.closes)
       || pick(camper?.season_start, camper?.season_end)
  if (!r || r.closes < r.opens) return null
  return { from: r.opens, to: addDays(r.closes, 1) }
}

/**
 * Turn contracts and campers into datable, typed occupants.
 *
 * ⚠ NOBODY IS SILENTLY DROPPED. A camper whose site number matches no site is still an occupant,
 * bucketed under `unresolved`. A camper with no usable season dates cannot be placed on any
 * particular night, so they hold none — but they are RETURNED in `undated` so the screen can say
 * how many there were rather than letting them evaporate.
 */
export function buildOccupants(
  contracts: ContractRow[] | null | undefined,
  seasonsById: ReadonlyMap<string, SeasonRow>,
  campers: CamperRow[] | null | undefined,
  byNumber: ReadonlyMap<string, string>,
): { occupants: Occupant[]; undated: string[] } {
  const occupants: Occupant[] = []
  const undated: string[] = []
  const camperById = new Map<string, CamperRow>()
  for (const c of campers || []) if (c.id) camperById.set(c.id, c)
  const withContract = new Set<string>()

  for (const c of contracts || []) {
    if (CONTRACT_DEAD_STATUSES.has((c.status || '').trim().toLowerCase())) continue
    const camper = (c.guest_id && camperById.get(c.guest_id)) || null
    const who = `${camper?.name || 'Seasonal camper'}${c.season_year ? ` (${c.season_year})` : ''}`
    if (c.guest_id) withContract.add(c.guest_id)
    const range = seasonRange(c, (c.season_id && seasonsById.get(c.season_id)) || null, camper)
    if (!range) { undated.push(who); continue }
    occupants.push({
      key: who,
      // The contract's own site number wins — it is what was agreed for that season.
      type: resolveSiteType(c.site_number || camper?.site_number, byNumber),
      from: range.from, to: range.to,
      totalCents: c.total_due_cents || 0,
      revenueUnknown: !c.total_due_cents,
    })
  }

  // Seasonal campers with no contract, and monthly campers, who hold a site all the same.
  for (const camper of campers || []) {
    if (!camper.is_seasonal && !camper.is_monthly) continue
    if (camper.id && withContract.has(camper.id)) continue
    const who = camper.name || 'Camper'
    const range = seasonRange(null, null, camper)
    if (!range) { undated.push(who); continue }
    occupants.push({
      key: who,
      type: resolveSiteType(camper.site_number, byNumber),
      from: range.from, to: range.to,
      // ⚠ NO CONTRACT MEANS NO AMOUNT TO ATTRIBUTE, and the schema has nowhere else to look. The
      // nights still count toward occupancy; the missing money is surfaced as
      // `nightsWithoutRevenue` so the average nightly rate is read as a floor, not a fact.
      totalCents: 0,
      revenueUnknown: true,
    })
  }

  return { occupants, undated }
}

// ── THE WINDOW ───────────────────────────────────────────────────────────────────────────────

/** Every night from `start` to `end` inclusive. */
export function nightsBetween(start: string, end: string): string[] {
  if (!start || !end || end < start) return []
  const out: string[] = []
  for (let d = start; d <= end; d = addDays(d, 1)) {
    out.push(d)
    if (out.length > 4000) break   // a decade's guard rail; no report window is longer
  }
  return out
}

const dowOf = (ymd: string): number => {
  const [y, m, d] = ymd.split('-').map(Number)
  return new Date(y, m - 1, d).getDay()      // 0 = Sunday
}

/**
 * ⚠ FRIDAY AND SATURDAY NIGHTS, which is not the same as "the weekend".
 *
 * A guest who arrives Friday and leaves Sunday has stayed the Friday and Saturday NIGHTS. Sunday
 * night is the start of the working week for a campground and prices like it. Counting Sunday as
 * weekend would drag every park's weekend number down with its quietest night.
 */
export const isWeekendNight = (ymd: string): boolean => {
  const d = dowOf(ymd)
  return d === 5 || d === 6
}
/** Monday–Thursday nights. Sunday sits in neither bucket, deliberately — see above. */
export const isMidweekNight = (ymd: string): boolean => {
  const d = dowOf(ymd)
  return d >= 1 && d <= 4
}

// ── THE REPORT ───────────────────────────────────────────────────────────────────────────────

export type TypeMetrics = {
  type: string
  label: string
  /** Rentable sites of this type — the denominator's width. */
  units: number
  availableNights: number
  occupiedNights: number
  occupancyPct: number
  weekendPct: number
  midweekPct: number
  revenueCents: number
  /** Revenue ÷ occupied nights. NULL when nothing was occupied — not 0, which would read as free. */
  avgNightlyCents: number | null
  /** Occupied nights carrying no attributable revenue. A non-zero value means avgNightly is a
   *  floor rather than the whole truth, and the UI says so. */
  nightsWithoutRevenue: number
  /** Occupancy % for each night of the week, Monday first. */
  byDow: number[]
  byMonth: { key: string; label: string; pct: number }[]
}

export type OccupancyReport = {
  byType: TypeMetrics[]
  total: TypeMetrics
  /** Occupants whose site number matched no site — counted under `unresolved`, and named here. */
  unresolvedOccupants: string[]
  /** Occupants with no usable date range, so they hold no specific nights. Reported, not hidden. */
  undatedOccupants: string[]
}

const pct = (occ: number, avail: number) => (avail > 0 ? Math.round((occ / avail) * 1000) / 10 : 0)

/**
 * Build the whole per-type occupancy picture for one window.
 *
 * ── HOW REVENUE IS ATTRIBUTED, AND WHY IT IS NOT R2'S NUMBER ─────────────────────────────────
 *
 * ⚠ THIS IS A PER-NIGHT LENS. Every amount is spread evenly across the nights it bought and only
 * the window's share is counted. A $2,000 season fee over a 153-night season is $13.07 a night,
 * and a window covering 30 of those nights counts $392.
 *
 * R2's dashboard answers a different question — money RECEIVED, on the day it arrived — and the
 * two will not match. That is correct rather than a bug: a season fee paid in one cheque in March
 * is one number on the March dashboard and a nightly rate spread across the whole summer here.
 * R2 is untouched; this view labels itself so nobody reads the difference as an error.
 *
 * The nightly rate falls out of it honestly: revenue ÷ occupied nights. For seasonal sites that
 * blends whatever the actual contracts say, so three or five fee levels average correctly without
 * anyone assuming a rate.
 */
export function buildOccupancyReport(
  sites: RentableSite[] | null | undefined,
  nightly: (StayRow & { site_id?: string | null; total_price?: number | null; id?: string | null })[] | null | undefined,
  siteTypeById: ReadonlyMap<string, string>,
  occupants: Occupant[] | null | undefined,
  window: { start: string; end: string },
  undatedOccupants: string[] = [],
): OccupancyReport {
  const nights = nightsBetween(window.start, window.end)
  const types = siteTypesFrom(sites)

  const unitsByType = new Map<string, number>()
  for (const t of types) unitsByType.set(t, 0)
  for (const s of sites || []) {
    if (!isRentable(s)) continue
    const t = norm(s.site_type) || UNRESOLVED_TYPE
    unitsByType.set(t, (unitsByType.get(t) || 0) + 1)
  }

  // Per type: occupied nights, weekend/midweek splits, day-of-week and month tallies, revenue.
  type Acc = {
    occ: number; wkndOcc: number; wkndAvail: number; midOcc: number; midAvail: number
    dowOcc: number[]; dowAvail: number[]
    month: Map<string, { occ: number; avail: number }>
    revenue: number; noRevenueNights: number
  }
  const blank = (): Acc => ({
    occ: 0, wkndOcc: 0, wkndAvail: 0, midOcc: 0, midAvail: 0,
    dowOcc: [0,0,0,0,0,0,0], dowAvail: [0,0,0,0,0,0,0], month: new Map(), revenue: 0, noRevenueNights: 0,
  })
  const acc = new Map<string, Acc>()
  for (const t of types) acc.set(t, blank())
  const accFor = (t: string): Acc => {
    let a = acc.get(t)
    if (!a) { a = blank(); acc.set(t, a); if (!unitsByType.has(t)) unitsByType.set(t, 0) }
    return a
  }

  // Availability: every rentable unit is available every night of the window.
  for (const night of nights) {
    const wknd = isWeekendNight(night), mid = isMidweekNight(night)
    const dow = (dowOf(night) + 6) % 7            // 0 = Monday
    const mk = night.slice(0, 7)
    for (const t of types) {
      const units = unitsByType.get(t) || 0
      const a = accFor(t)
      if (wknd) a.wkndAvail += units
      if (mid) a.midAvail += units
      a.dowAvail[dow] += units
      const m = a.month.get(mk) || { occ: 0, avail: 0 }
      m.avail += units
      a.month.set(mk, m)
    }
  }

  const inWindow = (n: string) => n >= window.start && n <= window.end
  const countNight = (t: string, night: string, revenuePerNight: number, unknown: boolean) => {
    const a = accFor(t)
    a.occ++
    a.revenue += revenuePerNight
    if (unknown) a.noRevenueNights++
    if (isWeekendNight(night)) a.wkndOcc++
    if (isMidweekNight(night)) a.midOcc++
    a.dowOcc[(dowOf(night) + 6) % 7]++
    const mk = night.slice(0, 7)
    const m = a.month.get(mk) || { occ: 0, avail: 0 }
    m.occ++
    a.month.set(mk, m)
  }

  // ── Nightly reservations: total_price spread over the nights it bought ──
  for (const r of nightly || []) {
    if (!isLiveStay(r) || !r.arrival_date || !r.departure_date) continue
    const type = (r.site_id && siteTypeById.get(r.site_id)) || UNRESOLVED_TYPE
    const stayNights: string[] = []
    for (let d = r.arrival_date; d < r.departure_date; d = addDays(d, 1)) {
      stayNights.push(d)
      if (stayNights.length > 4000) break
    }
    if (!stayNights.length) continue
    const perNight = Math.round((r.total_price || 0) / stayNights.length)
    for (const n of stayNights) {
      if (!inWindow(n) || !occupiesNight(r, n)) continue
      countNight(type, n, perNight, !r.total_price)
    }
  }

  // ── Seasonal / monthly occupants: the total spread over the season's nights ──
  const unresolvedOccupants: string[] = []
  for (const o of occupants || []) {
    if (o.type === UNRESOLVED_TYPE) unresolvedOccupants.push(o.key)
    const held: string[] = []
    for (let d = o.from; d < o.to; d = addDays(d, 1)) {
      held.push(d)
      if (held.length > 4000) break
    }
    if (!held.length) continue
    const perNight = Math.round((o.totalCents || 0) / held.length)
    for (const n of held) {
      if (!inWindow(n)) continue
      countNight(o.type, n, perNight, !!o.revenueUnknown || !o.totalCents)
    }
  }

  const monthLabel = (key: string) =>
    new Date(Number(key.slice(0, 4)), Number(key.slice(5, 7)) - 1, 1)
      .toLocaleDateString('en-US', { month: 'short', year: '2-digit' })

  const metricsFor = (type: string, a: Acc, units: number): TypeMetrics => {
    const availableNights = units * nights.length
    return {
      type, label: typeLabel(type), units,
      availableNights, occupiedNights: a.occ,
      occupancyPct: pct(a.occ, availableNights),
      weekendPct: pct(a.wkndOcc, a.wkndAvail),
      midweekPct: pct(a.midOcc, a.midAvail),
      revenueCents: a.revenue,
      // NULL, not 0: "nothing was booked" and "it was free" are different answers.
      avgNightlyCents: a.occ > 0 ? Math.round(a.revenue / a.occ) : null,
      nightsWithoutRevenue: a.noRevenueNights,
      byDow: a.dowOcc.map((o, i) => pct(o, a.dowAvail[i])),
      byMonth: [...a.month.entries()].sort((x, y) => x[0].localeCompare(y[0]))
        .map(([key, v]) => ({ key, label: monthLabel(key), pct: pct(v.occ, v.avail) })),
    }
  }

  const byType = [...acc.entries()]
    .map(([t, a]) => metricsFor(t, a, unitsByType.get(t) || 0))
    .sort((x, y) => y.units - x.units || x.label.localeCompare(y.label))

  // The all-types row is summed from the parts, so it cannot disagree with them.
  const totalAcc = blank()
  for (const [, a] of acc) {
    totalAcc.occ += a.occ; totalAcc.wkndOcc += a.wkndOcc; totalAcc.wkndAvail += a.wkndAvail
    totalAcc.midOcc += a.midOcc; totalAcc.midAvail += a.midAvail
    totalAcc.revenue += a.revenue; totalAcc.noRevenueNights += a.noRevenueNights
    for (let i = 0; i < 7; i++) { totalAcc.dowOcc[i] += a.dowOcc[i]; totalAcc.dowAvail[i] += a.dowAvail[i] }
    for (const [k, v] of a.month) {
      const m = totalAcc.month.get(k) || { occ: 0, avail: 0 }
      m.occ += v.occ; m.avail += v.avail
      totalAcc.month.set(k, m)
    }
  }
  const totalUnits = [...unitsByType.values()].reduce((s, n) => s + n, 0)
  const total = { ...metricsFor('all', totalAcc, totalUnits), label: 'All sites' }

  return { byType, total, unresolvedOccupants, undatedOccupants }
}
