import 'server-only'
import { svc } from '@/lib/contract-server'
import { rateFromSettings, type ElectricRate } from '@/lib/electric-billing'
import {
  campersBySite, camperForMeter, resolveBillable, meterWalkOrder, billableLabel, buildDraftBills,
  meterSiteKey,
  type Meter, type MeterCamper, type BillableReason,
} from '@/lib/meters'
import { splitSiteNumbers } from '@/lib/occupancy-report'

/** Meters that have no prior reading of their own — the ones needing a recovered baseline. */
function out0Meters(meters: Meter[], priorByMeter: Map<string, unknown>): Meter[] {
  return meters.filter(m => !priorByMeter.has(m.id))
}

// The server half of the meter walk. Everything that touches the database lives here so the
// routes stay thin and the pure logic in lib/meters.ts stays testable without one.
//
// ⚠ THE ONE RULE THIS FILE ENFORCES: nothing here posts a charge. It writes meters, sessions,
// readings, and DRAFT rows in electric_readings — and a draft has folio_line_item_id NULL and
// status 'draft', so it is not money and no ledger, receipt, report or statement counts it. The
// only thing that turns a draft into a charge is the owner pressing Bill Electric on the Electric
// Billing page, which is the existing, unmodified path.

export type MeterWithContext = {
  meter: Meter
  siteNumber: string
  camper: { id: string; name: string; site_number: string; email: string } | null
  billable: boolean
  reason: BillableReason
  reasonLabel: string
  /** The last reading BEFORE this session — what the walk carries forward from. */
  previousValue: number | null
  previousReadAt: string | null
  /** Where `previousValue` came from. 'meter' = a real prior meter reading; 'bill' = recovered
   *  from the camper's last posted electric bill because the meter has none yet; 'none' = there
   *  is genuinely no prior reading and usage will be measured from this walk onward. */
  previousSource: 'meter' | 'bill' | 'none'
  /** True when this meter shares its billing history with another meter (a camper on two sites
   *  whose bills carry ONE reading pair). A per-meter baseline cannot be recovered from that —
   *  see the note in loadMeterContext(). */
  sharedHistory: boolean
  /** This session's reading, when one has already been taken. */
  reading: {
    id: string; reading_value: number; previous_value: number | null; read_at: string
    is_meter_reset: boolean; reset_start_value: number | null; notes: string
  } | null
}

/** The park's electric rate, read once per request. */
export async function getElectricRate(): Promise<ElectricRate> {
  const { data } = await svc.from('settings')
    .select('electric_rate_per_kwh, electric_minimum_charge').limit(1).maybeSingle()
  return rateFromSettings(data)
}

/**
 * Every active meter, resolved: whose it is, whether it bills, and what it read last.
 *
 * `sessionId` scopes the "already read" half. Pass null for a single ad-hoc read, and the
 * previous value is then simply the most recent reading of any kind.
 *
 * ⚠ THE PREVIOUS VALUE IS THE LAST READING, NOT THE LAST BILL. They differ, legitimately: a
 * mid-month read on the 14th becomes the 30th's "previous" even though it was never billed on its
 * own, and an owner who edits an AMOUNT on a bill has not changed what the meter said. Carrying
 * from the meter is what keeps a month's usage from being counted twice or skipped.
 */
