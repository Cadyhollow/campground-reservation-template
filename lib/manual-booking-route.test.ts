// Integration tests for the booking horizon on /api/manual-booking, exercised through the REAL
// route with a REAL staff session:
//
//   node --test --test-timeout=180000 lib/manual-booking-route.test.ts
//
// WHY THIS FILE EXISTS. /api/manual-booking is the create path for every staff booking — all
// three wizards (/admin/manual-booking, /admin/new-reservation, /admin/walkin-booking) POST here
// — and until now its only route-level coverage anywhere was "it refuses an unauthenticated
// caller". lib/bookability.test.ts covers checkHorizon's arithmetic, but this route deliberately
// calls checkHorizon DIRECTLY rather than going through checkBookability, so none of those unit
// tests touch the wiring that actually runs in production. A refactor that dropped the call, or
// inverted the override, would leave every other test in the repo green.
//
// SAFETY. lib/route-test-session.ts always starts the server with an invalid SQUARE_ACCESS_TOKEN.
// This route takes no card anyway — it records a reservation and money lives in the folio — so
// nothing here can move funds.
//
// IT DOES WRITE. The accepted cases create real reservations on the test tenant, because "the
// booking succeeded" is the assertion. Every id created is tracked and deleted in after(), and
// the horizon setting is restored in a finally, so a failing assertion cannot leave the tenant
// holding either a stray booking or a window nobody configured.

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createClient } from '@supabase/supabase-js'
import type { ChildProcess } from 'node:child_process'
import { env, configured, canLogInAsStaff, logIn, startServer } from './route-test-session.ts'
import { addDays } from './bookability.ts'

const skip = !configured
  ? 'no configured Supabase project in .env.local'
  : !canLogInAsStaff
    ? 'no ADMIN_TEST_EMAIL / ADMIN_TEST_PASSWORD in .env.local'
    : false

// Its own port, so this file can coexist with the other two server-spawning suites.
const PORT = 4875
const BASE = `http://127.0.0.1:${PORT}`

let server: ChildProcess | null = null
let supabase: any
let STAFF_COOKIE = ''

// Every reservation this file creates, so after() can remove them all even if a test threw.
const created: string[] = []

before(async () => {
  if (skip) return
  supabase = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY)
  server = await startServer(PORT)
  STAFF_COOKIE = await logIn(env.ADMIN_TEST_EMAIL, env.ADMIN_TEST_PASSWORD)
}, { timeout: 130_000 })

after(async () => {
  // Cleanup first, server last — the tenant matters more than the process.
  if (supabase && created.length) {
    await supabase.from('reservation_addons').delete().in('reservation_id', created)
    await supabase.from('reservations').delete().in('id', created)
  }
  server?.kill('SIGTERM')
})

async function book(over: Record<string, any>) {
  const res = await fetch(`${BASE}/api/manual-booking`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', cookie: STAFF_COOKIE },
    body: JSON.stringify({
      num_adults: 2, num_children: 0,
      guest_name: 'Horizon Route Test', guest_email: 'horizon-test@example.invalid',
      guest_phone: '0000000000',
      camper_type: '', camper_length: 0, camper_amperage: '',
      extra_guest_fee_total: 0, addons_total: 0,
      amount_paid: 0, payment_type: 'unpaid',
      notes: 'automated test — safe to delete', addonItems: [],
      ...over,
    }),
  })
  const json: any = await res.json()
  if (json?.reservationId) created.push(json.reservationId)
  return { status: res.status, json }
}

// Sets the window, runs the body, and always puts the row back.
// EVERY GATE STATED EXPLICITLY, always. /api/manual-booking checks the horizon BEFORE the season,
// so a test that pins only one is really testing whatever the tenant happens to be configured with:
// a live booking window makes every season test fail with `beyond-horizon`, and a live season makes
// the far-future horizon tests fail with `out-of-season`.
//
// Found the hard way — a browser walk left season = April 1 to October 31 and window = 30 days on
// the sandbox, and six tests went red without a line of product code changing. Defaulting both to
// null and requiring each test to name what it wants means that cannot recur.
type Gates = { horizon?: number | null; seasonStart?: string | null; seasonEnd?: string | null }

