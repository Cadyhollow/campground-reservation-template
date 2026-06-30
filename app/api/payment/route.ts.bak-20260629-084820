import { NextRequest, NextResponse } from 'next/server'
import { Resend } from 'resend'
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
      camperType,
      camperLength,
      camperAmperage,
      nightlyRate,
      totalPrice,
      amountToPay,
      paymentType,
      addonItems,
      discountCode,
      discountAmount,
      extraGuestFee,
      addonTotal,
      earlyCheckin = false,
      earlyCheckinFee = 0,
      lateCheckout = false,
      lateCheckoutFee = 0,
      nights,
      waiverSigned,
      signatureData,
      feesTotal = 0,
      surchargeAmount = 0,
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
            amount: amountToPay + (surchargeAmount || 0),
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
    const reservationPayload = {
      site_id: siteId,
      status: 'confirmed',
      arrival_date: arrival,
      departure_date: departure,
      num_adults: adults,
      num_children: children,
      guest_name: guestName,
      guest_email: guestEmail,
      guest_phone: guestPhone,
      camper_type: camperType || '',
      camper_length: camperLength || 0,
      camper_amperage: camperAmperage || '',
      base_nightly_rate: nightlyRate,
      extra_guest_fee_total: extraGuestFee,
      addons_total: addonTotal,
      early_checkin: earlyCheckin,
      early_checkin_fee: earlyCheckinFee,
      late_checkout: lateCheckout,
      late_checkout_fee: lateCheckoutFee,
      discount_amount: discountAmount,
      total_price: totalPrice,
      amount_paid: amountToPay,
      fees_total: feesTotal || 0,
      surcharge_amount: surchargeAmount || 0,
      payment_type: paymentType,
      square_payment_id: squarePaymentId,
      waiver_signed: waiverSigned || false,
    }

    // Insert the reservation, retrying once on a transient failure.
    let reservation: any = null
    let reservationError: any = null
    for (let attempt = 0; attempt < 2; attempt++) {
      const result = await supabase
        .from('reservations')
        .insert(reservationPayload)
        .select()
        .single()
      reservation = result.data
      reservationError = result.error
      if (!reservationError) break
      console.error(`Reservation insert attempt ${attempt + 1} failed:`, reservationError)
      if (attempt === 0) await new Promise((r) => setTimeout(r, 400))
    }

    if (reservationError) {
      console.error('Reservation error (after retry):', reservationError)
      const errMsg = reservationError.message || String(reservationError)

      try {
        await supabase.from('failed_bookings').insert({
          guest_name: guestName,
          guest_email: guestEmail,
          guest_phone: guestPhone,
          amount_paid: amountToPay,
          square_payment_id: squarePaymentId,
          error_message: errMsg,
          attempted_arrival: arrival,
          attempted_departure: departure,
          site_id: siteId,
        })
      } catch (logErr) {
        console.error('Could not write to failed_bookings:', logErr)
      }

      try {
        const { data: alertSettings } = await supabase
          .from('settings')
          .select('park_name, park_email')
          .single()
        const parkName = alertSettings?.park_name || 'Campground'
        const recipients = ['resonationsystems@gmail.com']
        if (alertSettings?.park_email) recipients.unshift(alertSettings.park_email)

        const resend = new Resend(process.env.RESEND_API_KEY)
        await resend.emails.send({
          from: 'ResoNation Alerts <alerts@myresonation.com>',
          to: recipients,
          subject: `\u26a0\ufe0f Charged but NO booking at ${parkName}: ${guestName} ($${(amountToPay / 100).toFixed(2)})`,
          html: `<h2>Online booking failed after the card was charged</h2>
<p>A guest's card was charged on <strong>${parkName}</strong>'s booking system, but the reservation could not be created. The guest has <strong>not</strong> received a confirmation. <strong>Do not charge them again.</strong></p>
<ul>
<li><strong>Guest:</strong> ${guestName}</li>
<li><strong>Email:</strong> ${guestEmail || 'N/A'}</li>
<li><strong>Phone:</strong> ${guestPhone || 'N/A'}</li>
<li><strong>Amount charged:</strong> $${(amountToPay / 100).toFixed(2)}</li>
<li><strong>Square payment ID:</strong> ${squarePaymentId}</li>
<li><strong>Dates:</strong> ${arrival} &rarr; ${departure}</li>
<li><strong>Error:</strong> ${errMsg}</li>
</ul>
<p>Next step: create the reservation manually (record this payment as already collected &mdash; do not re-charge), or refund the Square payment above.</p>`,
        })
      } catch (alertErr) {
        console.error('Could not send orphaned-charge alert:', alertErr)
      }

      return NextResponse.json(
        {
          error: `Your card was charged $${(amountToPay / 100).toFixed(2)}, but something went wrong finalizing your reservation. Please call the campground to confirm your booking \u2014 do NOT pay again. (Reference: ${squarePaymentId})`,
          chargedButNoReservation: true,
          paymentId: squarePaymentId,
          detail: errMsg,
        },
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

    // Look up full addon names for emails
    let addonDetails: { name: string; quantity: number; price: number }[] = []
    if (addonItems && addonItems.length > 0) {
      const addonIds = addonItems.map((a: any) => a.id)
      const { data: addonRows } = await supabase
        .from('addons')
        .select('id, name')
        .in('id', addonIds)
      if (addonRows) {
        addonDetails = addonItems.map((item: any) => ({
          name: addonRows.find((r: any) => r.id === item.id)?.name || 'Add-on',
          quantity: item.quantity,
          price: item.price,
        }))
      }
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
          camperType: camperType || '',
          camperLength: camperLength || 0,
          camperAmperage: camperAmperage || '',
          totalPrice,
          amountPaid: amountToPay,
          paymentType,
          confirmationNumber: reservation.id.slice(0, 8).toUpperCase(),
          addonDetails,
          extraGuestFee,
          discountAmount,
          discountCode: discountCode || null,
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
