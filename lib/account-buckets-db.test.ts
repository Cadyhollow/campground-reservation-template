// The two buckets, against REAL folio rows in the Test Sandbox:
//
//   node --conditions=react-server --test --test-timeout=180000 lib/account-buckets-db.test.ts
//
// WHY A DATABASE TEST AND NOT ONLY UNIT TESTS. lib/account-buckets.test.ts proves the arithmetic
// from a hand-built LaneBalances. What it cannot prove is the thing the feature actually promises:
// that the rows the payment doors WRITE — a seasonal-tagged row and an untagged one — land each
// bucket on exactly zero once they are read back through the real classifier. That spans two
// tables, the `lane` columns on both, and laneBalances()' own classification rules, so it is
// asserted here against rows that really exist.
//
// ⚠ SAFETY. This file writes ONLY to rows it creates itself, under a folio it creates itself,
// and deletes every one of them in `after`. It never touches an existing camper, folio or
// payment, it never calls a money route, and it never reaches a card — there is no Square call
// anywhere in it. `.env.local` in this repo points at the Test Sandbox; a run against anything
// else would still be confined to its own rows, but this is the template, not a live park.
//
// It skips loudly rather than silently if the sandbox is not configured — see the assertion in
// the first test, which fails when credentials are absent instead of quietly passing.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createClient } from '@supabase/supabase-js'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve as resolvePath } from 'node:path'
import { laneBalances } from './ledger-lanes.ts'
import { accountBuckets, paymentLaneForBucket } from './account-buckets.ts'

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
  !placeholder(env.SUPABASE_SERVICE_ROLE_KEY)

const svc = configured
  ? createClient(env.NEXT_PUBLIC_SUPABASE_URL!, env.SUPABASE_SERVICE_ROLE_KEY!)
  : null

const TAG = 'bucket-db-test-' + Date.now()
let folioId = ''
let guestId = ''
const itemIds: string[] = []
const paymentIds: string[] = []

/** Read the folio back through the SAME path the screens use, and bucket it. */
async function readBuckets() {
  const [{ data: items }, { data: pmts }] = await Promise.all([
    svc!.from('folio_line_items').select('id, description, line_total, voided, product_id, lane').eq('folio_id', folioId),
    svc!.from('folio_payments').select('id, amount, surcharge_amount, lane').eq('folio_id', folioId).eq('status', 'completed'),
  ])
  // No electric readings in this fixture: the store charge classifies by product_id and the
  // seasonal charge by its declared lane, which is exactly how the real screens classify them.
  return accountBuckets(laneBalances(items || [], pmts || [], { electricLineItemIds: new Set<string>() }))
}

async function addCharge(description: string, cents: number, lane: string | null) {
  const { data, error } = await svc!.from('folio_line_items').insert({
    folio_id: folioId, description, quantity: 1, unit_price: cents, line_total: cents,
    charged_at: new Date().toISOString(), ...(lane ? { lane } : {}),
  }).select('id').single()
  assert.equal(error, null, `charge "${description}" should insert: ${error?.message}`)
  itemIds.push(data!.id)
  return data!.id as string
}

async function addPayment(cents: number, lane: string | null) {
  const { data, error } = await svc!.from('folio_payments').insert({
    folio_id: folioId, method: 'cash', amount: cents, surcharge_amount: 0,
    status: 'completed', note: TAG, lane,
  }).select('id').single()
  assert.equal(error, null, `payment should insert: ${error?.message}`)
  paymentIds.push(data!.id)
  return data!.id as string
}

before(async () => {
  if (!configured) return
  const { data: guest, error: gErr } = await svc!.from('guests').insert({
    name: TAG, email: `${TAG}@example.invalid`, is_seasonal: true,
  }).select('id').single()
  assert.equal(gErr, null, `test guest should insert: ${gErr?.message}`)
  guestId = guest!.id
  const { data: folio, error: fErr } = await svc!.from('folios').insert({
    reservation_id: null, guest_id: guestId, guest_name: TAG, guest_email: `${TAG}@example.invalid`,
    folio_type: 'guest_account', status: 'open', label: TAG,
  }).select('id').single()
  assert.equal(fErr, null, `test folio should insert: ${fErr?.message}`)
  folioId = folio!.id
})