async function withGates(gates: Gates, fn: () => Promise<void>) {
  const { data: before } = await supabase
    .from('settings').select('id, max_advance_days, season_start, season_end').limit(1).single()
  if (!before) throw new Error('no settings row on this tenant')

  await supabase.from('settings').update({
    max_advance_days: gates.horizon ?? null,
    season_start: gates.seasonStart ?? null,
    season_end: gates.seasonEnd ?? null,
  }).eq('id', before.id)

  try {
    await fn()
  } finally {
    await supabase.from('settings').update({
      max_advance_days: before.max_advance_days,
      season_start: before.season_start,
      season_end: before.season_end,
    }).eq('id', before.id)
  }
}

// Value-returning sibling, for tests that need the result back out of the wrapper.
async function withGatesValue<T>(gates: Gates, fn: () => Promise<T>): Promise<T> {
  let out!: T
  await withGates(gates, async () => { out = await fn() })
  return out
}

// Kept as thin, explicit wrappers so each test still reads as being about one gate — but both are
// always pinned underneath.
async function withHorizon(days: number | null, fn: () => Promise<void>) {
  return withGates({ horizon: days }, fn)
}

const isoPlus = (days: number) => addDays(new Date().toISOString().slice(0, 10), days)

// A site with nothing overlapping the given range. Read from the database rather than from
// /api/availability, because availability refuses to quote anything beyond the window at all —
// which is the very situation most of these tests are about.
async function freeSite(arrival: string, departure: string) {
  const { data: sites } = await supabase.from('sites').select('id, base_rate').eq('is_available', true).order('display_order')
  const { data: taken } = await supabase
    .from('reservations').select('site_id')
    .neq('status', 'cancelled').lt('arrival_date', departure).gt('departure_date', arrival)
  const busy = new Set((taken || []).map((r: any) => r.site_id))
  return (sites || []).find((s: any) => !busy.has(s.id)) || null
}

// ── THE GATE ─────────────────────────────────────────────────────────────────────────────────

test('manual-booking: an out-of-window arrival is refused for STAFF too', { skip }, async (t) => {
  await withHorizon(30, async () => {
    const arrival = isoPlus(400), departure = isoPlus(403)
    const site = await freeSite(arrival, departure)
    if (!site) return t.skip('no free site 400 days out')

    const r = await book({
      site_id: site.id, arrival_date: arrival, departure_date: departure,
      base_nightly_rate: site.base_rate, total_price: site.base_rate * 3,
    })

    // The horizon gate specifically — not an incidental 400 from something else. A test that
    // only checked the status code would pass if the route started rejecting for any reason.
    assert.equal(r.json.reason, 'beyond-horizon', `expected the horizon gate, got: ${JSON.stringify(r.json)}`)
    assert.equal(r.status, 400)
    assert.match(String(r.json.error), /30 days in advance/, 'the refusal names the park\'s own window')
    assert.equal(r.json.reservationId, undefined, 'nothing was created')
  })
})

test('manual-booking: the override lets staff book past the window', { skip }, async (t) => {
  await withHorizon(30, async () => {
    const arrival = isoPlus(400), departure = isoPlus(403)
    const site = await freeSite(arrival, departure)
    if (!site) return t.skip('no free site 400 days out')

    const r = await book({
      site_id: site.id, arrival_date: arrival, departure_date: departure,
      base_nightly_rate: site.base_rate, total_price: site.base_rate * 3,
      override_horizon: true,
    })

    assert.equal(r.json.success, true, `the override did not admit the booking: ${JSON.stringify(r.json)}`)
    assert.ok(r.json.reservationId, 'an overridden booking must actually be created')

    // It is really there, with the dates asked for — not a success response over nothing.
    const { data: row } = await supabase
      .from('reservations').select('arrival_date, status').eq('id', r.json.reservationId).single()
    assert.equal(row?.arrival_date, arrival)
    assert.equal(row?.status, 'manual')
  })
})

test('manual-booking: an in-window arrival is accepted with no override at all', { skip }, async (t) => {
  await withHorizon(30, async () => {
    const arrival = isoPlus(10), departure = isoPlus(12)
    const site = await freeSite(arrival, departure)
    if (!site) return t.skip('no free site inside the window')

    const r = await book({
      site_id: site.id, arrival_date: arrival, departure_date: departure,
      base_nightly_rate: site.base_rate, total_price: site.base_rate * 2,
    })

    assert.notEqual(r.json.reason, 'beyond-horizon', `an in-window booking was refused: ${JSON.stringify(r.json)}`)
    assert.equal(r.json.success, true, `an in-window booking failed: ${JSON.stringify(r.json)}`)
  })
})

