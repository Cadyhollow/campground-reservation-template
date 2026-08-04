// The cancellation policy, resolved to numbers something can compute with.
//
// cancellation_rules already stores the policy as structured data (refund_percent,
// cancellation_deadline_days, deposit_refundable) per date range, but nothing computed with
// it — the refund UIs hardcoded × 0.9, which is right only for a client whose standard policy
// happens to be 90% and wrong for every holiday rule sitting in the same table. Everything
// that needs a number now comes through here, so a client configuring a rule changes what the
// software does rather than only what the guest reads.
//
// Deliberately free of any Supabase import: the resolved policy and the refund arithmetic are
// used by the admin page in the browser as well as by the server routes, and a module-scope
// service-role client would be dragged into the client bundle behind it. The one function that
// touches the database takes the caller's client as an argument.

// Structural, so this file imports nothing. Both callers pass a real SupabaseClient.
type SupabaseLike = { from: (table: string) => any }

export type ResolvedPolicy = {
  name: string
  refund_percent: number
  cancellation_deadline_days: number
  deposit_refundable: boolean
  policy_text: string
  // Whether a date-specific rule matched, or these are the defaults below. Shown to the
  // operator so "Standard policy" is visibly not the same thing as "Fourth of July Holiday".
  source: 'rule' | 'default'
  rule_id: string | null
}

// The guaranteed floor. A client configures a default rule plus date-range exceptions, but
// until they do, a booking outside every range still has to resolve to something computable.
// Nulls used to come back here, which is exactly why the refund UI could not read the policy
// and hardcoded 90%. These match the cancellation_rules column defaults, so an unconfigured
// park and a park that saved the form without touching the numbers behave identically.
//
// NEUTRAL, not opinionated. These were 90% and 7 days — which is Cady's cancellation fee, not
// a fact about campgrounds. Baked into the template it meant every future client silently
// inherited Cady's business rule and kept 10% of a camper's money under a policy nobody at
// that park had chosen. A default that moves money has to be the one that cannot surprise
// anyone: refund everything, right up to arrival.
//
// The two failure modes are not symmetrical. A park that wanted to retain a fee and has not
// configured one yet refunds too generously and notices. A park that never chose to retain
// anything keeps money it has no basis to keep, and nobody notices — least of all the camper.
//
// A deadline of 0 means "full refund up to the arrival date, none after": computePolicyRefund
// tests `daysUntil < deadline`, so only a cancellation AFTER arrival (negative days) lands
// inside the deadline. Parks that want a real cutoff configure one.
//
// Cady keeps 90/7 through an explicit "Standard Policy" catch-all rule covering all dates, so
// its behaviour is unchanged by this — its policy is now data it owns rather than a constant
// every other client inherits.
export const DEFAULT_REFUND_PERCENT = 100
export const DEFAULT_DEADLINE_DAYS = 0
export const DEFAULT_DEPOSIT_REFUNDABLE = true

const DEFAULT_POLICY_TEXT = 'Please contact us for cancellation information.'

// Coerces a rule row — or a partial/legacy one — into fully numeric terms. A rule saved
// before a column existed, or with a NULL left in it, resolves to the default rather than to
// NaN or to "no refund".
export function normalizePolicy(
  rule: any | null,
  fallbackText?: string | null
): ResolvedPolicy {
  const pct = Number(rule?.refund_percent)
  const days = Number(rule?.cancellation_deadline_days)
  return {
    name: rule?.name || 'Standard Policy',
    refund_percent: Number.isFinite(pct) ? Math.min(100, Math.max(0, pct)) : DEFAULT_REFUND_PERCENT,
    cancellation_deadline_days: Number.isFinite(days) ? Math.max(0, days) : DEFAULT_DEADLINE_DAYS,
    deposit_refundable: rule?.deposit_refundable ?? DEFAULT_DEPOSIT_REFUNDABLE,
    policy_text: rule?.policy_text || fallbackText || DEFAULT_POLICY_TEXT,
    source: rule ? 'rule' : 'default',
    rule_id: rule?.id ?? null,
  }
}

// The rule whose date range contains the arrival date, or the defaults. Same query the
// public booking page's policy endpoint has always run — lifted here so the cancel route
// resolves the policy the same way instead of trusting whatever the browser computed.
export async function resolveCancellationPolicy(
  supabase: SupabaseLike,
  arrival: string
): Promise<ResolvedPolicy> {
  const { data: rules } = await supabase
    .from('cancellation_rules')
    .select('*')
    .eq('is_active', true)
    .lte('start_date', arrival)
    .gte('end_date', arrival)
    .order('start_date', { ascending: false })

  const rule = rules && rules.length > 0 ? rules[0] : null
  if (rule) return normalizePolicy(rule)

  // No date-specific rule: the park's prose policy from settings still supplies the wording,
  // but the numbers now come from the defaults rather than coming back null.
  const { data: settings } = await supabase
    .from('settings')
    .select('cancellation_policy')
    .limit(1)
    .single()

  return normalizePolicy(null, settings?.cancellation_policy)
}

