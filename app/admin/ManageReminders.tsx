'use client'

// "Manage reminders" — the phase-2 view that opens from the To-Do board header.
//
// Two jobs, and deliberately only two: edit or stop the RECURRING rules, and set how the
// automatic CHECK-IN prep tasks behave. The day-to-day happens on the board itself — a recurring
// reminder is born there, by setting "Repeat" when adding a task — so this screen is for the
// things you cannot do inline.
//
// RENDERED ONLY WHEN PHASE 2 IS PRESENT. TodoPanel probes for it and does not mount this
// otherwise, so nothing here has to defend against the tables being absent. What it DOES defend
// against is the two settings columns being missing while task_rules exists — see hasCheckinCols.

import { useEffect, useState } from 'react'
import { createBrowserSupabase } from '@/lib/supabase-browser'
import { describeRule, type TaskRule } from '@/lib/task-generation'
import type { Person } from '@/lib/tasks'
import { useRole } from '@/lib/use-role'
import { atLeast } from '@/lib/roles'

const supabase = createBrowserSupabase()

const LINE = '#e7e2d6'
const INK = '#26302b'
const INK_SOFT = '#61695f'
const MUTED = '#8a9187'
const GREEN = '#2f4238'

const DAY_LETTERS = ['S', 'M', 'T', 'W', 'T', 'F', 'S']
const DAY_FULL = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

