// The optional payment schedule printed on a seasonal agreement.
//
// ⚠ DISPLAY ONLY, exactly like total_due_cents and deposit_due_cents. Everything here formats;
// nothing here charges. No function in this file writes, and no folio total reads it. It is a
// printed plan, not a billing engine.
//
// EVERY FIELD IS OPTIONAL, AND THAT IS THE DESIGN RATHER THAN LAXNESS. Half-known plans are the
// normal state in the autumn — "something in January, we'll agree the figure nearer the time" is
// a row an owner genuinely wants to print. So a row with only a date is valid, a row with only an
// amount is valid, and only a row with NOTHING in it is dropped.


// ⚠ renderSchedule() LIVES IN lib/contracts.ts, NOT HERE, and is re-exported below.
//
// It needs formatCents and formatContractDate, which are contract-rendering concerns and live
// there; importing them here while contracts.ts imported this file back would be a cycle. So the
// PRINTING lives with the other printing, and this file keeps the FORM side — the draft rows the
// review screen edits. It is re-exported so there is still one name to reach for.
export { renderSchedule, bodyPlacesSchedule } from './contracts.ts'

/** One instalment, as stored in seasonal_contracts.payment_schedule. */
export type ScheduleRow = {
  label?: string | null
  /** Integer cents. Null means "an amount is not stated yet", which is different from $0.00. */
  amount_cents?: number | null
  /** ISO date, as the date input produces it. */
  due_by?: string | null
}

/** A row the form is editing — amounts as typed, before they become cents. */
export type ScheduleDraft = { label: string; amount: string; due_by: string }

export const emptyDraft = (): ScheduleDraft => ({ label: '', amount: '', due_by: '' })

/** True when a row holds nothing at all — the only case that is thrown away. */
export const isBlank = (d: ScheduleDraft): boolean =>
  !d.label.trim() && !d.amount.trim() && !d.due_by.trim()

/**
 * Drafts → the stored shape.
 *
 * Blank rows are dropped. An unparseable amount becomes null rather than NaN — a plan that says
 * "we'll agree it later" is a real plan, and NaN would reach the contract as "$NaN".
 * ORDER IS PRESERVED: instalments are a sequence, and re-sorting them by date would silently
 * rewrite what the owner typed.
 */
export function toStored(drafts: ScheduleDraft[]): ScheduleRow[] {
  return (drafts || []).filter(d => !isBlank(d)).map(d => {
    const cents = Math.round(parseFloat((d.amount || '').replace(/[^0-9.-]/g, '')) * 100)
    return {
      label: d.label.trim() || null,
      amount_cents: Number.isFinite(cents) ? cents : null,
      due_by: d.due_by.trim() || null,
    }
  })
}

/** The stored shape → drafts the form can edit. Survives anything hand-edited into the jsonb. */
export function toDrafts(stored: unknown): ScheduleDraft[] {
  if (!Array.isArray(stored)) return []
  return stored.map(r => {
    const row = (r ?? {}) as ScheduleRow
    return {
      label: (row.label ?? '').toString(),
      amount: row.amount_cents == null ? '' : (row.amount_cents / 100).toFixed(2),
      due_by: (row.due_by ?? '').toString(),
    }
  })
}

