// Integration tests for the /api/payment chokepoint, exercised through the REAL route, served
// by a real Next server:
//
//   node --test --test-timeout=180000 lib/payment-route.test.ts
//
// lib/bookability.test.ts covers the pure arithmetic. These cover what that arithmetic cannot:
// that the payment route actually CALLS the check, with the right arguments, and returns before
// reaching Square. A refactor that dropped the call, passed the wrong site, or moved the check
// below the charge would leave every pure unit test green — so the unit tests alone cannot
// protect the money. These can, because they drive the route end to end.
//
// WHY THIS FILE EXISTS: the first real-card test of this feature was reported as a double-
// booking that got charged. It turned out not to be one — the booking landed on a genuinely
// free site — but nothing in the suite could have told us that, and answering it took a
// database forensic. A route-level test that can be run in seconds is the thing that was
// missing.
//
// SAFETY. The server is started with SQUARE_ACCESS_TOKEN deliberately invalid, so no request
// this file makes can charge a card even if every gate failed at once. That also gives a clean
// discriminator, since the route's own response tells us which side of Square it stopped on:
//
//   - gated  -> our JSON with a `reason` field; Square was never contacted
//   - charged -> Square's "This request could not be authorized."; the gate let it through
//
// A rejected booking returns before the database insert, and an accepted one dies at the
// invalid Square call, which is also before the insert. So nothing is ever written.
//
// Needs a CONFIGURED Supabase project in .env.local, and data to exercise: a park with no
// bookings has no double-booking to refuse. Both are treated as skips rather than failures, so
// an unconfigured template checkout reports "skipped", never a false red.

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { spawn, type ChildProcess } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, resolve as resolvePath } from 'node:path'
import { createClient } from '@supabase/supabase-js'
import { fetchDateFacts, checkDateFacts, checkSeason } from './bookability.ts'

const REPO_ROOT = resolvePath(dirname(fileURLToPath(import.meta.url)), '..')
const ENV_PATH = resolvePath(REPO_ROOT, '.env.local')

const env: Record<string, string> = {}
if (existsSync(ENV_PATH)) {
  for (const line of readFileSync(ENV_PATH, 'utf8').split('\n')) {
    if (!line.includes('=') || line.trim().startsWith('#')) continue
    env[line.slice(0, line.indexOf('=')).trim()] = line.slice(line.indexOf('=') + 1).trim()
  }
}

// The template repo ships a .env.local of PLACEHOLDERS, so the file existing proves nothing —
// pointing these tests at "https://YOUR_PROJECT_REF.supabase.co" would hang rather than skip.
// A configured project is one with a real-looking URL and a service-role key.
const placeholder = (v: string | undefined) =>
  !v || /YOUR_|EXAMPLE|CHANGEME|xxxx/i.test(v)
const configured =
  !placeholder(env.NEXT_PUBLIC_SUPABASE_URL) &&
  /^https:\/\/[a-z0-9]+\.supabase\./i.test(env.NEXT_PUBLIC_SUPABASE_URL || '') &&
  !placeholder(env.SUPABASE_SERVICE_ROLE_KEY)

const haveEnv = configured
const skip = configured ? false : 'no configured Supabase project in .env.local'

// A high, unusual port so a developer's own `next dev` on 3000 is never disturbed.
const PORT = 4873
const BASE = `http://127.0.0.1:${PORT}`

let server: ChildProcess | null = null
let supabase: any

before(async () => {
  if (!haveEnv) return
  supabase = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY)

  server = spawn('npx', ['next', 'dev', '-p', String(PORT)], {
    cwd: REPO_ROOT,
    // THE SAFETY INTERLOCK: no request from this file can result in a charge.
    env: { ...process.env, ...env, SQUARE_ACCESS_TOKEN: 'INVALID_TOKEN_FOR_TESTING' },
    stdio: 'ignore',
  })

  const deadline = Date.now() + 120_000
  for (;;) {
    try {
      // Any response at all means the server is listening.
      await fetch(`${BASE}/api/availability?arrival=2026-08-18&departure=2026-08-20`)
      return
    } catch {
      if (Date.now() > deadline) throw new Error('next dev did not come up in time')
      await new Promise(r => setTimeout(r, 500))
    }
  }
}, { timeout: 130_000 })

after(() => { server?.kill('SIGTERM') })

async function post(over: Record<string, any>) {
  const res = await fetch(`${BASE}/api/payment`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      sourceId: 'FAKE-NONCE-MUST-NEVER-BE-CHARGEABLE',
      adults: 2, children: 0,
      guestName: 'Automated Test', guestEmail: 'test@example.invalid', guestPhone: '0000000000',
      nightlyRate: 5000, totalPrice: 15000, amountToPay: 15000, paymentType: 'full', nights: 3,
      ...over,
    }),
  })
  const json: any = await res.json()
  return {
    status: res.status,
    json,
    // The route only ever emits `reason` from the bookability gate, and the gate is the only
    // thing above the Square call. Its presence therefore proves Square was not contacted.
    gated: typeof json?.reason === 'string',
  }
}

