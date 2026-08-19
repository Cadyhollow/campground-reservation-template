import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  ymdOf, dateFromYmd, daysBetween, addDays, isValidYmd, clampToday,
  ruleFallsOn, catchUpFrom, occurrencesDue, parseAtTime, dueAtFor,
  describeRule, describeRuleShort, checkinTaskTitle, formatTime, ordinal,
  MAX_CATCHUP_DAYS, type TaskRule,
} from './task-generation.ts'

// Pure unit tests — no server, no database, no .env.local. The date arithmetic is the part of
// phase 2 most likely to be subtly wrong, so it is pinned here rather than checked by eye in a
// browser once.

function rule(over: Partial<TaskRule> = {}): TaskRule {
  return {
    id: 'r1', title: 'Take the deposit to the bank', notes: null, priority: null,
    assigned_to: null, freq: 'weekly', byweekday: [3], bymonthday: null,
    at_time: '10:00:00', active: true, created_by: null,
    created_at: '2026-08-01T12:00:00Z', last_generated_on: null,
    ...over,
  }
}

// ── date helpers ─────────────────────────────────────────────────────────────────────────────

test('dateFromYmd builds a LOCAL date, not a UTC one', () => {
  // The bug this guards: new Date('2026-08-19') is UTC midnight, which is the 18th in any
  // negative-offset timezone. Every reminder would fire a day early.
  const d = dateFromYmd('2026-08-19')
  assert.equal(d.getFullYear(), 2026)
  assert.equal(d.getMonth(), 7)
  assert.equal(d.getDate(), 19)
  assert.equal(ymdOf(d), '2026-08-19', 'round-trips in local time')
})

test('addDays and daysBetween cross a month and a year boundary', () => {
  assert.equal(addDays('2026-08-31', 1), '2026-09-01')
  assert.equal(addDays('2026-12-31', 1), '2027-01-01')
  assert.equal(addDays('2026-03-01', -1), '2026-02-28')
  assert.equal(daysBetween('2026-08-19', '2026-08-20'), 1)
  assert.equal(daysBetween('2026-08-20', '2026-08-19'), -1)
  assert.equal(daysBetween('2026-08-19', '2026-08-19'), 0)
})

test('addDays survives a daylight-saving transition', () => {
  // US DST ends 2026-11-01. A naive +86,400,000ms lands at 23:00 the previous day.
  assert.equal(addDays('2026-10-31', 1), '2026-11-01')
  assert.equal(addDays('2026-11-01', 1), '2026-11-02')
  assert.equal(daysBetween('2026-10-31', '2026-11-02'), 2)
})

test('isValidYmd rejects impossible dates and junk', () => {
  assert.equal(isValidYmd('2026-08-19'), true)
  assert.equal(isValidYmd('2026-02-31'), false, 'February has no 31st')
  assert.equal(isValidYmd('2026-13-01'), false)
  assert.equal(isValidYmd('19-08-2026'), false)
  assert.equal(isValidYmd(''), false)
  assert.equal(isValidYmd(null), false)
  assert.equal(isValidYmd(20260819), false)
})

// ── the clamp: what the server will accept from a browser ────────────────────────────────────

test('clampToday accepts any real timezone but refuses a far-off date', () => {
  const server = '2026-08-19'
  assert.equal(clampToday('2026-08-19', server), '2026-08-19', 'same day')
  assert.equal(clampToday('2026-08-18', server), '2026-08-18', 'a day behind — Pacific in the evening')
  assert.equal(clampToday('2026-08-20', server), '2026-08-20', 'a day ahead — Auckland in the morning')
  // The abuse case: a tampered date must not let the engine manufacture months of tasks.
  assert.equal(clampToday('2027-01-01', server), server)
  assert.equal(clampToday('2026-08-16', server), server)
})

test('clampToday falls back to the server date rather than throwing', () => {
  const server = '2026-08-19'
  // A bad clock must degrade to "generate on the UTC day", never to "no reminders at all".
  assert.equal(clampToday(undefined, server), server)
  assert.equal(clampToday('nonsense', server), server)
  assert.equal(clampToday('2026-02-31', server), server)
})

// ── which dates a rule falls on ──────────────────────────────────────────────────────────────

test('daily falls on every day', () => {
  const r = rule({ freq: 'daily', byweekday: null })
  for (const d of ['2026-08-19', '2026-08-20', '2026-08-21']) {
    assert.equal(ruleFallsOn(r, d), true)
  }
})

