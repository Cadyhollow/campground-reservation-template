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
      sourceId,
      siteId,
      arrival,
      departure,
      adults,
      children,
      guestName,
      guestEmail,
      guestPhone,
      nightlyRate,
      totalPrice,
      amountToPay,
      paymentType,
      addonItems,
      discountCode,
      discountAmount,
      extraGuestFee,
      addonTotal,
      nights,
    } = body

    // Double-check availability before charging
    const { data: existingReservations } = await supabase
      .from('reservations')
      .select('id')
      .eq('site_id', siteId)
      .neq('status', 'cancelled')
      .lt('arrival_date', departure)
      .gt('departure_date', arrival)

    if (existingReservations && existingReservations.length > 0) {
      return NextResponse.json(
        { error: 'Sorry, this site was just booked by someone else. Please select a different site.' },
        { status: 409 }
      )
    }

    // Look up site details
    const { data: siteData } = await supabase
      .from('sites')
      .select('site_number, site_type')
      .eq('id', siteId)
      .single()

    // Process payment with Square REST API
    const squareResponse = await fetch(
     `https://connect.squareup.com/v2/payments`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${process.env.SQUARE_ACCESS_TOKEN}`,
          'Square-Version': '2024-01-18',
        },
        body: JSON.stringify({
          source_id: sourceId,
          idempotency_key: `res-${Date.now()}`,
          amount_money: {
            amount: amountToPay,
            currency: 'USD',
          },
          location_id: process.env.SQUARE_LOCATION_ID,
          buyer_email_address: guestEmail,
          note: `Campground Reservation`,
        }),
      }
    )

    const squareData = await squareResponse.json()

    if (!squareResponse.ok || !squareData.payment) {
      console.error('Square error:', squareData)
      return NextResponse.json(
        { error: squareData.errors?.[0]?.detail || 'Payment failed. Please try again.' },
        { status: 400 }
      )
    }

    const squarePaymentId = squareData.payment.id

    // Create reservation in database
    const { data: reservation, error: reservationError } = await supabase
      .from('reservations')
      .insert({
        site_id: siteId,
        status: 'confirmed',
        arrival_date: arrival,
        departure_date: departure,
        num_adults: adults,
        num_children: children,
        guest_name: guestName,
        guest_email: guestEmail,
        guest_phone: guestPhone,
        base_nightly_rate: nightlyRate,
        extra_guest_fee_total: extraGuestFee,
        addons_total: addonTotal,
        discount_amount: discountAmount,
        total_price: totalPrice,
        amount_paid: amountToPay,
        payment_type: paymentType,
        square_payment_id: squarePaymentId,
        waiver_signed: false,
      })
      .select()
      .single()

    if (reservationError) {
      console.error('Reservation error:', reservationError)
      return NextResponse.json(
        { error: 'Payment succeeded but reservation creation failed. Please contact us immediately.' },
        { status: 500 }
      )
    }

    // Save addon selections
    if (addonItems && addonItems.length > 0) {
      await supabase.from('reservation_addons').insert(
        addonItems.map((item: any) => ({
          reservation_id: reservation.id,
          addon_id: item.id,
          quantity: item.quantity,
          price_at_booking: item.price,
        }))
      )
    }

    // Update discount usage
    if (discountCode) {
      await supabase
        .from('discounts')
        .update({ times_used: supabase.rpc('increment_discount_usage', { code: discountCode }) })
    }

    // Send confirmation emails
    try {
      await fetch(`${request.nextUrl.origin}/api/email`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          guestName,
          guestEmail,
          siteNumber: siteData?.site_number || 'N/A',
          siteType: siteData?.site_type || 'rv_site',
          arrival,
          departure,
          nights,
          adults,
          children,
          totalPrice,
          amountPaid: amountToPay,
          paymentType,
          confirmationNumber: reservation.id.slice(0, 8).toUpperCase(),
        }),
      })
    } catch (e) {
      console.error('Email send failed:', e)
    }

    return NextResponse.json({
      success: true,
      reservationId: reservation.id,
      paymentId: squarePaymentId,
    })

  } catch (error: any) {
    console.error('Payment error:', error)
    return NextResponse.json(
      { error: error.message || 'An unexpected error occurred.' },
      { status: 500 }
    )
  }
}