export async function loadMeterContext(sessionId: string | null): Promise<{
  meters: MeterWithContext[]
  conflicts: { siteNumber: string; campers: { id: string; name: string }[] }[]
}> {
  const [{ data: meterRows }, { data: siteRows }, { data: guestRows }] = await Promise.all([
    svc.from('meters').select('*').eq('active', true),
    svc.from('sites').select('id, site_number'),
    svc.from('guests').select('id, name, email, site_number, is_seasonal, is_monthly, electric_billing_enabled'),
  ])

  const meters = meterWalkOrder((meterRows || []) as Meter[])
  const siteNumberById = new Map<string, string>()
  for (const s of siteRows || []) siteNumberById.set(s.id, s.site_number)

  // Only campers who are actually resident matter. A guest row with a blank site number cannot
  // occupy a meter and is skipped rather than matched to the empty string.
  //
  // ⚠ THE TENURE FLAGS ARE THE FILTER NOW — `is_monthly` INCLUDED. It used to be
  // `is_seasonal || electric_billing_enabled`, which dropped a monthly camper who had not been
  // flagged for electric billing. Dropped meant the meter reported "No seasonal camper" while
  // somebody was living on the site — the reader could see no reason for it and nothing to fix.
  // They are now carried through and resolve to 'billing-off', which names them and says why.
  //
  // `electric_billing_enabled` stays in the OR so a camper flagged for electric billing is never
  // silently dropped from the walk on a park that records tenure differently; resolveBillable()
  // still decides whether they actually bill — and for a NIGHTLY guest carrying that flag by
  // mistake, it now refuses. That is the reachable half of the transient rule.
  //
  // ⚠ NIGHTLY GUESTS ARE DELIBERATELY *NOT* INDEXED BY `site_number`, AND THIS MUST NOT BE
  // "FIXED" LATER. It looks like an omission — a nightly camper is on a site, so why not match
  // them? Because `guests.site_number` is not live occupancy for them: it is a leftover from
  // whatever reservation last touched the row. On the live park, 65 of 66 non-long-stay guests
  // carry one (checked 2026-09-01), most of them long departed, many of them holding the number
  // of a site a seasonal camper lives on today.
  //
  // Matching on it would name a guest from a past stay as the current occupant of somebody's
  // meter, and — because two campers on one site is a conflict — could flip which camper a meter
  // bills. A meter over an unflagged nightly camper therefore reads "no camper", which is
  // recorded and never billed: the right OUTCOME, reached without pretending to know who is
  // standing there. Live nightly occupancy lives in `reservations`, not here.
  const campers = ((guestRows || []) as MeterCamper[])
    .filter(g => typeof g.site_number === 'string' && g.site_number.trim() !== '')
    .filter(g => g.is_seasonal === true || g.is_monthly === true || g.electric_billing_enabled === true)
  const { bySite, conflicts } = campersBySite(campers)

  const meterIds = meters.map(m => m.id)
  // Every reading for these meters, newest first. Two facts come out of one query: this session's
  // reading (if any) and the most recent one before it.
  const { data: readingRows } = meterIds.length
    ? await svc.from('meter_readings')
        .select('id, meter_id, session_id, reading_value, previous_value, read_at, is_meter_reset, reset_start_value, notes, created_at')
        .in('meter_id', meterIds)
        .order('read_at', { ascending: false })
        .order('created_at', { ascending: false })
    : { data: [] }

  const thisSession = new Map<string, Record<string, unknown>>()
  const priorByMeter = new Map<string, Record<string, unknown>>()
  for (const r of readingRows || []) {
    const mid = r.meter_id as string
    if (sessionId && r.session_id === sessionId) {
      if (!thisSession.has(mid)) thisSession.set(mid, r)
      continue
    }
    // Rows arrive newest-first, so the first non-session row per meter is the one to carry from.
    if (!priorByMeter.has(mid)) priorByMeter.set(mid, r)
  }

  // ── ⚠ THE CARRY-FORWARD FALLBACK — THIS IS THE FIX FOR A REAL BILLING BUG ─────────────────
  //
  // The registry is seeded from `sites`, which carries no readings. So on a park's FIRST walk
  // every meter had no prior `meter_readings` row, `previousValue` came back null, and the draft
  // builder's `?? 0` turned that into "the meter read zero last month". A camper whose meter
  // reads 5803 was billed for 5,803 kWh instead of the 43 they used — $1,566.81 instead of
  // $15.00. Draft-first caught it before it reached anybody, which is exactly what it is for.
  //
  // A meter with no reading of its own is not a meter that read zero. When the meter has nothing,
  // the camper's last POSTED, non-voided electric bill is the baseline — that is what the park
  // billed them up to, so it is where the next bill must start.
  //
  // ⚠ NOT APPLIED TO A CAMPER ON MORE THAN ONE METER, DELIBERATELY. Those bills carry ONE reading
  // pair for the whole camper (Cady's "67,68" is billed 4890 -> 5083), so there is no per-meter
  // number in there to recover. Splitting it, or giving the same figure to both meters, would
  // invent usage and over-bill — the very failure this fallback exists to prevent. Such meters
  // keep a null baseline, are flagged `sharedHistory`, and the first walk sets their true
  // starting numbers.
  const needFallback = out0Meters(meters, priorByMeter)
  const fallbackByMeter = new Map<string, { value: number; at: string | null }>()
  const sharedByMeter = new Set<string>()
  if (needFallback.length) {
    const guestIds = [...new Set(needFallback
      .map(m => camperForMeter(m, bySite, siteNumberById)?.id).filter(Boolean) as string[])]
    // How many metered numbers does each camper hold? More than one => shared history.
    const meterNumbers = new Set(meters.map(m => meterSiteKey(m, siteNumberById)).filter(Boolean))
    if (guestIds.length) {
      const { data: bills } = await svc.from('electric_readings')
        .select('guest_id, current_reading, created_at, billing_month, status, voided')
        .in('guest_id', guestIds).eq('status', 'posted')
        .order('created_at', { ascending: false })
      const lastByGuest = new Map<string, { current_reading: number; created_at: string }>()
      for (const b of bills || []) {
        if (b.voided === true) continue
        if (!lastByGuest.has(b.guest_id as string)) {
          lastByGuest.set(b.guest_id as string, {
            current_reading: Number(b.current_reading), created_at: String(b.created_at),
          })
        }
      }
      for (const m of needFallback) {
        const camper = camperForMeter(m, bySite, siteNumberById)
        if (!camper) continue
        const held = splitSiteNumbers(camper.site_number).filter(n => meterNumbers.has(n))
        if (held.length > 1) { sharedByMeter.add(m.id); continue }   // ambiguous — see above
        const last = lastByGuest.get(camper.id)
        if (last && Number.isFinite(last.current_reading)) {
          fallbackByMeter.set(m.id, { value: last.current_reading, at: last.created_at.slice(0, 10) })
        }
      }
    }
  }

  const out: MeterWithContext[] = meters.map(meter => {
    const camper = camperForMeter(meter, bySite, siteNumberById)
    const { billable, reason } = resolveBillable(meter, camper)
    const prior = priorByMeter.get(meter.id)
    const mine = thisSession.get(meter.id)
    return {
      meter,
      siteNumber: (meter.site_id && siteNumberById.get(meter.site_id)) || meter.meter_number,
      camper: camper ? { id: camper.id, name: camper.name, site_number: camper.site_number || '', email: camper.email || '' } : null,
      billable,
      reason,
      reasonLabel: billableLabel(reason),
      previousValue: prior ? Number(prior.reading_value)
                   : (fallbackByMeter.get(meter.id)?.value ?? null),
      previousReadAt: prior ? String(prior.read_at)
                    : (fallbackByMeter.get(meter.id)?.at ?? null),
      previousSource: prior ? 'meter' : (fallbackByMeter.has(meter.id) ? 'bill' : 'none'),
      sharedHistory: sharedByMeter.has(meter.id),
      reading: mine ? {
        id: String(mine.id),
        reading_value: Number(mine.reading_value),
        previous_value: mine.previous_value === null ? null : Number(mine.previous_value),
        read_at: String(mine.read_at),
        is_meter_reset: mine.is_meter_reset === true,
        reset_start_value: mine.reset_start_value === null ? null : Number(mine.reset_start_value),
        notes: String(mine.notes || ''),
      } : null,
    }
  })

  return {
    meters: out,
    conflicts: conflicts.map(c => ({ siteNumber: c.siteNumber, campers: c.campers.map(x => ({ id: x.id, name: x.name })) })),
  }
}

