import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  isSiteMeter, meterSiteKey, campersBySite, camperForMeter, resolveBillable,
  meterWalkOrder, buildDraftBills,
  type Meter, type MeterCamper, type ReadingRow,
} from './meters.ts'
import type { ElectricRate } from './electric-billing.ts'

// The meter registry, and the two questions the walk asks of it: whose meter is this, and does it
// bill? The awkward cases are the point of this file — a camper on two sites, a site number
// pointing at nothing, two campers on one site, an override fighting the occupancy.

const RATE: ElectricRate = { ratePerKwh: 0.27, minimumChargeCents: 1500 }

const m = (n: string, over?: Partial<Meter>): Meter =>
  ({ id: 'm' + n, meter_number: n, site_id: 's' + n, active: true, billable_override: null, ...over })

const SITE_NUMBERS = new Map<string, string>([
  ['s12', '12'], ['s43', '43'], ['s44', '44'], ['s7', '7'],
])

const seasonal = (id: string, sites: string): MeterCamper =>
  ({ id, name: id, site_number: sites, is_seasonal: true, electric_billing_enabled: true })

// ── WHOSE METER IS THIS ──────────────────────────────────────────────────────────────────────

test('a site meter reads its site number; a common-area meter reads nothing', () => {
  assert.equal(meterSiteKey(m('12'), SITE_NUMBERS), '12')
  const bathhouse: Meter = { id: 'mb', meter_number: 'BH', site_id: null, label: 'Bathhouse' }
  assert.equal(isSiteMeter(bathhouse), false)
  assert.equal(meterSiteKey(bathhouse, SITE_NUMBERS), '')
})

test('the site row is the authority on the number, so a renumbered site still matches', () => {
  // Site s12 is renumbered 12A. The meter row still says "12"; the link says otherwise.
  const renumbered = new Map([['s12', '12A']])
  assert.equal(meterSiteKey(m('12'), renumbered), '12a')
})

test('a meter whose site was deleted becomes record-only rather than billing a stale number', () => {
  const orphan: Meter = { id: 'm12', meter_number: '12', site_id: null }
  assert.equal(isSiteMeter(orphan), false)
  assert.equal(resolveBillable(orphan, seasonal('g1', '12')).reason, 'not-a-site')
})

test('a double-site camper is found under BOTH of their site numbers', () => {
  const { bySite } = campersBySite([seasonal('g1', '43, 44')])
  assert.equal(bySite.get('43')?.id, 'g1')
  assert.equal(bySite.get('44')?.id, 'g1')
  assert.equal(camperForMeter(m('43'), bySite, SITE_NUMBERS)?.id, 'g1')
  assert.equal(camperForMeter(m('44'), bySite, SITE_NUMBERS)?.id, 'g1')
})

test('the messy ways a second site gets typed all read the same', () => {
  for (const value of ['43,44', '43, 44', '  43 , 44  ', '43,,44,']) {
    const { bySite } = campersBySite([seasonal('g1', value)])
    assert.equal(bySite.get('43')?.id, 'g1', value)
    assert.equal(bySite.get('44')?.id, 'g1', value)
  }
})

test('two campers on one site is REPORTED, not silently resolved to whichever came first', () => {
  const { bySite, conflicts } = campersBySite([seasonal('g1', '12'), seasonal('g2', '12')])
  assert.equal(bySite.get('12')?.id, 'g1', 'the first still wins, so the walk is usable')
  assert.equal(conflicts.length, 1)
  assert.equal(conflicts[0].siteNumber, '12')
  assert.deepEqual(conflicts[0].campers.map(c => c.id), ['g1', 'g2'])
})

test('a camper listing the same site twice is not a conflict with themselves', () => {
  const { conflicts } = campersBySite([seasonal('g1', '12, 12')])
  assert.equal(conflicts.length, 0)
})

// ── DOES IT BILL ─────────────────────────────────────────────────────────────────────────────

test('a meter with a seasonal camper on its site bills, automatically', () => {
  const { bySite } = campersBySite([seasonal('g1', '12')])
  const r = resolveBillable(m('12'), camperForMeter(m('12'), bySite, SITE_NUMBERS))
  assert.deepEqual(r, { billable: true, reason: 'seasonal' })
})

test('an empty site is record-only, and that is not an error', () => {
  const { bySite } = campersBySite([])
  const r = resolveBillable(m('12'), camperForMeter(m('12'), bySite, SITE_NUMBERS))
  assert.deepEqual(r, { billable: false, reason: 'no-camper' })
})

test('a common-area meter is permanently record-only', () => {
  const bathhouse: Meter = { id: 'mb', meter_number: 'BH', site_id: null, label: 'Bathhouse' }
  assert.deepEqual(resolveBillable(bathhouse, null), { billable: false, reason: 'not-a-site' })
})

test('the manual override wins in BOTH directions', () => {
  const { bySite } = campersBySite([seasonal('g1', '12')])
  const camper = camperForMeter(m('12'), bySite, SITE_NUMBERS)
  // Forced off, despite a seasonal camper sitting on it.
  assert.deepEqual(resolveBillable(m('12', { billable_override: false }), camper),
    { billable: false, reason: 'override-off' })
  // Forced on, with nobody there at all.
  assert.deepEqual(resolveBillable(m('99', { site_id: 's99', billable_override: true }), null),
    { billable: true, reason: 'override-on' })
})

test('an override on a common-area meter still wins — that is how a bathhouse gets billed', () => {
  const bathhouse: Meter = { id: 'mb', meter_number: 'BH', site_id: null, label: 'Bathhouse', billable_override: true }
  assert.equal(resolveBillable(bathhouse, null).billable, true)
})

