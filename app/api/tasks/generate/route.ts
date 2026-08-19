import { NextRequest, NextResponse } from 'next/server'
import { requireRole } from '@/lib/require-role'
import { adminDb } from '@/lib/admin-users'
import {
  clampToday, occurrencesDue, dueAtFor, checkinTaskTitle, addDays, ymdOf,
  type TaskRule,
} from '@/lib/task-generation'

// POST /api/tasks/generate  { today?: 'YYYY-MM-DD' }  →  { generated, recurring, checkin, today }
//
// The phase-2 generation pass. Turns recurring RULES and upcoming RESERVATIONS into ordinary rows
// on the To-Do board. Called by TodoPanel once, before its first read, on every dashboard load.
//
// ── THIS RUNS ON EVERY DASHBOARD LOAD, SO IT MUST BE IDEMPOTENT ───────────────────────────────
//
// Two people opening the dashboard at the same moment, or one person refreshing, must never
// produce two identical "take the deposit to the bank" tasks. Everything below inserts with
// ignoreDuplicates against the unique indexes installed by the phase-2 migration:
//
//     tasks_rule_occurrence_uniq  (rule_id, occurrence_date)
//     tasks_reservation_uniq      (reservation_id)
//
// That is a DATABASE guarantee, not an application one — it holds under genuine concurrency,
// where a read-then-write check would not. Nothing here reads-then-decides; it offers the row and
// lets the index refuse it.
//
// Those indexes are deliberately NOT partial. PostgREST emits ON CONFLICT with no index predicate
// and Postgres will not infer a partial index from that — it errors instead of deduplicating. The
// migration explains this at length; do not "improve" the indexes without reading it.
//
// ── WHY THE BROWSER SENDS THE DATE ────────────────────────────────────────────────────────────
//
// There is no `settings.park_timezone` in this application (lib/bookability.ts documents the gap
// and carries HORIZON_SERVER_SLACK_DAYS as its workaround). The app's only notion of "today" is
// the browser's, which is the machine sitting at the park. A server-side pass on Vercel thinks in
// UTC, and from 17:00 Pacific onwards UTC is already tomorrow — so a "Wednesday" reminder would
// appear on Tuesday evening.
//
// The browser therefore supplies its local date and clampToday() refuses anything more than a day
// either side of the server's own. Every real timezone is inside that window; a tampered value
// cannot manufacture months of tasks. Same reasoning and same tolerance as the horizon's slack.
//
// WHAT A FORGED DATE COULD DO, stated plainly: shift a signed-in staff member's own reminders by
// one day. No money, no guest data, nothing another tenant can see. That is why a one-day clamp
// is proportionate here and a park timezone column is the real fix.
//
// ── WHY SERVICE-ROLE ──────────────────────────────────────────────────────────────────────────
//
// requireRole establishes WHO is asking before any privilege is used — the same shape as every
// other service-role route here. The pass then needs to read `reservations` and `sites` and write
// `tasks` in one go, and to do it identically no matter which staff member happened to open the
// dashboard. It writes nothing a signed-in user could not already write from the board.

export const dynamic = 'force-dynamic'

type GenResult = { generated: number; recurring: number; checkin: number; today: string; ran: boolean }

export async function POST(request: NextRequest) {
  const denied = await requireRole(request, 'staff')
  if (denied) return denied

  const body = await request.json().catch(() => ({}))
  const today = clampToday(body?.today, ymdOf(new Date()))

  const result: GenResult = { generated: 0, recurring: 0, checkin: 0, today, ran: true }

  // ── PHASE-2 PRESENT? ────────────────────────────────────────────────────────────────────────
  // A tenant may have phase 1 and not phase 2. Probing task_rules is the cheapest honest test:
  // it ships in the same migration as every other phase-2 object, so if it is here they all are.
  // A miss is not an error — it is a park that has not taken the feature — so this returns a
  // quiet `ran: false` and the board carries on as phase 1.
  const probe = await adminDb.from('task_rules').select('id').limit(1)
  if (probe.error) {
    return NextResponse.json({ ...result, ran: false, reason: 'phase-2 not installed' })
  }

  await generateRecurring(today, result)
  await generateCheckin(today, result)

  result.generated = result.recurring + result.checkin
  return NextResponse.json(result)
}

/**
 * Recurring rules → task rows.
 *
 * For each ACTIVE rule, every occurrence from its watermark up to today (never beyond — the
 * future is not pre-created, which is what lets an edit take effect and a dismissal stick).
 */
