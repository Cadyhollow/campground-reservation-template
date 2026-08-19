// The To-Do board's ordering and display rules, as plain functions.
//
// Split out of app/admin/TodoPanel.tsx for the same reason lib/pos-tiles.ts was split out of the
// POS tiles: that file contains JSX, which `node --test` cannot parse. Everything here is pure —
// no React, no DOM, no Supabase — which is also what lets it run in CI on every pull request.
//
// Phase 1 is manual tasks only. `source` exists on the row and is reserved for phase 2's
// automatic check-in and recurring reminders; nothing in this file branches on it yet.

/** A task row, exactly as `public.tasks` stores it. */
export type Task = {
  id: string
  title: string
  notes: string | null
  priority: 'high' | 'medium' | 'low' | null
  assigned_to: string | null
  due_at: string | null
  created_by: string | null
  created_at: string
  completed_at: string | null
  completed_by: string | null
  removed_at: string | null
  source: string
}

/** Someone a task can be assigned to. Two fields, matching /api/profiles/assignable exactly. */
export type Person = { id: string; full_name: string | null }

/**
 * high → medium → low → none.
 *
 * NULL SCORES LAST, NOT FIRST, and that is the whole reason this is a lookup rather than a sort on
 * the column: Postgres and JavaScript disagree about where NULL belongs, and "no priority set" is
 * the most common value on this board. Sorted naively, every unprioritised task would pile up
 * above the urgent ones.
 */
const PRIORITY_RANK: Record<string, number> = { high: 0, medium: 1, low: 2 }
const NO_PRIORITY = 3

export function priorityRank(priority: string | null | undefined): number {
  return priority ? (PRIORITY_RANK[priority] ?? NO_PRIORITY) : NO_PRIORITY
}

/**
 * The board's order, in one place.
 *
 * Open tasks first — priority, then soonest due, then oldest created. Completed tasks below,
 * most recently finished first, because the useful question about a finished task is "what just
 * got done", not "what got done first".
 *
 * SORTED HERE RATHER THAN IN THE DATABASE. The priority ordering is a custom rank over a text
 * column and the due-date ordering needs nulls last within it; expressing that in PostgREST means
 * a generated column or a view, which is a schema commitment for a list that is realistically a
 * few dozen rows. If a park ever has thousands of open tasks this is the thing to revisit.
 *
 * Does not mutate its input.
 */
export function sortTasks(tasks: Task[]): Task[] {
  return [...tasks].sort((a, b) => {
    const aDone = !!a.completed_at
    const bDone = !!b.completed_at
    if (aDone !== bDone) return aDone ? 1 : -1

    if (aDone && bDone) {
      // Newest completion first.
      return (b.completed_at ?? '').localeCompare(a.completed_at ?? '')
    }

    const byPriority = priorityRank(a.priority) - priorityRank(b.priority)
    if (byPriority !== 0) return byPriority

    // Due date ascending, NULLS LAST. A task with no due date is not urgent; it must not sort
    // above one that is due this afternoon.
    if (a.due_at !== b.due_at) {
      if (!a.due_at) return 1
      if (!b.due_at) return -1
      return a.due_at.localeCompare(b.due_at)
    }

    return a.created_at.localeCompare(b.created_at)
  })
}

/** The rows the board shows at all. Removal is a soft delete, so it is a filter, not a gap. */
export function visibleTasks(tasks: Task[]): Task[] {
  return tasks.filter(t => !t.removed_at)
}

/** The number on the "N open" pill: not removed, not yet ticked off. */
export function openCount(tasks: Task[]): number {
  return visibleTasks(tasks).filter(t => !t.completed_at).length
}

/**
 * True when an OPEN task's due time has passed. Drives the red due chip.
 *
 * A completed task is never overdue, however late it was finished — the chip is a prompt to act,
 * and there is nothing left to act on. `now` is a parameter so this is testable without freezing
 * the clock.
 */
export function isOverdue(task: Task, now: Date = new Date()): boolean {
  if (!task.due_at || task.completed_at) return false
  return new Date(task.due_at).getTime() < now.getTime()
}

/**
 * The due chip's text: "Today 2:00 PM", "Tomorrow 9:00 AM", or "Sep 3, 9:00 AM".
 *
 * Compared by CALENDAR DAY, not by elapsed hours — 11pm tonight and 1am tomorrow are 2 hours
 * apart and belong on different days, which is what a person reading a chore list means by
 * "tomorrow".
 */
export function dueLabel(dueAt: string, now: Date = new Date()): string {
  const due = new Date(dueAt)
  const time = due.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })

  const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
  const days = Math.round((startOfDay(due) - startOfDay(now)) / 86_400_000)

  if (days === 0) return `Today ${time}`
  if (days === 1) return `Tomorrow ${time}`
  if (days === -1) return `Yesterday ${time}`
  return `${due.toLocaleDateString([], { month: 'short', day: 'numeric' })}, ${time}`
}

/**
 * The due chip for a task that is due on a DAY rather than at a moment: "Today", "Tomorrow",
 * "Sep 3".
 *
 * Check-in prep tasks are the case. They are due "before the Ortiz family arrive tomorrow", not
 * at 00:00 — the midnight in the stored timestamp is a placeholder for "that day", and printing
 * it back as "Tomorrow 12:00 AM" reads like a 15-minutes-past-midnight chore. The mockup shows
 * the bare day for exactly this reason.
 */
export function dueDayLabel(dueAt: string, now: Date = new Date()): string {
  const due = new Date(dueAt)
  const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
  const days = Math.round((startOfDay(due) - startOfDay(now)) / 86_400_000)
  if (days === 0) return 'Today'
  if (days === 1) return 'Tomorrow'
  if (days === -1) return 'Yesterday'
  return due.toLocaleDateString([], { month: 'short', day: 'numeric' })
}

/**
 * Up to two initials for the round assignee badge.
 *
 * First and LAST word, so "Mary Anne Robinson" reads MR rather than MA — the first and last name
 * are what distinguishes two colleagues. Falls back to "?" so a profile with no name still
 * renders a badge instead of an empty circle.
 */
export function initials(fullName: string | null | undefined): string {
  const words = (fullName ?? '').trim().split(/\s+/).filter(Boolean)
  if (words.length === 0) return '?'
  const first = words[0][0]
  const last = words.length > 1 ? words[words.length - 1][0] : ''
  return (first + last).toUpperCase()
}

/**
 * The badge colour for a person.
 *
 * Hashed from the person's NAME, not their position in the list, so someone's colour does not
 * change when a colleague is added above them — the same rule, and the same twelve
 * contrast-checked jewel tones, as the POS category tiles. Reused rather than re-declared so the
 * admin has one palette, not two that drift.
 *
 * RELATIVE IMPORT, not the '@/lib/…' alias, and that is load-bearing: `node --test` resolves this
 * file directly and does not read tsconfig's paths, so an aliased import here fails the whole
 * suite with ERR_MODULE_NOT_FOUND. Every pure, unit-tested module in lib/ follows the same rule.
 */
export { posTileColor as personColor } from './pos-tiles.ts'

/** Name lookup for the assignee badge and the "Done by …" line. */
export function nameOf(id: string | null, people: Person[]): string | null {
  if (!id) return null
  const person = people.find(p => p.id === id)
  return person?.full_name?.trim() || null
}
