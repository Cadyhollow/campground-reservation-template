// The meter walk, end to end, through the REAL routes on a real Next server:
//
//   node --conditions=react-server --test --test-timeout=180000 lib/meter-walk-route.test.ts
//
// WHY A ROUTE TEST AND NOT ONLY UNIT TESTS. lib/meters.test.ts proves the arithmetic and the
// billable rule in isolation. What it cannot prove is the thing this feature actually promises:
// that walking the park produces DRAFT bills a double-site camper is billed once for, and that
// none of it charges anybody. That promise spans four routes, three tables and the existing
// Electric Billing page's own definition of "already billed" — so it is asserted here, over HTTP,
// against the same database the app uses.
//
// ⚠ SAFETY. Two interlocks, and neither is incidental:
//   1. The server starts with SQUARE_ACCESS_TOKEN deliberately invalid, like every other route
//      test here, so nothing in this file can reach a card.
//   2. THIS FILE NEVER POSTS A BILL. It asserts that drafts exist and that they are NOT charges —
//      it never calls the folio_line_items path. The one "posting" assertion below checks that a
//      draft REFUSES to be restaged over a posted bill, and it fabricates that posted row
//      directly rather than going through the money path.
//
// It cleans up after itself: every row it creates is deleted in `after`, identified by the
// session it created, so a re-run starts from the same place.

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createClient } from '@supabase/supabase-js'
import { createServerClient } from '@supabase/ssr'
import { existsSync, readFileSync } from 'node:fs'
import { spawn, type ChildProcess } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, resolve as resolvePath } from 'node:path'

const REPO_ROOT = resolvePath(dirname(fileURLToPath(import.meta.url)), '..')
const ENV_PATH = resolvePath(REPO_ROOT, '.env.local')