async function generateRecurring(today: string, result: GenResult) {
  const { data: rules } = await adminDb
    .from('task_rules')
    .select('*')
    .eq('active', true)

  for (const rule of (rules ?? []) as TaskRule[]) {
    const due = occurrencesDue(rule, today)
    if (due.length === 0) {
      // Still advance the watermark: a rule that simply had no due dates this week should not
      // re-walk those days on every single load for the rest of its life.
      await advanceWatermark(rule, today)
      continue
    }

    const rows = due.map(date => ({
      title: rule.title,
      notes: rule.notes,
      priority: rule.priority,
      assigned_to: rule.assigned_to,
      due_at: dueAtFor(date, rule.at_time),
      created_by: rule.created_by,
      source: 'recurring',
      rule_id: rule.id,
      occurrence_date: date,
    }))

    // ignoreDuplicates = ON CONFLICT DO NOTHING. This is the whole idempotency guarantee.
    //
    // A dismissed occurrence still occupies its (rule_id, occurrence_date) slot — removed_at is
    // set but the row is there — so it is NOT regenerated. Dismissing today's bank run does not
    // cancel next Wednesday's, and does not bring today's straight back either.
    const { data: inserted, error } = await adminDb
      .from('tasks')
      .upsert(rows, { onConflict: 'rule_id,occurrence_date', ignoreDuplicates: true })
      .select('id')

    if (!error) result.recurring += inserted?.length ?? 0

    // Only advance past days we actually attempted. If the insert failed, the watermark stays put
    // and the next load retries — losing a day silently would be worse than generating it twice,
    // which the index prevents anyway.
    if (!error) await advanceWatermark(rule, today)
  }
}

async function advanceWatermark(rule: TaskRule, today: string) {
  if (rule.last_generated_on === today) return
  await adminDb.from('task_rules').update({ last_generated_on: today }).eq('id', rule.id)
}

/**
 * Upcoming reservations → check-in prep tasks.
 *
 * Only when the park has switched it on, only for sites it has marked as needing prep, and only
 * for reservations that are not cancelled.
 */
async function generateCheckin(today: string, result: GenResult) {
  // select('*') rather than naming the columns: on a tenant without the phase-2 settings columns
  // a named `checkin_prep_enabled` makes PostgREST error and this read return nothing at all.
  // Same rule the Settings and Sites screens follow for the pet columns.
  const { data: settings } = await adminDb.from('settings').select('*').limit(1).maybeSingle()
  if (!settings?.checkin_prep_enabled) return

  // 1 = the day before, 2 = two days before, 0 = the morning of. Anything unusable falls back to
  // the day before rather than to 0, because 0 would silently narrow the window to same-day.
  const raw = Number(settings.checkin_prep_lead_days)
  const lead = Number.isInteger(raw) && raw >= 0 && raw <= 14 ? raw : 1

  // Sites the park has actually marked. No marked sites → nothing to do, which is the state every
  // park is in the moment it switches the feature on. The Sites page carries a banner for exactly
  // this, so it is a visible nothing rather than a silent one.
  const { data: sites } = await adminDb.from('sites').select('id, site_number, needs_prep')
  const prepSites = new Map<string, string>()
  for (const s of sites ?? []) {
    if (s.needs_prep) prepSites.set(s.id, s.site_number)
  }
  if (prepSites.size === 0) return

  // The window: arrivals from today through `lead` days out. Bounded at both ends — an arrival
  // further out than the lead time is not due yet, and one already in the past is not raised
  // retroactively.
  const { data: arrivals } = await adminDb
    .from('reservations')
    .select('id, site_id, site_name, guest_name, arrival_date, status')
    .gte('arrival_date', today)
    .lte('arrival_date', addDays(today, lead))
    // Cancelled reservations raise nothing. This is the same test every other caller uses
    // (lib/bookability.ts, the dashboard's arrivals list): status = 'cancelled'.
    .neq('status', 'cancelled')

  const rows = (arrivals ?? [])
    .filter(r => r.site_id && prepSites.has(r.site_id))
    .map(r => ({
      // The reservation's `site_name` is the DISPLAY name a park chose ("Cabin 3", "Site 1"),
      // which is what belongs in a sentence a person reads. `sites.site_number` is the identity
      // needs_prep hangs off and is often just "1" — "Prep 1 — check-in tomorrow" reads like a
      // typo, so it is the fallback and gets a "Site " prefix to make it a name again.
      title: checkinTaskTitle(
        r.site_name?.trim() || `Site ${prepSites.get(r.site_id!) ?? ''}`.trim(),
        r.arrival_date, r.guest_name, today,
      ),
      due_at: dueAtFor(r.arrival_date, '00:00'),
      source: 'auto_checkin',
      reservation_id: r.id,
    }))

  if (rows.length === 0) return

  // One prep task per reservation, ever — including after it has been ticked off or dismissed.
  // That is what stops a dismissed prep task reappearing on the next load.
  const { data: inserted, error } = await adminDb
    .from('tasks')
    .upsert(rows, { onConflict: 'reservation_id', ignoreDuplicates: true })
    .select('id')

  if (!error) result.checkin += inserted?.length ?? 0
}
