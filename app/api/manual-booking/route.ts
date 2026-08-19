// The create path for all three staff booking pages — /admin/manual-booking,
// /admin/new-reservation and /admin/walkin-booking all POST here. One route, three callers, so a
// date rule added here covers every staff path at once.
//
// ── WHAT THIS ROUTE STILL DOES NOT CHECK ──────────────────────────────────────────────────────
//
// This route applies the booking horizon and the closed season. Park-wide and per-site BLOCKED
// DATES and MIN-STAY are still unenforced here — a real gap, predating all of this, deliberately
// held for its own PR because closing it changes what staff may do on every existing tenant and
// deserves its own review rather than riding in behind a new setting.
//
// So the route calls checkHorizon and checkSeasonSpan directly rather than checkBookability.
// Calling the full chokepoint would silently close the remaining gaps at once, which is exactly
// the unreviewable change being avoided.
import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { requireRole } from '@/lib/require-role'
import { checkHorizon, checkSeasonSpan, HORIZON_SERVER_SLACK_DAYS } from '@/lib/bookability'
import { checkPetBooking, computePetFee } from '@/lib/pet-fee'

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
      // The same, for a stay with nights outside the park's open season.
      override_season,
      // Pets, as entered by the operator. The fee is recomputed server-side below; the counts
      // and flags are checked against the park's own policy.
      pet_count,
      is_service_animal,
      pet_rules_affirmed,
      // The staff waiver for putting a guest with pets on a site not marked pet-friendly — the
      // known-guest exception. Waives ONLY that restriction, never the cap or the affirmation.
      override_pet_site,
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
    const { data: gateSettings } = await supabase
      .from('settings')
      // NAMED COLUMNS — the tenant must have max_advance_days already, or this read errors and no
      // staff booking can be created at all. See db/2026-08-17-booking-horizon.sql. The season
      // columns have existed since the original schema.
      .select('max_advance_days, season_start, season_end, closed_season_message')
      .limit(1)
      .single()

    if (!override_horizon) {
      // Same slack as /api/payment and /api/availability: the server has no park timezone, so it
      // refuses only what is unambiguously past the window. See HORIZON_SERVER_SLACK_DAYS.
      const today = new Date().toISOString().split('T')[0]
      const horizon = checkHorizon(arrival_date, gateSettings, today, HORIZON_SERVER_SLACK_DAYS)
      if (!horizon.bookable) {
        return NextResponse.json(
          // `reason` so the booking pages can tell this apart from a double-booking and offer the
          // override, rather than showing a dead end with a date the operator cannot book.
          { error: horizon.message, reason: 'beyond-horizon' },
          { status: 400 }
        )
      }
    }

    // ── THE CLOSED SEASON, WITH ITS OWN OPERATOR OVERRIDE ───────────────────────────────────
    //
    // WHOLE STAY, not just the arrival: every night from arrival to departure-1 must fall inside
    // the open season. The public path had the arrival-only version of this check and it was a
    // live hole — a stay starting in season and running past closing was accepted and charged.
    // The staff path had no season check at all, which is how a wizard booking of October 20 to
    // December 31 was taken against a season ending October 31.
    //
    // A SEPARATE FLAG from override_horizon, deliberately. They are different severities and
    // different rules: the horizon is the park's preference about how far ahead it takes online
    // bookings; a closed season means the park is shut. An operator waiving one has not waived
    // the other, and a single combined flag would make that impossible to express.
    //
    // Waives the SEASON ONLY. The double-booking check below still runs, and no override reaches
    // it — waiving that would put a guest in an occupied site. When blocked dates and min-stay are
    // finally enforced here, neither of these flags may be extended to cover them.
    if (!override_season) {
      const season = checkSeasonSpan(arrival_date, departure_date, gateSettings)
      if (!season.bookable) {
        return NextResponse.json(
          // `reason` so the booking pages can tell this apart from a horizon refusal or a
          // double-booking and offer the right override rather than a dead end.
          { error: season.message, reason: 'out-of-season' },
          { status: 400 }
        )
      }
    }

    // ── THE PET GATE ──────────────────────────────────────────────────────────────────────────
    //
    // The same lib/pet-fee.ts decision the public path runs, so the two cannot drift — with one
    // addition: an operator may waive the pet-SITE restriction for a known guest, exactly as they
    // may waive the horizon and the season. It waives nothing else.
    //
    // Unlike the dates, the pet FEE is recomputed here rather than trusted from the body. This
    // route otherwise takes the staff pages' totals as given (see the note at the top of the
    // file), but a brand-new charge is worth deriving server-side from the moment it exists
    // rather than inheriting that debt.
    //
    // Entirely dead on a tenant without the pet columns: select('*') keeps the read safe there,
    // `pets_enabled` is absent, and checkPetBooking answers "no pets".
    const { data: petSettings } = await supabase.from('settings').select('*').limit(1).single()
    let petFields: Record<string, unknown> = {}
    if (petSettings?.pets_enabled) {
      const { data: petSite } = await supabase
        .from('sites').select('pet_friendly').eq('id', site_id).single()

      const verdict = checkPetBooking(petSettings, {
        petCount: Number(pet_count) || 0,
        isServiceAnimal: !!is_service_animal,
        petRulesAffirmed: !!pet_rules_affirmed,
        sitePetFriendly: petSite?.pet_friendly,
        allowPetSiteOverride: !!override_pet_site,
      })
      if (!verdict.ok) {
        return NextResponse.json({ error: verdict.message, reason: verdict.reason }, { status: 400 })
      }

      const nights = Math.max(0, Math.round(
        (new Date(departure_date).getTime() - new Date(arrival_date).getTime()) / 86400000))
      const { petFee, petCount: chargedPets } = computePetFee({
        petCount: verdict.petCount,
        nights,
        isServiceAnimal: verdict.isServiceAnimal,
        settings: petSettings,
      })

      petFields = {
        pet_count: chargedPets,
        pet_fee: petFee,
        pet_rules_affirmed_at:
          petSettings.pet_rules_require_affirmation && pet_rules_affirmed && chargedPets > 0
            ? new Date().toISOString()
            : null,
        is_service_animal: verdict.isServiceAnimal,
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
        // Spreads to nothing on a tenant without the pet columns — an unknown column would fail
        // the whole insert and lose the booking.
        ...petFields,
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
