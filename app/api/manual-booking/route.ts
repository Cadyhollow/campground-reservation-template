import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

export async function POST(request: NextRequest) {
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
      base_nightly_rate,
      extra_guest_fee_total,
      total_price,
      amount_paid,
      payment_type,
      notes,
    } = body

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
        base_nightly_rate,
        extra_guest_fee_total,
        addons_total: 0,
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