export default function ManageReminders({
  rules, people, onClose, onChanged,
}: {
  rules: TaskRule[]
  people: Person[]
  onClose: () => void
  onChanged: () => Promise<void> | void
}) {
  const [busy, setBusy] = useState(false)
  const [editing, setEditing] = useState<string | null>(null)

  // ⚠ THE CHECK-IN PREP SWITCHES ARE OWNER-ONLY, AND NOT BECAUSE PHASE 2 DECIDED SO.
  //
  // They live on `settings`, whose RLS has required `owner` for UPDATE since PR 5b-1. Everything
  // else on this screen — creating, pausing, editing and removing recurring reminders — stays
  // open to any signed-in user, exactly as phase 1's board does, because task_rules is an
  // operational table.
  //
  // Without this the controls would render for a Staff member, accept the click, and be silently
  // refused by the database: the switch would flick and nothing would happen. Reflecting the
  // policy in the UI is the honest option; widening the policy is not mine to do, and would hand
  // every staff member the whole Settings table.
  const { role, roleLoaded } = useRole()
  const canEditPark = atLeast(role, 'owner')

  // The check-in prep switches live on `settings`. They may be absent even here: a tenant could
  // in principle have task_rules without them. Detected from the loaded row and hidden if missing,
  // because showing a control that cannot be saved is worse than showing none — the same rule the
  // Settings and Sites screens follow for the pet columns.
  const [hasCheckinCols, setHasCheckinCols] = useState(false)
  const [settingsId, setSettingsId] = useState<string | number | null>(null)
  const [prepEnabled, setPrepEnabled] = useState(false)
  const [leadDays, setLeadDays] = useState(1)

  useEffect(() => {
    let alive = true
    // select('*') rather than naming the columns: a named `checkin_prep_enabled` would make
    // PostgREST error on a tenant without it and this read would return nothing at all.
    supabase.from('settings').select('*').limit(1).maybeSingle().then(({ data }) => {
      if (!alive || !data) return
      setSettingsId(data.id)
      setHasCheckinCols('checkin_prep_enabled' in data)
      setPrepEnabled(!!data.checkin_prep_enabled)
      setLeadDays(Number.isInteger(data.checkin_prep_lead_days) ? data.checkin_prep_lead_days : 1)
    })
    return () => { alive = false }
  }, [])

  // Writes ONLY the two check-in columns.
  //
  // ⚠ Deliberately not routed through the Settings screen's save. That page sends one payload
  // containing every settings column, so a column missing on a tenant fails the ENTIRE save and
  // would stop an owner editing a rate. Keeping these two here keeps that blast radius at zero.
  async function saveCheckin(next: { enabled?: boolean; lead?: number }) {
    if (!hasCheckinCols || settingsId == null || busy) return
    setBusy(true)
    const enabled = next.enabled ?? prepEnabled
    const lead = next.lead ?? leadDays
    setPrepEnabled(enabled); setLeadDays(lead)
    await supabase
      .from('settings')
      .update({ checkin_prep_enabled: enabled, checkin_prep_lead_days: lead })
      .eq('id', settingsId)
    // Switching it on should produce today's prep tasks now, not on the next page load.
    await onChanged()
    setBusy(false)
  }

  // Pause / Resume. `active = false` generates nothing; the instances already made stay on the
  // board, because they are real work somebody may still owe.
  async function toggleActive(rule: TaskRule) {
    if (busy) return
    setBusy(true)
    await supabase.from('task_rules').update({ active: !rule.active }).eq('id', rule.id)
    // Resuming can make today's occurrence due immediately — regenerate so it appears.
    await onChanged()
    setBusy(false)
  }

  // Remove the RULE. A real delete, unlike a task: a rule is a setting a park may withdraw, not a
  // record of work. Past instances survive — tasks.rule_id is ON DELETE SET NULL — so the work
  // people already did stays on the board and simply stops being attached to a schedule.
  async function removeRule(rule: TaskRule) {
    if (busy) return
    setBusy(true)
    await supabase.from('task_rules').delete().eq('id', rule.id)
    await onChanged()
    setBusy(false)
  }

  async function saveEdit(rule: TaskRule, patch: Partial<TaskRule>) {
    if (busy) return
    setBusy(true)
    await supabase.from('task_rules').update(patch).eq('id', rule.id)
    setEditing(null)
    // An edited schedule only affects occurrences not yet created — the engine never pre-creates
    // the future, which is exactly what makes an edit take effect from now on.
    await onChanged()
    setBusy(false)
  }

  return (
    // FIXED, not absolute. The board renders inside a section with `overflow-hidden` (so the task
    // list can scroll within its own rounded corners), which would clip an absolutely-positioned
    // child to a sliver. Fixed escapes that and centres over the page. Click the backdrop or press
    // Escape to close.
    <div
      className="fixed inset-0 z-50 flex items-start justify-center p-4 overflow-y-auto"
      style={{ background: 'rgba(38,48,43,.28)' }}
      onClick={onClose}
      role="presentation"
    >
      <div
        className="w-full rounded-2xl bg-white my-8"
        // maxWidth INLINE, not `max-w-lg`. app/globals.css carries an unlayered
        // `* { box-sizing: border-box; max-width: 100% }` (the mobile-overflow guard), and in
        // Tailwind v4 unlayered CSS beats every utility regardless of specificity — so max-w-lg
        // silently loses and the dialog spans the whole window. Same trap as the board
        // checkbox's width; inline styles sit outside the layer system.
        style={{ border: `1px solid ${LINE}`, boxShadow: '0 8px 30px rgba(30,40,35,.18)', maxWidth: 560 }}
        onClick={e => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="Manage reminders"
        onKeyDown={e => { if (e.key === 'Escape') onClose() }}
      >
        <div className="flex items-center gap-2 px-4 py-3.5 font-extrabold text-[15px]"
          style={{ borderBottom: `1px solid ${LINE}`, color: INK }}>
          <span aria-hidden="true">⚙</span> Manage reminders
          <button
            type="button"
            onClick={onClose}
            aria-label="Close manage reminders"
            className="ml-auto border-none bg-transparent text-[17px] leading-none px-1 rounded-md cursor-pointer hover:bg-[#f3eee3]"
            style={{ color: MUTED }}
          >
            ×
          </button>
        </div>

        {/* ── RECURRING RULES ─────────────────────────────────────────────────────────────── */}
        <div className="px-4 py-3.5" style={{ borderBottom: `1px solid ${LINE}` }}>
          <h3 className="m-0 mb-2.5 text-[12px] font-bold uppercase tracking-wide" style={{ color: MUTED }}>
            Recurring reminders
          </h3>

          {rules.length === 0 && (
            <p className="text-[12.5px] m-0" style={{ color: MUTED }}>
              None yet. Create one from the board — set “Repeat” when you add a task.
            </p>
          )}

          {rules.map((rule, i) => (
            <div key={rule.id} style={{ borderBottom: i === rules.length - 1 ? 'none' : '1px solid #f1ede2' }}>
              <div className="flex items-center gap-2.5 py-2.5">
                <div className="min-w-0">
                  <div className="text-[13.5px] font-semibold" style={{ color: rule.active ? INK : MUTED }}>
                    {rule.title}
                    {!rule.active && <span className="ml-1.5 font-normal text-[11.5px]">(paused)</span>}
                  </div>
                  <div className="text-[12px] mt-0.5" style={{ color: INK_SOFT }}>
                    {describeRule(rule)}
                    {rule.assigned_to && (() => {
                      const name = people.find(p => p.id === rule.assigned_to)?.full_name
                      return name ? ` · ${name}` : ''
                    })()}
                  </div>
                </div>
                <div className="ml-auto flex gap-1.5 flex-none">
                  <button type="button" disabled={busy}
                    onClick={() => setEditing(editing === rule.id ? null : rule.id)}
                    className="text-[11.5px] font-bold rounded-lg px-2.5 py-1 bg-white cursor-pointer"
                    style={{ border: `1px solid ${LINE}`, color: INK_SOFT }}>
                    {editing === rule.id ? 'Cancel' : 'Edit'}
                  </button>
                  <button type="button" disabled={busy} onClick={() => toggleActive(rule)}
                    className="text-[11.5px] font-bold rounded-lg px-2.5 py-1 bg-white cursor-pointer"
                    style={{ border: `1px solid ${LINE}`, color: INK_SOFT }}>
                    {rule.active ? 'Pause' : 'Resume'}
                  </button>
                  <button type="button" disabled={busy} onClick={() => removeRule(rule)}
                    aria-label={`Remove the reminder “${rule.title}”`}
                    className="text-[11.5px] font-bold rounded-lg px-2.5 py-1 cursor-pointer"
                    style={{ border: '1px solid #f2ccd0', background: '#fdf1f2', color: '#b0432b' }}>
                    ×
                  </button>
                </div>
              </div>

              {editing === rule.id && <ScheduleEditor rule={rule} busy={busy} onSave={saveEdit} />}
            </div>
          ))}
        </div>

        {/* ── CHECK-IN PREP ───────────────────────────────────────────────────────────────── */}
        {hasCheckinCols && (
          <div className="px-4 py-3.5">
            <h3 className="m-0 mb-2.5 text-[12px] font-bold uppercase tracking-wide" style={{ color: MUTED }}>
              Check-in prep reminders
            </h3>

            {/* A button with role="switch" rather than a styled checkbox: it needs no sizing
                override against globals.css's unlayered `input { width: 100% }`, and it announces
                its on/off state to a screen reader through aria-checked. Same visual as the
                Sites page's pet toggle. */}
            <div className="flex items-center gap-2.5 text-[13.5px]" style={{ color: INK }}>
              <button
                type="button"
                role="switch"
                aria-checked={prepEnabled}
                aria-label="Automatically add a prep task before each check-in"
                disabled={busy || !canEditPark}
                onClick={() => saveCheckin({ enabled: !prepEnabled })}
                className="relative rounded-full border-none cursor-pointer flex-none disabled:opacity-60"
                style={{
                  width: 38, height: 22,
                  background: prepEnabled ? GREEN : '#d1d5db',
                  transition: 'background .15s',
                }}
              >
                <span
                  aria-hidden="true"
                  className="absolute rounded-full bg-white"
                  style={{ width: 18, height: 18, top: 2, left: prepEnabled ? 18 : 2, transition: 'left .15s' }}
                />
              </button>
              <b>{prepEnabled ? 'On' : 'Off'}</b>
              <span style={{ color: INK_SOFT }}>— auto-add a prep task before each check-in</span>
            </div>

            <div className="mt-2.5 flex items-center gap-2 text-[13px]" style={{ color: INK_SOFT }}>
              <label htmlFor="prep-lead">Show it</label>
              <select
                id="prep-lead"
                value={leadDays}
                disabled={busy || !prepEnabled || !canEditPark}
                onChange={e => saveCheckin({ lead: Number(e.target.value) })}
                className="rounded-lg px-2 py-1 text-[12.5px] bg-white"
                // width inline for the same reason as the dialog above — globals.css sets
                // `select { width: 100% }` unlayered, which no utility class can beat.
                style={{ border: `1px solid ${LINE}`, color: INK_SOFT, width: 'auto', flex: 'none' }}
              >
                <option value={1}>the day before</option>
                <option value={2}>2 days before</option>
                <option value={0}>the morning of</option>
              </select>
            </div>

            <p className="text-[12px] mt-2 leading-relaxed" style={{ color: MUTED }}>
              Choose which sites need prep on the <b>Sites</b> page (a “needs prep before check-in”
              switch, next to pet-friendly). Cabins and rooms usually on; tent and RV sites usually off.
            </p>

            {/* Said out loud rather than left as a dead switch. roleLoaded gates the message so a
                slow /api/me does not flash "ask an owner" at an owner. */}
            {roleLoaded && !canEditPark && (
              <p className="text-[12px] mt-2 leading-relaxed" style={{ color: '#9a7420' }}>
                These two settings, and the Sites page, are owner-only — ask an owner to switch
                check-in prep on. Recurring reminders above are open to everyone.
              </p>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

/** The schedule editor, reopened by "Edit". Same vocabulary as the board's Repeat control. */
function ScheduleEditor({
  rule, busy, onSave,
}: {
  rule: TaskRule
  busy: boolean
  onSave: (rule: TaskRule, patch: Partial<TaskRule>) => void
}) {
  const [freq, setFreq] = useState(rule.freq)
  const [days, setDays] = useState<number[]>(rule.byweekday ?? [])
  const [monthday, setMonthday] = useState<number>(rule.bymonthday ?? 1)
  const [time, setTime] = useState((rule.at_time || '10:00').slice(0, 5))

  return (
    <div className="rounded-[10px] px-[11px] py-[9px] mb-2.5" style={{ border: `1px dashed ${LINE}`, background: '#faf8f2' }}>
      <div className="flex items-center gap-2 flex-wrap text-[12.5px]" style={{ color: INK_SOFT }}>
        <label htmlFor={`freq-${rule.id}`} className="sr-only">Frequency</label>
        <select id={`freq-${rule.id}`} value={freq} onChange={e => setFreq(e.target.value as TaskRule['freq'])}
          className="rounded-lg px-2 py-1 text-[12.5px] bg-white" style={{ border: `1px solid ${LINE}`, color: INK_SOFT, width: 'auto', flex: 'none' }}>
          <option value="daily">Daily</option>
          <option value="weekly">Weekly</option>
          <option value="monthly">Monthly</option>
        </select>

        {freq === 'weekly' && (
          <div className="flex gap-1" role="group" aria-label="Days of the week">
            {DAY_LETTERS.map((letter, i) => {
              const on = days.includes(i)
              return (
                <button key={i} type="button" aria-pressed={on} aria-label={DAY_FULL[i]}
                  onClick={() => setDays(on ? days.filter(d => d !== i) : [...days, i])}
                  className="rounded-full text-[11px] font-bold inline-flex items-center justify-center cursor-pointer"
                  style={{
                    width: 26, height: 26,
                    border: `1px solid ${on ? GREEN : LINE}`,
                    background: on ? GREEN : '#fff',
                    color: on ? '#fff' : INK_SOFT,
                  }}>
                  {letter}
                </button>
              )
            })}
          </div>
        )}

        {freq === 'monthly' && (
          <>
            <label htmlFor={`md-${rule.id}`} className="sr-only">Day of the month</label>
            <select id={`md-${rule.id}`} value={monthday} onChange={e => setMonthday(Number(e.target.value))}
              className="rounded-lg px-2 py-1 text-[12.5px] bg-white" style={{ border: `1px solid ${LINE}`, color: INK_SOFT, width: 'auto', flex: 'none' }}>
              {Array.from({ length: 31 }, (_, i) => i + 1).map(d => <option key={d} value={d}>{d}</option>)}
            </select>
          </>
        )}

        <label htmlFor={`t-${rule.id}`} className="sr-only">Time of day</label>
        <input id={`t-${rule.id}`} type="time" value={time} onChange={e => setTime(e.target.value)}
          className="rounded-lg px-2 py-1 text-[12.5px] bg-white"
          style={{ border: `1px solid ${LINE}`, color: INK_SOFT, width: 110, flex: 'none' }} />

        <button
          type="button"
          disabled={busy || (freq === 'weekly' && days.length === 0)}
          onClick={() => onSave(rule, {
            freq,
            byweekday: freq === 'weekly' ? days : null,
            bymonthday: freq === 'monthly' ? monthday : null,
            at_time: time,
          })}
          className="rounded-lg px-3 py-1 text-[12.5px] font-bold text-white cursor-pointer disabled:opacity-50"
          style={{ background: GREEN, border: 'none' }}
        >
          Save
        </button>
        {freq === 'weekly' && days.length === 0 && (
          <span style={{ color: '#b0432b' }}>pick at least one day</span>
        )}
      </div>
    </div>
  )
}