after(async () => {
  if (!configured || !folioId) return
  // Deleted in dependency order, and only ever the ids this file created.
  if (paymentIds.length) await svc!.from('folio_payments').delete().in('id', paymentIds)
  if (itemIds.length) await svc!.from('folio_line_items').delete().in('id', itemIds)
  await svc!.from('folios').delete().eq('id', folioId)
  if (guestId) await svc!.from('guests').delete().eq('id', guestId)
})

test('the sandbox is configured — a skipped run is not a passing run', () => {
  assert.ok(
    configured,
    'lib/account-buckets-db.test.ts needs NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY ' +
    'in .env.local (the Test Sandbox project). Refusing to report success without running.',
  )
})

test('a real seasonal charge lands in Seasonal, a real store charge in Camp', async () => {
  await addCharge('Season fee 2027', 189500, 'seasonal')
  // No lane, but a product_id would make it store; without one it is `other` — which still folds
  // into Camp, which is the point of the bucket.
  await addCharge('Firewood', 2000, null)
  const b = await readBuckets()
  assert.equal(b.seasonal.balance, 189500)
  assert.equal(b.camp.balance, 2000)
  assert.equal(b.camp.balance + b.seasonal.balance, b.accountBalance)
})

test('⚠ AN UNTAGGED PAYMENT REDUCES CAMP, NOT SEASONAL — the historical shape', async () => {
  // The overwhelming majority of a park's existing payments carry no lane. They must read as
  // everyday money, or every camper appears to owe their whole store history over again.
  await addPayment(2000, null)
  const b = await readBuckets()
  assert.equal(b.camp.balance, 0, 'the untagged payment settled the everyday charge')
  assert.equal(b.seasonal.balance, 189500, 'and left the season fee untouched')
})

test('⚠ "PAY BOTH" WRITES TWO ROWS AND LANDS EACH BUCKET ON ZERO', async () => {
  // Exactly what the doors write: one row per bucket, Seasonal tagged and Camp untagged, from a
  // single tender. Re-charge the everyday side first so both buckets owe something.
  await addCharge('Propane', 4500, null)
  const before = await readBuckets()
  assert.equal(before.camp.balance, 4500)
  assert.equal(before.seasonal.balance, 189500)

  const rows = [
    { lane: paymentLaneForBucket('camp'), amount: before.camp.balance },
    { lane: paymentLaneForBucket('seasonal'), amount: before.seasonal.balance },
  ]
  assert.equal(rows.length, 2, 'Pay both is two rows, never one')
  assert.equal(rows[0].lane, null, 'the Camp row is untagged')
  assert.equal(rows[1].lane, 'seasonal', 'the Seasonal row is tagged')
  for (const r of rows) await addPayment(r.amount, r.lane)

  const after = await readBuckets()
  assert.equal(after.camp.balance, 0, 'Camp settles exactly')
  assert.equal(after.seasonal.balance, 0, 'Seasonal settles exactly')
  assert.equal(after.accountBalance, 0)
})

test('a seasonal overpayment stays a Seasonal credit and does not bleed into Camp', async () => {
  await addCharge('Storage', 1000, null)
  await addPayment(5000, 'seasonal')
  const b = await readBuckets()
  assert.equal(b.seasonal.balance, -5000, 'the overpayment is a credit in its own bucket')
  assert.equal(b.camp.balance, 1000, 'everyday money is untouched by it')
  assert.equal(b.camp.balance + b.seasonal.balance, b.accountBalance)
})

test('THE INVARIANT HOLDS ON REAL ROWS: camp + seasonal === accountBalance', async () => {
  const b = await readBuckets()
  assert.equal(b.camp.balance + b.seasonal.balance, b.accountBalance)
})