test('manual-booking: with no window configured, a far-future staff booking needs no override', { skip }, async (t) => {
  // The provisioned state of every tenant. Proves the refusals above come from the horizon and
  // not from something else that happens to dislike distant dates.
  await withHorizon(null, async () => {
    const arrival = isoPlus(500), departure = isoPlus(502)
    const site = await freeSite(arrival, departure)
    if (!site) return t.skip('no free site 500 days out')

    const r = await book({
      site_id: site.id, arrival_date: arrival, departure_date: departure,
      base_nightly_rate: site.base_rate, total_price: site.base_rate * 2,
    })

    assert.notEqual(r.json.reason, 'beyond-horizon', `NULL horizon refused a booking: ${JSON.stringify(r.json)}`)
    assert.equal(r.json.success, true)
  })
})

// ── THE OVERRIDE'S LIMITS ────────────────────────────────────────────────────────────────────

test('manual-booking: the override waives the horizon and NOT double-booking', { skip }, async (t) => {
  // The property that makes the override safe to give staff. Waiving the park's booking-window
  // preference must not also waive the one rule that protects a guest from arriving to find
  // someone else on their site.
  await withHorizon(30, async () => {
    const arrival = isoPlus(420), departure = isoPlus(423)
    const site = await freeSite(arrival, departure)
    if (!site) return t.skip('no free site 420 days out')

    const body = {
      site_id: site.id, arrival_date: arrival, departure_date: departure,
      base_nightly_rate: site.base_rate, total_price: site.base_rate * 3,
      override_horizon: true,
    }

    const first = await book(body)
    assert.equal(first.json.success, true, `setup booking failed: ${JSON.stringify(first.json)}`)

    // Same site, same dates, override still set. The horizon is waived; the conflict is not.
    const second = await book(body)
    assert.equal(second.status, 409, `a double-booking slipped through the override: ${JSON.stringify(second.json)}`)
    assert.equal(second.json.reservationId, undefined, 'the second booking must not have been created')
  })
})

// NOT TESTED HERE, deliberately: that the acknowledgement is bound to the specific arrival date.
//
// `override_horizon` is a plain boolean on the wire, so there is nothing at this layer to bind.
// The binding lives in useHorizonOverride (app/components/HorizonOverride.tsx), which stores the
// date the operator agreed to and only reports an override when it still matches the date on
// screen — so changing the date by a day withdraws the waiver before it can be sent. That is a
// React hook, and it is browser-verified by clicking a wizard rather than by a test harness
// invented for one assertion. Asserting it here would mean asserting against a boolean this file
// sets itself, which would prove nothing about the hook.

// ─────────────────────────────────────────────────────────────────────────────────────────────
// THE CLOSED SEASON ON THE STAFF PATH
//
// The wizards had no season check at all, which is how a staff booking of October 20 to
// December 31 was taken against a season ending October 31. These drive the real route with a
// real staff session, and set/restore the season in a finally.
// ─────────────────────────────────────────────────────────────────────────────────────────────

async function withSeason(start: string | null, end: string | null, fn: () => Promise<void>) {
  return withGates({ seasonStart: start, seasonEnd: end }, fn)
}

test('manual-booking: a stay running past closing is refused for STAFF too', { skip }, async (t) => {
  await withSeason('April 1', 'October 31', async () => {
    const arrival = '2026-10-20', departure = '2026-12-31'
    const site = await freeSite(arrival, departure)
    if (!site) return t.skip('no free site for the sample range')

    const r = await book({
      site_id: site.id, arrival_date: arrival, departure_date: departure,
      base_nightly_rate: site.base_rate, total_price: site.base_rate * 72,
    })

    assert.equal(r.json.reason, 'out-of-season', `expected the season gate, got: ${JSON.stringify(r.json)}`)
    assert.equal(r.status, 400)
    assert.equal(r.json.reservationId, undefined, 'nothing was created')
  })
})

test('manual-booking: the season override lets staff book across the closure', { skip }, async (t) => {
  await withSeason('April 1', 'October 31', async () => {
    const arrival = '2026-10-20', departure = '2026-12-31'
    const site = await freeSite(arrival, departure)
    if (!site) return t.skip('no free site for the sample range')

    const r = await book({
      site_id: site.id, arrival_date: arrival, departure_date: departure,
      base_nightly_rate: site.base_rate, total_price: site.base_rate * 72,
      override_season: true,
    })

    assert.equal(r.json.success, true, `the override did not admit the booking: ${JSON.stringify(r.json)}`)
    assert.ok(r.json.reservationId, 'an overridden booking must actually be created')
  })
})

