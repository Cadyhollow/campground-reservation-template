// The booking page's reference data, read on the server with the service-role key.
//
// Security PR 7-1. /book used to assemble itself in the browser from four publishable-key
// PostgREST reads — settings, fees, addons and a reservations scan for the turnover check —
// plus a fifth read of `discounts` when the camper typed a code (that one is gone entirely; see
// app/api/discount). Nothing about what the camper sees changes: the same rows, the same order,
// the same arithmetic. Only the query moves.
//
// It is also the only way these reads can work now. A camper has no session, so a browser client
// resolves to the `anon` role, and the locked-down schema grants anon nothing.
//
// This is the same shape lib/confirmation-server.ts already established, for the same reason:
// after this, the browser holds no Supabase client on the public pages at all.
//
// FEE MODEL — READ BEFORE COPYING ANYTHING FROM CADY HERE. This repo is on the card-only-fee
// model: the fee sits INSIDE the booking total and rides on `fees.card_only`. The reference
// implementation is on a different model, where a percentage surcharge sits OUTSIDE the cash
// total and is read from `settings.card_surcharge_percent` — a column this select deliberately
// does NOT request, because nothing in this repo consumes it. Moving a read server-side must not
// quietly import the other model's inputs. See lib/booking-quote.ts.
//
// Importing this from a client component would drag the service-role key toward the browser
// bundle. It is only ever called from the /book server component.
//
// NOT AN API ROUTE, deliberately. There is no JSON endpoint here to call or widen — the output
// is the props of one rendered page.

import { createClient } from '@supabase/supabase-js'

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

export type BookAddon = {
  id: string
  name: string
  description: string
  price: number
  is_early_checkin: boolean
}

export type BookFee = {
  id: string
  name: string
  type: 'percentage' | 'flat'
  amount: number
  applies_to: string
  is_active: boolean
  card_only: boolean
}

export type BookPageData = {
  settings: any
  fees: BookFee[]
  addons: BookAddon[]
  /** Turnover conflicts on this site — a same-day departure/arrival blocks the extra. */
  earlyBlocked: boolean
  lateBlocked: boolean
}

/**
 * Everything /book needs that does not come from the URL.
 *
 * Scoped by the site and dates already in the booking link. There is no caller-supplied filter,
 * table name or column list — a camper cannot widen this into a query of their own.
 */
export async function getBookingPageData(
  siteId: string,
  arrival: string,
  departure: string,
): Promise<BookPageData> {
  // The same named column list the browser used to send, plus max_advance_days. It is already the
  // page's real appetite, so nothing new is exposed and nothing needed goes missing.
  //
  // season_start / season_end / closed_season_message are here for the same reason as
  // max_advance_days below: /book is reachable by URL without ever running a search, and until now
  // it showed NO closure warning at all — a crafted link to a closed week rendered a normal booking
  // page right up to the card form, where /api/payment refused it.
  //
  // max_advance_days is here because /book takes its dates from URL parameters and the search that
  // would have applied the booking window is skippable — BookingForm re-checks it so a guest on a
  // crafted or stale link is told up front rather than after entering a card. Without the column in
  // this select that check silently never fires, which is worse than not having it at all: it looks
  // enforced and is not. (/api/payment is the actual enforcement either way.)
  //
  // NAMED COLUMNS: the tenant must already have max_advance_days or PostgREST errors and the whole
  // /book page loses its settings. See db/2026-08-17-booking-horizon.sql — schema first, code after.
  const settingsQuery = supabase
    .from('settings')
    .select('park_name, park_location, logo_url, logo_shape, waiver_enabled, waiver_text, same_day_cutoff_time, same_day_cutoff_message, early_checkin_enabled, early_checkin_price, early_checkin_time, early_checkin_show_customers, late_checkout_enabled, late_checkout_price, late_checkout_time, late_checkout_show_customers, check_in_time, check_out_time, deposit_type, deposit_value, base_occupancy_adults, base_occupancy_children, extra_adult_fee, extra_child_fee, max_advance_days, season_start, season_end, closed_season_message')
    .limit(1)
    .single()

  // Named columns, not select('*') — the browser was being handed every column of a table it
  // displays a handful of fields from. These are the fields the quote and the line items read,
  // and nothing else. `card_only` is this repo's fee model and stays.
  const feesQuery = supabase
    .from('fees')
    .select('id, name, type, amount, applies_to, is_active, card_only')
    .eq('is_active', true)

  const addonsQuery = supabase
    .from('addons')
    .select('id, name, description, price, is_early_checkin')
    .eq('is_active', true)
    .order('display_order')

  const [{ data: settings }, { data: fees }, { data: addons }] = await Promise.all([
    settingsQuery, feesQuery, addonsQuery,
  ])

  // Turnover, by the same two comparisons the browser made — so what the checkbox offers is what
  // the charge will allow. Guarded exactly as the browser guarded it: no site or no dates means
  // no scan.
  let earlyBlocked = false
  let lateBlocked = false
  if (siteId && (arrival || departure)) {
    const { data: turnover } = await supabase
      .from('reservations')
      .select('arrival_date, departure_date')
      .eq('site_id', siteId)
      .neq('status', 'cancelled')
    earlyBlocked = (turnover || []).some((r: { departure_date: string }) => r.departure_date === arrival)
    lateBlocked = (turnover || []).some((r: { arrival_date: string }) => r.arrival_date === departure)
  }

  return {
    settings: settings ?? null,
    fees: (fees || []) as BookFee[],
    addons: (addons || []) as BookAddon[],
    earlyBlocked,
    lateBlocked,
  }
}