// The site+dates of a real non-cancelled reservation whose site is NOT also blocked, so the
// assertion is specifically about the overlap check rather than the blocked-date check that
// runs before it.
async function anExistingReservation() {
  const { data } = await supabase
    .from('reservations')
    .select('site_id, arrival_date, departure_date')
    .neq('status', 'cancelled')
    .gte('arrival_date', '2026-01-01')
    .order('arrival_date')
    .limit(60)
  for (const r of data || []) {
    const { data: blocks } = await supabase
      .from('blocked_dates').select('site_id')
      .gte('date', r.arrival_date).lt('date', r.departure_date)
    if (!(blocks || []).some((b: any) => !b.site_id || b.site_id === r.site_id)) return r
  }
  return null
}

// THE REGRESSION GUARD. The case the first real-card test was meant to cover.
test('payment: an overlapping booking is refused, and never reaches Square', { skip }, async (t) => {
  const existing = await anExistingReservation()
  // A park with no bookings yet has nothing to double-book. Skip rather than fail: this is a
  // missing fixture, not a broken gate. Visible in the output either way.
  if (!existing) return t.skip('no non-cancelled reservation on an unblocked site to test against')

  const r = await post({
    siteId: existing.site_id,
    arrival: existing.arrival_date,
    departure: existing.departure_date,
  })

  assert.ok(r.gated, `double-booking reached Square instead of being refused: ${JSON.stringify(r.json)}`)
  assert.equal(r.json.reason, 'double-booked')
  assert.equal(r.status, 409, 'a double-booking is a 409 — someone got there first')
})

test('payment: an out-of-season booking is refused, and never reaches Square', { skip }, async (t) => {
  const { data: settings } = await supabase.from('settings').select('season_start, season_end').limit(1).single()
  if (!settings?.season_start || !settings?.season_end) return t.skip('no season configured')

  const { data: site } = await supabase.from('sites').select('id').eq('is_available', true).limit(1).single()
  const r = await post({ siteId: site.id, arrival: '2026-12-20', departure: '2026-12-23' })

  assert.ok(r.gated, `out-of-season booking reached Square: ${JSON.stringify(r.json)}`)
  assert.equal(r.json.reason, 'out-of-season')
  assert.equal(r.status, 400)
})

test('payment: a blocked date is refused, and never reaches Square', { skip }, async (t) => {
  const { data: blocks } = await supabase
    .from('blocked_dates').select('site_id, date').not('site_id', 'is', null)
    .gte('date', '2026-05-01').lte('date', '2026-10-01').order('date').limit(1)
  if (!blocks?.length) return t.skip('no per-site blocked dates configured')

  const b = blocks[0]
  const departure = new Date(Date.parse(`${b.date}T12:00:00Z`) + 86400000).toISOString().slice(0, 10)
  const r = await post({ siteId: b.site_id, arrival: b.date, departure, nights: 1 })

  assert.ok(r.gated, `blocked date reached Square: ${JSON.stringify(r.json)}`)
  assert.equal(r.json.reason, 'blocked')
  assert.equal(r.status, 400)
})

test('payment: a malformed range is refused, and never reaches Square', { skip }, async () => {
  const { data: site } = await supabase.from('sites').select('id').eq('is_available', true).limit(1).single()
  const r = await post({ siteId: site.id, arrival: '2026-08-13', departure: '2026-08-10' })

  assert.ok(r.gated, `malformed range reached Square: ${JSON.stringify(r.json)}`)
  assert.equal(r.json.reason, 'invalid-range')
})

// The counterpart that makes all of the above meaningful: a genuinely bookable request must get
// PAST the chokepoint. Without this, a gate that rejected everything would pass every test here
// — and "no false rejections" is the property that keeps real guests able to book.
//
// It stops at Square, which is the evidence we want: the route got as far as attempting
// payment, so nothing above it turned a legitimate booking away. The invalid token means no
// card is charged, and the reservation insert is downstream of a successful charge, so nothing
// is written.
test('payment: a legitimate booking is NOT refused — it reaches the charge', { skip }, async (t) => {
  const arrival = '2026-08-18', departure = '2026-08-20'
  const { data: sites } = await supabase.from('sites').select('id').eq('is_available', true)
  const facts = await fetchDateFacts(supabase, arrival, departure)
  const free = (sites || []).find((s: any) => checkDateFacts(s.id, facts).bookable)
  if (!free) return t.skip('no free site in the sample week — nothing to prove the negative with')
  // The season must actually contain the sample week, or this asserts the wrong thing.
  const { data: st } = await supabase.from('settings').select('season_start, season_end').limit(1).single()
  if (st?.season_start && st?.season_end && !checkSeason(arrival, st).bookable) {
    return t.skip('sample week falls outside the configured season')
  }

  const r = await post({ siteId: free.id, arrival, departure, nights: 2 })

  assert.equal(r.gated, false, `a legitimate booking was wrongly refused: ${JSON.stringify(r.json)}`)
  assert.match(String(r.json.error), /authoriz/i, 'expected to die at the deliberately invalid Square token')
})