test('a seasonal camper with electric billing switched OFF is named, not silently ignored', () => {
  // The distinction that matters: 'billing-off' tells the owner WHY no bill is coming, on the
  // meter, in the field. Collapsing it into 'no-camper' would hide a misconfiguration until a
  // bill went missing at the end of the month.
  const off: MeterCamper = { id: 'g1', name: 'g1', site_number: '12', is_seasonal: true, electric_billing_enabled: false }
  const { bySite } = campersBySite([off])
  const r = resolveBillable(m('12'), camperForMeter(m('12'), bySite, SITE_NUMBERS))
  assert.deepEqual(r, { billable: false, reason: 'billing-off' })
})

test('a non-seasonal guest parked on a site does not create a bill', () => {
  const transient: MeterCamper = { id: 'g9', name: 'g9', site_number: '12', is_seasonal: false, electric_billing_enabled: false }
  const { bySite } = campersBySite([transient])
  assert.equal(resolveBillable(m('12'), camperForMeter(m('12'), bySite, SITE_NUMBERS)).billable, false)
})

// ── THE ORDER OF THE WALK ────────────────────────────────────────────────────────────────────

test('the walk runs in numeric site order, not alphabetical', () => {
  const order = meterWalkOrder([m('10'), m('2'), m('1'), m('21'), m('3')]).map(x => x.meter_number)
  assert.deepEqual(order, ['1', '2', '3', '10', '21'])
})

test('named meters come after the numbered ones, so the site walk is not interrupted', () => {
  const bathhouse: Meter = { id: 'mb', meter_number: 'Bathhouse', site_id: null }
  const shop: Meter = { id: 'ms', meter_number: 'Shop', site_id: null }
  const order = meterWalkOrder([bathhouse, m('2'), shop, m('1')]).map(x => x.meter_number)
  assert.deepEqual(order, ['1', '2', 'Bathhouse', 'Shop'])
})

test("a park's own display_order wins over the number", () => {
  const order = meterWalkOrder([
    m('1', { display_order: 2 }), m('2', { display_order: 1 }),
  ]).map(x => x.meter_number)
  assert.deepEqual(order, ['2', '1'])
})

// ── READINGS -> DRAFT BILLS ──────────────────────────────────────────────────────────────────

const metersById = new Map<string, Meter>([
  ['m43', m('43')], ['m44', m('44')], ['m12', m('12')],
])

const reading = (meterId: string, prev: number, curr: number, guest: string | null, extra?: Partial<ReadingRow>): ReadingRow =>
  ({ meter_id: meterId, previous_value: prev, reading_value: curr, guest_id: guest, ...extra })

test('a double-site camper gets ONE draft bill summing both meters', () => {
  const drafts = buildDraftBills([
    reading('m43', 1000, 1300, 'g1'),
    reading('m44', 500, 700, 'g1'),
  ], metersById, RATE)
  assert.equal(drafts.length, 1, 'one camper, one bill — never two rows')
  assert.equal(drafts[0].guestId, 'g1')
  assert.equal(drafts[0].kwhUsed, 500)
  assert.equal(drafts[0].calculatedAmountCents, 13500)
  assert.deepEqual(drafts[0].meters.map(x => x.meterNumber), ['43', '44'], 'both lines, in meter order')
  assert.deepEqual(drafts[0].meters.map(x => x.kwh), [300, 200])
})

test('the per-meter lines carry their own previous and current readings for verification', () => {
  const [draft] = buildDraftBills([
    reading('m44', 500, 700, 'g1'), reading('m43', 1000, 1300, 'g1'),
  ], metersById, RATE)
  assert.deepEqual(draft.meters[0], {
    meterId: 'm43', meterNumber: '43', previousReading: 1000, currentReading: 1300, kwh: 300, isReset: false,
  })
})

test('a reading with no camper produces no bill, and is not an error', () => {
  const drafts = buildDraftBills([reading('m12', 100, 200, null)], metersById, RATE)
  assert.deepEqual(drafts, [], 'record-only meters are history, not bills')
})

test('separate campers get separate bills', () => {
  const drafts = buildDraftBills([
    reading('m43', 1000, 1300, 'g1'), reading('m12', 100, 200, 'g2'),
  ], metersById, RATE)
  assert.equal(drafts.length, 2)
  assert.deepEqual(drafts.map(d => d.guestId).sort(), ['g1', 'g2'])
})

test('a meter swapped mid-month does not put a wild jump into the draft bill', () => {
  const drafts = buildDraftBills([
    reading('m12', 48210, 412, 'g2', { is_meter_reset: true, reset_start_value: 0 }),
  ], metersById, RATE)
  assert.equal(drafts[0].kwhUsed, 412)
  assert.equal(drafts[0].meters[0].isReset, true, 'the bill records that this was a replacement')
})

test('one replaced meter on a double site still sums correctly with its healthy neighbour', () => {
  const drafts = buildDraftBills([
    reading('m43', 1000, 1300, 'g1'),
    reading('m44', 90000, 250, 'g1', { is_meter_reset: true, reset_start_value: 0 }),
  ], metersById, RATE)
  assert.equal(drafts[0].kwhUsed, 550, '300 from the old meter + 250 from the new one')
})

test('the order of the readings does not change the bill', () => {
  const a = buildDraftBills([reading('m43', 1000, 1300, 'g1'), reading('m44', 500, 700, 'g1')], metersById, RATE)
  const b = buildDraftBills([reading('m44', 500, 700, 'g1'), reading('m43', 1000, 1300, 'g1')], metersById, RATE)
  assert.deepEqual(a, b)
})
