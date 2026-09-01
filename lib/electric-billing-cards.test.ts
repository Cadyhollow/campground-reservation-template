import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  cardStatus, primaryLabel, menuFor, tallyCards, matchesFilter, owesBalance,
  CARD_MENU, ACTION_HANDLER_NOTES,
  type CardRow, type MenuActionId,
} from './electric-billing-cards.ts'
import { planElectricPost } from './electric-billing.ts'

// The Electric Billing redesign moves most per-camper controls into a "⋯" menu.
//
// ⚠ THE POINT OF THIS FILE IS THAT A PRESENTATION CHANGE DID NOT BECOME A CAPABILITY CHANGE.
// The old page carried eight controls per row: Bill Electric · Send Statement · "wrong email?" ·
// Record Payment / Prepay · Send Receipt · View History · Skip. Losing one of those in a reskin
// would be silent — the screen would simply look calmer and do less. These tests name each one.

const row = (over: Partial<CardRow> = {}): CardRow => ({
  sent: false, skip: false, hasEmail: true, hasRecordedPayment: false,
  anomaly: false, anomalyAcknowledged: false, meterLines: 1, finalAmount: '15.00',
  balanceCents: 0,
  ...over,
})

// ── STATUS ───────────────────────────────────────────────────────────────────────────────────

test('a staged, ordinary reading is ready', () => {
  assert.equal(cardStatus(row()), 'ready')
  assert.equal(primaryLabel('ready'), 'Bill')
})

test('a flagged reading is "worth a look", and its button says Review — not Bill', () => {
  // The existing anomaly guard already refuses to post this row in one click. A button reading
  // "Bill" would promise something it then declines to do.
  assert.equal(cardStatus(row({ anomaly: true })), 'attention')
  assert.equal(primaryLabel('attention'), 'Review')
})

test('acknowledging the anomaly returns the card to ready', () => {
  assert.equal(cardStatus(row({ anomaly: true, anomalyAcknowledged: true })), 'ready')
})

test('a posted bill is billed, and that wins over everything else', () => {
  assert.equal(cardStatus(row({ sent: true, anomaly: true })), 'billed')
  assert.equal(cardStatus(row({ sent: true, meterLines: 0 })), 'billed')
  assert.equal(primaryLabel('billed'), 'Billed')
})

test('an amount with no meter reading behind it is a manual bill', () => {
  // The broken-meter case: read by a separate device, amount typed in.
  assert.equal(cardStatus(row({ meterLines: 0, finalAmount: '42.21' })), 'manual')
})

test('a row not filled in yet is ready, not manual', () => {
  // No lines AND no amount is simply blank. Calling it "manual" would claim somebody set it.
  assert.equal(cardStatus(row({ meterLines: 0, finalAmount: '' })), 'ready')
  assert.equal(cardStatus(row({ meterLines: 0, finalAmount: '   ' })), 'ready')
})

// ── ⚠ NOTHING WAS LOST IN THE MOVE ───────────────────────────────────────────────────────────

test('⚠ every action the old page had is still reachable', () => {
  const ids = menuFor(row()).map(a => a.id)
  // The primary button covers Bill; these are the seven the row used to carry.
  for (const id of ['resend', 'resend-other-email', 'payment', 'history', 'dont-bill', 'folio-receipt'] as MenuActionId[]) {
    assert.ok(ids.includes(id), `${id} vanished from the menu`)
  }
  // And "Adjust & re-bill" is the billed-row equivalent of the old inline edit.
  assert.ok(menuFor(row({ sent: true })).map(a => a.id).includes('adjust'))
})

test('⚠ every menu action names the existing handler it runs', () => {
  // The redesign relocates controls; it reimplements none of them. If an id ever appears with no
  // note, somebody has added an action without saying what it calls.
  for (const a of CARD_MENU) {
    assert.ok(ACTION_HANDLER_NOTES[a.id], `${a.id} has no handler note`)
    assert.ok(ACTION_HANDLER_NOTES[a.id].length > 10, `${a.id}'s note says nothing useful`)
  }
  assert.equal(Object.keys(ACTION_HANDLER_NOTES).length, CARD_MENU.length,
    'the handler notes and the menu have drifted apart')
})

