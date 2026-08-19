'use client'

// The shared To-Do board (phase 1).
//
// One list per park. Everyone signed in sees the same board, anyone can add to it, assign it,
// give it a priority and a due time, and tick things off. Ticking off records WHO and WHEN.
//
// ── TOLERANT OF THE TABLE NOT EXISTING ───────────────────────────────────────────────────────
//
// `public.tasks` ships as a migration (resonation-admin db/2026-08-19-tasks-todo-board.sql) and is
// applied per tenant. Most parks will not have run it. On those, the first select fails and this
// component renders NOTHING — no panel, no error, no empty state — and app/admin/page.tsx gives
// the quick-action buttons the full width back. The dashboard must never break because a park has
// not opted into a feature.
//
// It is `null` rather than a caught error message on purpose: an error box on the dashboard of a
// park that never asked for a To-Do board is a bug report waiting to happen.
//
// Note that PostgREST reports a missing table as PGRST205 ("could not find the table in the
// schema cache"), NOT as Postgres's 42P01. Rather than matching either code, ANY failure on the
// first load hides the panel — a park whose board cannot load is not helped by a broken one.
//
// ── PERMISSIONS ──────────────────────────────────────────────────────────────────────────────
//
// None, beyond being signed in. That is the product decision for phase 1, and it is enforced in
// RLS as select/insert/update = staff+ rather than by a role string in this file. There is
// deliberately no `if (role === …)` here to drift out of step with the database.
//
// The writes below go straight to PostgREST as the logged-in user, so the policies are the real
// guard — this component cannot grant itself anything.

import { useEffect, useState } from 'react'
import { createBrowserSupabase } from '@/lib/supabase-browser'
import {
  sortTasks, visibleTasks, openCount, isOverdue, dueLabel, dueDayLabel, initials, personColor, nameOf,
  type Task, type Person,
} from '@/lib/tasks'
import { describeRuleShort, type TaskRule } from '@/lib/task-generation'
import ManageReminders from './ManageReminders'

const supabase = createBrowserSupabase()

// ⚠ select('*'), AND THE PHASE-1 REASONING FOR A NAMED LIST HAS BEEN INVERTED ON PURPOSE.
//
// Phase 1 named every column here so that adding one could not silently change what this
// component receives. Phase 2 is that added column — three of them — and naming them turns out to
// be the dangerous choice: on a tenant carrying phase 1 but NOT phase 2, PostgREST errors on the
// unknown column, the select fails, and this component's own tolerance logic hides the ENTIRE
// board. A park would lose the working checklist it already had because it had not taken a
// feature it never asked for.
//
// select('*') is what the Settings and Sites screens do for exactly this reason (see the pet
// column notes in app/admin/sites/page.tsx). Phase-2 fields are then read defensively below.
const TASK_COLUMNS = '*'

