import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  isSiteMeter, meterSiteKey, campersBySite, camperForMeter, resolveBillable, isMeteredTenure,
  meterWalkOrder, buildDraftBills, billableLabel,
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

test('every meter reads its own number, linked to a site or not', () => {
  assert.equal(meterSiteKey(m('12'), SITE_NUMBERS), '12')
  // ⚠ A STANDALONE READ POINT KEEPS ITS NUMBER. Cady reads meters 16, 30, 57 and 62 every cycle
  // and none has a `sites` row — they are real pitches the park does not currently BOOK.
  const standalone: Meter = { id: 'm16', meter_number: '16', site_id: null }
  assert.equal(isSiteMeter(standalone), false, 'not attached to a site')
  assert.equal(meterSiteKey(standalone, SITE_NUMBERS), '16', 'but still identified by its number')
  const bathhouse: Meter = { id: 'mb', meter_number: 'BH', site_id: null, label: 'Bathhouse' }
  assert.equal(meterSiteKey(bathhouse, SITE_NUMBERS), 'bh')
})

test('⚠ A STANDALONE METER CAN BE CREATED AND READ, and bills whoever is on its number', () => {
  // The model change. A meter is a READ POINT identified by its number; whether `sites` holds a
  // row for that number is bookkeeping about BOOKABLE INVENTORY, not about electricity.
  const standalone: Meter = { id: 'm16', meter_number: '16', site_id: null }

  // Nobody there — the ordinary case for an unbooked pitch — recorded, never billed.
  assert.deepEqual(resolve(standalone, []), { billable: false, reason: 'no-camper' })

  // ⚠ AND IF A CAMPER IS LATER PLACED THERE, IT BILLS. Under the old rule it returned
  // 'not-a-site' forever, so that camper would have been read every month and silently never
  // billed. That is the bug this removes, not a permission it grants.
  assert.deepEqual(resolve(standalone, [seasonal('g1', '16')]), { billable: true, reason: 'metered' })
  assert.deepEqual(resolve(standalone, [monthly('g2', '16')]), { billable: true, reason: 'metered' })
  // The policy still holds on a standalone meter: nightly campers are never billed.
  assert.deepEqual(resolve(standalone, [transient('g9', '16')]), { billable: false, reason: 'transient' })
})

test('a standalone meter can carry a note saying what it is (Cady meter 30 is Cabin 1)', () => {
  const cabin: Meter = { id: 'm30', meter_number: '30', site_id: null, label: 'Cabin 1' }
  assert.equal(meterSiteKey(cabin, SITE_NUMBERS), '30', 'read under its meter number, not its name')
  assert.deepEqual(resolve(cabin, []), { billable: false, reason: 'no-camper' })
})

test('the site row is the authority on the number, so a renumbered site still matches', () => {
  // Site s12 is renumbered 12A. The meter row still says "12"; the link says otherwise.
  const renumbered = new Map([['s12', '12A']])
  assert.equal(meterSiteKey(m('12'), renumbered), '12a')
})

test('a meter whose site was deleted keeps billing whoever is actually on its number', () => {
  // ⚠ THIS ASSERTION IS THE REVERSE OF WHAT IT WAS, DELIBERATELY. It expected 'not-a-site' — a
  // meter whose site row had gone was unbillable forever, on the reasoning that a deleted site
  // cannot have a camper. `guests.site_number` is free text, so it very much can: deleting a site
  // removes it from BOOKABLE INVENTORY, it does not evict anybody or unplug anything. Losing the
  // site row must not lose the bill.
  const orphan: Meter = { id: 'm12', meter_number: '12', site_id: null }
  assert.equal(isSiteMeter(orphan), false)
  assert.deepEqual(resolveBillable(orphan, seasonal('g1', '12')), { billable: true, reason: 'metered' })
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
  assert.equal(bySite.get('12')?.id, 'g1', 'one still wins, so the walk is usable')
  assert.equal(conflicts.length, 1)
  assert.equal(conflicts[0].siteNumber, '12')
  assert.deepEqual(conflicts[0].campers.map(c => c.id), ['g1', 'g2'])
})

test('⚠ a contested site resolves the SAME WAY whatever order the rows arrive in', () => {
  // Reachable now that monthly campers join the walk — an unflagged monthly camper used to be
  // filtered out and could not collide. "Who is billed for this meter" must not change between
  // page loads because PostgREST returned the rows the other way round.
  const a = campersBySite([seasonal('g1', '12'), monthly('g2', '12')])
  const b = campersBySite([monthly('g2', '12'), seasonal('g1', '12')])
  assert.equal(a.bySite.get('12')?.id, b.bySite.get('12')?.id)
  assert.deepEqual(
    a.conflicts[0].campers.map(c => c.id).sort(),
    b.conflicts[0].campers.map(c => c.id).sort(),
  )
})

