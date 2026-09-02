// ⚠ THE PROMISE THIS FILE EXISTS TO KEEP: a COMBINED park sees nothing of the two-bucket work.
//
// Separated billing is opt-in and, today, opted into by nobody. Every other park in the fleet is
// combined, and the whole two-account feature — the cards, the payment doors, the renamed
// buckets, the Camp-only electric balance — must be invisible to them. That is not a nice-to-have
// it is the condition under which this could be merged at all.
//
// These tests pin the PURE layer, which is where every gate is decided. The screens then gate on
// normalizeBillingMode(...) === 'separated' before reaching for any of it.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { normalizeBillingMode } from './ledger-lanes.ts'
import { billAccountBalance } from './account-buckets.ts'
import { bucketLabels } from './bucket-labels.ts'
import { normalizeLaneSplit } from './lane-payments.ts'

test('⚠ COMBINED IS THE DEFAULT, AND EVERY UNRECOGNISED VALUE LANDS THERE', () => {
  // A park with no billing_mode column at all reads undefined here. It must be combined, because
  // "we could not tell" and "this park opted in" are very different things.
  assert.equal(normalizeBillingMode(undefined), 'combined')
  assert.equal(normalizeBillingMode(null), 'combined')
  assert.equal(normalizeBillingMode(''), 'combined')
  assert.equal(normalizeBillingMode('nonsense'), 'combined')
  assert.equal(normalizeBillingMode('separated'), 'separated')
  // Case and surrounding whitespace are tolerated on the opt-in value — deliberate, and pinned
  // here so the leniency stays a decision rather than becoming an accident.
  assert.equal(normalizeBillingMode('Separated'), 'separated')
  assert.equal(normalizeBillingMode('  SEPARATED  '), 'separated')
  // But nothing merely resembling it opts a park in.
  assert.equal(normalizeBillingMode('separate'), 'combined')
  assert.equal(normalizeBillingMode('separated-billing'), 'combined')
})

test('a combined electric bill states the whole account, whatever the buckets say', () => {
  // The Camp figure may even be computable; combined must ignore it.
  assert.equal(billAccountBalance('combined', 3200, 163200), 163200)
  assert.equal(billAccountBalance('combined', 0, 163200), 163200)
  assert.equal(billAccountBalance('combined', -900, 163200), 163200)
})

test('bucket labels are inert for a combined park', () => {
  // The columns may not exist, may be null, or may even hold a value from an abandoned trial —
  // none of it reaches a combined screen, because a combined screen never renders a bucket.
  // What is pinned here is that reading them is SAFE and never throws, on any shape.
  for (const s of [null, undefined, {}, { bucket_label_camp: 'Store Account' }]) {
    const l = bucketLabels(s as Parameters<typeof bucketLabels>[0])
    assert.ok(l.camp.length > 0 && l.seasonal.length > 0)
  }
})

test('⚠ THE SPLIT NORMALISER IS UNCHANGED FOR EVERY SHAPE THAT EXISTED BEFORE', () => {
  // Untagged split rows are new. Everything a caller could previously send must normalise
  // EXACTLY as it did, because these rows decide what a card is charged.
  assert.deepEqual(
    normalizeLaneSplit([{ lane: 'seasonal', amount: 1000, surchargeAmount: 30 }]),
    [{ lane: 'seasonal', amount: 1000, surchargeAmount: 30 }],
  )
  assert.deepEqual(
    normalizeLaneSplit([
      { lane: 'electric', amount: 4200, surchargeAmount: 126 },
      { lane: 'store', amount: 900, surchargeAmount: 27 },
    ]),
    [
      { lane: 'electric', amount: 4200, surchargeAmount: 126 },
      { lane: 'store', amount: 900, surchargeAmount: 27 },
    ],
  )
  // And the shapes that were dropped are still dropped — an empty split is what makes the card
  // routes fall back to the caller's own `amount`, so this behaviour is load-bearing.
  assert.deepEqual(normalizeLaneSplit([]), [])
  assert.deepEqual(normalizeLaneSplit([{ lane: '', amount: 100, surchargeAmount: 0 }]), [])
  assert.deepEqual(normalizeLaneSplit([{ lane: 'store', amount: 0, surchargeAmount: 0 }]), [])
})

test('a combined park never has a reason to call the bucket maths at all', () => {
  // Stated as a contract rather than exercised: every caller gates first. This test documents
  // the gate so that a future change which reaches for accountBuckets() unconditionally has to
  // delete a test that says not to, rather than quietly slipping past review.
  const gate = (mode: unknown) => normalizeBillingMode(mode) === 'separated'
  assert.equal(gate('combined'), false)
  assert.equal(gate(undefined), false)
  assert.equal(gate('separated'), true)
})