// The browser's local date as 'YYYY-MM-DD'. Deliberately identical to lib/transactions.ts ymd()
// and to the inline copy in app/admin/page.tsx — this is the app's one notion of "today", and the
// generation pass must use the same one the stats above it use.
function ymdLocal(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

// The mockup's palette, kept together so the panel can be restyled in one place.
const LINE = '#e7e2d6'
const INK = '#26302b'
const INK_SOFT = '#61695f'
const MUTED = '#8a9187'
const GREEN = '#2f4238'

// The picker reads S M T W T F S starting on Sunday, because index 0 is Sunday in
// JavaScript's Date.getDay() — which is what task_rules.byweekday stores and what the generation
// engine matches on. Reordering these letters without reindexing would fire every weekly rule on
// the wrong day.
const DAY_LETTERS = ['S', 'M', 'T', 'W', 'T', 'F', 'S']
const DAY_FULL = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

const PRIORITY_CHIP: Record<string, { bg: string; color: string; label: string }> = {
  high: { bg: '#fbe9e4', color: '#b0432b', label: 'High' },
  medium: { bg: '#fbf1dd', color: '#9a7420', label: 'Medium' },
  low: { bg: '#eef1f4', color: '#556070', label: 'Low' },
}

// `onAvailability` is how the DASHBOARD learns whether this panel rendered. It matters for the
// layout, not for this component: when a tenant has no tasks table the panel returns null, and
// app/admin/page.tsx has to give the quick-action buttons the full width back rather than leave a
// third of the row empty. Reported from here because this is where the answer is actually known.
export default function TodoPanel({ onAvailability }: { onAvailability?: (ok: boolean) => void }) {
  // null = we do not know yet; false = this tenant has no tasks table, render nothing.
  const [available, setAvailable] = useState<boolean | null>(null)
  const [tasks, setTasks] = useState<Task[]>([])
  const [people, setPeople] = useState<Person[]>([])
  const [meId, setMeId] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  // Whether this tenant has the phase-2 objects at all. Probed against task_rules, which ships in
  // the same migration as every other phase-2 object — if it is there, they all are. Everything
  // phase 2 adds (the Repeat control, the badges, Manage reminders) is hidden while this is false,
  // and the phase-1 board carries on exactly as before.
  const [phase2, setPhase2] = useState(false)
  const [rules, setRules] = useState<TaskRule[]>([])
  const [showManage, setShowManage] = useState(false)

  const [title, setTitle] = useState('')
  const [priority, setPriority] = useState('')
  const [assignee, setAssignee] = useState('')
  const [due, setDue] = useState('')
  // The Repeat control. 'none' keeps the phase-1 behaviour exactly: a one-off task with a
  // datetime. Anything else makes "Add" create a RULE instead.
  const [repeat, setRepeat] = useState<'none' | 'daily' | 'weekly' | 'monthly'>('none')
  const [repeatTime, setRepeatTime] = useState('10:00')
  const [repeatDays, setRepeatDays] = useState<number[]>([])
  const [repeatMonthday, setRepeatMonthday] = useState<number>(new Date().getDate())

  useEffect(() => {
    let alive = true

    async function load() {
      // Who am I — needed to attribute created_by and completed_by. /api/me is the one place the
      // app answers this; it fails closed with a 401 rather than a null id.
      fetch('/api/me')
        .then(r => (r.ok ? r.json() : null))
        .then(d => { if (alive && d?.userId) setMeId(d.userId) })
        .catch(() => {})

      // The assignee roster. Cannot come from Supabase directly: profiles' RLS scopes SELECT to
      // the caller's OWN row, so a browser query returns one person and a join returns nulls.
      // See app/api/profiles/assignable/route.ts.
      fetch('/api/profiles/assignable')
        .then(r => (r.ok ? r.json() : null))
        .then(d => { if (alive && d?.people) setPeople(d.people) })
        .catch(() => {})

      // THE GENERATION PASS, BEFORE THE FIRST READ, so anything due today is already on the
      // board by the time it renders rather than appearing a moment later.
      //
      // `today` is the BROWSER's local date. The app has no park timezone (see lib/bookability.ts)
      // and the browser is the machine sitting at the park, so this is the app's existing notion
      // of "today" rather than a new one. The route bounds what it will accept.
      //
      // Awaited, but never allowed to block the board: a generation failure must leave the
      // existing tasks readable, so this cannot throw past here.
      try {
        await fetch('/api/tasks/generate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ today: ymdLocal(new Date()) }),
        })
      } catch { /* the board is still worth showing */ }

      const { data, error } = await supabase
        .from('tasks')
        .select(TASK_COLUMNS)
        .is('removed_at', null)
      if (!alive) return

      if (error) {
        // No table on this tenant (or no access). Hide the panel entirely — see the note at the
        // top of this file.
        setAvailable(false)
        onAvailability?.(false)
        return
      }
      setAvailable(true)
      onAvailability?.(true)
      setTasks((data ?? []) as Task[])

      // Phase-2 probe. An error here is not a failure — it is a park that has phase 1 only — so
      // the board stays exactly as it was and every phase-2 control simply does not render.
      const ruleProbe = await supabase.from('task_rules').select('*').order('created_at')
      if (!alive) return
      if (!ruleProbe.error) {
        setPhase2(true)
        setRules((ruleProbe.data ?? []) as TaskRule[])
      }
    }

    load()
    return () => { alive = false }
    // onAvailability is in the deps because the linter is right to insist, and it is safe here:
    // the dashboard passes its `setTodoAvailable` setter, which React guarantees is stable, so
    // this effect still runs exactly once. Passing an INLINE arrow from a parent would re-run the
    // whole load on every parent render — if a future caller needs one, wrap it in useCallback.
  }, [onAvailability])

  // Re-read after every write rather than patching local state by hand. The board is shared, so
  // the round trip is also how one person's screen picks up what a colleague just did, and it
  // means the displayed row is always the row the database actually holds.
  async function refresh() {
    const { data, error } = await supabase
      .from('tasks')
      .select(TASK_COLUMNS)
      .is('removed_at', null)
    if (!error) setTasks((data ?? []) as Task[])
    // Rules travel with the board so Manage reminders and the badges cannot disagree about what
    // is scheduled. Only attempted once phase 2 is known present.
    if (phase2) {
      const r = await supabase.from('task_rules').select('*').order('created_at')
      if (!r.error) setRules((r.data ?? []) as TaskRule[])
    }
  }

  // Re-run generation and reload. Used after a schedule changes: creating, resuming or editing a
  // rule can make an occurrence due right now, and the person who just did it should see it
  // appear rather than wonder whether it worked.
  async function regenerate() {
    try {
      await fetch('/api/tasks/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ today: ymdLocal(new Date()) }),
      })
    } catch { /* the reload below still shows whatever is there */ }
    await refresh()
  }

  async function add() {
    const text = title.trim()
    if (!text || busy) return
    setBusy(true)

    // REPEAT SET → this creates a RULE, not a task. The rule is the thing that will manufacture
    // tasks from now on; the generation pass immediately afterwards is what makes today's
    // occurrence (if it is due today) appear straight away, so the person who just typed it sees
    // something happen rather than an empty board and a hope.
    if (repeat !== 'none') {
      await supabase.from('task_rules').insert({
        title: text,
        priority: priority || null,
        assigned_to: assignee || null,
        freq: repeat,
        byweekday: repeat === 'weekly' ? repeatDays : null,
        bymonthday: repeat === 'monthly' ? repeatMonthday : null,
        at_time: repeatTime,
        created_by: meId,
      })
      setTitle(''); setPriority(''); setAssignee(''); setDue('')
      setRepeat('none'); setRepeatDays([])
      await regenerate()
      setBusy(false)
      return
    }

    await supabase.from('tasks').insert({
      title: text,
      priority: priority || null,
      assigned_to: assignee || null,
      // datetime-local gives a wall-clock string with no zone; new Date() reads it in the
      // browser's zone, which is the park's zone, and toISOString stores it as UTC. The park
      // sees back the time they typed.
      due_at: due ? new Date(due).toISOString() : null,
      created_by: meId,
      // Phase 1 only ever writes 'manual'. Phase 2 writes the other two.
      source: 'manual',
    })
    setTitle(''); setPriority(''); setAssignee(''); setDue('')
    await refresh()
    setBusy(false)
  }

  // Tick / untick. Unticking clears BOTH attribution columns — a task that is open again has not
  // been done by anyone, and leaving a stale completed_by would show "Done by …" on an open task
  // the moment anything else read the row.
  async function toggle(task: Task) {
    if (busy) return
    setBusy(true)
    const done = !!task.completed_at
    await supabase
      .from('tasks')
      .update(
        done
          ? { completed_at: null, completed_by: null }
          : { completed_at: new Date().toISOString(), completed_by: meId },
      )
      .eq('id', task.id)
    await refresh()
    setBusy(false)
  }

  // The "×". A SOFT removal: the row stays, with removed_at set, and drops out of every read the
  // board makes. There is no DELETE grant on this table, so this is not merely the polite option
  // — it is the only one available to a browser session.
  async function remove(task: Task) {
    if (busy) return
    setBusy(true)
    await supabase.from('tasks').update({ removed_at: new Date().toISOString() }).eq('id', task.id)
    await refresh()
    setBusy(false)
  }

  // Nothing at all until we know, and nothing ever on a tenant without the table.
  if (available !== true) return null

  const shown = sortTasks(visibleTasks(tasks))
  const open = openCount(tasks)
  // The rule behind a recurring instance, when it still exists. It may not: deleting a rule sets
  // rule_id to NULL on its past instances, so the badge falls back to a plain "Recurring" rather
  // than claiming a schedule that has been withdrawn.
  const ruleOf = (task: Task) =>
    (task as Task & { rule_id?: string }).rule_id
      ? rules.find(r => r.id === (task as Task & { rule_id?: string }).rule_id) ?? null
      : null

  return (
    <section
      className="rounded-2xl overflow-hidden bg-white"
      style={{ border: `1px solid ${LINE}`, boxShadow: '0 1px 2px rgba(30,40,35,.05), 0 8px 22px rgba(30,40,35,.05)' }}
    >
      {/* Header */}
      <div className="flex items-center gap-2.5 px-4 py-3.5" style={{ borderBottom: `1px solid ${LINE}` }}>
        <h2 className="m-0 text-[15px] font-extrabold flex items-center gap-2" style={{ color: INK }}>
          <span aria-hidden="true">✓</span> To-Do
          <span
            className="rounded-full px-2 py-0.5 text-[11.5px] font-bold"
            style={{ background: '#e7ecdf', color: '#4a5a3f' }}
          >
            {open} open
          </span>
        </h2>
        {phase2 ? (
          <button
            type="button"
            onClick={() => setShowManage(true)}
            className="ml-auto text-[12.5px] font-bold bg-transparent border-none cursor-pointer hover:underline"
            style={{ color: '#3f679a' }}
          >
            ⚙ Manage reminders
          </button>
        ) : (
          <span className="ml-auto text-[13px]" style={{ color: MUTED }}>Everyone sees this</span>
        )}
      </div>

      {/* Quick add */}
      <div
        className="flex flex-wrap items-center gap-[7px] px-4 py-3"
        style={{ background: '#faf8f2', borderBottom: `1px solid ${LINE}` }}
      >
        <label htmlFor="todo-title" className="sr-only">Task</label>
        <input
          id="todo-title"
          className="basis-full rounded-[9px] px-[11px] py-[9px] text-[13.5px] bg-white"
          style={{ border: `1px solid ${LINE}`, color: INK }}
          placeholder="Add a task — e.g. “mow the dog park”"
          value={title}
          onChange={e => setTitle(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') add() }}
        />
        <label htmlFor="todo-priority" className="sr-only">Priority</label>
        <select
          id="todo-priority"
          className="flex-1 min-w-0 rounded-[9px] px-[9px] py-2 text-[12.5px] bg-white"
          style={{ border: `1px solid ${LINE}`, color: INK_SOFT }}
          value={priority}
          onChange={e => setPriority(e.target.value)}
        >
          <option value="">Priority</option>
          <option value="high">High</option>
          <option value="medium">Medium</option>
          <option value="low">Low</option>
        </select>
        <label htmlFor="todo-assignee" className="sr-only">Assign to</label>
        <select
          id="todo-assignee"
          className="flex-1 min-w-0 rounded-[9px] px-[9px] py-2 text-[12.5px] bg-white"
          style={{ border: `1px solid ${LINE}`, color: INK_SOFT }}
          value={assignee}
          onChange={e => setAssignee(e.target.value)}
        >
          <option value="">Assign…</option>
          {people.map(p => (
            <option key={p.id} value={p.id}>{p.full_name || 'Unnamed'}</option>
          ))}
        </select>
        {phase2 && (
          <>
            <label htmlFor="todo-repeat" className="sr-only">Repeat</label>
            <select
              id="todo-repeat"
              className="flex-1 min-w-0 rounded-[9px] px-[9px] py-2 text-[12.5px] bg-white"
              style={{ border: `1px solid ${LINE}`, color: INK_SOFT }}
              value={repeat}
              onChange={e => setRepeat(e.target.value as typeof repeat)}
            >
              <option value="none">Repeat: Never</option>
              <option value="daily">Daily</option>
              <option value="weekly">Weekly</option>
              <option value="monthly">Monthly</option>
            </select>
          </>
        )}

        {/* One control, two meanings. A one-off task needs a DATE and a time; a repeating one
            needs only a time of day, because its dates come from the schedule. Showing both at
            once would invite somebody to set a due date on a weekly rule and expect it to mean
            something. */}
        {repeat === 'none' ? (
          <>
            <label htmlFor="todo-due" className="sr-only">Due date and time</label>
            <input
              id="todo-due"
              type="datetime-local"
              className="flex-1 min-w-0 rounded-[9px] px-[9px] py-2 text-[12.5px] bg-white"
              style={{ border: `1px solid ${LINE}`, color: INK_SOFT }}
              value={due}
              onChange={e => setDue(e.target.value)}
            />
          </>
        ) : (
          <>
            <label htmlFor="todo-attime" className="sr-only">Time of day</label>
            <input
              id="todo-attime"
              type="time"
              className="flex-1 min-w-0 rounded-[9px] px-[9px] py-2 text-[12.5px] bg-white"
              style={{ border: `1px solid ${LINE}`, color: INK_SOFT }}
              value={repeatTime}
              onChange={e => setRepeatTime(e.target.value)}
            />
          </>
        )}
        <button
          type="button"
          onClick={add}
          disabled={!title.trim() || busy}
          className="rounded-[9px] px-[15px] py-2 text-[13.5px] font-bold text-white disabled:opacity-50"
          style={{ background: GREEN }}
        >
          Add
        </button>
      </div>

      {/* The schedule detail, revealed by the Repeat control. Weekly gets the S-M-T-W-T-F-S
          picker; monthly a day-of-month. Daily needs nothing beyond the time already in the row
          above, so it reveals nothing. */}
      {phase2 && repeat !== 'none' && (
        <div className="px-4 pb-3" style={{ background: '#faf8f2', borderBottom: `1px solid ${LINE}` }}>
          <div className="rounded-[10px] px-[11px] py-[9px] bg-white" style={{ border: `1px dashed ${LINE}` }}>
            {repeat === 'weekly' && (
              <div className="flex items-center gap-2 flex-wrap text-[12.5px]" style={{ color: INK_SOFT }}>
                <b style={{ color: INK }}>Repeats weekly on:</b>
                <div className="flex gap-1" role="group" aria-label="Days of the week">
                  {DAY_LETTERS.map((letter, i) => {
                    const on = repeatDays.includes(i)
                    return (
                      <button
                        key={i}
                        type="button"
                        aria-pressed={on}
                        aria-label={DAY_FULL[i]}
                        onClick={() => setRepeatDays(on ? repeatDays.filter(d => d !== i) : [...repeatDays, i])}
                        className="rounded-full text-[11px] font-bold inline-flex items-center justify-center cursor-pointer"
                        style={{
                          width: 26, height: 26,
                          border: `1px solid ${on ? GREEN : LINE}`,
                          background: on ? GREEN : '#fff',
                          color: on ? '#fff' : INK_SOFT,
                        }}
                      >
                        {letter}
                      </button>
                    )
                  })}
                </div>
                {repeatDays.length === 0 && (
                  // Said plainly rather than silently accepting an unfinished rule: a weekly rule
                  // with no days matches nothing, and the engine deliberately does not treat it
                  // as "every day".
                  <span style={{ color: '#b0432b' }}>pick at least one day</span>
                )}
              </div>
            )}
            {repeat === 'monthly' && (
              <div className="flex items-center gap-2 flex-wrap text-[12.5px]" style={{ color: INK_SOFT }}>
                <b style={{ color: INK }}>Repeats monthly on day</b>
                <label htmlFor="todo-monthday" className="sr-only">Day of the month</label>
                <select
                  id="todo-monthday"
                  className="rounded-lg px-2 py-1 text-[12.5px] bg-white"
                  style={{ border: `1px solid ${LINE}`, color: INK_SOFT, width: 'auto', flex: 'none' }}
                  value={repeatMonthday}
                  onChange={e => setRepeatMonthday(Number(e.target.value))}
                >
                  {Array.from({ length: 31 }, (_, i) => i + 1).map(d => (
                    <option key={d} value={d}>{d}</option>
                  ))}
                </select>
                <span>— short months use their last day.</span>
              </div>
            )}
            {repeat === 'daily' && (
              <div className="text-[12.5px]" style={{ color: INK_SOFT }}>
                <b style={{ color: INK }}>Repeats every day</b> at the time set above.
              </div>
            )}
          </div>
        </div>
      )}

      {/* The list scrolls INSIDE the panel, so the buttons in the left column never move. */}
      <ul className="list-none m-0 py-1 overflow-y-auto" style={{ maxHeight: 430 }}>
        {shown.length === 0 && (
          <li className="px-4 py-5 text-[13px]" style={{ color: MUTED }}>
            Nothing on the list. Add the first task above.
          </li>
        )}
        {shown.map((task, i) => {
          const done = !!task.completed_at
          const chip = task.priority ? PRIORITY_CHIP[task.priority] : null
          const assigneeName = nameOf(task.assigned_to, people)
          const doneByName = nameOf(task.completed_by, people)
          const overdue = isOverdue(task)

          return (
            <li
              key={task.id}
              className="flex items-start gap-[11px] px-4 py-[11px]"
              style={{ borderBottom: i === shown.length - 1 ? 'none' : '1px solid #f1ede2' }}
            >
              {/* A REAL checkbox, not the mockup's styled div: it is focusable, toggles with the
                  space bar, and announces its state to a screen reader. appearance-none lets it
                  keep the mockup's look without giving up any of that. */}
              <input
                type="checkbox"
                checked={done}
                onChange={() => toggle(task)}
                disabled={busy}
                aria-label={done ? `Mark "${task.title}" as not done` : `Mark "${task.title}" as done`}
                className="appearance-none rounded-md cursor-pointer mt-px relative
                           checked:after:content-[''] checked:after:absolute checked:after:left-[5px] checked:after:top-px
                           checked:after:w-[5px] checked:after:h-[10px] checked:after:border-solid
                           checked:after:border-white checked:after:border-r-2 checked:after:border-b-2
                           checked:after:border-t-0 checked:after:border-l-0 checked:after:rotate-45"
                // THE SIZE IS INLINE, NOT A `w-[19px]` UTILITY, AND IT HAS TO BE.
                //
                // app/globals.css carries an UNLAYERED `input, select, textarea { width: 100% }`
                // (the mobile-overflow guard, ~line 218). Tailwind v4 puts its utilities in
                // @layer utilities, and unlayered CSS beats every layered rule no matter what the
                // specificity says — so `w-[19px]` loses, silently, and the checkbox renders as a
                // full-width bar that shoves the task text out of the panel. Inline styles are
                // outside the layer system entirely, which is what makes them stick.
                //
                // Do not "tidy" these back into utility classes without re-checking the board.
                style={{
                  width: 19,
                  height: 19,
                  flex: 'none',
                  border: `2px solid ${done ? GREEN : '#c3cbc0'}`,
                  background: done ? GREEN : '#fff',
                }}
              />

              <div className="flex-1 min-w-0">
                <div
                  className="text-[14px] font-semibold leading-[1.3]"
                  style={done
                    ? { color: MUTED, textDecoration: 'line-through' }
                    : { color: INK }}
                >
                  {task.title}
                </div>

                <div className="flex items-center flex-wrap gap-[7px] mt-[5px]">
                  {done ? (
                    <span className="text-[11px] italic" style={{ color: MUTED }}>
                      Done by {doneByName || 'someone'} · {new Date(task.completed_at!).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}
                    </span>
                  ) : (
                    <>
                      {/* Where a generated task says so. Purple for a recurring instance, teal
                          for one raised from a check-in — the same two badges as the mockup, and
                          the only visual difference between an automatic task and a typed one.
                          Everything else about them behaves identically. */}
                      {task.source === 'recurring' && (
                        <span
                          className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10.5px] font-bold"
                          style={{ background: '#efeaf6', color: '#6a51a0' }}
                        >
                          ↺ Recurring{ruleOf(task) ? ` · ${describeRuleShort(ruleOf(task)!)}` : ''}
                        </span>
                      )}
                      {task.source === 'auto_checkin' && (
                        <span
                          className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10.5px] font-bold"
                          style={{ background: '#e2f0ee', color: '#2f6f6a' }}
                        >
                          ⟳ Auto · from check-in
                        </span>
                      )}
                      {chip && (
                        <span
                          className="rounded-full px-2 py-0.5 text-[11px] font-bold"
                          style={{ background: chip.bg, color: chip.color }}
                        >
                          ● {chip.label}
                        </span>
                      )}
                      {task.due_at && (
                        <span
                          className="rounded-full px-2 py-0.5 text-[11px]"
                          style={overdue
                            ? { background: '#fbe9e4', color: '#b0432b', fontWeight: 700 }
                            : { background: '#f1efe8', color: INK_SOFT }}
                        >
                          {/* A check-in prep task is due on a DAY; everything else at a moment. */}
                          ⚑ {task.source === 'auto_checkin' ? dueDayLabel(task.due_at) : dueLabel(task.due_at)}
                          {overdue && <span className="sr-only"> (overdue)</span>}
                        </span>
                      )}
                      {assigneeName ? (
                        <span className="inline-flex items-center gap-[5px] text-[11.5px]" style={{ color: INK_SOFT }}>
                          <span
                            aria-hidden="true"
                            className="w-5 h-5 rounded-full text-white text-[10px] font-bold inline-flex items-center justify-center flex-none"
                            style={{ background: personColor(assigneeName) }}
                          >
                            {initials(assigneeName)}
                          </span>
                          {assigneeName}
                        </span>
                      ) : (
                        <span className="text-[11.5px]" style={{ color: MUTED }}>Unassigned</span>
                      )}
                    </>
                  )}
                </div>
              </div>

              <button
                type="button"
                onClick={() => remove(task)}
                disabled={busy}
                title="Remove"
                aria-label={`Remove "${task.title}" from the list`}
                className="flex-none ml-1.5 border-none bg-transparent text-[17px] leading-none px-1 rounded-md
                           hover:bg-[#f3eee3] hover:text-[#b0432b]"
                style={{ color: MUTED }}
              >
                ×
              </button>
            </li>
          )
        })}
      </ul>

      {phase2 && showManage && (
        <ManageReminders
          rules={rules}
          people={people}
          onClose={() => setShowManage(false)}
          onChanged={regenerate}
        />
      )}
    </section>
  )
}