test('weekly falls only on its chosen days', () => {
  const r = rule({ freq: 'weekly', byweekday: [3] }) // Wednesday
  assert.equal(ruleFallsOn(r, '2026-08-19'), true, '2026-08-19 is a Wednesday')
  assert.equal(ruleFallsOn(r, '2026-08-20'), false)
  assert.equal(ruleFallsOn(r, '2026-08-26'), true, 'the following Wednesday')
})

test('a weekly rule with NO days chosen matches nothing, not everything', () => {
  // "Weekly, no days" is an unfinished rule. Firing daily would be the worst possible reading.
  const r = rule({ freq: 'weekly', byweekday: [] })
  assert.equal(ruleFallsOn(r, '2026-08-19'), false)
  assert.deepEqual(occurrencesDue(r, '2026-08-19'), [])
  assert.equal(ruleFallsOn(rule({ freq: 'weekly', byweekday: null }), '2026-08-19'), false)
})

test('monthly falls on its day of the month', () => {
  const r = rule({ freq: 'monthly', byweekday: null, bymonthday: 1 })
  assert.equal(ruleFallsOn(r, '2026-09-01'), true)
  assert.equal(ruleFallsOn(r, '2026-09-02'), false)
})

test('monthly on the 31st clamps to the last day of a short month', () => {
  // A rule for the 31st must still fire in June and February — a person means "the last day-ish",
  // not "skip those months entirely".
  const r = rule({ freq: 'monthly', byweekday: null, bymonthday: 31 })
  assert.equal(ruleFallsOn(r, '2026-06-30'), true, 'June has 30 days')
  assert.equal(ruleFallsOn(r, '2026-02-28'), true, 'February 2026 has 28')
  assert.equal(ruleFallsOn(r, '2026-07-31'), true, 'July has 31, so no clamping')
  assert.equal(ruleFallsOn(r, '2026-07-30'), false, 'and the 30th is not it')
})

// ── the watermark and catch-up ───────────────────────────────────────────────────────────────

test('a rule that has never run starts from its creation date', () => {
  const r = rule({ created_at: '2026-08-17T09:00:00', last_generated_on: null })
  assert.equal(catchUpFrom(r, '2026-08-19'), '2026-08-17')
})

test('a rule that has run starts the day AFTER its watermark', () => {
  // Starting ON the watermark would re-offer a day already generated; the dedup index would
  // absorb it, but the engine should not be relying on that to be correct.
  const r = rule({ last_generated_on: '2026-08-18' })
  assert.equal(catchUpFrom(r, '2026-08-19'), '2026-08-19')
})

test('catch-up is floored so a long-paused rule cannot flood the board', () => {
  // Resumed in August after being paused in March: without the floor this manufactures five
  // months of missed bank runs at once.
  const r = rule({ last_generated_on: '2026-03-01' })
  const from = catchUpFrom(r, '2026-08-19')
  assert.equal(from, addDays('2026-08-19', -MAX_CATCHUP_DAYS))
  assert.ok(occurrencesDue(r, '2026-08-19').length <= 6, 'a weekly rule yields at most ~5 in 30 days')
})

test('occurrencesDue never generates beyond today', () => {
  const r = rule({ freq: 'daily', byweekday: null, last_generated_on: '2026-08-17' })
  const due = occurrencesDue(r, '2026-08-19')
  assert.deepEqual(due, ['2026-08-18', '2026-08-19'])
  assert.ok(!due.some(d => daysBetween('2026-08-19', d) > 0), 'the future is never pre-created')
})

test('a rule generated today yields exactly today, once', () => {
  const r = rule({ freq: 'weekly', byweekday: [3], created_at: '2026-08-19T08:00:00' })
  assert.deepEqual(occurrencesDue(r, '2026-08-19'), ['2026-08-19'])
})

test('a paused rule yields nothing at all', () => {
  const r = rule({ active: false, last_generated_on: '2026-08-12' })
  assert.deepEqual(occurrencesDue(r, '2026-08-19'), [])
})

test('resuming a paused rule picks up from the watermark, not from scratch', () => {
  const paused = rule({ active: false, last_generated_on: '2026-08-12' })
  assert.deepEqual(occurrencesDue(paused, '2026-08-26'), [])
  const resumed = { ...paused, active: true }
  // Wednesdays between the 13th and the 26th: the 19th and the 26th.
  assert.deepEqual(occurrencesDue(resumed, '2026-08-26'), ['2026-08-19', '2026-08-26'])
})

// ── times ────────────────────────────────────────────────────────────────────────────────────

