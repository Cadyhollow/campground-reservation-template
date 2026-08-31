import { test } from 'node:test'
import assert from 'node:assert/strict'
import { paymentLines, balanceLine, receiptDate, receiptMoney } from './receipt-lines.ts'

// How the receipt reads.
//
// The bug this file exists to prevent: a figure printed under a label that does not describe it.
// "Seasonal fee $0.00" on a receipt for a camper who paid $1,895.00 is the worst kind of wrong —
// the arithmetic was right and nothing looked broken.

test('a cheque or cash payment is ONE line', () => {
  // paid_at is a timestamptz in the schema, so this is the realistic shape.
  const lines = paymentLines({ method: 'check', paid_at: '2026-08-31T14:05:00Z', amount: 94750, surcharge_amount: 0 })
  assert.equal(lines.length, 1)
  assert.equal(lines[0].amount, 94750)
  assert.match(lines[0].label, /^Payment — check · Aug 31, 2026$/)
})

test('a CARD payment shows net, fee and gross so the arithmetic closes', () => {
  // The balance comes off the NET; the camper's card was charged the GROSS. A receipt printing
  // only one of the two cannot be reconciled by the person holding it.
  const lines = paymentLines({ method: 'card', paid_at: '2026-08-31', amount: 97500, surcharge_amount: 2750 })
  assert.equal(lines.length, 3)
  assert.deepEqual(lines.map(l => l.amount), [94750, 2750, 97500])
  assert.equal(lines[0].amount + lines[1].amount, lines[2].amount, 'net + fee must equal the gross')
  assert.match(lines[1].label, /Transaction fee/)
  assert.match(lines[2].label, /Total charged/)
})

test('a REFUND says "Total refunded" — "charged" would read backwards', () => {
  const lines = paymentLines({ method: 'card', paid_at: '2026-08-31', amount: -97500, surcharge_amount: -2750 })
  assert.match(lines[2].label, /Total refunded/)
  assert.equal(lines[0].amount, -94750)
})

test('a DATE-ONLY value does not print the day before — the classic receipt off-by-one', () => {
  // new Date('2026-08-31') is midnight UTC, which is August 30th anywhere west of Greenwich. A
  // payment printing on a camper's receipt a day before they made it is the kind of error that
  // gets argued about at the counter.
  assert.equal(receiptDate('2026-08-31'), 'Aug 31, 2026')
  assert.equal(receiptDate('2026-01-01'), 'Jan 1, 2026')
})

test('a note rides along on the label, and a missing date does not print "Invalid Date"', () => {
  assert.match(paymentLines({ method: 'check', paid_at: '2026-08-31', note: '#1042', amount: 100, surcharge_amount: 0 })[0].label, /#1042/)
  assert.doesNotMatch(paymentLines({ method: 'cash', paid_at: null, amount: 100 })[0].label, /Invalid Date/)
})

test('the balance says what it MEANS, in all three states', () => {
  assert.deepEqual(balanceLine(0), { label: 'Balance', value: '✓ Paid in full', paid: true })
  assert.deepEqual(balanceLine(94750), { label: 'Balance due', value: '$947.50', paid: false })
  // An early deposit taken before the fee is posted — a real autumn case, not an error.
  assert.deepEqual(balanceLine(-50000), { label: 'Credit on account', value: '$500.00', paid: true })
})

test('the balance is never labelled with the fee — the bug this replaces', () => {
  // A camper who has paid in full: the fee was $1,895.00 and the balance is $0.00. Whatever the
  // receipt prints for the balance, it must not be the thing the word "fee" points at.
  const b = balanceLine(0)
  assert.doesNotMatch(b.label, /fee/i, 'the balance line called itself a fee')
  assert.equal(b.value, '✓ Paid in full', 'a bare $0.00 beside "fee" is exactly the confusion')
})

test('money prints with a thousands separator — the value is unchanged, only its rendering', () => {
  assert.equal(receiptMoney(189500), '$1,895.00')
  assert.equal(receiptMoney(94750), '$947.50')
  assert.equal(receiptMoney(0), '$0.00')
  // Always absolute: the minus sign is placed by the caller, so "−$-947.50" is impossible.
  assert.equal(receiptMoney(-94750), '$947.50')
})

test('a SECTION on the account receipt is a subtotal — not a second "Balance due"', () => {
  // The account receipt shows per-lane sections AND a grand total. Labelling both "Balance due"
  // printed the same words and the same figure twice on a single-lane account — the duplication
  // this work removed, reappearing one card lower.
  assert.equal(balanceLine(184800, 'subtotal').label, 'Subtotal due')
  assert.equal(balanceLine(184800).label, 'Balance due')
  assert.notEqual(balanceLine(184800, 'subtotal').label, balanceLine(184800).label)
  // The figure is the same in both — only the word describing it changes.
  assert.equal(balanceLine(184800, 'subtotal').value, balanceLine(184800).value)
})

test('subtotal wording covers paid and credit too', () => {
  assert.equal(balanceLine(0, 'subtotal').value, '✓ Paid in full')
  assert.equal(balanceLine(-5000, 'subtotal').label, 'Subtotal — credit')
})
