// The create path for all three staff booking pages — /admin/manual-booking,
// /admin/new-reservation and /admin/walkin-booking all POST here. One route, three callers, so a
// date rule added here covers every staff path at once.
//
// ── WHAT THIS ROUTE STILL DOES NOT CHECK ──────────────────────────────────────────────────────
//
// The booking horizon (below) is the ONLY rule from lib/bookability.ts that this route applies.
// The season gate, park-wide and per-site blocked dates, and min-stay are all still unenforced
// here — this route checks double-booking and nothing else, as it always has. That is a real gap,
// it predates this change, and closing it is deliberately held for its own PR: it would change
// what staff are allowed to do on every existing tenant, which deserves to be reviewed on its own
// rather than riding in behind a new setting.
//
// So this route calls checkHorizon directly rather than checkBookability. Calling the full
// chokepoint here would silently close all four gaps at once, which is exactly the unreviewable
// change being avoided.
import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { requireRole } from '@/lib/require-role'
import { checkHorizon, HORIZON_SERVER_SLACK_DAYS } from '@/lib/bookability'

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

export async function POST(request: NextRequest) {
  const denied = await requireRole(request, 'staff')
  if (denied) return denied

  try {
    const body = await request.json()
    const {
      site_id,
      arrival_date,
      departure_date,
      num_adults,
      num_children,
      guest_name,
      guest_email,
      guest_phone,
      camper_type,
      camper_length,
      camper_amperage,
      base_nightly_rate,
      extra_guest_fee_total,
      addons_total,
      early_checkin,
      early_checkin_fee,
      late_checkout,
      late_checkout_fee,
      total_price,
      amount_paid,
      payment_type,
      notes,
      addonItems,
      // Set by the staff booking pages when an operator has ticked "book beyond the booking
      // window" on a date past the park's horizon. Absent or false on every other request.
      override_horizon,
    } = body

    // ── THE BOOKING HORIZON, WITH AN OPERATOR OVERRIDE ──────────────────────────────────────
    //
    // The horizon is the park's own preference about how far ahead it takes ONLINE bookings, so
    // its own staff setting it aside is the point of it being a preference rather than a rule.
    // The phone call that starts "can I get a site for next August?" is a real workflow, and staff
    // have had unrestricted date entry on these pages since they were written.
    //
    // What makes the override acceptable is that it is EXPLICIT and NARROW. It only exists because
    // an operator ticked a box next to a warning naming the park's window, and it waives nothing
    // else — there is no override here for double-booking, and when the season/blocked/min-stay
    // gap above is closed, this flag must not be extended to cover those either. Those are not
    // preferences: waiving them books a guest into an occupied site or a closed campground.
    const { data: horizonSettings } = await supabase
      .from('settings')
      // NAMED COLUMN — the tenant must have max_advance_days already, or this read errors and no
      // staff booking can be created at all. See db/2026-08-17-booking-horizon.sql.
      .select('max_advance_days')
      .limit(1)
      .single()

    if (!override_horizon) {
      // Same slack as /api/payment and /api/availability: the server has no park timezone, so it
      // refuses only what is unambiguously past the window. See HORIZON_SERVER_SLACK_DAYS.
      const today = new Date().toISOString().split('T')[0]
      const horizon = checkHorizon(arrival_date, horizonSettings, today, HORIZON_SERVER_SLACK_DAYS)
      if (!horizon.bookable) {
        return NextResponse.json(
          // `reason` so the booking pages can tell this apart from a double-booking and offer the
          // override, rather than showing a dead end with a date the operator cannot book.
          { error: horizon.message, reason: 'beyond-horizon' },
          { status: 400 }
        )
      }
    }

    // Check availability
    const { data: conflicts } = await supabase
      .from('reservations')
      .select('id')
      .eq('site_id', site_id)
      .neq('status', 'cancelled')
      .lt('arrival_date', departure_date)
      .gt('departure_date', arrival_date)

    if (conflicts && conflicts.length > 0) {
      return NextResponse.json(
        { error: 'This site is already booked for those dates!' },
        { status: 409 }
      )
    }

    const { data: reservation, error } = await supabase
      .from('reservations')
      .insert({
        site_id,
        status: 'manual',
        arrival_date,
        departure_date,
        num_adults,
        num_children,
        guest_name,
        guest_email,
        guest_phone,
        camper_type: camper_type || '',
        camper_length: camper_length || 0,
        camper_amperage: camper_amperage || '',
        base_nightly_rate,
        extra_guest_fee_total,
        addons_total: addons_total || 0,
        early_checkin: early_checkin || false,
        early_checkin_fee: early_checkin_fee || 0,
        late_checkout: late_checkout || false,
        late_checkout_fee: late_checkout_fee || 0,
        discount_amount: 0,
        total_price,
        amount_paid,
        payment_type,
        square_payment_id: null,
        waiver_signed: false,
        notes,
      })
      .select()
      .single()

    if (error) {
      console.error('Reservation error:', error)
      return NextResponse.json(
        { error: error.message },
        { status: 500 }
      )
    }

    // Save add-ons if any were selected
    if (addonItems && addonItems.length > 0) {
      const { error: addonError } = await supabase
        .from('reservation_addons')
        .insert(
          addonItems.map((item: any) => ({
            reservation_id: reservation.id,
            addon_id: item.id,
            quantity: item.quantity,
            price_at_booking: item.price,
          }))
        )
      if (addonError) {
        console.error('Addon save error:', addonError)
      }
    }

    return NextResponse.json({
      success: true,
      reservationId: reservation.id,
      confirmationNumber: reservation.id.slice(0, 8).toUpperCase(),
    })

  } catch (error: any) {
    console.error('Manual booking error:', error)
    return NextResponse.json(
      { error: error.message || 'An unexpected error occurred.' },
      { status: 500 }
    )
  }
}
