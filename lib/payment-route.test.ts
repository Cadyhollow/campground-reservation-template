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
import { fetchDateFacts, checkDateFacts, isNightInSeason, addDays } from './bookability.ts'
// READ-ONLY here. The fee-configured test below runs the browser's arithmetic so it can post the
// figures /book would post; it does not modify the quote, and this file is not fee-model code.
import { computeBookingQuote } from './booking-quote.ts'
import { computePetFee } from './pet-fee.ts'

const REPO_ROOT = resolvePath(dirname(fileURLToPath(import.meta.url)), '..')
const ENV_PATH = resolvePath(REPO_ROOT, '.env.local')

const env: Record<string, string> = {}
if (existsSync(ENV_PATH)) {
  for (const line of readFileSync(ENV_PATH, 'utf8').split('\n')) {
    if (!line.includes('=') || line.trim().startsWith('#')) continue
    // Surrounding quotes are stripped, because .env files legitimately carry them and Next.js
    // strips them when it loads the same file — so a quoted value works in the app. Without this
    // the value here keeps its quotes, the anchored URL check below fails, and EVERY test in this
    // file reports SKIP against a perfectly good project. A safety suite that quietly opts itself
    // out on a formatting detail is worse than one that fails: the run is green either way.
    const rawValue = line.slice(line.indexOf('=') + 1).trim()
    const value = /^(["']).*\1$/.test(rawValue) ? rawValue.slice(1, -1) : rawValue
    env[line.slice(0, line.indexOf('=')).trim()] = value
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

  // Horizon pinned off: an existing reservation can sit any distance in the future, so a tenant
  // with a booking window would refuse this for the wrong reason.
  await withHorizon(null, async () => {
    const r = await post({
      siteId: existing.site_id,
      arrival: existing.arrival_date,
      departure: existing.departure_date,
    })

    assert.ok(r.gated, `double-booking reached Square instead of being refused: ${JSON.stringify(r.json)}`)
    assert.equal(r.json.reason, 'double-booked')
    assert.equal(r.status, 409, 'a double-booking is a 409 — someone got there first')
  })
})

test('payment: an out-of-season booking is refused, and never reaches Square', { skip }, async (t) => {
  const { data: settings } = await supabase.from('settings').select('season_start, season_end').limit(1).single()
  if (!settings?.season_start || !settings?.season_end) return t.skip('no season configured')

  // The sample date has to be one the CONFIGURED season actually excludes. This used to hardcode
  // a December date and assume every park runs a summer season; a tenant configured January 1 to
  // December 31 is open year-round, so that date was in season, the gate correctly let it by, and
  // the assertion failed against working code. Find a genuinely excluded date instead, and skip
  // honestly when the park never closes.
  const excluded = ['2026-12-20', '2026-01-15', '2026-03-05', '2026-07-04', '2026-10-28']
    .find(d => isNightInSeason(d, settings) === false)
  if (!excluded) return t.skip('this park is open year-round — no out-of-season date to test with')

  const { data: site } = await supabase.from('sites').select('id').eq('is_available', true).limit(1).single()
  const departure = addDays(excluded, 3)

  // Horizon pinned off: an out-of-season date is usually months away, so a live booking window
  // rejects it as `beyond-horizon` before the season is ever consulted.
  await withHorizon(null, async () => {
    const r = await post({ siteId: site.id, arrival: excluded, departure })

    assert.ok(r.gated, `out-of-season booking reached Square: ${JSON.stringify(r.json)}`)
    assert.equal(r.json.reason, 'out-of-season')
    assert.equal(r.status, 400)
  })
})

test('payment: a blocked date is refused, and never reaches Square', { skip }, async (t) => {
  const { data: blocks } = await supabase
    .from('blocked_dates').select('site_id, date').not('site_id', 'is', null)
    .gte('date', '2026-05-01').lte('date', '2026-10-01').order('date').limit(1)
  if (!blocks?.length) return t.skip('no per-site blocked dates configured')

  const b = blocks[0]
  const departure = new Date(Date.parse(`${b.date}T12:00:00Z`) + 86400000).toISOString().slice(0, 10)

  // Horizon pinned off, same reason: a blocked date can be any distance out.
  await withHorizon(null, async () => {
    const r = await post({ siteId: b.site_id, arrival: b.date, departure, nights: 1 })

    assert.ok(r.gated, `blocked date reached Square: ${JSON.stringify(r.json)}`)
    assert.equal(r.json.reason, 'blocked')
    assert.equal(r.status, 400)
  })
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
  if (isNightInSeason(arrival, st) === false) {
    return t.skip('sample week falls outside the configured season')
  }

  // THE QUOTE COMES FROM THE SERVER, exactly as the booking page's does.
  //
  // This used to post the `post()` helper's hardcoded nightlyRate/totalPrice. That was fine when
  // the file was written, and stopped being fine when security PR 4a made the server authoritative
  // on price: the route now recomputes the quote and refuses anything that disagrees, so the
  // made-up figures were rejected with `price-mismatch` before Square was ever reached. The test
  // had been reporting SKIP since long before that landed, so the rot was invisible.
  //
  // Asking /api/availability for the price is what the real flow does, and it keeps this test
  // honest about what it is proving: that the DATE gates do not refuse a legitimate booking.
  const quoteRes = await fetch(`${BASE}/api/availability?arrival=${arrival}&departure=${departure}`)
  const quote: any = await quoteRes.json()
  const priced = (quote.sites || []).find((s: any) => s.id === free.id)
  if (!priced) return t.skip('the search did not offer the free site — nothing to price against')

  // Horizon pinned off here too. This test asserts that NO gate refused a legitimate booking, so
  // a tenant with a short window would fail it for a reason that has nothing to do with what it
  // is checking.
  const r = await withHorizonValue(null, () => post({
    siteId: free.id,
    arrival,
    departure,
    nights: priced.nights,
    nightlyRate: priced.nightly_rate,
    totalPrice: priced.total_price,
    amountToPay: priced.total_price,
  }))

  // WHAT THIS PROVES, precisely: no gate above the payment step refused a legitimate booking.
  //
  // It used to assert `gated === false` and then match Square's own "could not be authorized"
  // error. Both have rotted, and neither rot was visible while this file was skipping:
  //
  //   * `gated` is "the response carries a `reason`", which was a sound proxy for "one of our
  //     gates stopped it" only while the gates were the only things emitting one. Square steps
  //     7-8 added `square-unavailable` from the credential resolver, which also carries a reason.
  //   * the Square error itself only appeared while the access token came from the environment.
  //     The resolver now reads per-tenant credentials, so in an environment with no SQUARE_*
  //     variables it fails before Square is contacted and the authorization error never happens.
  //
  // So assert the thing that actually matters and does not depend on either: the refusal, if any,
  // is NOT one of the gates. A false rejection by the date gates or the pricing guard fails this;
  // an unreachable payment provider does not, because that is downstream of everything this file
  // is about, and the invalid token means no card could be charged either way.
  const GATE_REASONS = [
    'missing-dates', 'invalid-range', 'beyond-horizon', 'out-of-season',
    'blocked', 'double-booked', 'min-stay', 'price-mismatch', 'discount-invalid',
  ]
  assert.ok(
    !GATE_REASONS.includes(r.json.reason),
    `a legitimate booking was wrongly refused by a gate: ${JSON.stringify(r.json)}`
  )
  // And it did get as far as trying to pay, rather than quietly succeeding without a charge.
  assert.ok(
    /authoriz/i.test(String(r.json.error)) || r.json.reason === 'square-unavailable',
    `expected to reach the payment step, got: ${JSON.stringify(r.json)}`
  )
})

// ─────────────────────────────────────────────────────────────────────────────────────────────
// A TENANT THAT HAS CONFIGURED FEES
//
// The test above sources its price from /api/availability, which is honest about the real flow
// but has one blind spot: it can only prove what the tenant's own data exercises, and every
// tenant is provisioned with NO `fees` rows. So on a fresh tenant the search and the checkout
// agree trivially, and the arithmetic that only runs when a fee exists is never touched.
//
// That blind spot hid a live defect. /api/availability returned `total_price` with fees already
// inside it; HomeClient put that in the /book URL; BookingForm took it as the stay base and
// lib/booking-quote.ts applied every fee to it a SECOND time. /api/payment derives its base as
// nightlyRate x nights with no fees, so the two disagreed and the pricing chokepoint answered
// "Pricing has changed since this page was loaded" — the first owner to add a tax row could take
// no online booking at all. It also read a flat fee's DOLLARS as cents.
//
// This test closes the blind spot the only way it can be closed: by giving the tenant fees of
// both kinds for the duration of the test, running the real browser path against them, and
// putting the rows back afterwards.
// ─────────────────────────────────────────────────────────────────────────────────────────────

// The subset of a /api/availability site row these assertions read.
type PricedSite = {
  id: string
  site_type: string
  nightly_rate: number
  nights: number
  base_price: number
  fees_total: number
  extra_guest_fee: number
  total_price: number
  fees_breakdown?: Array<{ name: string; type: string; amount: number }>
}

// 2 adults + 2 children included; $15 per extra adult per night, $7.50 per extra child per night.
// Pinned rather than read so the assertions below can state exact figures.
const BASE_OCCUPANCY = {
  base_occupancy_adults: 2,
  base_occupancy_children: 2,
  extra_adult_fee: 1500,
  extra_child_fee: 750,
}

// Pins the occupancy settings the extra-guest fee is computed from, and puts them back. Same
// shape as withHorizon() below, and for the same reason: these tests assert an exact number, so
// they must not depend on whatever the tenant happens to have configured.
async function withOccupancy<T>(
  occ: {
    base_occupancy_adults: number
    base_occupancy_children: number
    extra_adult_fee: number
    extra_child_fee: number
  },
  fn: () => Promise<T>,
): Promise<T> {
  const { data: before } = await supabase
    .from('settings')
    .select('id, base_occupancy_adults, base_occupancy_children, extra_adult_fee, extra_child_fee')
    .limit(1).single()
  if (!before) throw new Error('no settings row on this tenant')
  await supabase.from('settings').update(occ).eq('id', before.id)
  try {
    return await fn()
  } finally {
    await supabase.from('settings').update({
      base_occupancy_adults: before.base_occupancy_adults,
      base_occupancy_children: before.base_occupancy_children,
      extra_adult_fee: before.extra_adult_fee,
      extra_child_fee: before.extra_child_fee,
    }).eq('id', before.id)
  }
}

// Both fee shapes, because they broke differently: the percentage compounded, the flat one was
// off by 100x. Removed by id in a finally, so a failing assertion cannot leave the test tenant
// quietly charging a cleaning fee nobody configured.
async function withFees<T>(fn: () => Promise<T>): Promise<T> {
  const { data: rows, error } = await supabase.from('fees').insert([
    // Stored exactly as app/admin/fees/page.tsx writes them: `parseFloat` of what the owner
    // typed, so the flat fee's `amount` is DOLLARS.
    { name: 'ZZ Test Tax', type: 'percentage', amount: 6, applies_to: 'all', is_active: true, card_only: false },
    { name: 'ZZ Test Cleaning', type: 'flat', amount: 10, applies_to: 'all', is_active: true, card_only: false },
  ]).select('id')
  if (error) throw new Error(`could not seed test fees: ${error.message}`)
  const ids = (rows || []).map((r: { id: string }) => r.id)
  try {
    return await fn()
  } finally {
    if (ids.length) await supabase.from('fees').delete().in('id', ids)
  }
}

test('payment: a booking on a tenant WITH fees is not refused, and search matches checkout', { skip }, async (t) => {
  const arrival = '2026-08-18', departure = '2026-08-20'
  const { data: st } = await supabase.from('settings').select('season_start, season_end').limit(1).single()
  if (isNightInSeason(arrival, st) === false) {
    return t.skip('sample week falls outside the configured season')
  }

  // 2 adults / 0 children against a 2/2 base is AT or under occupancy, so this test stays a test
  // of the fee arithmetic alone. The party above occupancy is the next test.
  await withOccupancy(BASE_OCCUPANCY, async () => {
   await withFees(async () => {
    await withHorizon(null, async () => {
      // 1. THE SEARCH — what the guest is shown on the results card.
      const availRes = await fetch(`${BASE}/api/availability?arrival=${arrival}&departure=${departure}&adults=2&children=0`)
      const avail = await availRes.json() as { sites?: PricedSite[] }
      const facts = await fetchDateFacts(supabase, arrival, departure)
      const priced = (avail.sites || []).find(s => checkDateFacts(s.id, facts).bookable)
      if (!priced) return t.skip('the search offered no free site — nothing to price against')

      // The fees actually reached the card. If this fails the rest proves nothing.
      assert.ok(priced.fees_total > 0, 'the seeded fees did not reach the search card')

      // UNITS: a $10 flat fee is 1000 cents. It used to arrive as 10.
      const flatLine = (priced.fees_breakdown || []).find(f => f.name === 'ZZ Test Cleaning')
      assert.ok(flatLine, 'the flat fee is missing from the search breakdown')
      assert.equal(flatLine.amount, 1000, 'a $10 flat fee must be 1000 cents on the search card')

      // COUNTED ONCE: the card's total is the stay plus the fees, and no more.
      assert.equal(priced.base_price, priced.nightly_rate * priced.nights, 'base_price must be the stay alone')
      assert.equal(priced.extra_guest_fee, 0, 'a party at base occupancy must add no guest fee')
      assert.equal(priced.total_price - priced.base_price, priced.fees_total, 'search fees counted twice')

      // 2. THE CHECKOUT PAGE — app/book/BookingForm.tsx, arithmetic and all.
      const { data: settings } = await supabase.from('settings').select('*').limit(1).single()
      const { data: fees } = await supabase
        .from('fees').select('id, name, type, amount, applies_to, is_active, card_only').eq('is_active', true)

      const quote = computeBookingQuote({
        site: {
          site_type: priced.site_type,
          nightly_rate: priced.nightly_rate,
          // DERIVED, exactly as BookingForm does it. Passing priced.total_price here is the
          // original bug, and it is what this whole test exists to keep out.
          total_price: priced.nightly_rate * priced.nights,
          nights: priced.nights,
        },
        adults: 2, children: 0,
        settings: settings as any, fees: (fees || []) as any,
        addonSelections: [], discount: null,
        earlyRequested: false, lateRequested: false, earlyBlocked: false, lateBlocked: false,
      })

      // THE HEADLINE: the number on the search card is the number at checkout.
      assert.equal(
        quote.total, priced.total_price,
        `search card said ${priced.total_price} but checkout computed ${quote.total}`,
      )

      // 3. THE CHARGE — post what BookingForm posts for "Pay in Full".
      const surchargeAmount = quote.cashTotal > 0
        ? Math.round(quote.cashTotal * quote.cardOnlyFeesTotal / quote.cashTotal) : 0
      const r = await post({
        siteId: priced.id, arrival, departure, nights: priced.nights,
        nightlyRate: priced.nightly_rate,
        totalPrice: quote.cashTotal,
        amountToPay: quote.cashTotal,
        paymentType: 'full',
        feesTotal: quote.feesTotal - quote.cardOnlyFeesTotal,
        extraGuestFee: quote.extraGuestFee, addonTotal: quote.addonTotal,
        discountAmount: quote.discountAmount, surchargeAmount,
        lines: quote.emailLines,
      })

      // THE REGRESSION, precisely: the pricing chokepoint did not turn this away. Before the fix
      // this was a 409 with reason 'price-mismatch'.
      assert.notEqual(
        r.json.reason, 'price-mismatch',
        `a fee-configured booking was refused as a price mismatch: ${JSON.stringify(r.json)}`,
      )
      // And no OTHER gate refused it either.
      const GATE_REASONS = [
        'missing-dates', 'invalid-range', 'beyond-horizon', 'out-of-season',
        'blocked', 'double-booked', 'min-stay', 'price-mismatch', 'discount-invalid',
      ]
      assert.ok(
        !GATE_REASONS.includes(r.json.reason),
        `a fee-configured booking was wrongly refused by a gate: ${JSON.stringify(r.json)}`,
      )
      // It reached the payment step. Same evidence the test above accepts, and the same reason:
      // the invalid token means no card can be charged, and the reservation insert is downstream
      // of a successful charge, so nothing is written.
      assert.ok(
        /authoriz/i.test(String(r.json.error)) || r.json.reason === 'square-unavailable',
        `expected to reach the payment step, got: ${JSON.stringify(r.json)}`,
      )

      // 4. THE OTHER DIRECTION — the bug's exact signature, pinned.
      //
      // Recompute the way /book USED to: the fees-inclusive `total_price` as the stay base. The
      // server must still refuse this, because it is an overcharge. Asserting it here does two
      // things: it proves the numbers above are not passing by luck (a route that accepted
      // anything would pass step 3 too), and it names the failure a future reader will see in
      // the logs if the client ever regresses.
      const doubled = computeBookingQuote({
        site: {
          site_type: priced.site_type,
          nightly_rate: priced.nightly_rate,
          total_price: priced.total_price,   // <-- fees already inside. The bug.
          nights: priced.nights,
        },
        adults: 2, children: 0,
        settings: settings as any, fees: (fees || []) as any,
        addonSelections: [], discount: null,
        earlyRequested: false, lateRequested: false, earlyBlocked: false, lateBlocked: false,
      })
      assert.ok(
        doubled.total > quote.total,
        'compounding the fees must overcharge, or this test is not exercising the bug',
      )
      const rDoubled = await post({
        siteId: priced.id, arrival, departure, nights: priced.nights,
        nightlyRate: priced.nightly_rate,
        totalPrice: doubled.cashTotal,
        amountToPay: doubled.cashTotal,
        paymentType: 'full',
        feesTotal: doubled.feesTotal - doubled.cardOnlyFeesTotal,
        extraGuestFee: doubled.extraGuestFee, addonTotal: doubled.addonTotal,
        discountAmount: doubled.discountAmount, surchargeAmount: 0,
        lines: doubled.emailLines,
      })
      assert.equal(
        rDoubled.json.reason, 'price-mismatch',
        `the double-counted total should still be refused, got: ${JSON.stringify(rDoubled.json)}`,
      )
      assert.equal(rDoubled.status, 409)
    })
   })
  })
})

// The party-above-occupancy case. The search form collects adults and children before it prices
// anything, but never sent them, so the card priced every party as if it were at base occupancy.
// Nothing errored — the checkout page and /api/payment agreed with each other — so a guest was
// simply quoted one number and then shown a higher one.
//
// Reproduction this pins: 2 nights at $55, 4 adults + 3 children against a 2/2 base, a 6% tax and
// a $10 flat fee. The card said $126.60; checkout said $206.10.
test('payment: a party ABOVE base occupancy is priced the same in search and at checkout', { skip }, async (t) => {
  const arrival = '2026-08-18', departure = '2026-08-20'
  const { data: st } = await supabase.from('settings').select('season_start, season_end').limit(1).single()
  if (isNightInSeason(arrival, st) === false) {
    return t.skip('sample week falls outside the configured season')
  }

  const ADULTS = 4, CHILDREN = 3   // 2 extra adults, 1 extra child

  await withOccupancy(BASE_OCCUPANCY, async () => {
   await withFees(async () => {
    await withHorizon(null, async () => {
      const availRes = await fetch(
        `${BASE}/api/availability?arrival=${arrival}&departure=${departure}&adults=${ADULTS}&children=${CHILDREN}`)
      const avail = await availRes.json() as { sites?: PricedSite[] }
      const facts = await fetchDateFacts(supabase, arrival, departure)
      const priced = (avail.sites || []).find(s => checkDateFacts(s.id, facts).bookable)
      if (!priced) return t.skip('the search offered no free site — nothing to price against')

      // The guest fee reached the card at all. This is the whole defect in one assertion.
      const expectedGuestFee = (2 * 1500 + 1 * 750) * priced.nights
      assert.equal(
        priced.extra_guest_fee, expectedGuestFee,
        'the search card ignored the extra-guest fee',
      )

      const { data: settings } = await supabase.from('settings').select('*').limit(1).single()
      const { data: fees } = await supabase
        .from('fees').select('id, name, type, amount, applies_to, is_active, card_only').eq('is_active', true)

      const quote = computeBookingQuote({
        site: {
          site_type: priced.site_type,
          nightly_rate: priced.nightly_rate,
          total_price: priced.nightly_rate * priced.nights,   // stay alone, as BookingForm derives it
          nights: priced.nights,
        },
        adults: ADULTS, children: CHILDREN,
        settings: settings as any, fees: (fees || []) as any,
        addonSelections: [], discount: null,
        earlyRequested: false, lateRequested: false, earlyBlocked: false, lateBlocked: false,
      })

      assert.equal(quote.extraGuestFee, expectedGuestFee, 'the quote disagrees on the guest fee')

      // THE HEADLINE.
      assert.equal(
        quote.total, priced.total_price,
        `search card said ${priced.total_price} but checkout computed ${quote.total}`,
      )

      // The percentage fee must be charged on the stay PLUS the guests, not the stay alone —
      // otherwise the card is short by the tax on the guest fee even with the fee itself added.
      const pctLine = (priced.fees_breakdown || []).find(f => f.name === 'ZZ Test Tax')
      assert.ok(pctLine, 'the percentage fee is missing from the search breakdown')
      assert.equal(
        pctLine.amount,
        Math.round((priced.base_price + expectedGuestFee) * 6 / 100),
        'the percentage fee must be computed on the stay plus the extra guests',
      )

      // And the server still honours it — no false rejection.
      const r = await post({
        siteId: priced.id, arrival, departure, nights: priced.nights,
        adults: ADULTS, children: CHILDREN,
        nightlyRate: priced.nightly_rate,
        totalPrice: quote.cashTotal, amountToPay: quote.cashTotal, paymentType: 'full',
        feesTotal: quote.feesTotal - quote.cardOnlyFeesTotal,
        extraGuestFee: quote.extraGuestFee, addonTotal: quote.addonTotal,
        discountAmount: quote.discountAmount, surchargeAmount: 0,
        lines: quote.emailLines,
      })
      const GATE_REASONS = [
        'missing-dates', 'invalid-range', 'beyond-horizon', 'out-of-season',
        'blocked', 'double-booked', 'min-stay', 'price-mismatch', 'discount-invalid',
      ]
      assert.ok(
        !GATE_REASONS.includes(r.json.reason),
        `a party above occupancy was wrongly refused: ${JSON.stringify(r.json)}`,
      )
      assert.ok(
        /authoriz/i.test(String(r.json.error)) || r.json.reason === 'square-unavailable',
        `expected to reach the payment step, got: ${JSON.stringify(r.json)}`,
      )
    })
   })
  })
})

// ─────────────────────────────────────────────────────────────────────────────────────────────
// PETS — THE CRAFTED-REQUEST CASES
//
// The guest UI does not exist yet, so every request below is exactly what an attacker would send:
// hand-built JSON asserting pets, or asserting nothing while bringing them. That is the point.
// Client-side gating is UX; these prove the SERVER refuses, which is the only thing that holds.
//
// The park's pet settings and the sites' pet_friendly flags are pinned for the duration of each
// test and restored in a finally, so a failing assertion cannot leave the tenant charging for
// pets nobody configured.
// ─────────────────────────────────────────────────────────────────────────────────────────────

const PET_SETTINGS = {
  pets_enabled: true,
  pet_fee_amount: 2500,
  pet_fee_per_night: false,
  pet_fee_per_pet: true,
  pet_max: 2,
  pet_rules_text: 'Pets must be leashed.',
  pet_rules_require_affirmation: false,
  pet_fee_taxable: false,
  pet_fee_surcharged: false,
  service_animal_allowed: true,
}

/**
 * Pins the park's pet policy and marks exactly one site pet-friendly, returning both site ids.
 * Skips the whole test when the tenant has no pet columns — an un-migrated tenant is a valid
 * state, not a failure.
 */
async function withPets<T>(
  over: Record<string, unknown>,
  fn: (sites: { petSite: string; noPetSite: string }) => Promise<T>,
): Promise<T | 'no-pet-columns'> {
  const { data: before } = await supabase.from('settings').select('*').limit(1).single()
  if (!before || !('pets_enabled' in before)) return 'no-pet-columns'

  const { data: allSites } = await supabase
    .from('sites').select('id, pet_friendly').eq('is_available', true).order('display_order')
  if (!allSites || allSites.length < 2) return 'no-pet-columns'
  const petSite = allSites[0].id
  const noPetSite = allSites[1].id
  const priorFlags = allSites.map((s: { id: string; pet_friendly: boolean }) => [s.id, s.pet_friendly] as const)

  await supabase.from('settings').update({ ...PET_SETTINGS, ...over }).eq('id', before.id)
  await supabase.from('sites').update({ pet_friendly: false }).eq('id', noPetSite)
  await supabase.from('sites').update({ pet_friendly: true }).eq('id', petSite)
  try {
    return await fn({ petSite, noPetSite })
  } finally {
    const restore: Record<string, unknown> = {}
    for (const k of Object.keys(PET_SETTINGS)) restore[k] = (before as Record<string, unknown>)[k]
    await supabase.from('settings').update(restore).eq('id', before.id)
    for (const [id, flag] of priorFlags) {
      await supabase.from('sites').update({ pet_friendly: flag }).eq('id', id)
    }
  }
}

/** The quote a legitimate booking would produce, so a test can post the RIGHT number. */
async function petQuote(siteId: string, arrival: string, departure: string, pets: {
  petCount?: number; isServiceAnimal?: boolean
}) {
  const { data: site } = await supabase.from('sites').select('*').eq('id', siteId).single()
  const { data: settings } = await supabase.from('settings').select('*').limit(1).single()
  const { data: fees } = await supabase.from('fees').select('*').eq('is_active', true)
  const nights = Math.round((new Date(departure).getTime() - new Date(arrival).getTime()) / 86400000)
  return computeBookingQuote({
    site: { site_type: site!.site_type, nightly_rate: site!.base_rate, total_price: site!.base_rate * nights, nights },
    adults: 2, children: 0, settings: settings as any, fees: (fees || []) as any,
    addonSelections: [], discount: null,
    earlyRequested: false, lateRequested: false, earlyBlocked: false, lateBlocked: false,
    petCount: pets.petCount ?? 0, isServiceAnimal: pets.isServiceAnimal,
  })
}

const PET_ARRIVAL = '2026-08-18', PET_DEPARTURE = '2026-08-20'

test('pets: a request that declares pets but pays the no-pet price is REFUSED', { skip }, async (t) => {
  // THE FEE-DODGE. The server recomputes the quote from the database, so asserting pets while
  // paying the stay-only total cannot succeed.
  const r = await withPets({}, async ({ petSite }) => {
    const stayOnly = await petQuote(petSite, PET_ARRIVAL, PET_DEPARTURE, { petCount: 0 })
    return withHorizonValue(null, () => post({
      siteId: petSite, arrival: PET_ARRIVAL, departure: PET_DEPARTURE, nights: 2,
      nightlyRate: 5500,
      totalPrice: stayOnly.cashTotal, amountToPay: stayOnly.cashTotal, paymentType: 'full',
      petCount: 2,          // <- brings two dogs
    }))
  })
  if (r === 'no-pet-columns') return t.skip('tenant has no pet columns')
  assert.equal(r.json.reason, 'price-mismatch', `the pet fee was dodged: ${JSON.stringify(r.json)}`)
  assert.equal(r.status, 409)
})

test('pets: declaring MORE pets than the park allows is refused, and never reaches Square', { skip }, async (t) => {
  const r = await withPets({ pet_max: 2 }, async ({ petSite }) => {
    const q = await petQuote(petSite, PET_ARRIVAL, PET_DEPARTURE, { petCount: 5 })
    return withHorizonValue(null, () => post({
      siteId: petSite, arrival: PET_ARRIVAL, departure: PET_DEPARTURE, nights: 2,
      nightlyRate: 5500, totalPrice: q.cashTotal, amountToPay: q.cashTotal, paymentType: 'full',
      petCount: 5,
    }))
  })
  if (r === 'no-pet-columns') return t.skip('tenant has no pet columns')
  assert.ok(r.gated, `over-cap request reached Square: ${JSON.stringify(r.json)}`)
  assert.equal(r.json.reason, 'pet-max')
  assert.equal(r.status, 400)
})

test('pets: a pet on a site that does not allow pets is refused', { skip }, async (t) => {
  const r = await withPets({}, async ({ noPetSite }) => {
    const q = await petQuote(noPetSite, PET_ARRIVAL, PET_DEPARTURE, { petCount: 1 })
    return withHorizonValue(null, () => post({
      siteId: noPetSite, arrival: PET_ARRIVAL, departure: PET_DEPARTURE, nights: 2,
      nightlyRate: 5500, totalPrice: q.cashTotal, amountToPay: q.cashTotal, paymentType: 'full',
      petCount: 1,
    }))
  })
  if (r === 'no-pet-columns') return t.skip('tenant has no pet columns')
  assert.ok(r.gated, `pet-site request reached Square: ${JSON.stringify(r.json)}`)
  assert.equal(r.json.reason, 'pet-site')
})

test('pets: the public path cannot assert the staff site override', { skip }, async (t) => {
  // override_pet_site is honoured only at /api/manual-booking, behind requireRole. A camper
  // sending it must still be refused.
  const r = await withPets({}, async ({ noPetSite }) => {
    const q = await petQuote(noPetSite, PET_ARRIVAL, PET_DEPARTURE, { petCount: 1 })
    return withHorizonValue(null, () => post({
      siteId: noPetSite, arrival: PET_ARRIVAL, departure: PET_DEPARTURE, nights: 2,
      nightlyRate: 5500, totalPrice: q.cashTotal, amountToPay: q.cashTotal, paymentType: 'full',
      petCount: 1, override_pet_site: true, allowPetSiteOverride: true, overridePetSite: true,
    }))
  })
  if (r === 'no-pet-columns') return t.skip('tenant has no pet columns')
  assert.equal(r.json.reason, 'pet-site', `a camper waived the site restriction: ${JSON.stringify(r.json)}`)
})

test('pets: a required rules affirmation cannot be skipped', { skip }, async (t) => {
  const r = await withPets({ pet_rules_require_affirmation: true }, async ({ petSite }) => {
    const q = await petQuote(petSite, PET_ARRIVAL, PET_DEPARTURE, { petCount: 1 })
    return withHorizonValue(null, () => post({
      siteId: petSite, arrival: PET_ARRIVAL, departure: PET_DEPARTURE, nights: 2,
      nightlyRate: 5500, totalPrice: q.cashTotal, amountToPay: q.cashTotal, paymentType: 'full',
      petCount: 1,           // no petRulesAffirmed
    }))
  })
  if (r === 'no-pet-columns') return t.skip('tenant has no pet columns')
  assert.ok(r.gated, `unaffirmed request reached Square: ${JSON.stringify(r.json)}`)
  assert.equal(r.json.reason, 'pet-rules')
})

test('pets: a legitimate pet booking is NOT refused, and the fee is in the charge', { skip }, async (t) => {
  // The counterpart that makes the refusals meaningful: a gate that rejected everything would
  // pass every test above.
  const out = await withPets({ pet_rules_require_affirmation: true }, async ({ petSite }) => {
    const q = await petQuote(petSite, PET_ARRIVAL, PET_DEPARTURE, { petCount: 2 })
    const r = await withHorizonValue(null, () => post({
      siteId: petSite, arrival: PET_ARRIVAL, departure: PET_DEPARTURE, nights: 2,
      nightlyRate: 5500, totalPrice: q.cashTotal, amountToPay: q.cashTotal, paymentType: 'full',
      petCount: 2, petRulesAffirmed: true,
    }))
    return { r, q }
  })
  if (out === 'no-pet-columns') return t.skip('tenant has no pet columns')
  const { r, q } = out
  assert.equal(q.petFee, 5000, 'the quote should carry 2 x $25')
  const GATE_REASONS = ['missing-dates','invalid-range','beyond-horizon','out-of-season','blocked','double-booked','min-stay','price-mismatch','discount-invalid','pet-max','pet-rules','pet-site']
  assert.ok(!GATE_REASONS.includes(r.json.reason), `a legitimate pet booking was refused: ${JSON.stringify(r.json)}`)
  assert.ok(
    /authoriz/i.test(String(r.json.error)) || r.json.reason === 'square-unavailable',
    `expected to reach the payment step, got: ${JSON.stringify(r.json)}`,
  )
})

test('pets: a service animal is free, and may book a site that does not allow pets', { skip }, async (t) => {
  const out = await withPets({ pet_max: 1, pet_rules_require_affirmation: true }, async ({ noPetSite }) => {
    const q = await petQuote(noPetSite, PET_ARRIVAL, PET_DEPARTURE, { petCount: 1, isServiceAnimal: true })
    const r = await withHorizonValue(null, () => post({
      siteId: noPetSite, arrival: PET_ARRIVAL, departure: PET_DEPARTURE, nights: 2,
      nightlyRate: 5500, totalPrice: q.cashTotal, amountToPay: q.cashTotal, paymentType: 'full',
      petCount: 1, isServiceAnimal: true,   // no affirmation, non-pet site, over the cap of 1
    }))
    return { r, q }
  })
  if (out === 'no-pet-columns') return t.skip('tenant has no pet columns')
  const { r, q } = out
  assert.equal(q.petFee, 0, 'a service animal must be free')
  assert.ok(
    !['pet-max','pet-rules','pet-site','price-mismatch'].includes(r.json.reason),
    `a service animal was refused: ${JSON.stringify(r.json)}`,
  )
})

test('pets: with the feature OFF, a request asserting pets changes nothing', { skip }, async (t) => {
  // The dormant state every park is in. Pet fields in the body must be inert, not merely
  // harmless — a park with pets off must not start charging because a request said "petCount".
  const r = await withPets({ pets_enabled: false }, async ({ noPetSite }) => {
    const q = await petQuote(noPetSite, PET_ARRIVAL, PET_DEPARTURE, { petCount: 0 })
    assert.equal(q.petFee, 0)
    return withHorizonValue(null, () => post({
      siteId: noPetSite, arrival: PET_ARRIVAL, departure: PET_DEPARTURE, nights: 2,
      nightlyRate: 5500, totalPrice: q.cashTotal, amountToPay: q.cashTotal, paymentType: 'full',
      petCount: 3, isServiceAnimal: false,
    }))
  })
  if (r === 'no-pet-columns') return t.skip('tenant has no pet columns')
  assert.ok(
    !['pet-max','pet-rules','pet-site','price-mismatch'].includes(r.json.reason),
    `a pets-off park was disturbed by pet fields: ${JSON.stringify(r.json)}`,
  )
})

// ─────────────────────────────────────────────────────────────────────────────────────────────
// THE BOOKING HORIZON
//
// The horizon is a setting, so unlike the season and the blocked dates there is nothing to find
// in the tenant's data to test against — these tests SET one, exercise the route, and put the
// row back. Restored in a finally, so a failing assertion cannot leave the test tenant with a
// booking window nobody configured.
// ─────────────────────────────────────────────────────────────────────────────────────────────

// Also used by the tests ABOVE that assert a non-horizon gate. The horizon is checked before the
// season and before the date facts, so a tenant that happens to have a booking window configured
// makes those tests fail with `beyond-horizon` instead of the gate they are about — which is
// exactly what happened the first time this suite met a tenant with a live window. Pinning the
// window to null is what makes each of them a test of one gate rather than of the tenant's config.
// Value-returning sibling, for the tests that need the response back out of the wrapper.
async function withHorizonValue<T>(days: number | null, fn: () => Promise<T>): Promise<T> {
  let out!: T
  await withHorizon(days, async () => { out = await fn() })
  return out
}

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
    if (isNightInSeason(arrival, st) === false) {
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
    if (isNightInSeason(arrival, st) === false) {
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

// ─────────────────────────────────────────────────────────────────────────────────────────────
// THE CLOSED SEASON — whole-stay, hard block, public path
//
// The defect these cover was live and took money: checkBookability passed the ARRIVAL alone to
// the season gate, so a stay that began in season and ran past closing was accepted and charged,
// and a guest could occupy a site for weeks after the park had shut.
//
// Like the horizon tests, these SET a season and put it back in a finally.
// ─────────────────────────────────────────────────────────────────────────────────────────────

async function withSeason(
  start: string | null,
  end: string | null,
  fn: () => Promise<void>
) {
  const { data: before } = await supabase
    .from('settings').select('id, season_start, season_end, closed_season_message').limit(1).single()
  if (!before) throw new Error('no settings row on this tenant')
  await supabase.from('settings')
    .update({ season_start: start, season_end: end }).eq('id', before.id)
  try {
    await fn()
  } finally {
    await supabase.from('settings')
      .update({ season_start: before.season_start, season_end: before.season_end })
      .eq('id', before.id)
  }
}

// THE CRAFTED REQUEST. Charissa's exact case, posted straight at the charge route with the
// browser bypassed: arrival inside the season, departure two months past closing.
test('payment: a stay that runs PAST CLOSING is refused, and never reaches Square', { skip }, async (t) => {
  await withHorizon(null, async () => {
    await withSeason('April 1', 'October 31', async () => {
      const arrival = '2026-10-20', departure = '2026-12-31'
      const site = await aFreeSite(arrival, departure)
      if (!site) return t.skip('no free site for the sample range')

      const r = await post({ siteId: site.id, arrival, departure, nights: 72 })

      assert.ok(r.gated, `a stay running past closing reached Square: ${JSON.stringify(r.json)}`)
      assert.equal(r.json.reason, 'out-of-season', 'refused by the season gate specifically')
      assert.equal(r.status, 400)
    })
  })
})

// The counterpart: the arrival alone was always enough to pass before, so this proves the gate
// is looking at the whole stay rather than having simply become stricter about arrivals.
test('payment: a stay wholly inside the season is NOT refused by it', { skip }, async (t) => {
  await withHorizon(null, async () => {
    await withSeason('April 1', 'October 31', async () => {
      const arrival = '2026-07-06', departure = '2026-07-09'
      const site = await aFreeSite(arrival, departure)
      if (!site) return t.skip('no free site for the sample range')

      const r = await post({ siteId: site.id, arrival, departure, nights: 3 })

      assert.notEqual(r.json.reason, 'out-of-season', `an in-season stay was refused: ${JSON.stringify(r.json)}`)
    })
  })
})

// THE CLOSING DAY, through the real route. INVERTED: season_end is the last allowed CHECKOUT, so
// a check-in ON the closing day is a night in a park that has shut, and must be refused at the
// charge route rather than merely discouraged in the browser.
test('payment: CHECKING IN on the closing day is refused, and never reaches Square', { skip }, async (t) => {
  await withHorizon(null, async () => {
    await withSeason('April 1', 'October 31', async () => {
      const arrival = '2026-10-31', departure = '2026-11-01'
      const site = await aFreeSite(arrival, departure)
      if (!site) return t.skip('no free site for the boundary range')

      const r = await post({ siteId: site.id, arrival, departure, nights: 1 })

      assert.ok(r.gated, `a check-in on the closing day reached Square: ${JSON.stringify(r.json)}`)
      assert.equal(r.json.reason, 'out-of-season', 'refused by the season gate specifically')
      assert.equal(r.status, 400)
    })
  })
})

// The counterpart, and the one that keeps the fix from overshooting: the last stay of the year
// still books. If this ever fails, the park has lost its final night of trade.
test('payment: THE LAST VALID STAY — arrive the day before closing, check out ON it', { skip }, async (t) => {
  await withHorizon(null, async () => {
    await withSeason('April 1', 'October 31', async () => {
      const arrival = '2026-10-30', departure = '2026-10-31'
      const site = await aFreeSite(arrival, departure)
      if (!site) return t.skip('no free site for the boundary range')

      const r = await post({ siteId: site.id, arrival, departure, nights: 1 })

      assert.notEqual(r.json.reason, 'out-of-season',
        `the last valid stay of the season was wrongly refused: ${JSON.stringify(r.json)}`)
    })
  })
})

// Search must agree with create, or the site advertises a stay it will refuse to charge for.
test('availability: the search refuses the same past-closing stay the route does', { skip }, async () => {
  await withHorizon(null, async () => {
    await withSeason('April 1', 'October 31', async () => {
      const res = await fetch(`${BASE}/api/availability?arrival=2026-10-20&departure=2026-12-31`)
      const json: any = await res.json()
      assert.equal(json.closed, true, `search offered a stay running past closing: ${JSON.stringify(json)}`)
      assert.ok(Array.isArray(json.sites) && json.sites.length === 0)

      const res2 = await fetch(`${BASE}/api/availability?arrival=2026-10-31&departure=2026-11-01`)
      const json2: any = await res2.json()
      assert.equal(json2.closed, true, 'search must not offer a check-in on the closing day')

      // And the last valid stay stays searchable, or search and create disagree in the other
      // direction — advertising nothing for a night the route would happily sell.
      const res3 = await fetch(`${BASE}/api/availability?arrival=2026-10-30&departure=2026-10-31`)
      const json3: any = await res3.json()
      assert.notEqual(json3.closed, true, 'the last valid stay must remain searchable')
    })
  })
})

// A winter park could not take a single booking before this: the season was built from the
// arrival's own year, so Nov 1 resolved LATER than Mar 31 and every date failed both bounds.
test('payment: a wrapping winter season is bookable across New Year', { skip }, async (t) => {
  await withHorizon(null, async () => {
    await withSeason('November 1', 'March 31', async () => {
      const arrival = '2026-12-28', departure = '2027-01-04'
      const site = await aFreeSite(arrival, departure)
      if (!site) return t.skip('no free site over New Year')

      const r = await post({ siteId: site.id, arrival, departure, nights: 7 })

      assert.notEqual(r.json.reason, 'out-of-season',
        `a wrapping season refused its own mid-season dates: ${JSON.stringify(r.json)}`)
    })
  })
})
