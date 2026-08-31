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
  /**
   * R4b: sold BY THE SEASON rather than by the night.
   *
   * ⚠ OPTIONAL, AND UNDEFINED MEANS TRANSIENT. A park whose database has not had the R4b
   * migration applied returns rows without this key at all, and every one of them must keep
   * behaving exactly as it did before the column existed — which is transient.
   */
  is_seasonal_site?: boolean | null
}

/** Strictly `true`. Undefined (un-migrated park) and null both mean transient. */
export const isSeasonalSite = (s: RentableSite): boolean => s?.is_seasonal_site === true

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
  /** The FIRST site they name, normalised. Kept so a single-site occupant reads exactly as it
   *  always has; `siteNumbers` is the whole truth when a camper holds more than one. */
  siteNumber?: string
  /** EVERY site they hold, normalised and de-duplicated. See splitSiteNumbers(). */
  siteNumbers?: string[]
  /** The type of each entry in `siteNumbers`, in the same order. */
  types?: string[]
  /** True for a SEASONAL camper; false for a monthly or other long-stay one. */
  seasonal?: boolean
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

/**
 * One camper can hold more than one site.
 *
 * A seasonal camper who rents a second site — usually at a discounted rate — has that recorded
 * as a single free-text value: "43, 44". Read whole, that string matches no site at all, so the
 * camper resolved to nothing and BOTH their sites read as open. Read as one site, the second one
 * read as open while somebody was living on it — which sends an owner to sell a site that is
 * taken. Splitting is what makes a second site countable.
 *
 * ⚠ A SINGLE VALUE TAKES THE IDENTICAL PATH IT ALWAYS DID: no comma means one token, and that
 * token is normalised exactly as `resolveSiteType` normalises it. The common case is unchanged.
 *
 * Blank tokens are dropped ("43,," and a trailing comma are typing, not a site) and duplicates
 * are collapsed, so a value like "43, 43" cannot fill one site twice and overstate occupancy.
 */
export function splitSiteNumbers(value: string | null | undefined): string[] {
  if (typeof value !== 'string') return []
  const out: string[] = []
  for (const raw of value.split(',')) {
    const t = norm(raw)
    if (t && !out.includes(t)) out.push(t)
  }
  return out
}

/**
 * Every site a camper holds, paired with its type.
 *
 * ⚠ AN UNKNOWN TOKEN IS KEPT, NOT DROPPED. "43, 999" on a park with no site 999 yields site 43
 * AND an `unresolved` entry — because a camper pointing at a site that does not exist is a real
 * thing an owner needs to see and fix, and silently discarding the token would hide it while
 * making the numbers look tidier.
 */