test('every menu item has a label and a distinct id', () => {
  const ids = CARD_MENU.map(a => a.id)
  assert.equal(new Set(ids).size, ids.length, 'duplicate menu ids')
  for (const a of CARD_MENU) assert.ok(a.label.trim().length > 0, `${a.id} has no label`)
})

// ── THE PREDICATES MIRROR THE OLD PAGE'S CONDITIONS ─────────────────────────────────────────

test('"Send another copy" is hidden without an email, as the old button was disabled', () => {
  assert.ok(!menuFor(row({ hasEmail: false })).map(a => a.id).includes('resend'))
  assert.ok(menuFor(row({ hasEmail: true })).map(a => a.id).includes('resend'))
})

test('a corrected address is offered even with no email on file — that is when it is needed', () => {
  assert.ok(menuFor(row({ hasEmail: false })).map(a => a.id).includes('resend-other-email'))
})

test('"Don\'t bill this month" disappears once the bill is posted, and flips back when skipped', () => {
  assert.ok(menuFor(row()).map(a => a.id).includes('dont-bill'))
  assert.ok(!menuFor(row({ sent: true })).map(a => a.id).includes('dont-bill'))
  // Skipping is reversible — the old toggle worked both ways and so does this.
  const skipped = menuFor(row({ skip: true })).map(a => a.id)
  assert.ok(skipped.includes('do-bill'))
  assert.ok(!skipped.includes('dont-bill'))
})

test('"Adjust & re-bill" appears only on a billed card', () => {
  assert.ok(!menuFor(row()).map(a => a.id).includes('adjust'))
  assert.ok(menuFor(row({ sent: true })).map(a => a.id).includes('adjust'))
})

test('the folio, a payment and the history are always reachable', () => {
  // Including on a billed card — a settled bill still needs receipts and payments.
  for (const r of [row(), row({ sent: true }), row({ skip: true }), row({ hasEmail: false })]) {
    const ids = menuFor(r).map(a => a.id)
    for (const id of ['folio-receipt', 'payment', 'history']) {
      assert.ok(ids.includes(id as MenuActionId), `${id} missing`)
    }
  }
})

// ── COUNTS AND THE VIEW FILTER ───────────────────────────────────────────────────────────────

test('the summary counts each camper exactly once', () => {
  const rows = [row(), row(), row({ anomaly: true }), row({ sent: true }), row({ meterLines: 0, finalAmount: '9.00' })]
  const t = tallyCards(rows)
  assert.deepEqual(t, { ready: 3, attention: 1, billed: 1, owing: 0, everyone: 5 })
  assert.equal(t.ready + t.attention + t.billed, t.everyone, 'every card lands in exactly one pile')
})

test('a manual bill is counted as ready — it is awaiting the same decision', () => {
  assert.equal(tallyCards([row({ meterLines: 0, finalAmount: '42.21' })]).ready, 1)
})

test('⚠ the filter only hides cards — it decides nothing about billing', () => {
  const ready = row(), attn = row({ anomaly: true }), billed = row({ sent: true })
  assert.ok(matchesFilter(ready, 'ready') && !matchesFilter(attn, 'ready') && !matchesFilter(billed, 'ready'))
  assert.ok(matchesFilter(attn, 'attention') && !matchesFilter(ready, 'attention'))
  assert.ok(matchesFilter(billed, 'billed') && !matchesFilter(ready, 'billed'))
  // "Everyone" is the escape hatch — nothing can be permanently hidden from the owner.
  for (const r of [ready, attn, billed]) assert.ok(matchesFilter(r, 'everyone'))
})

test('a manual card shows up under Ready, so it cannot get lost between filters', () => {
  const manual = row({ meterLines: 0, finalAmount: '42.21' })
  assert.ok(matchesFilter(manual, 'ready'))
  assert.ok(matchesFilter(manual, 'everyone'))
})


// ── ⚠ SEND ALL STILL POSTS ONLY THE READY ONES ───────────────────────────────────────────────
//
// The page's bulk loop is `if (!row.skip && !row.sent) sendBill(i)`, and sendBill() then asks
// planElectricPost() — which checks the DATABASE for an existing posted bill. This models that
// composition, because the redesign must not have widened what a single click bills.