// Whole calendar days from today to arrival. Both are plain YYYY-MM-DD, parsed at UTC noon so
// a DST boundary between them cannot round the difference to 0.9 or 1.1 days and land the
// booking on the wrong side of the deadline.
export function daysUntilArrival(arrival: string, today: string): number {
  const a = Date.parse(`${arrival}T12:00:00Z`)
  const t = Date.parse(`${today}T12:00:00Z`)
  if (!Number.isFinite(a) || !Number.isFinite(t)) return 0
  return Math.round((a - t) / 86400000)
}

// How the cancellation sits relative to arrival, in words. An operator cancelling a no-show
// or tidying up a past booking is cancelling a NEGATIVE number of days before arrival, and
// "Cancelling -73 days before arrival" is not a sentence.
export function arrivalPhrase(days: number): string {
  const n = Math.abs(days)
  const unit = `${n} day${n === 1 ? '' : 's'}`
  if (days < 0) return `${unit} after arrival`
  if (days === 0) return 'on the arrival date'
  return `${unit} before arrival`
}

export type PolicyRefundBasis =
  | 'nothing-refundable'
  | 'inside-deadline'
  | 'non-refundable-deposit'
  | 'policy-percent'

export type PolicyRefundInput = {
  policy: ResolvedPolicy
  arrival: string
  today: string
  // What the card was charged on the booking leg: amount_paid + surcharge_amount. The policy
  // percentage applies to this, not to what happens to be left after an earlier refund.
  originalGrossCents: number
  // That original less the booking-leg refunds already recorded. The ceiling on anything this
  // flow can hand back, and the same figure /api/reservation-refund recomputes server-side.
  refundableCents: number
  paymentType: string | null | undefined
}

export type PolicyRefundResult = {
  refundCents: number
  daysUntil: number
  withinDeadline: boolean
  basis: PolicyRefundBasis
  // One line for the operator, naming the rule that produced the number.
  explanation: string
}

export function computePolicyRefund(input: PolicyRefundInput): PolicyRefundResult {
  const { policy, arrival, today, originalGrossCents, refundableCents, paymentType } = input
  const daysUntil = daysUntilArrival(arrival, today)
  const withinDeadline = daysUntil < policy.cancellation_deadline_days
  const money = (c: number) => `$${(c / 100).toFixed(2)}`

  if (refundableCents <= 0) {
    return {
      refundCents: 0, daysUntil, withinDeadline, basis: 'nothing-refundable',
      explanation: 'Nothing left to refund on this booking.',
    }
  }

  if (withinDeadline) {
    return {
      refundCents: 0, daysUntil, withinDeadline, basis: 'inside-deadline',
      explanation: `Cancelling ${arrivalPhrase(daysUntil)}, inside the ${policy.cancellation_deadline_days}-day deadline — ${policy.name} retains the full ${money(refundableCents)}.`,
    }
  }

  // Non-refundable deposit. Only a deposit booking has a deposit amount this can be applied
  // to: amount_paid IS the deposit, so the whole of it is retained. A payment_type='full'
  // booking stores no separate deposit figure, so there is nothing to single out — it falls
  // through to the percentage below. See the note in the PR: this is the reading that keeps a
  // full-payment guest from losing 100% under a rule that only ever meant to keep the deposit.
  if (!policy.deposit_refundable && paymentType === 'deposit') {
    return {
      refundCents: 0, daysUntil, withinDeadline, basis: 'non-refundable-deposit',
      explanation: `${policy.name} makes the deposit non-refundable, and the ${money(refundableCents)} paid on this booking is the deposit.`,
    }
  }

  // Prorated on the ORIGINAL charge, then clamped to what is still refundable — the same
  // basis the refund panel uses, so a booking already partially refunded cannot be talked
  // into handing back 90% of a figure that is no longer there.
  const byPercent = Math.round(originalGrossCents * policy.refund_percent / 100)
  const refundCents = Math.max(0, Math.min(byPercent, refundableCents))
  const clamped = refundCents < byPercent
  return {
    refundCents, daysUntil, withinDeadline, basis: 'policy-percent',
    explanation: `Cancelling ${arrivalPhrase(daysUntil)}, outside the ${policy.cancellation_deadline_days}-day deadline — ${policy.name} refunds ${policy.refund_percent}% of ${money(originalGrossCents)}${clamped ? `, held to the ${money(refundCents)} still refundable after earlier refunds` : ''}.`,
  }
}
