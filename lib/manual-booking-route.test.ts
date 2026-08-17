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
async function withHorizon(days: number | null, fn: () => Promise<void>) {
  const { data: before } = await supabase.from('settings').select('id, max_advance_days').limit(1).single()
  if (!before) throw new Error('no settings row on this tenant')
  await supabase.from('settings').update({ max_advance_days: days }).eq('id', before.id)
  try {
    await fn()
  } finally {
    await supabase.from('settings').update({ max_advance_days: before.max_advance_days }).eq('id', before.id)
  }
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
