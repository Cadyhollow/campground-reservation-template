// Tests for the cross-service refresh request — the tenant's half of step 9.
//
//   node --test lib/square-refresh-request.test.ts
//
// This module sits DIRECTLY IN FRONT OF A PAYMENT. It is called by the credential resolver a few
// milliseconds before a card is charged, and it talks to another service over the network. So the
// property that matters most is not that it refreshes successfully — it is that it cannot take a
// checkout down when it fails. Every failure mode below asserts "returns, does not throw".
//
// The second property is that `refreshed: true` is not claimed loosely. The caller re-reads the
// connection row on that signal alone; claiming it when nothing was written would mean a charge
// proceeding on a token the caller believes is new and isn't.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { requestSquareRefresh, RESONATION_ADMIN_URL } from './square-refresh-request.ts'

const signOk = (id: string) => `v1.signed-state-for-${id}`

/** Swap in a fake fetch for one test, and always put the real one back. */
async function withFetch(
  impl: (url: string, init: any) => Promise<any>,
  fn: (calls: Array<{ url: string; init: any }>) => Promise<void>,
) {
  const calls: Array<{ url: string; init: any }> = []
  const saved = globalThis.fetch
  globalThis.fetch = (async (url: any, init: any) => {
    calls.push({ url: String(url), init })
    return impl(String(url), init)
  }) as unknown as typeof fetch
  try {
    await fn(calls)
  } finally {
    globalThis.fetch = saved
  }
}

const ok = (body: unknown) => async () => ({
  ok: true,
  status: 200,
  json: async () => body,
})

// ── the happy path ────────────────────────────────────────────────────────────────────────────

test('a confirmed refresh reports refreshed: true', async () => {
  await withFetch(ok({ refreshed: true, expires_at: '2026-09-13T00:00:00Z' }), async () => {
    assert.deepEqual(await requestSquareRefresh('pine-ridge', signOk), { refreshed: true })
  })
})

test('it POSTs the SIGNED STATE to the platform, and nothing else', async () => {
  await withFetch(ok({ refreshed: true }), async (calls) => {
    await requestSquareRefresh('pine-ridge', signOk)

    assert.equal(calls.length, 1)
    assert.equal(calls[0].url, `${RESONATION_ADMIN_URL}/api/square/refresh`)
    assert.equal(calls[0].init.method, 'POST')

    // The state is the ENTIRE proof of identity — the same seal as the connect handshake and the
    // revoke call. The body carries no token, no service key and no campground id of its own: the
    // platform reads the park out of the signed payload, so nothing here is steerable by an
    // unsigned field alongside it.
    const body = JSON.parse(calls[0].init.body)
    assert.deepEqual(Object.keys(body), ['state'])
    assert.equal(body.state, 'v1.signed-state-for-pine-ridge')
  })
})

test('the state is signed for the campground being refreshed', async () => {
  await withFetch(ok({ refreshed: true }), async (calls) => {
    await requestSquareRefresh('other-park', signOk)
    assert.equal(JSON.parse(calls[0].init.body).state, 'v1.signed-state-for-other-park')
  })
})

// ── refreshed: false is not a failure ─────────────────────────────────────────────────────────

test('the ordinary "nothing to do" outcomes come back as refreshed: false with a reason', async () => {
  // These are the common answers and none of them is a problem: the token was not actually due,
  // the connection has no refresh token (a dashboard-issued one), or a concurrent charge already
  // holds the single-flight lock. The caller uses the row it already has, which is still valid.
  for (const reason of ['not_due', 'no_refresh_token', 'locked', 'backing_off']) {
    await withFetch(ok({ refreshed: false, reason }), async () => {
      assert.deepEqual(await requestSquareRefresh('pine-ridge', signOk), { refreshed: false, reason })
    })
  }
})

test('a missing `refreshed` field is read as false, never as success', async () => {
  // Defensive against a platform response shape drifting: the caller re-reads the connection row
  // on `refreshed: true` alone, so anything ambiguous must resolve to "nothing changed".
  await withFetch(ok({}), async () => {
    const out = await requestSquareRefresh('pine-ridge', signOk)
    assert.equal(out.refreshed, false)
  })
  await withFetch(ok({ refreshed: 'true' }), async () => {
    // A STRING 'true' is not a confirmation. Strict comparison, on purpose.
    assert.equal((await requestSquareRefresh('pine-ridge', signOk)).refreshed, false)
  })
})

// ── IT MUST NOT TAKE A CHECKOUT DOWN ──────────────────────────────────────────────────────────

test('a 403 from the platform returns, it does not throw', async () => {
  await withFetch(
    async () => ({ ok: false, status: 403, json: async () => ({ error: 'invalid_state' }) }),
    async () => {
      const out = await requestSquareRefresh('pine-ridge', signOk)
      assert.deepEqual(out, { refreshed: false, reason: 'http_403' })
    },
  )
})

test('an unreachable platform returns, it does not throw', async () => {
  await withFetch(
    async () => { throw new Error('ECONNREFUSED') },
    async () => {
      assert.deepEqual(await requestSquareRefresh('pine-ridge', signOk), {
        refreshed: false,
        reason: 'request_failed',
      })
    },
  )
})

test('a non-JSON response returns, it does not throw', async () => {
  await withFetch(
    async () => ({ ok: true, status: 200, json: async () => { throw new Error('not json') } }),
    async () => {
      const out = await requestSquareRefresh('pine-ridge', signOk)
      assert.equal(out.refreshed, false)
    },
  )
})

test('a missing SQUARE_STATE_SECRET cannot break a payment', async () => {
  // signSquareState throws rather than emitting an unsigned state — correct, and this is where
  // that throw has to stop. A park that cannot sign simply cannot refresh; it must still be able
  // to take the payment it holds a perfectly valid token for.
  const signThrows = () => {
    throw new Error('SQUARE_STATE_SECRET is not set — refusing to start an unsigned Square connection.')
  }
  await withFetch(ok({ refreshed: true }), async (calls) => {
    assert.deepEqual(await requestSquareRefresh('pine-ridge', signThrows), {
      refreshed: false,
      reason: 'request_failed',
    })
    assert.equal(calls.length, 0, 'and no unsigned request is sent')
  })
})

// ── where the platform lives ──────────────────────────────────────────────────────────────────

test('the platform URL defaults to production', async () => {
  // Overridable for preview testing, but forgetting to set it must land on the real platform
  // rather than on nothing. Same rule as SQUARE_REDIRECT_URI on the callback.
  assert.equal(RESONATION_ADMIN_URL, process.env.RESONATION_ADMIN_URL || 'https://admin.myresonation.com')
  if (!process.env.RESONATION_ADMIN_URL) {
    assert.equal(RESONATION_ADMIN_URL, 'https://admin.myresonation.com')
  }
})