export function resolveSiteTypes(
  value: string | null | undefined,
  byNumber: ReadonlyMap<string, string>,
): { siteNumbers: string[]; types: string[] } {
  const siteNumbers = splitSiteNumbers(value)
  if (siteNumbers.length === 0) return { siteNumbers: [], types: [UNRESOLVED_TYPE] }
  return { siteNumbers, types: siteNumbers.map(n => byNumber.get(n) || UNRESOLVED_TYPE) }
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
    const raw = c.site_number || camper?.site_number
    const { siteNumbers, types } = resolveSiteTypes(raw, byNumber)
    occupants.push({
      key: who,
      // The contract's own site number wins — it is what was agreed for that season. A camper
      // holding two sites names both here; see splitSiteNumbers().
      type: types[0],
      types,
      siteNumber: siteNumbers[0] || '',
      siteNumbers,
      seasonal: true,
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
    const resolved = resolveSiteTypes(camper.site_number, byNumber)
    occupants.push({
      key: who,
      type: resolved.types[0],
      types: resolved.types,
      siteNumber: resolved.siteNumbers[0] || '',
      siteNumbers: resolved.siteNumbers,
      seasonal: !!camper.is_seasonal,
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

/** Every site an occupant holds. Falls back to the singular field so an Occupant built by older
 *  code (or by a test) behaves exactly as it did. */
export const sitesOf = (o: Occupant): string[] =>
  o.siteNumbers && o.siteNumbers.length ? o.siteNumbers : (o.siteNumber ? [o.siteNumber] : [])

/** The type of each site they hold, same fallback. */
export const typesOf = (o: Occupant): string[] =>
  o.types && o.types.length ? o.types : [o.type]

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

// ── THE SEASONAL PROGRAM (R4b) ───────────────────────────────────────────────────────────────
//
// ⚠ SEASONAL OCCUPANCY IS NOT A NIGHT-BY-NIGHT NUMBER, and that is the whole point of splitting
// it out. A seasonal camper holds their site for the entire season, so "how many of tonight's
// seasonal site-nights were occupied?" is always either 100% or meaningless. The number an owner
// runs the seasonal business on is a PROGRAM FILL RATIO — 46 of 48 sold — and the two sites that
// are open are the actionable part of it.
//
// Blending that into a nightly average, which is what R4 did, hides both halves: it drags the
// nightly occupancy up with sites that were never for sale by the night, and it buries the
// vacancy count entirely.

export type SeasonalTypeLine = { type: string; label: string; total: number; filled: number; open: number }

export type SeasonalProgram = {
  totalSites: number
  filled: number
  open: number
  /** filled ÷ total, as a whole percent. */
  fillPct: number
  /** The site numbers standing empty — the actionable list. */
  openSites: { siteNumber: string; type: string; label: string }[]
  byType: SeasonalTypeLine[]
  /** Every seasonal fee under contract, whatever the window. The roster's value. */
  contractedCents: number
  /** Those fees ÷ the nights they buy — blended across however many fee levels a park has. */
  effectiveNightlyCents: number | null
  /** The share of those fees falling inside the selected window, prorated per night. */
  windowRevenueCents: number
  /** Seasonal campers with no fee on record; excluded from the blend rather than dragging it down. */
  campersWithoutFee: string[]
  /** ⚠ Seasonal campers sitting on a site flagged TRANSIENT — a designation to fix, not a number to bury. */
  onTransientSites: string[]
  /** Seasonal campers whose site number matches no site at all. */
  unresolved: string[]
}

/**
 * The seasonal program: how much of it is sold, what it is worth, and what is still open.
 *
 * ── WHAT "FILLED" MEANS, AND WHY IT IS NOT A DATE QUESTION ───────────────────────────────────
 *
 * A seasonal site is FILLED when a seasonal camper is assigned to it, and OPEN when it is not.
 * That is a roster question, not a calendar one — the park has either sold that site for the
 * season or it has not, and an owner asking "how many are left?" in February means exactly this.
 * Restricting it to campers whose season happens to cover today would report a park as entirely
 * unsold every winter, which is when the question matters most.
 */
export function buildSeasonalProgram(
  sites: RentableSite[] | null | undefined,
  occupants: Occupant[] | null | undefined,
  window: { start: string; end: string },
): SeasonalProgram {
  const seasonalSites = (sites || []).filter(s => isRentable(s) && isSeasonalSite(s))
  const flaggedSeasonal = new Set(seasonalSites.map(s => norm(s.site_number)).filter(Boolean))
  const allSiteNumbers = new Set((sites || []).map(s => norm(s.site_number)).filter(Boolean))

  const seasonalCampers = (occupants || []).filter(o => o.seasonal)
  // EVERY site each camper holds, not just the first — a second site is occupied too.
  const heldNumbers = new Set(seasonalCampers.flatMap(sitesOf))

  const openSites = seasonalSites
    .filter(s => !heldNumbers.has(norm(s.site_number)))
    .map(s => {
      const t = norm(s.site_type) || UNRESOLVED_TYPE
      return { siteNumber: s.site_number || '', type: t, label: typeLabel(t) }
    })

  const byTypeMap = new Map<string, SeasonalTypeLine>()
  for (const s of seasonalSites) {
    const t = norm(s.site_type) || UNRESOLVED_TYPE
    const line = byTypeMap.get(t) || { type: t, label: typeLabel(t), total: 0, filled: 0, open: 0 }
    line.total++
    if (heldNumbers.has(norm(s.site_number))) line.filled++
    else line.open++
    byTypeMap.set(t, line)
  }

  // Money. The blend is of the fees actually on record — a camper with no contract figure is
  // excluded from BOTH sides of the division rather than counted as free, which would quietly
  // drag the effective nightly below what any camper is really paying.
  let contractedCents = 0, feeNights = 0, windowRevenueCents = 0
  const campersWithoutFee: string[] = []
  for (const o of seasonalCampers) {
    let nights = 0
    for (let d = o.from; d < o.to; d = addDays(d, 1)) { nights++; if (nights > 4000) break }
    if (!nights) continue
    if (o.revenueUnknown || !o.totalCents) { campersWithoutFee.push(o.key) }
    else { contractedCents += o.totalCents; feeNights += nights }
    const perNight = Math.round((o.totalCents || 0) / nights)
    for (let d = o.from; d < o.to; d = addDays(d, 1)) {
      if (d >= window.start && d <= window.end) windowRevenueCents += perNight
    }
  }

  return {
    totalSites: seasonalSites.length,
    filled: seasonalSites.length - openSites.length,
    open: openSites.length,
    fillPct: seasonalSites.length > 0
      ? Math.round(((seasonalSites.length - openSites.length) / seasonalSites.length) * 100) : 0,
    openSites,
    byType: [...byTypeMap.values()].sort((a, b) => b.total - a.total || a.label.localeCompare(b.label)),
    contractedCents,
    effectiveNightlyCents: feeNights > 0 ? Math.round(contractedCents / feeNights) : null,
    windowRevenueCents,
    campersWithoutFee,
    // ⚠ Surfaced, never silently reclassified. A seasonal camper on a transient-flagged site is a
    // designation the park has not made yet, and the fix is one toggle on the Sites screen.
    // ⚠ ANY of a camper's sites being mis-designated is worth surfacing, not just the first.
    onTransientSites: seasonalCampers
      .filter(o => sitesOf(o).some(n => allSiteNumbers.has(n) && !flaggedSeasonal.has(n)))
      .map(o => o.key),
    // Likewise for a token that matches nothing: "43, 999" fills 43 AND still reports the camper,
    // because a site number pointing at nothing is a real thing an owner needs to fix.
    unresolved: seasonalCampers
      .filter(o => sitesOf(o).length === 0 || sitesOf(o).some(n => !allSiteNumbers.has(n)))
      .map(o => o.key),
  }
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
    const heldTypes = typesOf(o)
    // Any unresolvable token names the camper — see resolveSiteTypes().
    if (heldTypes.some(t => t === UNRESOLVED_TYPE)) unresolvedOccupants.push(o.key)
    const held: string[] = []
    for (let d = o.from; d < o.to; d = addDays(d, 1)) {
      held.push(d)
      if (held.length > 4000) break
    }
    if (!held.length) continue

    // ⚠ A CAMPER ON TWO SITES OCCUPIES TWO SITE-NIGHTS PER NIGHT, AND STILL PAYS ONE FEE.
    //
    // So the nights multiply and the money does not: the per-night amount is divided across the
    // sites it bought. A $2,000 season fee covering two sites is $1,000 of season against each,
    // which keeps `revenueCents` exactly what it was and stops the average nightly rate reading
    // double. Splitting evenly is the neutral choice — the discount on a second site is real but
    // is nowhere in the data, and inventing a ratio would be worse than sharing it.
    const perNightTotal = Math.round((o.totalCents || 0) / held.length)
    const perNight = Math.round(perNightTotal / Math.max(1, heldTypes.length))
    for (const n of held) {
      if (!inWindow(n)) continue
      for (const t of heldTypes) {
        countNight(t, n, perNight, !!o.revenueUnknown || !o.totalCents)
      }
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