test('parseAtTime handles both stored forms and clamps nonsense', () => {
  assert.deepEqual(parseAtTime('10:00:00'), [10, 0])
  assert.deepEqual(parseAtTime('09:30'), [9, 30])
  assert.deepEqual(parseAtTime('99:99'), [23, 59])
  assert.deepEqual(parseAtTime(''), [0, 0])
})

test('dueAtFor puts the occurrence on the right calendar day at the right wall-clock time', () => {
  const iso = dueAtFor('2026-08-19', '10:00:00')
  const back = new Date(iso)
  assert.equal(ymdOf(back), '2026-08-19', 'still the 19th when read back locally')
  assert.equal(back.getHours(), 10)
  assert.equal(back.getMinutes(), 0)
})

test('formatTime and ordinal read the way a person writes them', () => {
  assert.equal(formatTime('10:00:00'), '10:00 AM')
  assert.equal(formatTime('00:00:00'), '12:00 AM')
  assert.equal(formatTime('12:00:00'), '12:00 PM')
  assert.equal(formatTime('13:05:00'), '1:05 PM')
  assert.deepEqual([1, 2, 3, 4, 11, 12, 13, 21, 22, 23, 31].map(ordinal),
    ['1st', '2nd', '3rd', '4th', '11th', '12th', '13th', '21st', '22nd', '23rd', '31st'])
})

// ── the words ────────────────────────────────────────────────────────────────────────────────

test('describeRule reads as a sentence for each frequency', () => {
  assert.equal(describeRule(rule({ freq: 'daily', byweekday: null })), 'Daily · 10:00 AM')
  assert.equal(describeRule(rule({ freq: 'weekly', byweekday: [3] })), 'Weekly · Wednesdays · 10:00 AM')
  assert.equal(describeRule(rule({ freq: 'weekly', byweekday: [1, 5] })), 'Weekly · Mondays, Fridays · 10:00 AM')
  assert.equal(describeRule(rule({ freq: 'monthly', byweekday: null, bymonthday: 1 })), 'Monthly · 1st · 10:00 AM')
  // An unfinished weekly rule says so rather than pretending to be scheduled.
  assert.match(describeRule(rule({ freq: 'weekly', byweekday: [] })), /no days chosen/)
})

test('describeRuleShort is the board badge form', () => {
  assert.equal(describeRuleShort(rule({ freq: 'weekly', byweekday: [3] })), 'every Wed 10:00 AM')
  assert.equal(describeRuleShort(rule({ freq: 'daily', byweekday: null })), 'every day 10:00 AM')
})

test('the day picker order matches JavaScript getDay(), so 0 is Sunday', () => {
  // If this drifts, every weekly rule fires on the wrong day — and the schema comment on
  // task_rules.byweekday promises this exact mapping.
  assert.match(describeRule(rule({ freq: 'weekly', byweekday: [0] })), /Sundays/)
  assert.match(describeRule(rule({ freq: 'weekly', byweekday: [6] })), /Saturdays/)
  assert.equal(dateFromYmd('2026-08-19').getDay(), 3, '2026-08-19 is a Wednesday')
})

// ── check-in titles ──────────────────────────────────────────────────────────────────────────

test('the check-in title states the relative day it was raised on', () => {
  assert.equal(
    checkinTaskTitle('Cabin 3', '2026-08-20', 'Ortiz family', '2026-08-19'),
    'Prep Cabin 3 — check-in tomorrow (Ortiz family)')
  assert.equal(
    checkinTaskTitle('Cabin 1', '2026-08-19', 'Henderson', '2026-08-19'),
    'Prep Cabin 1 — check-in today (Henderson)')
  assert.equal(
    checkinTaskTitle('Cabin 1', '2026-08-21', 'Henderson', '2026-08-19'),
    'Prep Cabin 1 — check-in in 2 days (Henderson)')
})

test('the check-in title copes with a missing site label or guest name', () => {
  assert.equal(checkinTaskTitle('', '2026-08-20', '', '2026-08-19'), 'Prep site — check-in tomorrow')
  assert.equal(checkinTaskTitle('  ', '2026-08-20', ' Ortiz ', '2026-08-19'),
    'Prep site — check-in tomorrow (Ortiz)')
})

test('an arrival already in the past still reads sensibly', () => {
  // A reservation whose arrival slipped behind "today" must not say "in -1 days".
  assert.equal(checkinTaskTitle('Cabin 2', '2026-08-18', 'Vale', '2026-08-19'),
    'Prep Cabin 2 — check-in today (Vale)')
})
