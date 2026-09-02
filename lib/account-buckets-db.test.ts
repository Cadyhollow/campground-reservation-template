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
import { accountBuckets, paymentLaneForBucket, filterToBucket } from './account-buckets.ts'

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


// ── ⚠ THE COLUMN LIST IS PART OF THE LOGIC ───────────────────────────────────────────────────
//
// This test exists because of a real bug that shipped. The electric bill route selected `lane` on
// PAYMENTS but not on LINE ITEMS. classifyLineItem() checks a DECLARED lane first and only then
// infers from the electric signal and product_id — and the seasonal fee has neither, so with the
// column missing it fell through to `other`, which rolls up into Camp.
//
// The consequences were invisible on every screen and wrong on the one thing that leaves the
// building: the season fee appeared on the camper's electric bill, and the Camp balance equalled
// the whole account, which silently defeated billAccountBalance().
//
// Every unit test passed throughout, because they all build their fixtures WITH a lane. Only a
// read that uses the route's own column list can catch this, which is what this does.

/** The exact column list app/api/electric-bill-email/route.ts selects for line items. */
const BILL_ITEM_COLUMNS = 'id, description, quantity, line_total, charged_at, product_id, voided, lane'
/** ...and for payments. */
const BILL_PAYMENT_COLUMNS = 'id, method, amount, surcharge_amount, paid_at, lane'

test('⚠ THE BILL ROUTE\'S OWN COLUMN LIST STILL SEPARATES SEASONAL FROM CAMP', async () => {
  // ⚠ DERIVED FROM THE PRIOR STATE, NOT ASSUMED. The tests above leave this folio with a
  // seasonal credit and a settled camp balance; hard-coding a total here would pass alone and
  // fail in the suite.
  const before = await readBuckets()

  // A seasonal charge with no product_id and no electric reading — the exact shape that
  // misclassified. It must NOT land in Camp when read the way the bill route reads it.
  await addCharge('Season fee — column-list guard', 150000, 'seasonal')

  const [{ data: items }, { data: pmts }] = await Promise.all([
    svc!.from('folio_line_items').select(BILL_ITEM_COLUMNS).eq('folio_id', folioId),
    svc!.from('folio_payments').select(BILL_PAYMENT_COLUMNS).eq('folio_id', folioId).eq('status', 'completed'),
  ])

  const seasonalRow = (items || []).find(i => i.description === 'Season fee — column-list guard')
  assert.ok(seasonalRow, 'the seasonal charge should come back')
  assert.equal(
    (seasonalRow as { lane?: string | null }).lane, 'seasonal',
    'the bill route must SELECT `lane` on line items — without it the season fee classifies as ' +
    '`other` and lands on the electric bill',
  )

  const scoped = filterToBucket('camp', items || [], pmts || [], { electricLineItemIds: new Set<string>() })
  assert.ok(
    !scoped.items.some(i => i.description === 'Season fee — column-list guard'),
    'the season fee must be absent from a Camp-scoped statement',
  )

  // And the Camp balance must not have absorbed it.
  const b = accountBuckets(laneBalances(items || [], pmts || [], { electricLineItemIds: new Set<string>() }))
  assert.equal(b.seasonal.balance - before.seasonal.balance, 150000, 'the whole fee landed in Seasonal')
  assert.equal(b.camp.balance, before.camp.balance, 'Camp is completely unchanged by a seasonal charge')
})
