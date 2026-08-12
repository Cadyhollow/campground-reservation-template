// Shared transaction source — the ONE place that assembles the unified payment
// list (folio payments + reservation booking payments). Consumed by both
// /admin/transactions and the Reports > Transactions tab so they can never drift.
import { createBrowserSupabase } from '@/lib/supabase-browser'

// Security PR 7-1: the admin browser talks to Supabase as the LOGGED-IN USER, not as `anon`.
// Same publishable key, but it travels with the session cookie, so PostgREST runs these queries
// as `authenticated` and the role-gated RLS policies apply. Safe at module scope:
// createBrowserClient returns a singleton in the browser and a no-op cookie store during
// prerender.
const supabase = createBrowserSupabase()

export type UnifiedPayment = {
  id: string
  paid_at: string
  method: string
  amount: number            // gross: what actually hit the till / card
  surcharge_amount: number  // portion of amount that is card fee (0 for cash/check)
  status: string
  note: string
  folio_id: string
  folio_type: string
  guest_name: string
  reservation_id: string | null
  guest_id: string | null
  is_reservation_payment: boolean // true = booking payment stored on reservations (no folio)
}

// Local-date YYYY-MM-DD (avoids the toISOString() UTC rollover bug after ~8pm ET)
export function ymd(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

// Map a LOCAL calendar day ('YYYY-MM-DD') to the correct UTC-instant window boundaries.
// Postgres compares timestamptz columns (paid_at, created_at, charged_at) against a naive
// string as UTC, so a bare 'date T00:00:00' silently shifts the window by the local offset
// (the ~8pm-ET rollover bug). Building the boundary from new Date(y, m-1, d, ...) — which is
// LOCAL time — then .toISOString() yields the real UTC instant of local midnight / end-of-day.
// Uses browser-local time, consistent with ymd() and the display grouping (a per-campground
// timezone setting is the long-term fix; see the reports page design note).
export function dayStartUTC(localDate: string): string {
  const [y, m, d] = localDate.split('-').map(Number)
  return new Date(y, m - 1, d, 0, 0, 0, 0).toISOString()
}
export function dayEndUTC(localDate: string): string {
  const [y, m, d] = localDate.split('-').map(Number)
  return new Date(y, m - 1, d, 23, 59, 59, 999).toISOString()
}

// startISO/endISO must be UTC-instant ISO strings (with a 'Z'/offset), e.g. from
// dayStartUTC(localDate) / dayEndUTC(localDate). Passing a naive local string here compares
// as UTC in Postgres and drops/misattributes payments near the local-day boundary.
export async function fetchUnifiedTransactions(startISO: string, endISO: string): Promise<UnifiedPayment[]> {
  const [{ data: pmtData }, { data: resData }] = await Promise.all([
    supabase
      .from('folio_payments')
      .select(`
        id, paid_at, method, amount, surcharge_amount, status, note, folio_id,
        folios ( id, folio_type, guest_name, reservation_id, guest_id )
      `)
      // Refund rows are counted, not filtered out. /api/refund leaves the original payment in
      // place, flips its status to 'refunded' or 'partially_refunded', and inserts a negative
      // row. Counting only 'completed' therefore dropped BOTH rows, so a partial refund erased
      // the whole original payment from revenue instead of just the part handed back — the kept
      // portion vanished. Counting all three lets them net: an untouched payment stands alone, a
      // full refund cancels to zero, a partial refund leaves exactly what was kept.
      // Listed explicitly rather than 'not voided' so any future status is excluded until
      // someone decides it counts. 'voided' stays out — a voided payment never happened.
      .in('status', ['completed', 'refunded', 'partially_refunded'])
      .gte('paid_at', startISO)
      .lte('paid_at', endISO)
      .order('paid_at', { ascending: false }),
    supabase
      .from('reservations')
      .select('id, guest_name, amount_paid, surcharge_amount, payment_type, payment_method, created_at, square_payment_id')
      .gt('amount_paid', 0)
      // Cancelled bookings are NOT filtered out, for the same reason refund rows are counted
      // above: the negative row does the netting. Excluding them double-counted the reduction
      // — a cancelled $500 booking refunded $450 lost the +$500 here AND still landed the
      // −$450 refund row on the folio, reading as −$450 revenue instead of the +$50 retained.
      // Counting the booking payment lets the two net to exactly what was kept, and a booking
      // cancelled WITHOUT a refund correctly stays as revenue, because the business kept the
      // money. Cancellation is a reservation-state fact; whether the money came back is a
      // payment fact, and only the payment rows should speak to revenue.
      .gte('created_at', startISO)
      .lte('created_at', endISO),
  ])

  const folioPayments: UnifiedPayment[] = ((pmtData as any[]) || []).map(p => ({
    id: p.id,
    paid_at: p.paid_at,
    method: p.method,
    amount: p.amount,
    surcharge_amount: p.surcharge_amount || 0,
    status: p.status,
    note: p.note || '',
    folio_id: p.folio_id,
    folio_type: p.folios?.folio_type || '',
    guest_name: p.folios?.guest_name || 'Unknown',
    reservation_id: p.folios?.reservation_id || null,
    guest_id: p.folios?.guest_id || null,
    is_reservation_payment: false,
  }))

  // Booking payments live in reservations.amount_paid and never overlap with
  // folio_payments, so merging the two lists needs no dedup. Post-Option-B the
  // card was charged amount_paid + surcharge_amount, so gross = the sum.
  //
  // paid_at below is created_at, not a payment timestamp — reservations carry no
  // paid_at. It is a close proxy rather than a fudge: amount_paid is written in the
  // request that creates the reservation, so creation is when the money arrived. Folio
  // payments above use their real paid_at.
  //
  // A reservation-leg refund no longer diverges from this: since 146ce86 it leaves
  // amount_paid untouched and records a dated negative row on the folio instead, so the
  // reduction lands in the month the money actually went back rather than the month the
  // booking was created.
  const bookingPayments: UnifiedPayment[] = ((resData as any[]) || []).map(r => ({
    id: 'res-' + r.id,
    paid_at: r.created_at,
    method: r.payment_method || (r.square_payment_id ? 'card' : 'cash'),
    amount: (r.amount_paid || 0) + (r.surcharge_amount || 0),
    surcharge_amount: r.surcharge_amount || 0,
    status: 'completed',
    note: r.payment_type === 'deposit' ? 'Deposit' : r.payment_type === 'unpaid' ? 'Pay on arrival' : 'Full payment',
    folio_id: '',
    folio_type: 'reservation',
    guest_name: r.guest_name,
    reservation_id: r.id,
    guest_id: null,
    is_reservation_payment: true,
  }))

  return [...folioPayments, ...bookingPayments]
    .sort((a, b) => new Date(b.paid_at).getTime() - new Date(a.paid_at).getTime())
}

// Base methods every campground has; custom ones (venmo, paypal, ...) come from
// settings.custom_payment_methods and get appended by callers.
export const BASE_PAYMENT_METHODS = ['cash', 'card', 'check'] as const

// ── Payment method helpers (Fix 6) ──────────────────────────────────────────
// Custom methods (venmo, paypal, cashapp, ...) come from settings.custom_payment_methods.
// Callers pass the settings row (or the array itself); we normalize + dedupe.
export function allPaymentMethods(custom?: string[] | null): string[] {
  const extras = (custom || [])
    .map(m => (m || '').trim().toLowerCase())
    .filter(m => m.length > 0 && !(BASE_PAYMENT_METHODS as readonly string[]).includes(m))
  return [...BASE_PAYMENT_METHODS, ...Array.from(new Set(extras))]
}

// Display: 'cash' -> 'Cash', 'cashapp' -> 'Cashapp' (clients can name methods as they like)
export function methodLabel(method: string): string {
  if (!method) return ''
  return method.charAt(0).toUpperCase() + method.slice(1)
}

// Consistent dot colors: fixed for the base three, rotating palette for customs
const CUSTOM_METHOD_COLORS = ['#3b82f6', '#10b981', '#ec4899', '#f97316', '#14b8a6']
export function methodColor(method: string, custom?: string[] | null): string {
  if (method === 'cash') return '#f59e0b'
  if (method === 'card') return '#8b5cf6'
  if (method === 'check') return '#6b7280'
  const idx = (custom || []).findIndex(m => (m || '').trim().toLowerCase() === method)
  return idx >= 0 ? CUSTOM_METHOD_COLORS[idx % CUSTOM_METHOD_COLORS.length] : '#d1d5db'
}