test('manual-booking: an in-season stay needs no override at all', { skip }, async (t) => {
  await withSeason('April 1', 'October 31', async () => {
    const arrival = '2026-07-06', departure = '2026-07-09'
    const site = await freeSite(arrival, departure)
    if (!site) return t.skip('no free site for the sample range')

    const r = await book({
      site_id: site.id, arrival_date: arrival, departure_date: departure,
      base_nightly_rate: site.base_rate, total_price: site.base_rate * 3,
    })

    assert.notEqual(r.json.reason, 'out-of-season', `an in-season stay was refused: ${JSON.stringify(r.json)}`)
    assert.equal(r.json.success, true)
  })
})

test('manual-booking: the checkout boundary is accepted without an override', { skip }, async (t) => {
  // Arrive on the last open day, leave the next morning: one night, October 31, which is open.
  await withSeason('April 1', 'October 31', async () => {
    const arrival = '2026-10-31', departure = '2026-11-01'
    const site = await freeSite(arrival, departure)
    if (!site) return t.skip('no free site for the boundary range')

    const r = await book({
      site_id: site.id, arrival_date: arrival, departure_date: departure,
      base_nightly_rate: site.base_rate, total_price: site.base_rate,
    })

    assert.notEqual(r.json.reason, 'out-of-season', `the checkout boundary was refused: ${JSON.stringify(r.json)}`)
    assert.equal(r.json.success, true)
  })
})

// THE WAIVER IS BOUND TO THE DATES IT WAS GIVEN FOR.
//
// The route takes a boolean, so this asserts the SERVER half of that contract: an override sent
// for one stay does not authorise a different, longer stay unless it is sent again. The browser
// half — that moving the departure clears the tick, so the flag is not sent at all — lives in
// useSeasonOverride, whose key is `arrival|departure`, and is browser-verified.
test('manual-booking: moving the departure past closing needs a fresh acknowledgement', { skip }, async (t) => {
  await withSeason('April 1', 'October 31', async () => {
    const arrival = '2026-10-25'
    const inSeason = '2026-10-30'   // wholly inside the season
    const pastClose = '2026-11-20'  // now crosses the closure

    const site = await freeSite(arrival, pastClose)
    if (!site) return t.skip('no free site for the sample range')

    // The short stay needs no override, and the operator never ticks anything.
    const short = await book({
      site_id: site.id, arrival_date: arrival, departure_date: inSeason,
      base_nightly_rate: site.base_rate, total_price: site.base_rate * 5,
    })
    assert.equal(short.json.success, true, `the in-season stay should book: ${JSON.stringify(short.json)}`)

    // Same arrival, departure dragged past closing, and NO override — because the hook would have
    // withdrawn it when the date changed. The route must refuse.
    const stretched = await book({
      site_id: site.id, arrival_date: arrival, departure_date: pastClose,
      base_nightly_rate: site.base_rate, total_price: site.base_rate * 26,
    })
    assert.equal(stretched.json.reason, 'out-of-season',
      `a stay stretched past closing was accepted without a fresh acknowledgement: ${JSON.stringify(stretched.json)}`)
    assert.equal(stretched.json.reservationId, undefined, 'nothing was created')
  })
})

test('manual-booking: the season override waives the season and NOT double-booking', { skip }, async (t) => {
  // The invariant that keeps every override safe. Waiving a closure must not also waive the one
  // rule that stops two guests being sold the same site.
  await withSeason('April 1', 'October 31', async () => {
    const arrival = '2026-11-10', departure = '2026-11-14'
    const site = await freeSite(arrival, departure)
    if (!site) return t.skip('no free site for the sample range')

    const body = {
      site_id: site.id, arrival_date: arrival, departure_date: departure,
      base_nightly_rate: site.base_rate, total_price: site.base_rate * 4,
      override_season: true,
    }

    const first = await book(body)
    assert.equal(first.json.success, true, `setup booking failed: ${JSON.stringify(first.json)}`)

    const second = await book(body)
    assert.equal(second.status, 409, `a double-booking slipped through the season override: ${JSON.stringify(second.json)}`)
    assert.equal(second.json.reservationId, undefined, 'the second booking must not have been created')
  })
})

