// The split-payment normaliser. Pure — `node --test`, no server, no DB.
//
// These exist because a dropped split row is SILENT: the card routes fall back to the caller's
// own `amount` when a split normalises to empty (`split.length ? laneSplitTotal(split) : amount`),
// so a row lost here charges one figure while the screen shows another and every page still
// reconciles. The two-bucket "Pay both" tender depends on an untagged row surviving.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { normalizeLaneSplit, laneSplitTotal } from './lane-payments.ts'
import { paymentLaneForBucket } from './account-buckets.ts'

test('an ordinary tagged split is unchanged', () => {
  assert.deepEqual(
    normalizeLaneSplit([{ lane: 'seasonal', amount: 90363, surchargeAmount: 0 }]),
    [{ lane: 'seasonal', amount: 90363, surchargeAmount: 0 }],
  )
})

test('⚠ AN EXPLICIT null LANE SURVIVES — it is the Camp half of "Pay both"', () => {
  const split = normalizeLaneSplit([
    { lane: null, amount: 3200, surchargeAmount: 0 },
    { lane: 'seasonal', amount: 90363, surchargeAmount: 0 },
  ])
  assert.equal(split.length, 2, 'both rows must survive')
  assert.equal(split[0].lane, null)
  assert.equal(split[1].lane, 'seasonal')
  // And the card is charged the whole thing, not just the tagged half.
  assert.equal(laneSplitTotal(split), 93563)
})

test('a MISSING or EMPTY lane is still dropped, exactly as before', () => {
  // Malformed input, not a deliberate whole-account row. Dropping it is the existing guard that
  // keeps a garbled request from being charged.
  assert.deepEqual(normalizeLaneSplit([{ amount: 500, surchargeAmount: 0 }]), [])
  assert.deepEqual(normalizeLaneSplit([{ lane: '', amount: 500, surchargeAmount: 0 }]), [])
  assert.deepEqual(normalizeLaneSplit([{ lane: undefined, amount: 500, surchargeAmount: 0 }]), [])
})

test('zero and negative amounts are dropped whether tagged or not', () => {
  assert.deepEqual(normalizeLaneSplit([{ lane: null, amount: 0, surchargeAmount: 0 }]), [])
  assert.deepEqual(normalizeLaneSplit([{ lane: 'store', amount: -100, surchargeAmount: 0 }]), [])
})

test('the bucket doors produce exactly the lanes this normaliser must accept', () => {
  // The contract between account-buckets and lane-payments, asserted rather than assumed.
  assert.equal(paymentLaneForBucket('seasonal'), 'seasonal')
  assert.equal(paymentLaneForBucket('camp'), null)
  const split = normalizeLaneSplit([
    { lane: paymentLaneForBucket('camp'), amount: 3200, surchargeAmount: 96 },
    { lane: paymentLaneForBucket('seasonal'), amount: 90363, surchargeAmount: 2711 },
  ])
  assert.equal(split.length, 2)
  assert.deepEqual(split.map(l => l.lane), [null, 'seasonal'])
})

test('a non-array, or junk, is an empty split rather than a throw', () => {
  for (const junk of [null, undefined, 'nope', 42, {}]) {
    assert.deepEqual(normalizeLaneSplit(junk), [])
  }
})

test('laneSplitTotal sums the rows that will be written, surcharge excluded', () => {
  // ⚠ The card routes charge laneSplitTotal(). Each row's `amount` is what the caller intends to
  // charge for that row; the surcharge travels alongside for the ledger.
  const split = normalizeLaneSplit([
    { lane: null, amount: 1000, surchargeAmount: 30 },
    { lane: 'seasonal', amount: 2000, surchargeAmount: 60 },
  ])
  assert.equal(laneSplitTotal(split), 3000)
})
