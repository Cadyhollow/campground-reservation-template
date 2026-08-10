// Fail-safe tests for the Square environment toggle. Framework-free — runs on Node's built-in
// runner with type stripping, no dependencies:
//
//   node --test lib/square-env.test.ts
//
// This file exists because the toggle it covers decides whether a card is charged for REAL
// money or for fake money, and the dangerous direction is silent. A deployment wrongly on
// sandbox still "succeeds" — bookings confirm, the folio says paid — while no revenue arrives.
// So the property under test is not "sandbox works", it is:
//
//   ANY value that is not exactly the word "sandbox" must resolve to PRODUCTION.
//
// The matrix below is deliberately full of near-misses — the empty string, 'prod',
// 'PRODUCTION', 'sandbox ' with a space, a typo, an unset variable — because those are the
// realistic ways a dashboard entry goes wrong. Every one of them must land on production.
//
// It also pins the production-unchanged claim: with the variable set to 'production', as every
// real environment has it, the resolved URLs must be byte-identical to the literals that were
// hardcoded before this toggle existed.

import { test } from 'node:test'
import assert from 'node:assert/strict'

const PROD_API = 'https://connect.squareup.com'
const PROD_SDK = 'https://web.squarecdn.com/v1/square.js'
const SANDBOX_API = 'https://connect.squareupsandbox.com'
const SANDBOX_SDK = 'https://sandbox.web.squarecdn.com/v1/square.js'

// The module reads the variable once at load, so each case needs a fresh module instance.
// A distinct query string defeats the ESM module cache.
let n = 0
async function resolveWith(value: string | undefined) {
  if (value === undefined) delete process.env.NEXT_PUBLIC_SQUARE_ENVIRONMENT
  else process.env.NEXT_PUBLIC_SQUARE_ENVIRONMENT = value
  const mod = await import(`./square-env.ts?case=${n++}`)
  return {
    isSandbox: mod.SQUARE_IS_SANDBOX as boolean,
    api: mod.SQUARE_API_BASE as string,
    sdk: mod.SQUARE_SDK_URL as string,
  }
}

// Every one of these must fail SAFE to production. Unset is listed first because it is the
// case the old inline ternaries got backwards: all five sent an unconfigured deployment to
// sandbox.
const MUST_BE_PRODUCTION: Array<[string, string | undefined]> = [
  ['unset', undefined],
  ['empty string', ''],
  ['whitespace only', '   '],
  ['production', 'production'],
  ['PRODUCTION', 'PRODUCTION'],
  ['Production', 'Production'],
  ['prod', 'prod'],
  ['live', 'live'],
  ['typo: sandbx', 'sandbx'],
  ['typo: sanbox', 'sanbox'],
  ['substring: sandboxed', 'sandboxed'],
  ['substring: not-sandbox', 'not-sandbox'],
  ['prefixed: xsandbox', 'xsandbox'],
  ['boolean-ish: true', 'true'],
  ['boolean-ish: false', 'false'],
  ['numeric', '1'],
]

for (const [label, value] of MUST_BE_PRODUCTION) {
  test(`fails safe to production: ${label}`, async () => {
    const r = await resolveWith(value)
    assert.equal(r.isSandbox, false, `${label} must NOT be sandbox`)
    assert.equal(r.api, PROD_API)
    assert.equal(r.sdk, PROD_SDK)
  })
}

// Sandbox is reachable only by the exact word. Case and surrounding whitespace are forgiven —
// both normalise TOWARD the opt-in, which is the only direction where being lenient is safe:
// a human who typed the word meant it, and the alternative is a Preview quietly charging real
// cards. No other string gets there.
const MUST_BE_SANDBOX: Array<[string, string]> = [
  ['exact', 'sandbox'],
  ['uppercase', 'SANDBOX'],
  ['mixed case', 'Sandbox'],
  ['trailing space', 'sandbox '],
  ['leading space', ' sandbox'],
]

for (const [label, value] of MUST_BE_SANDBOX) {
  test(`opts in to sandbox: ${label}`, async () => {
    const r = await resolveWith(value)
    assert.equal(r.isSandbox, true, `${label} should be sandbox`)
    assert.equal(r.api, SANDBOX_API)
    assert.equal(r.sdk, SANDBOX_SDK)
  })
}

// The production-unchanged proof, stated as an assertion rather than a claim: these are the
// exact literals that were hardcoded at every Square call site before the toggle landed.
test('production resolves to the previously-hardcoded literals', async () => {
  const r = await resolveWith('production')
  assert.equal(r.api, 'https://connect.squareup.com')
  assert.equal(r.sdk, 'https://web.squarecdn.com/v1/square.js')
})

// The two halves must always agree. A card tokenized by the sandbox SDK and charged against
// the production API (or the reverse) is the mismatch a second, separate variable would have
// made possible; one variable feeding both makes it unrepresentable, and this pins that.
test('SDK and API always describe the same environment', async () => {
  for (const [, value] of [...MUST_BE_PRODUCTION, ...MUST_BE_SANDBOX]) {
    const r = await resolveWith(value)
    assert.equal(r.api.includes('sandbox'), r.sdk.includes('sandbox'),
      `SDK and API disagree for ${JSON.stringify(value)}`)
    assert.equal(r.api.includes('sandbox'), r.isSandbox)
  }
})
