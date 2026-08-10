// The confirmation page's data, read on the server with the service-role key.
//
// Security PR 3. The page a camper lands on after paying used to assemble itself in the
// browser from five anon-key PostgREST reads — reservations, folios, folio_payments,
// folio_line_items and settings. That is the dependency this module removes: the reads now
// happen here, server-side, and the browser receives rendered HTML instead of a Supabase
// client and a database it is allowed to query. Nothing about who can SEE a confirmation
// changes; only where the query runs.
//
// Importing this from a client component would drag the service-role key toward the browser
// bundle. It is only ever called from the confirmation server component.
//
// NOT AN API ROUTE, deliberately. There is no JSON endpoint here to call, widen or page
// through — the only output is one rendered confirmation. See getConfirmation below.

import { createClient } from '@supabase/supabase-js'
import { resolveCancellationPolicy } from '@/lib/cancellation-policy'

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

// reservations.id is `uuid DEFAULT gen_random_uuid()` — a random v4, not a sequence. That is
// what makes the link itself the credential and why relocating these reads needs no token:
// anyone holding the link sees the booking (exactly as today), and nobody can walk ids.
// Checked before querying so a malformed id answers "not found" instead of surfacing a
// PostgREST uuid-syntax error, and so nothing but a uuid ever reaches the filter.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export type ConfirmationData = {
  id: string
  guest_name: string
  guest_email: string
  arrival_date: string
  departure_date: string
  num_adults: number
  num_children: number
  site_number: string
  site_type: string
  // The three figures the payment summary prints. Computed here so the page stays
  // presentational, by the same arithmetic it used before — see below.
  chargesTotal: number
  totalPaid: number
  balanceRemaining: number
  checkInTime: string
  checkOutTime: string
  // Branding for the header. Read here rather than in the browser for the same reason as the
  // rest: this page should issue no anon query of its own.
  parkName: string
  logoUrl: string | null
  logoShape: string | null
  accentColor: string | null
  policyText: string | null
  depositRefundable: boolean
}

/**
 * One booking's confirmation, or null.
 *
 * Scoped to a single reservation by primary key and nothing else. There is no list form, no
 * caller-supplied filter, limit or offset, and the return type is a single object rather than
 * an array — a caller cannot widen this into an enumeration even with a valid id in hand.
 */
export async function getConfirmation(reservationId: string | null): Promise<ConfirmationData | null> {
  if (!reservationId || !UUID_RE.test(reservationId)) return null

  // Named columns, not select('*'). The browser used to receive every reservation column —
  // square_payment_id, payment_method, discount_code, special_requests, waiver_signed_at and
  // `notes`, which carries the refund audit trail. The page displays ten fields; it now
  // receives ten.
  const { data: reservation } = await supabase
    .from('reservations')
    .select('id, guest_name, guest_email, arrival_date, departure_date, num_adults, num_children, total_price, amount_paid, sites(site_number, site_type)')
    .eq('id', reservationId)
    .single()

  if (!reservation) return null

  const res = reservation as any
  const site = Array.isArray(res.sites) ? res.sites[0] : res.sites

  // Money for a booking taken by staff — the wizard, an owner booking, a walk-in — is recorded
  // on the reservation's folio, not in reservations.amount_paid. Reading only amount_paid told
  // those campers they had paid $0.00 and owed the full stay at check-in when they had in fact
  // already paid.
  //
  // Deliberately the same arithmetic as app/api/receipt/route.ts, so this page and the receipt
  // that lands in the camper's inbox cannot disagree: payments are summed NET of the
  // transaction fee (the fee is a processing pass-through, not money toward the stay), and
  // folio line items count as charges alongside the stay itself.
  //
  // Aggregated across every folio on the reservation rather than a single one — the receipt
  // route is invoked per folio, but this page only knows the reservation.
  let folioPaid = 0
  let folioCharges = 0
  const { data: folios } = await supabase.from('folios').select('id').eq('reservation_id', reservationId)
  const ids = (folios || []).map((f: any) => f.id)
  if (ids.length > 0) {
    const [{ data: pmts }, { data: items }] = await Promise.all([
      // Includes refund rows: a booking refund is a negative folio row and
      // reservations.amount_paid no longer shrinks, so excluding them would show the guest as
      // having paid money that was handed back.
      supabase.from('folio_payments').select('amount, surcharge_amount').in('status', ['completed', 'refunded', 'partially_refunded']).in('folio_id', ids),
      supabase.from('folio_line_items').select('line_total, voided').in('folio_id', ids),
    ])
    folioPaid = (pmts || []).reduce((sum: number, p: any) => sum + p.amount - (p.surcharge_amount || 0), 0)
    folioCharges = (items || []).reduce((sum: number, i: any) => sum + (i.voided ? 0 : (i.line_total || 0)), 0)
  }

  // The receipt route's three figures, by the same formula. With no folio both addends are
  // zero, so an ordinary online card booking renders exactly as it did before.
  const totalPaid = (res.amount_paid || 0) + folioPaid
  const chargesTotal = (res.total_price || 0) + folioCharges

  const { data: settings } = await supabase
    .from('settings')
    .select('check_in_time, check_out_time, park_name, logo_url, logo_shape, accent_color')
    .limit(1)
    .single()

  // The cancellation terms for THIS booking's arrival date, resolved through the same helper
  // /api/cancellation-policy uses, so the terms on the confirmation are the terms the camper
  // agreed to at checkout. Called directly rather than over HTTP — a server component fetching
  // its own API route would need an absolute URL and a second round trip for the same answer.
  // A failure leaves the policy null and the block simply renders nothing, exactly as before:
  // a missing paragraph is better than a wrong one about someone's money.
  let policyText: string | null = null
  let depositRefundable = true
  try {
    const policy: any = await resolveCancellationPolicy(supabase, res.arrival_date)
    policyText = policy?.policy_text || null
    depositRefundable = policy?.deposit_refundable !== false
  } catch {
    policyText = null
  }

  return {
    id: res.id,
    guest_name: res.guest_name,
    guest_email: res.guest_email,
    arrival_date: res.arrival_date,
    departure_date: res.departure_date,
    num_adults: res.num_adults,
    num_children: res.num_children,
    site_number: site?.site_number || '',
    site_type: site?.site_type || '',
    chargesTotal,
    totalPaid,
    balanceRemaining: chargesTotal - totalPaid,
    checkInTime: settings?.check_in_time || '2:00 PM',
    checkOutTime: settings?.check_out_time || '12:00 PM',
    parkName: settings?.park_name || 'Campground',
    logoUrl: settings?.logo_url ?? null,
    logoShape: settings?.logo_shape ?? null,
    accentColor: settings?.accent_color ?? null,
    policyText,
    depositRefundable,
  }
}