test('manual-booking: the two overrides are separate — season does not waive the horizon', { skip }, async (t) => {
  // Different rules, different severities, different flags. An operator who accepted a closure
  // has not thereby accepted booking years ahead.
  await withGates({ horizon: 30, seasonStart: 'April 1', seasonEnd: 'October 31' }, async () => {
    const arrival = isoPlus(400), departure = addDays(isoPlus(400), 2)
    const site = await freeSite(arrival, departure)
    if (!site) return t.skip('no free site 400 days out')

    const r = await book({
      site_id: site.id, arrival_date: arrival, departure_date: departure,
      base_nightly_rate: site.base_rate, total_price: site.base_rate * 2,
      override_season: true, // season waived, horizon NOT
    })

    assert.equal(r.json.reason, 'beyond-horizon',
      `the season override wrongly waived the booking window: ${JSON.stringify(r.json)}`)
  })
})

// ─────────────────────────────────────────────────────────────────────────────────────────────
// PETS ON THE STAFF PATH
//
// This is the only route that INSERTS a reservation without a card, so it is where the four
// pet columns can actually be proven to persist.
//
// DATES ARE FAR OUT (600+ days) and stepped, deliberately: the horizon and season tests above
// create real reservations in the near future on the same sites, and a pet test landing on one of
// those dates fails as a double-booking rather than for anything to do with pets. It also carries the staff site override —
// the known-guest exception — which the public path must never honour.
// ─────────────────────────────────────────────────────────────────────────────────────────────

const PET_SETTINGS = {
  pets_enabled: true, pet_fee_amount: 2500,
  pet_fee_per_night: false, pet_fee_per_pet: true,
  pet_max: 2, pet_rules_text: 'Pets must be leashed.',
  pet_rules_require_affirmation: false,
  pet_fee_taxable: false, pet_fee_surcharged: false, service_animal_allowed: true,
}

async function withPets<T>(
  over: Record<string, unknown>,
  fn: (s: { petSite: string; noPetSite: string }) => Promise<T>,
): Promise<T | 'no-pet-columns'> {
  const { data: before } = await supabase.from('settings').select('*').limit(1).single()
  if (!before || !('pets_enabled' in before)) return 'no-pet-columns'
  const { data: sites } = await supabase
    .from('sites').select('id, pet_friendly').eq('is_available', true).order('display_order')
  if (!sites || sites.length < 2) return 'no-pet-columns'
  const petSite = sites[0].id, noPetSite = sites[1].id
  const prior = sites.map((x: { id: string; pet_friendly: boolean }) => [x.id, x.pet_friendly] as const)

  await supabase.from('settings').update({ ...PET_SETTINGS, ...over }).eq('id', before.id)
  await supabase.from('sites').update({ pet_friendly: true }).eq('id', petSite)
  await supabase.from('sites').update({ pet_friendly: false }).eq('id', noPetSite)
  try {
    return await fn({ petSite, noPetSite })
  } finally {
    const restore: Record<string, unknown> = {}
    for (const k of Object.keys(PET_SETTINGS)) restore[k] = (before as Record<string, unknown>)[k]
    await supabase.from('settings').update(restore).eq('id', before.id)
    for (const [id, flag] of prior) await supabase.from('sites').update({ pet_friendly: flag }).eq('id', id)
  }
}

test('manual-booking: the pet fee and count are STORED, computed by the server', { skip }, async (t) => {
  const out = await withPets({}, async ({ petSite }) => {
    return withGatesValue({ horizon: null }, async () => {
      const arrival = isoPlus(600), departure = isoPlus(602)
      // The body claims a nonsense pet_fee. The route must ignore it and derive its own.
      const r = await book({
        site_id: petSite, arrival_date: arrival, departure_date: departure,
        base_nightly_rate: 5000, total_price: 10000,
        pet_count: 2, pet_fee: 999999, is_service_animal: false,
      })
      if (!r.json.reservationId) return { r, row: null }
      const { data: row } = await supabase
        .from('reservations')
        .select('pet_count, pet_fee, pet_rules_affirmed_at, is_service_animal')
        .eq('id', r.json.reservationId).single()
      return { r, row }
    })
  })
  if (out === 'no-pet-columns') return t.skip('tenant has no pet columns')
  assert.equal(out.r.status, 200, `booking failed: ${JSON.stringify(out.r.json)}`)
  assert.ok(out.row, 'no reservation row')
  assert.equal(out.row!.pet_count, 2)
  assert.equal(out.row!.pet_fee, 5000, 'the server must compute 2 x $25, not trust the body')
  assert.equal(out.row!.is_service_animal, false)
  assert.equal(out.row!.pet_rules_affirmed_at, null, 'no affirmation was required, so none is stamped')
})