// ─────────────────────────────────────────────────────────────────────────────────────────────
// THE BOOKING HORIZON
//
// The horizon is a setting, so unlike the season and the blocked dates there is nothing to find
// in the tenant's data to test against — these tests SET one, exercise the route, and put the
// row back. Restored in a finally, so a failing assertion cannot leave the test tenant with a
// booking window nobody configured.
// ─────────────────────────────────────────────────────────────────────────────────────────────

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

const isoPlus = (days: number) =>
  new Date(Date.now() + days * 86400000).toISOString().slice(0, 10)

async function aFreeSite(arrival: string, departure: string) {
  const { data: sites } = await supabase.from('sites').select('id').eq('is_available', true)
  const facts = await fetchDateFacts(supabase, arrival, departure)
  return (sites || []).find((s: any) => checkDateFacts(s.id, facts).bookable) || null
}

// THE CRAFTED REQUEST. The whole reason the horizon cannot live in the browser.
//
// This skips the search and the date picker completely and posts the booking straight at the
// route, exactly as a hand-edited request or a doctored /book URL would. Greying out days in a
// calendar stops none of this; only the server does.
test('payment: a booking far beyond the horizon is refused, and never reaches Square', { skip }, async (t) => {
  await withHorizon(30, async () => {
    const arrival = isoPlus(400), departure = isoPlus(403)
    const site = await aFreeSite(arrival, departure)
    if (!site) return t.skip('no free site 400 days out')

    const r = await post({ siteId: site.id, arrival, departure, nights: 3 })

    assert.ok(r.gated, `a booking 400 days out reached Square with a 30-day horizon: ${JSON.stringify(r.json)}`)
    assert.equal(r.json.reason, 'beyond-horizon')
    assert.equal(r.status, 400, 'never bookable in the first place, so 400 rather than 409')
  })
})

// The boundary, through the real route. The off-by-one most likely to ship: the calendar offers
// today+N and the server must honour it.
test('payment: the last day inside the horizon is NOT refused', { skip }, async (t) => {
  await withHorizon(30, async () => {
    const arrival = isoPlus(30), departure = isoPlus(32)
    const site = await aFreeSite(arrival, departure)
    if (!site) return t.skip('no free site on the horizon boundary')
    const { data: st } = await supabase.from('settings').select('season_start, season_end').limit(1).single()
    if (st?.season_start && st?.season_end && !checkSeason(arrival, st).bookable) {
      return t.skip('the boundary date falls outside the configured season')
    }

    const r = await post({ siteId: site.id, arrival, departure, nights: 2 })

    assert.notEqual(r.json.reason, 'beyond-horizon', `the boundary day was wrongly refused: ${JSON.stringify(r.json)}`)
  })
})

// The property that makes the whole feature safe to roll out: with no window configured — the
// provisioned state of every tenant — the route behaves exactly as it did before the column
// existed.
test('payment: with no horizon configured, a far-future booking is not refused for it', { skip }, async (t) => {
  await withHorizon(null, async () => {
    const arrival = isoPlus(400), departure = isoPlus(403)
    const site = await aFreeSite(arrival, departure)
    if (!site) return t.skip('no free site 400 days out')
    const { data: st } = await supabase.from('settings').select('season_start, season_end').limit(1).single()
    if (st?.season_start && st?.season_end && !checkSeason(arrival, st).bookable) {
      return t.skip('the sample date falls outside the configured season')
    }

    const r = await post({ siteId: site.id, arrival, departure, nights: 3 })

    assert.notEqual(r.json.reason, 'beyond-horizon', `NULL horizon refused a booking: ${JSON.stringify(r.json)}`)
  })
})

// The search path must agree with the create path. If search were STRICTER, a guest could find
// nothing available on a date the route would happily charge for; if it were looser, they would
// pick a site and be refused at the end.
test('availability: the search reports the horizon on the same dates the route refuses', { skip }, async () => {
  await withHorizon(30, async () => {
    const beyond = isoPlus(400)
    const res = await fetch(`${BASE}/api/availability?arrival=${beyond}&departure=${isoPlus(403)}`)
    const json: any = await res.json()
    assert.equal(json.outOfWindow, true, `search did not report the window: ${JSON.stringify(json)}`)
    assert.equal(json.closed, false, 'out-of-window is not the same fact as closed-for-season')
    assert.ok(Array.isArray(json.sites) && json.sites.length === 0, 'no sites are offered beyond the window')

    const inside = isoPlus(10)
    const res2 = await fetch(`${BASE}/api/availability?arrival=${inside}&departure=${isoPlus(12)}`)
    const json2: any = await res2.json()
    assert.notEqual(json2.outOfWindow, true, `search wrongly reported the window inside it: ${JSON.stringify(json2)}`)
  })
})