const env: Record<string, string> = {}
if (existsSync(ENV_PATH)) {
  for (const line of readFileSync(ENV_PATH, 'utf8').split('\n')) {
    if (!line.includes('=') || line.trim().startsWith('#')) continue
    const rawValue = line.slice(line.indexOf('=') + 1).trim()
    const value = /^(["']).*\1$/.test(rawValue) ? rawValue.slice(1, -1) : rawValue
    env[line.slice(0, line.indexOf('=')).trim()] = value
  }
}

const placeholder = (v: string | undefined) => !v || /YOUR_|EXAMPLE|CHANGEME|xxxx/i.test(v)
const configured =
  !placeholder(env.NEXT_PUBLIC_SUPABASE_URL) &&
  /^https:\/\/[a-z0-9]+\.supabase\./i.test(env.NEXT_PUBLIC_SUPABASE_URL || '') &&
  !placeholder(env.SUPABASE_SERVICE_ROLE_KEY) &&
  !placeholder(env.ADMIN_TEST_OWNER_EMAIL) && !placeholder(env.ADMIN_TEST_OWNER_PASSWORD)
const skip = configured ? false : 'no configured Supabase project / owner account in .env.local'

// Its own port, so this file can run beside the other route suites.
const PORT = 4877
const BASE = `http://127.0.0.1:${PORT}`

const svc = configured
  ? createClient(env.NEXT_PUBLIC_SUPABASE_URL!, env.SUPABASE_SERVICE_ROLE_KEY!)
  : null

async function logIn(email: string, password: string): Promise<string> {
  const jar = new Map<string, string>()
  const client = createServerClient(env.NEXT_PUBLIC_SUPABASE_URL!, env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, {
    cookies: {
      getAll: () => [...jar.entries()].map(([name, value]) => ({ name, value })),
      setAll: (list) => list.forEach(({ name, value }) => { if (value) jar.set(name, value); else jar.delete(name) }),
    },
  })
  const { error } = await client.auth.signInWithPassword({ email, password })
  assert.equal(error, null, `signing in as ${email} should succeed`)
  return [...jar.entries()].map(([n, v]) => `${n}=${v}`).join('; ')
}

let server: ChildProcess | null = null
let COOKIE = ''
let sessionId = ''
const BILLING_MONTH = `Test Month ${Date.now()}` // unique, so it collides with no real bill
const createdReadingIds: string[] = []

const api = (path: string, init?: RequestInit) =>
  fetch(`${BASE}${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', Cookie: COOKIE, ...(init?.headers || {}) },
  })

before(async () => {
  if (!configured) return
  server = spawn('npx', ['next', 'dev', '-p', String(PORT)], {
    cwd: REPO_ROOT,
    // THE SAFETY INTERLOCK: no request from this file can result in a charge.
    env: { ...process.env, ...env, SQUARE_ACCESS_TOKEN: 'INVALID_TOKEN_FOR_TESTING' },
    stdio: 'ignore',
  })
  const deadline = Date.now() + 120_000
  for (;;) {
    try { await fetch(`${BASE}/api/availability?arrival=2026-08-18&departure=2026-08-20`); break }
    catch {
      if (Date.now() > deadline) throw new Error('next dev did not come up in time')
      await new Promise(r => setTimeout(r, 500))
    }
  }
  COOKIE = await logIn(env.ADMIN_TEST_OWNER_EMAIL, env.ADMIN_TEST_OWNER_PASSWORD)
}, { timeout: 130_000 })

after(async () => {
  // Leave the tenant as it was found.
  if (svc && sessionId) {
    await svc.from('electric_readings').delete().eq('billing_month', BILLING_MONTH)
    await svc.from('meter_readings').delete().eq('session_id', sessionId)
    if (createdReadingIds.length) await svc.from('meter_readings').delete().in('id', createdReadingIds)
    await svc.from('meter_reading_sessions').delete().eq('id', sessionId)
  }
  server?.kill('SIGTERM')
})

// ── THE REGISTRY ─────────────────────────────────────────────────────────────────────────────

test('every site has a meter, numbered as the site', { skip }, async () => {
  const res = await api('/api/meters')
  assert.equal(res.status, 200)
  const { meters } = await res.json()
  assert.ok(meters.length > 0, 'the registry is seeded')

  const { data: sites } = await svc!.from('sites').select('site_number')
  const siteNumbers = new Set((sites || [])
    .map((s: { site_number: string }) => (s.site_number || '').trim().toLowerCase())
    .filter(Boolean))
  const meterNumbers = new Set(meters.map((m: { meter: { meter_number: string } }) =>
    m.meter.meter_number.trim().toLowerCase()))
  for (const n of siteNumbers) {
    assert.ok(meterNumbers.has(n), `site ${n} has no meter`)
  }
})

test('the walk is in numeric site order, whatever display_order says', { skip }, async () => {
  const { meters } = await (await api('/api/meters')).json()
  const numeric = meters
    .map((m: { meter: { meter_number: string } }) => parseInt(m.meter.meter_number, 10))
    .filter((n: number) => Number.isFinite(n))
  const sorted = [...numeric].sort((a, b) => a - b)
  assert.deepEqual(numeric, sorted, 'numbered meters come back ascending')
})

// ── THE WALK ─────────────────────────────────────────────────────────────────────────────────

test('a walk can be started, and it queues every active meter', { skip }, async () => {
  const res = await api('/api/meter-sessions', {
    method: 'POST',
    body: JSON.stringify({ billing_month: BILLING_MONTH, read_date: '2026-09-01', label: 'Route test walk' }),
  })
  assert.equal(res.status, 200)
  const { session } = await res.json()
  sessionId = session.id
  assert.equal(session.billing_month, BILLING_MONTH)
  assert.equal(session.status, 'in_progress')

  const q = await (await api(`/api/meter-sessions/${sessionId}`)).json()
  assert.ok(q.meters.length > 0)
  assert.equal(q.progress.read, 0, 'a fresh walk has read nothing')
  assert.equal(q.progress.remaining, q.meters.length)
})

test('⚠ THE BILLING MONTH IS A LABEL — an August read may be the September bill', { skip }, async () => {
  // Nothing checks read_date against billing_month, deliberately: reading in the last days of one
  // month for the next month's bill is normal practice, and enforcing month maths would reject it.
  const res = await api('/api/meter-sessions', {
    method: 'POST',
    body: JSON.stringify({ billing_month: 'September 2026', read_date: '2026-08-28' }),
  })
  assert.equal(res.status, 200)
  const { session } = await res.json()
  assert.equal(session.billing_month, 'September 2026')
  assert.equal(session.read_date, '2026-08-28')
  await svc!.from('meter_reading_sessions').delete().eq('id', session.id)
})

test('a reading is saved for EVERY meter, billable or not — the permanent record', { skip }, async () => {
  const q = await (await api(`/api/meter-sessions/${sessionId}`)).json()
  const billable = q.meters.filter((m: { billable: boolean }) => m.billable)
  const recordOnly = q.meters.filter((m: { billable: boolean }) => !m.billable)
  assert.ok(billable.length > 0, 'the tenant has at least one billable meter')
  assert.ok(recordOnly.length > 0, 'and at least one record-only meter')

  // Read one of each.
  for (const m of [billable[0], recordOnly[0]]) {
    const res = await api('/api/meter-readings', {
      method: 'POST',
      body: JSON.stringify({ meter_id: m.meter.id, session_id: sessionId, reading_value: 1000 }),
    })
    assert.equal(res.status, 200, `saving meter ${m.meter.meter_number}`)
  }

  const { data: saved } = await svc!.from('meter_readings').select('*').eq('session_id', sessionId)
  assert.equal(saved!.length, 2, 'both readings are stored')
  const recordOnlyRow = saved!.find(r => r.meter_id === recordOnly[0].meter.id)
  assert.equal(recordOnlyRow!.billable, false)
  assert.equal(recordOnlyRow!.guest_id, null, 'a record-only reading names no camper')
})

test('a record-only meter NEVER creates a bill', { skip }, async () => {
  const q = await (await api(`/api/meter-sessions/${sessionId}`)).json()
  const recordOnly = q.meters.find((m: { billable: boolean }) => !m.billable)
  const { data: drafts } = await svc!.from('electric_readings')
    .select('guest_id').eq('billing_month', BILLING_MONTH)
  // The record-only meter's site has no billable camper, so nothing it could have billed exists.
  assert.ok(!drafts!.some(d => d.guest_id === null), 'no bill was staged without a camper')
  assert.ok(recordOnly, 'sanity: a record-only meter was found')
})

test('re-reading a meter UPDATES its reading rather than adding a second', { skip }, async () => {
  const q = await (await api(`/api/meter-sessions/${sessionId}`)).json()
  const m = q.meters.find((x: { billable: boolean }) => x.billable)
  await api('/api/meter-readings', {
    method: 'POST',
    body: JSON.stringify({ meter_id: m.meter.id, session_id: sessionId, reading_value: 1234 }),
  })
  const { data: rows } = await svc!.from('meter_readings')
    .select('id, reading_value').eq('session_id', sessionId).eq('meter_id', m.meter.id)
  assert.equal(rows!.length, 1, 'one reading per meter per walk — a second would double the usage')
  assert.equal(Number(rows![0].reading_value), 1234, 'the correction won')
})

test('progress is in the database, so the walk resumes on any device', { skip }, async () => {
  const q = await (await api(`/api/meter-sessions/${sessionId}`)).json()
  assert.equal(q.progress.read, 2, 'the two meters read so far are counted')
  assert.equal(q.progress.remaining, q.meters.length - 2)
  const read = q.meters.filter((m: { reading: unknown }) => m.reading !== null)
  assert.equal(read.length, 2, 'and each one carries its own saved reading back')
})

// ── DRAFTS, AND THE DOUBLE-SITE CAMPER ───────────────────────────────────────────────────────

test('⚠ A WALK STAGES DRAFTS AND CHARGES NOTHING', { skip }, async () => {
  const { data: drafts } = await svc!.from('electric_readings')
    .select('*').eq('billing_month', BILLING_MONTH)
  assert.ok(drafts!.length > 0, 'the billable meter produced a draft')
  for (const d of drafts!) {
    assert.equal(d.status, 'draft', 'staged as a draft')
    assert.equal(d.folio_line_item_id, null, 'and pointing at NO folio line item — this is the guarantee')
    assert.equal(d.reading_session_id, sessionId, 'traceable to the walk that made it')
  }

  // The stronger statement: no folio line item exists for this month at all.
  const { data: items } = await svc!.from('folio_line_items')
    .select('id').eq('description', `${BILLING_MONTH} Electric`)
  assert.equal(items!.length, 0, 'no charge was created anywhere')
})

test('a camper on TWO sites gets ONE bill summing both meters', { skip }, async () => {
  // Find a camper who holds more than one site, and read every meter they hold.
  const q = await (await api(`/api/meter-sessions/${sessionId}`)).json()
  const byGuest = new Map<string, { meterId: string; number: string }[]>()
  for (const m of q.meters) {
    if (!m.billable || !m.camper) continue
    const list = byGuest.get(m.camper.id) || []
    list.push({ meterId: m.meter.id, number: m.meter.meter_number })
    byGuest.set(m.camper.id, list)
  }
  const doubled = [...byGuest.entries()].find(([, list]) => list.length > 1)
  if (!doubled) return // a tenant with no double-site camper: lib/meters.test.ts covers the maths

  const [guestId, list] = doubled

  // ⚠ THE READINGS ARE DERIVED FROM EACH METER'S OWN PREVIOUS VALUE, NOT HARDCODED.
  //
  // An earlier version wrote a flat 300 and 200 and asserted 500 kWh. It passed alone and FAILED
  // in the full suite, because the tenant is shared: a meter that already read 1,300 turned a
  // reading of 300 into zero usage (floored, correctly — a reading below the previous one is a
  // typo, not a credit). The test was assuming a clean tenant, which nothing guarantees.
  //
  // Reading "previous + N" asserts the delta the feature actually promises, whatever the meters
  // happen to hold when the suite runs.
  const prevOf = (meterId: string) => {
    const m = q.meters.find((x: { meter: { id: string } }) => x.meter.id === meterId)
    return Number(m?.previousValue ?? 0)
  }
  const first = prevOf(list[0].meterId) + 300
  const second = prevOf(list[1].meterId) + 200
  await api('/api/meter-readings', { method: 'POST', body: JSON.stringify({ meter_id: list[0].meterId, session_id: sessionId, reading_value: first }) })
  await api('/api/meter-readings', { method: 'POST', body: JSON.stringify({ meter_id: list[1].meterId, session_id: sessionId, reading_value: second }) })

  const { data: bills } = await svc!.from('electric_readings')
    .select('*').eq('billing_month', BILLING_MONTH).eq('guest_id', guestId)
  assert.equal(bills!.length, 1, 'ONE bill — never one row per meter, never two statements')

  const bill = bills![0]
  const breakdown = bill.meter_breakdown as { meter_number: string; kwh: number }[]
  assert.equal(breakdown.length, list.length, 'a reading line per meter, for verification')
  assert.equal(Number(bill.kwh_used), 500, 'the usage is the SUM of both meters')
  assert.equal(
    breakdown.reduce((s, l) => s + Number(l.kwh), 0), Number(bill.kwh_used),
    'and the lines add up to the total on the bill',
  )
  // The minimum charge is met once, not once per meter.
  const rate = Number(bill.rate_per_kwh), min = Number(bill.minimum_charge)
  assert.equal(Number(bill.calculated_amount), Math.max(min, Math.round(500 * rate * 100)))
})

test('a meter replacement does not put a wild jump on the bill', { skip }, async () => {
  const q = await (await api(`/api/meter-sessions/${sessionId}`)).json()
  const m = q.meters.find((x: { billable: boolean; reading: unknown }) => x.billable && x.reading !== null)
  // Its last reading becomes the "previous"; swap the meter and read 412 on the new one.
  await api('/api/meter-readings', {
    method: 'POST',
    body: JSON.stringify({
      meter_id: m.meter.id, session_id: sessionId, reading_value: 412,
      is_meter_reset: true, reset_start_value: 0,
    }),
  })
  const { data: rows } = await svc!.from('meter_readings')
    .select('*').eq('session_id', sessionId).eq('meter_id', m.meter.id)
  assert.equal(rows![0].is_meter_reset, true)

  const { data: bills } = await svc!.from('electric_readings')
    .select('*').eq('billing_month', BILLING_MONTH).eq('guest_id', m.camper.id)
  const line = (bills![0].meter_breakdown as { meter_id: string; kwh: number; is_reset: boolean; previous_reading: number; current_reading: number }[])
    .find(l => l.meter_id === m.meter.id)!
  assert.equal(line.is_reset, true, 'the bill records the replacement')
  assert.equal(Number(line.kwh), 412, 'usage is measured on the NEW meter alone')
  assert.equal(
    Number(line.current_reading) - Number(line.previous_reading), Number(line.kwh),
    'and the line still adds up, which is what stops the statement looking like nonsense',
  )
})

// ── THE OVERRIDE ─────────────────────────────────────────────────────────────────────────────

test('forcing a meter OFF stops it billing, and withdraws its draft', { skip }, async () => {
  const q = await (await api(`/api/meter-sessions/${sessionId}`)).json()
  // A camper with exactly one meter, so switching it off removes their whole bill.
  const counts = new Map<string, number>()
  for (const m of q.meters) if (m.billable && m.camper) counts.set(m.camper.id, (counts.get(m.camper.id) || 0) + 1)
  const single = q.meters.find((m: { billable: boolean; camper: { id: string } | null; reading: unknown }) =>
    m.billable && m.camper && counts.get(m.camper.id) === 1 && m.reading !== null)
  if (!single) return

  const before = await svc!.from('electric_readings')
    .select('id').eq('billing_month', BILLING_MONTH).eq('guest_id', single.camper.id)
  assert.equal(before.data!.length, 1, 'they have a draft to begin with')

  const off = await api('/api/meters', {
    method: 'PATCH', body: JSON.stringify({ id: single.meter.id, billable_override: false }),
  })
  assert.equal(off.status, 200)

  // Re-read it: now record-only, and the draft goes with it.
  await api('/api/meter-readings', {
    method: 'POST', body: JSON.stringify({ meter_id: single.meter.id, session_id: sessionId, reading_value: 1500 }),
  })
  const after1 = await svc!.from('electric_readings')
    .select('id').eq('billing_month', BILLING_MONTH).eq('guest_id', single.camper.id)
  assert.equal(after1.data!.length, 0, 'the draft is withdrawn, not left stranded')

  // The READING survives — that is the point of the permanent record.
  const { data: still } = await svc!.from('meter_readings')
    .select('id, billable').eq('session_id', sessionId).eq('meter_id', single.meter.id)
  assert.equal(still!.length, 1, 'the reading is still recorded')
  assert.equal(still![0].billable, false)

  // Put it back to automatic and confirm the draft returns.
  await api('/api/meters', { method: 'PATCH', body: JSON.stringify({ id: single.meter.id, billable_override: null }) })
  await api('/api/meter-readings', {
    method: 'POST', body: JSON.stringify({ meter_id: single.meter.id, session_id: sessionId, reading_value: 1500 }),
  })
  const after2 = await svc!.from('electric_readings')
    .select('id').eq('billing_month', BILLING_MONTH).eq('guest_id', single.camper.id)
  assert.equal(after2.data!.length, 1, 'automatic billing resumes')
})

// ── THE LINE A WALK MUST NOT CROSS ───────────────────────────────────────────────────────────

test('⚠ A WALK NEVER OVERWRITES A BILL THAT HAS ALREADY BEEN POSTED', { skip }, async () => {
  const q = await (await api(`/api/meter-sessions/${sessionId}`)).json()
  const m = q.meters.find((x: { billable: boolean; camper: unknown }) => x.billable && x.camper)
  const month = `${BILLING_MONTH} posted`

  // A posted bill, written directly — this file does not use the money path. £42.00 and a
  // non-null folio_line_item_id are what make it "already billed and sent".
  const { data: posted } = await svc!.from('electric_readings').insert({
    guest_id: m.camper.id, billing_month: month, previous_reading: 0, current_reading: 100,
    kwh_used: 100, rate_per_kwh: 0.27, minimum_charge: 1500,
    calculated_amount: 4200, final_amount: 4200, status: 'posted',
    folio_line_item_id: '00000000-0000-0000-0000-000000000001',
  }).select().single()

  // A walk that bills to the SAME month.
  const { data: s2 } = await svc!.from('meter_reading_sessions').insert({
    billing_month: month, read_date: '2026-09-02', label: 'collision walk', status: 'in_progress',
  }).select().single()
  const res = await api('/api/meter-readings', {
    method: 'POST', body: JSON.stringify({ meter_id: m.meter.id, session_id: s2!.id, reading_value: 99999 }),
  })
  const body = await res.json()
  assert.equal(res.status, 200)
  assert.ok(body.staged.skippedAlreadyPosted.includes(m.camper.id),
    'the collision is REPORTED, not silent')

  const { data: after } = await svc!.from('electric_readings').select('*').eq('billing_month', month)
  assert.equal(after!.length, 1, 'still exactly one row — no competing draft was created')
  assert.equal(after![0].final_amount, 4200, 'and the posted amount is untouched')
  assert.equal(after![0].status, 'posted')

  // The reading itself is still recorded, which is the correct outcome: the meter was read.
  const { data: reading } = await svc!.from('meter_readings').select('id').eq('session_id', s2!.id)
  assert.equal(reading!.length, 1)
  reading!.forEach(r => createdReadingIds.push(r.id))

  await svc!.from('meter_readings').delete().eq('session_id', s2!.id)
  await svc!.from('meter_reading_sessions').delete().eq('id', s2!.id)
  await svc!.from('electric_readings').delete().eq('id', posted!.id)
})

test('⚠ THE SERVER DECIDES WHO IS BILLED — a crafted request cannot name a camper', { skip }, async () => {
  const q = await (await api(`/api/meter-sessions/${sessionId}`)).json()
  const recordOnly = q.meters.find((x: { billable: boolean }) => !x.billable)
  const someGuest = q.meters.find((x: { camper: unknown }) => x.camper)?.camper

  // Claim a camper and billable status the meter does not have.
  const res = await api('/api/meter-readings', {
    method: 'POST',
    body: JSON.stringify({
      meter_id: recordOnly.meter.id, session_id: sessionId, reading_value: 5000,
      guest_id: someGuest.id, billable: true,   // <- ignored
    }),
  })
  assert.equal(res.status, 200)
  const { data: row } = await svc!.from('meter_readings')
    .select('guest_id, billable').eq('session_id', sessionId).eq('meter_id', recordOnly.meter.id).single()
  assert.equal(row!.billable, false, 'the client cannot make a meter billable')
  assert.equal(row!.guest_id, null, 'nor attach a camper to somebody else’s meter')
})

test('a single ad-hoc read saves with no session and carries forward', { skip }, async () => {
  const { meters } = await (await api('/api/meters')).json()
  const m = meters.find((x: { billable: boolean }) => x.billable)

  const res = await api('/api/meter-readings', {
    method: 'POST',
    body: JSON.stringify({ meter_id: m.meter.id, reading_value: 7777, read_at: '2026-09-14' }),
  })
  assert.equal(res.status, 200)
  const { reading } = await res.json()
  createdReadingIds.push(reading.id)
  assert.equal(reading.session_id, null, 'a mid-month read belongs to no walk')
  assert.equal(reading.read_at, '2026-09-14', 'and carries its own date')

  // ⚠ IT BECOMES THE NEXT "PREVIOUS" — which is what stops the fortnight being billed twice.
  const fresh = await (await api('/api/meters')).json()
  const again = fresh.meters.find((x: { meter: { id: string } }) => x.meter.id === m.meter.id)
  assert.equal(again.previousValue, 7777)
  assert.equal(again.previousReadAt, '2026-09-14')
})