test('manual-booking: the affirmation timestamp is stamped when the park requires one', { skip }, async (t) => {
  const out = await withPets({ pet_rules_require_affirmation: true }, async ({ petSite }) => {
    return withGatesValue({ horizon: null }, async () => {
      const r = await book({
        site_id: petSite, arrival_date: isoPlus(603), departure_date: isoPlus(605),
        base_nightly_rate: 5000, total_price: 10000,
        pet_count: 1, pet_rules_affirmed: true,
      })
      if (!r.json.reservationId) return { r, row: null }
      const { data: row } = await supabase.from('reservations')
        .select('pet_count, pet_rules_affirmed_at').eq('id', r.json.reservationId).single()
      return { r, row }
    })
  })
  if (out === 'no-pet-columns') return t.skip('tenant has no pet columns')
  assert.equal(out.r.status, 200, `booking failed: ${JSON.stringify(out.r.json)}`)
  assert.ok(out.row!.pet_rules_affirmed_at, 'the affirmation should have been stamped')
})

test('manual-booking: staff are refused over the cap, and without a required affirmation', { skip }, async (t) => {
  const out = await withPets({ pet_max: 2, pet_rules_require_affirmation: true }, async ({ petSite }) => {
    return withGatesValue({ horizon: null }, async () => {
      const overCap = await book({
        site_id: petSite, arrival_date: isoPlus(606), departure_date: isoPlus(608),
        base_nightly_rate: 5000, total_price: 10000, pet_count: 5, pet_rules_affirmed: true,
      })
      const noAffirm = await book({
        site_id: petSite, arrival_date: isoPlus(609), departure_date: isoPlus(611),
        base_nightly_rate: 5000, total_price: 10000, pet_count: 1,
      })
      return { overCap, noAffirm }
    })
  })
  if (out === 'no-pet-columns') return t.skip('tenant has no pet columns')
  assert.equal(out.overCap.json.reason, 'pet-max')
  assert.equal(out.noAffirm.json.reason, 'pet-rules')
})

test('manual-booking: the site override is the known-guest exception, and waives ONLY that', { skip }, async (t) => {
  const out = await withPets({ pet_max: 1 }, async ({ noPetSite }) => {
    return withGatesValue({ horizon: null }, async () => {
      // Refused without it...
      const refused = await book({
        site_id: noPetSite, arrival_date: isoPlus(612), departure_date: isoPlus(614),
        base_nightly_rate: 5000, total_price: 10000, pet_count: 1,
      })
      // ...allowed with it...
      const allowed = await book({
        site_id: noPetSite, arrival_date: isoPlus(615), departure_date: isoPlus(617),
        base_nightly_rate: 5000, total_price: 10000, pet_count: 1, override_pet_site: true,
      })
      // ...but it is not a skeleton key: the cap still bites.
      const stillCapped = await book({
        site_id: noPetSite, arrival_date: isoPlus(618), departure_date: isoPlus(620),
        base_nightly_rate: 5000, total_price: 10000, pet_count: 4, override_pet_site: true,
      })
      return { refused, allowed, stillCapped }
    })
  })
  if (out === 'no-pet-columns') return t.skip('tenant has no pet columns')
  assert.equal(out.refused.json.reason, 'pet-site')
  assert.equal(out.allowed.status, 200, `override did not work: ${JSON.stringify(out.allowed.json)}`)
  assert.equal(out.stillCapped.json.reason, 'pet-max', 'the override must not waive the cap')
})

test('manual-booking: a service animal is stored as such, free, and on any site', { skip }, async (t) => {
  const out = await withPets({ pet_max: 1, pet_rules_require_affirmation: true }, async ({ noPetSite }) => {
    return withGatesValue({ horizon: null }, async () => {
      const r = await book({
        site_id: noPetSite, arrival_date: isoPlus(621), departure_date: isoPlus(623),
        base_nightly_rate: 5000, total_price: 10000,
        pet_count: 1, is_service_animal: true,   // no affirmation, non-pet site, over the cap
      })
      if (!r.json.reservationId) return { r, row: null }
      const { data: row } = await supabase.from('reservations')
        .select('pet_count, pet_fee, is_service_animal').eq('id', r.json.reservationId).single()
      return { r, row }
    })
  })
  if (out === 'no-pet-columns') return t.skip('tenant has no pet columns')
  assert.equal(out.r.status, 200, `service animal refused: ${JSON.stringify(out.r.json)}`)
  assert.equal(out.row!.is_service_animal, true)
  assert.equal(out.row!.pet_fee, 0, 'a service animal must be free')
  assert.equal(out.row!.pet_count, 0, 'a service animal is not a pet')
})
