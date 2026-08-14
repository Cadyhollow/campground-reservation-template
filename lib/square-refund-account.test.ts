// Tests for the refund-account pre-flight — the guard that stops a refund being drawn from a
// Square account that never took the payment.
//
//   node --conditions=react-server --test lib/square-refund-account.test.ts
//
// THE FLAG IS NOT OPTIONAL: square-refund-account.ts opens with `import 'server-only'`. See the
// header of square-credentials.test.ts for why.
//
// The property pinned here is a pair, and the pair is the whole design:
//
//   A DEFINITE "this payment is not on this account" blocks the refund.
//   ANYTHING ELSE — timeout, 500, 401, rate limit — lets it through.
//
// Both halves matter and they fail in opposite directions. Losing the first half means a park
// that switched Square accounts refunds a guest out of the wrong merchant's balance. Losing the
// second means a Square outage, or a token that has merely gone stale, silently stops every
// legitimate refund in the building — which is the far likelier event, and one where Square is
// still the backstop because it rejects a cross-account refund itself.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { verifyPaymentOnAccount } from './square-refund-account.ts'
import type { SquareCreds } from './square-credentials.ts'

const CREDS: SquareCreds = {
  accessToken: 'sq0atp-connection-token',
  locationId: 'LOC_CONNECTED',
  applicationId: 'sq0idp-app',
  environment: 'sandbox',
  apiBase: 'https://connect.squareupsandbox.com',
  source: 'connection',
}

/** Swap global fetch for the duration of one case, then put it back. */
async function withFetch(
  impl: (url: string, init?: RequestInit) => Promise<Response> | never,
  run: () => Promise<void>,
) {
  const original = globalThis.fetch
  globalThis.fetch = impl as unknown as typeof fetch
  try {
    await run()
  } finally {
    globalThis.fetch = original
  }
}

const okResponse = () => new Response(JSON.stringify({ payment: { id: 'PAY123' } }), { status: 200 })
const notFound = () => new Response(JSON.stringify({ errors: [{ code: 'NOT_FOUND' }] }), { status: 404 })

test('a payment the account knows about is refundable', async () => {
  await withFetch(async () => okResponse(), async () => {
    const result = await verifyPaymentOnAccount(CREDS, 'PAY123')
    assert.equal(result.ok, true)
  })
})

test('a 404 blocks the refund — the payment belongs to a different Square account', async () => {
  await withFetch(async () => notFound(), async () => {
    const result = await verifyPaymentOnAccount(CREDS, 'PAY_FROM_OLD_MERCHANT')
    assert.equal(result.ok, false)
    if (result.ok) return
    // The operator has to be told what to do instead, not merely that it failed: the money is
    // genuinely owed and it is sitting in an account this deployment can no longer reach.
    assert.match(result.error, /Square dashboard/i)
  })
})

test('the lookup is addressed to the resolved account — host and token, not env vars', async () => {
  let seenUrl = ''
  let seenAuth = ''
  await withFetch(async (url, init) => {
    seenUrl = url
    seenAuth = String((init?.headers as Record<string, string>)?.Authorization ?? '')
    return okResponse()
  }, async () => {
    await verifyPaymentOnAccount(CREDS, 'PAY123')
  })
  // Sandbox host because the CONNECTION says sandbox. If this ever reads connect.squareup.com
  // while the token is a sandbox token, the guard is checking a different account than the one
  // the refund will be sent to, which makes it worse than no guard at all.
  assert.equal(seenUrl, 'https://connect.squareupsandbox.com/v2/payments/PAY123')
  assert.equal(seenAuth, `Bearer ${CREDS.accessToken}`)
})

test('a network failure does NOT block the refund', async () => {
  await withFetch(async () => { throw new Error('ECONNRESET') }, async () => {
    const result = await verifyPaymentOnAccount(CREDS, 'PAY123')
    assert.equal(result.ok, true)
  })
})

test('a 500 does NOT block the refund — it says nothing about ownership', async () => {
  await withFetch(async () => new Response('{}', { status: 500 }), async () => {
    const result = await verifyPaymentOnAccount(CREDS, 'PAY123')
    assert.equal(result.ok, true)
  })
})

test('a 401 does NOT block the refund — Square rejects it downstream anyway', async () => {
  await withFetch(async () => new Response('{}', { status: 401 }), async () => {
    const result = await verifyPaymentOnAccount(CREDS, 'PAY123')
    assert.equal(result.ok, true)
  })
})

test('a payment id with awkward characters is escaped into the path', async () => {
  let seenUrl = ''
  await withFetch(async (url) => { seenUrl = url; return okResponse() }, async () => {
    await verifyPaymentOnAccount(CREDS, 'PAY/../locations')
  })
  // Square ids are opaque, and one arriving from the database with a slash in it must not be
  // able to steer the request at a different endpoint.
  assert.equal(seenUrl, 'https://connect.squareupsandbox.com/v2/payments/PAY%2F..%2Flocations')
})