test('a camper listing the same site twice is not a conflict with themselves', () => {
  const { conflicts } = campersBySite([seasonal('g1', '12, 12')])
  assert.equal(conflicts.length, 0)
})

// ── DOES IT BILL ─────────────────────────────────────────────────────────────────────────────
//
// THE PARK'S POLICY, which these tests are the executable copy of:
//   electric is billed to SEASONAL and MONTHLY campers, never to nightly ones (their power is
//   already inside their nightly rate), never to empty sites.
//
// The control is two states — Auto and "Don't bill". "Always" was removed: a bill is a charge on
// a camper's folio, so a meter with nobody on it has nothing to bill.

const monthly = (id: string, sites: string): MeterCamper =>
  ({ id, name: id, site_number: sites, is_monthly: true, electric_billing_enabled: true })
const transient = (id: string, sites: string): MeterCamper =>
  ({ id, name: id, site_number: sites, is_seasonal: false, is_monthly: false, electric_billing_enabled: false })

/** Resolve a meter against a set of campers, the way the walk does. */
function resolve(meter: Meter, campers: MeterCamper[]) {
  const { bySite } = campersBySite(campers)
  return resolveBillable(meter, camperForMeter(meter, bySite, SITE_NUMBERS))
}

test('CASE 1 — Auto + seasonal camper: bills, as it always has', () => {
  assert.deepEqual(resolve(m('12'), [seasonal('g1', '12')]), { billable: true, reason: 'metered' })
})

test('CASE 2 — Auto + MONTHLY camper: bills. This is the widening.', () => {
  // The change this refinement exists for. `is_monthly` was not read anywhere in the meter code:
  // a monthly camper who had not also been flagged for electric billing was dropped from the
  // walk entirely, and the meter reported "No seasonal camper" while somebody lived on the site.
  assert.deepEqual(resolve(m('12'), [monthly('g1', '12')]), { billable: true, reason: 'metered' })
})

test('a monthly camper is metered tenure exactly as a seasonal one is', () => {
  assert.equal(isMeteredTenure(monthly('g1', '12')), true)
  assert.equal(isMeteredTenure(seasonal('g1', '12')), true)
  assert.equal(isMeteredTenure(transient('g1', '12')), false)
  assert.equal(isMeteredTenure(null), false)
})

test('CASE 3 — Auto + transient camper: recorded, NEVER billed', () => {
  // A nightly camper's power is already inside their nightly rate. Billing the meter as well
  // charges them twice for the same electricity.
  const r = resolve(m('12'), [transient('g9', '12')])
  assert.deepEqual(r, { billable: false, reason: 'transient' })
  assert.match(billableLabel(r.reason), /nightly camper/, 'and the walk says WHY, at the meter')
})

test('a transient flagged for electric billing STILL does not bill', () => {
  // ⚠ A NARROWING, and a deliberate one. The old rule was `electric_billing_enabled === true`
  // alone, with no tenure test at all — so a nightly camper carrying that flag would have been
  // billed, against the park's policy. Tenure is now checked first.
  const flagged: MeterCamper = { id: 'g9', name: 'g9', site_number: '12', is_seasonal: false, is_monthly: false, electric_billing_enabled: true }
  assert.deepEqual(resolve(m('12'), [flagged]), { billable: false, reason: 'transient' })
})

test('CASE 4 — Auto + empty site: recorded, no bill, no camper to attach a charge to', () => {
  const r = resolve(m('12'), [])
  assert.deepEqual(r, { billable: false, reason: 'no-camper' })
  // The orphan-charge guarantee is structural: buildDraftBills() drops any reading with no
  // guest_id, so an unbilled meter cannot produce a bill with nobody on it.
  assert.deepEqual(
    buildDraftBills([{ meter_id: 'm12', previous_value: 100, reading_value: 200, guest_id: null }], metersById, RATE),
    [], 'no bill, and no error',
  )
})

test('CASE 5 — Auto + camper with electric billing switched off: named, not billed (Barnes)', () => {
  const off: MeterCamper = { id: 'g1', name: 'g1', site_number: '12', is_seasonal: true, electric_billing_enabled: false }
  assert.deepEqual(resolve(m('12'), [off]), { billable: false, reason: 'billing-off' })
})

test('a MONTHLY camper with electric billing switched off is named the same way', () => {
  // ⚠ THE COST OF REQUIRING THE FLAG, pinned so it is a decision rather than a surprise.
  // `electric_billing_enabled` is NOT NULL DEFAULT false, so "switched off on purpose" and
  // "nobody ever set it" are the same value — and the flag has to be required, because the
  // Electric Billing page populates from it alone and a draft for a camper it never lists would
  // be an invisible bill. So an unflagged monthly camper does not bill; the walk NAMES them and
  // says why, which puts the fix one toggle away instead of leaving a silent gap.
  const off: MeterCamper = { id: 'g2', name: 'g2', site_number: '12', is_monthly: true, electric_billing_enabled: false }
  const r = resolve(m('12'), [off])
  assert.deepEqual(r, { billable: false, reason: 'billing-off' })
  assert.match(billableLabel(r.reason), /electric billing is off/)
})

