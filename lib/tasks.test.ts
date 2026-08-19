import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  sortTasks, visibleTasks, openCount, isOverdue, dueLabel, dueDayLabel, initials, nameOf, priorityRank,
  type Task,
} from './tasks.ts'

// Pure unit tests — no server, no database, no .env.local. These run in CI on every pull request
// alongside lib/pos-tiles.test.ts and lib/bookability.test.ts.

const NOW = new Date('2026-08-19T12:00:00Z')

function task(over: Partial<Task> & { id: string }): Task {
  return {
    title: 'a task', notes: null, priority: null, assigned_to: null, due_at: null,
    created_by: null, created_at: '2026-08-19T00:00:00Z', completed_at: null,
    completed_by: null, removed_at: null, source: 'manual',
    ...over,
  }
}

test('priority ranks high before medium before low before none', () => {
  assert.ok(priorityRank('high') < priorityRank('medium'))
  assert.ok(priorityRank('medium') < priorityRank('low'))
  // The one that a naive sort gets wrong: no priority must come LAST, not first.
  assert.ok(priorityRank('low') < priorityRank(null))
})

test('an unrecognised priority sorts with "none" rather than to the top', () => {
  assert.equal(priorityRank('URGENT!!'), priorityRank(null))
})

test('open tasks sort above completed ones', () => {
  const sorted = sortTasks([
    task({ id: 'done', completed_at: '2026-08-19T09:00:00Z' }),
    task({ id: 'open' }),
  ])
  assert.deepEqual(sorted.map(t => t.id), ['open', 'done'])
})

test('open tasks sort by priority, then due date, then created', () => {
  const sorted = sortTasks([
    task({ id: 'none' }),
    task({ id: 'low', priority: 'low' }),
    task({ id: 'high', priority: 'high' }),
    task({ id: 'medium', priority: 'medium' }),
  ])
  assert.deepEqual(sorted.map(t => t.id), ['high', 'medium', 'low', 'none'])
})

test('within one priority, the sooner due date comes first and no due date comes last', () => {
  const sorted = sortTasks([
    task({ id: 'undated', priority: 'high' }),
    task({ id: 'later', priority: 'high', due_at: '2026-08-25T10:00:00Z' }),
    task({ id: 'sooner', priority: 'high', due_at: '2026-08-20T10:00:00Z' }),
  ])
  assert.deepEqual(sorted.map(t => t.id), ['sooner', 'later', 'undated'])
})

test('a due date does not outrank priority', () => {
  // The trap: a low-priority task due in an hour must still sit below an undated high-priority
  // one, because priority is the first key.
  const sorted = sortTasks([
    task({ id: 'low-due-now', priority: 'low', due_at: '2026-08-19T13:00:00Z' }),
    task({ id: 'high-undated', priority: 'high' }),
  ])
  assert.deepEqual(sorted.map(t => t.id), ['high-undated', 'low-due-now'])
})

test('completed tasks sort newest-finished first', () => {
  const sorted = sortTasks([
    task({ id: 'older', completed_at: '2026-08-19T08:00:00Z' }),
    task({ id: 'newer', completed_at: '2026-08-19T11:00:00Z' }),
  ])
  assert.deepEqual(sorted.map(t => t.id), ['newer', 'older'])
})

test('sortTasks does not mutate its input', () => {
  const input = [task({ id: 'b', priority: 'low' }), task({ id: 'a', priority: 'high' })]
  sortTasks(input)
  assert.deepEqual(input.map(t => t.id), ['b', 'a'])
})

test('removed tasks are filtered from the board but the row is not gone', () => {
  const all = [task({ id: 'kept' }), task({ id: 'removed', removed_at: '2026-08-19T10:00:00Z' })]
  assert.deepEqual(visibleTasks(all).map(t => t.id), ['kept'])
  assert.equal(all.length, 2, 'visibleTasks must not drop the row from the caller\'s array')
})

test('the open count excludes completed AND removed tasks', () => {
  assert.equal(openCount([
    task({ id: '1' }),
    task({ id: '2' }),
    task({ id: '3', completed_at: '2026-08-19T09:00:00Z' }),
    task({ id: '4', removed_at: '2026-08-19T09:00:00Z' }),
    // A removed task that was also completed must not be counted twice or at all.
    task({ id: '5', completed_at: '2026-08-19T09:00:00Z', removed_at: '2026-08-19T09:30:00Z' }),
  ]), 2)
})

test('overdue is a past due date on an OPEN task only', () => {
  assert.equal(isOverdue(task({ id: 'a', due_at: '2026-08-19T09:00:00Z' }), NOW), true)
  assert.equal(isOverdue(task({ id: 'b', due_at: '2026-08-19T15:00:00Z' }), NOW), false)
  assert.equal(isOverdue(task({ id: 'c' }), NOW), false, 'no due date is never overdue')
  // Finished late is not overdue — there is nothing left to act on.
  assert.equal(
    isOverdue(task({ id: 'd', due_at: '2026-08-19T09:00:00Z', completed_at: '2026-08-19T11:00:00Z' }), NOW),
    false,
  )
})

test('due labels are by calendar day, not elapsed hours', () => {
  const evening = new Date('2026-08-19T23:00:00')
  // 1am the next morning is 2 hours away but belongs to "tomorrow", which is what a person
  // reading a chore list means.
  assert.match(dueLabel('2026-08-20T01:00:00', evening), /^Tomorrow /)
  assert.match(dueLabel('2026-08-19T23:30:00', evening), /^Today /)
  assert.match(dueLabel('2026-08-18T09:00:00', evening), /^Yesterday /)
  // Anything further out gets an explicit date rather than a relative word.
  assert.match(dueLabel('2026-09-03T09:00:00', evening), /^Sep 3, /)
})

test('initials take the first and last name, not the first two words', () => {
  assert.equal(initials('Maria Rodriguez'), 'MR')
  assert.equal(initials('Mary Anne Robinson'), 'MR')
  assert.equal(initials('Jake'), 'J')
  assert.equal(initials(null), '?')
  assert.equal(initials('   '), '?')
})

test('nameOf resolves a profile id, and is null when it cannot', () => {
  const people = [{ id: 'p1', full_name: 'Dana Perez' }, { id: 'p2', full_name: null }]
  assert.equal(nameOf('p1', people), 'Dana Perez')
  assert.equal(nameOf(null, people), null)
  assert.equal(nameOf('p2', people), null, 'a profile with no name resolves to null, not ""')
  // The case that matters after someone is deactivated: they drop out of the roster, and the
  // board must fall back rather than render "undefined".
  assert.equal(nameOf('gone', people), null)
})

test('dueDayLabel prints a bare day, for tasks due on a date rather than at a moment', () => {
  const now = new Date('2026-08-19T14:00:00')
  // A check-in prep task stores midnight as a stand-in for "that day". Printing the time back
  // would read as a 15-minutes-past-midnight chore.
  assert.equal(dueDayLabel('2026-08-20T00:00:00', now), 'Tomorrow')
  assert.equal(dueDayLabel('2026-08-19T00:00:00', now), 'Today')
  assert.equal(dueDayLabel('2026-08-18T00:00:00', now), 'Yesterday')
  assert.equal(dueDayLabel('2026-09-03T00:00:00', now), 'Sep 3')
  assert.doesNotMatch(dueDayLabel('2026-08-20T00:00:00', now), /AM|PM|:/)
})