/** What the page would actually post, given a set of cards. */
function sendAllWouldPost(rows: (CardRow & { alreadyPostedInDb?: boolean })[]): number[] {
  const posted: number[] = []
  rows.forEach((r, i) => {
    if (r.skip || r.sent) return                       // the bulk loop's own skip
    const plan = planElectricPost({                     // sendBill()'s guard
      alreadyPostedThisMonth: r.alreadyPostedInDb ?? r.sent,
      skipped: r.skip,
      draftId: null,
      finalAmountCents: Math.round(parseFloat(r.finalAmount || '0') * 100),
    })
    if (plan.action === 'post') posted.push(i)
  })
  return posted
}

test('⚠ Send All bills the ready ones and no one else', () => {
  const rows = [
    row(),                                              // 0 ready        -> bills
    row({ sent: true }),                                // 1 billed       -> skipped
    row({ skip: true }),                                // 2 don't bill   -> skipped
    row({ anomaly: true }),                             // 3 worth a look -> see below
    row({ finalAmount: '' }),                           // 4 no amount    -> skipped
    row({ meterLines: 0, finalAmount: '42.21' }),       // 5 manual       -> bills
  ]
  assert.deepEqual(sendAllWouldPost(rows), [0, 3, 5])
})

test('⚠ a leftover orphan draft cannot be billed a second time by Send All', () => {
  // The September incident: the row looks unsent to the screen, but the database already holds a
  // posted bill for that month. This is the case the guard exists for.
  const rows = [row({ sent: false }), row({ sent: false })]
  rows[1].finalAmount = '183.87'
  assert.deepEqual(
    sendAllWouldPost([rows[0], { ...rows[1], alreadyPostedInDb: true }]),
    [0], 'only the genuinely unbilled camper is charged')
})

test('a "worth a look" card is still reachable by Send All — the per-card guard is what stops it', () => {
  // Deliberately recorded rather than asserted away: the bulk loop does not filter on the anomaly,
  // and it should not silently drop somebody. The single-card path is where the guard withholds
  // the one-click post, and the batch confirm names the count before anything is sent.
  assert.deepEqual(sendAllWouldPost([row({ anomaly: true })]), [0])
})


// ── ⚠ THE BALANCE PILL: WHAT THEY OWE, NOT WHAT THIS MONTH COSTS ─────────────────────────────
//
// These are two different numbers and the card shows both. The big figure on the right is what
// this bill ADDS; the pill is what is outstanding on the folio right now. A camper can owe
// nothing this month and still carry a balance from last, and vice versa.

test('owing is a positive balance — zero and a credit are not owing', () => {
  assert.equal(owesBalance(row({ balanceCents: 3000 })), true)
  assert.equal(owesBalance(row({ balanceCents: 0 })), false)
  assert.equal(owesBalance(row({ balanceCents: -2500 })), false, 'a credit is not a debt')
})

test('⚠ "Owes a balance" cuts across every status — it is a different question', () => {
  // "Who owes me money" is not "what is left to send". A billed camper who has not paid belongs
  // in this tab; a ready camper who is paid up does not.
  const billedOwing = row({ sent: true, balanceCents: 2673 })
  const readyPaid = row({ balanceCents: 0 })
  const attnOwing = row({ anomaly: true, balanceCents: 6210 })
  assert.ok(matchesFilter(billedOwing, 'owing'))
  assert.ok(matchesFilter(attnOwing, 'owing'))
  assert.ok(!matchesFilter(readyPaid, 'owing'))
  // And they still appear under their own status tab — the pill does not move them.
  assert.ok(matchesFilter(billedOwing, 'billed'))
  assert.ok(matchesFilter(attnOwing, 'attention'))
})

test('the owing count overlaps the others rather than replacing them', () => {
  const t = tallyCards([
    row({ balanceCents: 100 }),                 // ready, owes
    row({ sent: true, balanceCents: 200 }),     // billed, owes
    row({ balanceCents: 0 }),                   // ready, paid up
  ])
  assert.equal(t.owing, 2)
  // The three status piles still account for everyone exactly once.
  assert.equal(t.ready + t.attention + t.billed, t.everyone)
  assert.equal(t.everyone, 3)
})

test('a credit shows as paid up, never as a negative balance owed', () => {
  const credited = row({ balanceCents: -2500 })
  assert.ok(!matchesFilter(credited, 'owing'))
  assert.ok(matchesFilter(credited, 'everyone'))
})