test("CASE 6 — Don't bill: never bills, whoever is on the site", () => {
  const dontBill = m('12', { billable_override: false })
  for (const who of [[seasonal('g1', '12')], [monthly('g2', '12')], [transient('g9', '12')], []]) {
    assert.deepEqual(resolve(dontBill, who), { billable: false, reason: 'override-off' })
  }
})

test('⚠ "Always" IS GONE — a surviving TRUE row reads as Auto, not as force-on', () => {
  // A removed value must not resurrect removed behaviour from an old row, a restored backup, or
  // a park whose migration has not run. TRUE now falls through to the ordinary Auto rules.
  const stale = m('12', { billable_override: true })
  assert.deepEqual(resolve(stale, []), { billable: false, reason: 'no-camper' },
    'forced ON with nobody there no longer claims to bill anybody')
  assert.deepEqual(resolve(stale, [transient('g9', '12')]), { billable: false, reason: 'transient' },
    'nor a nightly camper')
  assert.deepEqual(resolve(stale, [seasonal('g1', '12')]), { billable: true, reason: 'metered' },
    'and a real seasonal camper still bills, so no park loses a bill to the migration')
})

test('a common-area meter bills nobody — because nobody is on it, which is self-limiting', () => {
  // No longer a special case in the code, and it does not need to be: no camper has a site
  // number of "BH", so the ordinary camper match finds nothing. "Don't bill" stays available as
  // the explicit control for a meter that must never be charged to anyone.
  const bathhouse: Meter = { id: 'mb', meter_number: 'BH', site_id: null, label: 'Bathhouse' }
  const { bySite } = campersBySite([seasonal('g1', '12'), monthly('g2', '5')])
  assert.deepEqual(
    resolveBillable(bathhouse, camperForMeter(bathhouse, bySite, SITE_NUMBERS)),
    { billable: false, reason: 'no-camper' },
  )
  assert.deepEqual(
    resolveBillable({ ...bathhouse, billable_override: false }, null),
    { billable: false, reason: 'override-off' },
  )
})

test('every reason has a label, and none of them is empty', () => {
  for (const reason of ['override-off', 'metered', 'billing-off', 'transient', 'no-camper'] as const) {
    assert.ok(billableLabel(reason).length > 0, reason)
  }
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

test('⚠ display_order CANNOT reorder the walk — it defaults to 0 and parks half-fill it', () => {
  // The regression this pins. On the test tenant sites 10-14 sat at display_order 0 while 1-6
  // had 1-6, and an earlier version that honoured the column opened the walk on meter 10 and ran
  // 10, 11, 12, 13, 14, 1, 2, 3 — the order that makes somebody walk the park twice.
  const order = meterWalkOrder([
    m('10', { display_order: 0 }), m('11', { display_order: 0 }),
    m('1', { display_order: 1 }), m('2', { display_order: 2 }),
  ]).map(x => x.meter_number)
  assert.deepEqual(order, ['1', '2', '10', '11'])
})

test('a meter number with a letter still sorts sensibly among its neighbours', () => {
  const order = meterWalkOrder([m('A2'), m('2'), m('A10'), m('1')]).map(x => x.meter_number)
  assert.deepEqual(order, ['1', '2', 'A2', 'A10'])
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
    meterId: 'm43', meterNumber: '43', previousReading: 1000, currentReading: 1300, kwh: 300,
    isReset: false, replacedMeterFinal: null,
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
  assert.equal(drafts[0].meters[0].replacedMeterFinal, 48210, "the old meter's last number is kept")
})

test('every bill line adds up: current - previous === kwh, resets included', () => {
  // The invariant an owner checks by hand. Without the reset-aware `previousReading` this line
  // would read "48210 -> 412 = 412 kWh", which is the kind of nonsense that makes a camper
  // distrust the whole statement.
  const drafts = buildDraftBills([
    reading('m43', 1000, 1300, 'g1'),
    reading('m44', 90000, 250, 'g1', { is_meter_reset: true, reset_start_value: 0 }),
  ], metersById, RATE)
  for (const line of drafts[0].meters) {
    assert.equal(line.currentReading - line.previousReading, line.kwh,
      `line ${line.meterNumber} does not add up`)
  }
  assert.equal(drafts[0].meters.reduce((s, l) => s + l.kwh, 0), drafts[0].kwhUsed)
})

test('a replacement that did not start at zero shows the start it did have', () => {
  const drafts = buildDraftBills([
    reading('m12', 48210, 900, 'g2', { is_meter_reset: true, reset_start_value: 500 }),
  ], metersById, RATE)
  assert.equal(drafts[0].meters[0].previousReading, 500)
  assert.equal(drafts[0].kwhUsed, 400)
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