// ── DRAFT STAGING ────────────────────────────────────────────────────────────────────────────
//
// ⚠ READ THIS BEFORE CHANGING ANYTHING BELOW. This is the closest the meter walk comes to money,
// and it deliberately stops short of it. A draft row is:
//
//     status              = 'draft'
//     folio_line_item_id  = NULL      <- the load-bearing one
//
// Nothing is charged, nothing is emailed, no folio is touched, no folio_line_items row is
// written. Every consumer that classifies a charge as electric does it by looking a line-item id
// up in electric_readings.folio_line_item_id (see lib/ledger-lanes.ts), and a draft's is NULL, so
// a draft cannot be mistaken for a charge by the ledger, the receipts, the statements or the
// reports even if one of them forgets to filter on status.
//
// The ONLY thing that turns a draft into money is the owner pressing Bill Electric on the
// Electric Billing page — the existing path, unchanged by this feature.

/** Re-derive every draft bill for a session from its readings. Idempotent. */
export async function restageDraftsForSession(sessionId: string): Promise<{
  drafts: number; skippedAlreadyPosted: string[]
}> {
  const { data: session } = await svc.from('meter_reading_sessions')
    .select('id, billing_month, read_date').eq('id', sessionId).maybeSingle()
  if (!session) return { drafts: 0, skippedAlreadyPosted: [] }

  const [{ data: readingRows }, { data: meterRows }, rate] = await Promise.all([
    svc.from('meter_readings')
      .select('meter_id, reading_value, previous_value, is_meter_reset, reset_start_value, guest_id, billable')
      .eq('session_id', sessionId),
    svc.from('meters').select('*'),
    getElectricRate(),
  ])

  const metersById = new Map<string, Meter>()
  for (const m of (meterRows || []) as Meter[]) metersById.set(m.id, m)

  // ⚠ `billable` is read from the READING, not recomputed now. It was resolved when the meter was
  // read — override and occupancy as they stood at that moment — and re-deriving it here would
  // let a camper who moved out between the walk and the review silently lose their bill for
  // power they had already used.
  const bills = buildDraftBills(
    (readingRows || []).filter(r => r.billable === true),
    metersById,
    rate
  )

  // What already exists for this month, so a POSTED bill is never overwritten and a re-run
  // updates its own draft instead of adding a second one.
  const guestIds = bills.map(b => b.guestId)
  const { data: existing } = guestIds.length
    ? await svc.from('electric_readings')
        .select('id, guest_id, status, final_amount, calculated_amount')
        .eq('billing_month', session.billing_month).in('guest_id', guestIds)
    : { data: [] }

  const postedGuests = new Set((existing || []).filter(r => r.status !== 'draft').map(r => r.guest_id))
  const draftByGuest = new Map<string, { id: string; edited: boolean }>()
  for (const r of existing || []) {
    if (r.status !== 'draft') continue
    // "Edited" means the owner has moved the final away from what the meters computed. That is
    // her figure and a re-stage keeps it; an untouched draft follows the calculation.
    draftByGuest.set(r.guest_id as string, {
      id: r.id as string,
      edited: r.final_amount !== null && r.final_amount !== r.calculated_amount,
    })
  }

  const skippedAlreadyPosted: string[] = []
  let written = 0

  for (const bill of bills) {
    // ⚠ A POSTED BILL IS NEVER TOUCHED. If the owner already billed this camper for this month,
    // a later walk must not quietly restate the charge they have already sent. The reading is
    // still recorded in meter_readings; it simply does not restage a bill. Reported back so the
    // screen can say so rather than looking like it silently did nothing.
    if (postedGuests.has(bill.guestId)) { skippedAlreadyPosted.push(bill.guestId); continue }

    const breakdown = bill.meters.map(mu => ({
      meter_id: mu.meterId, meter_number: mu.meterNumber,
      previous_reading: mu.previousReading, current_reading: mu.currentReading,
      kwh: mu.kwh, is_reset: mu.isReset, replaced_meter_final: mu.replacedMeterFinal ?? null,
    }))
    // The scalar columns carry the SUMS across the camper's meters, which for the ordinary
    // one-meter camper is simply that meter's own readings. Because `previousReading` is
    // reset-aware, current - previous == kwh_used holds for a double-site camper and across a
    // meter replacement alike.
    const previousSum = bill.meters.reduce((s, mu) => s + mu.previousReading, 0)
    const currentSum = bill.meters.reduce((s, mu) => s + mu.currentReading, 0)

    const row = {
      guest_id: bill.guestId,
      billing_month: session.billing_month,
      previous_reading: previousSum,
      current_reading: currentSum,
      kwh_used: bill.kwhUsed,
      rate_per_kwh: rate.ratePerKwh,
      minimum_charge: rate.minimumChargeCents,
      calculated_amount: bill.calculatedAmountCents,
      status: 'draft',
      reading_session_id: sessionId,
      meter_breakdown: breakdown,
      folio_line_item_id: null,
    }

    const prior = draftByGuest.get(bill.guestId)
    if (prior) {
      // ⚠ AN EDITED AMOUNT SURVIVES A RE-STAGE. If the owner has already adjusted this draft's
      // final away from what the meters computed, that edit is hers and is kept; only the
      // readings and the calculated figure are refreshed. An untouched draft follows the
      // calculation, which is what she expects while she is still walking the park.
      await svc.from('electric_readings').update({
        ...row,
        ...(prior.edited ? {} : { final_amount: bill.calculatedAmountCents }),
      }).eq('id', prior.id)
    } else {
      await svc.from('electric_readings').insert({ ...row, final_amount: bill.calculatedAmountCents })
    }
    written++
  }

  // A draft this session created for a camper who no longer has a billable reading (the meter was
  // set to record-only, or the reading was removed) is withdrawn, so the review list matches the
  // walk. Scoped to THIS session's own drafts — never touches a posted bill or another walk's.
  const keep = new Set(bills.map(b => b.guestId))
  const { data: mine } = await svc.from('electric_readings')
    .select('id, guest_id').eq('reading_session_id', sessionId).eq('status', 'draft')
  const stale = (mine || []).filter(r => !keep.has(r.guest_id as string)).map(r => r.id as string)
  if (stale.length) await svc.from('electric_readings').delete().in('id', stale).eq('status', 'draft')

  return { drafts: written, skippedAlreadyPosted }
}
