import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { Resend } from 'resend'
import { checkBookability, nightsBetween, ruleAppliesToSite } from '@/lib/bookability'
import { computeBookingQuote, checkDiscount, resolveNightlyRate, cardOnlyFeeShare } from '@/lib/booking-quote'
import { sendConfirmationEmails } from '@/lib/confirmation-email'
import { SQUARE_API_BASE } from '@/lib/square-env'

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
      cardOnlyFeesTotal = 0,
      surchargeAmount = 0,
      // Itemized cash lines built by the booking page, in the same { label, amount } shape
      // lib/pricing produces for the admin wizard. Passed straight through to the email.
      lines = [],
    } = body

    // Look up site details. Moved above the bookability check so the min-stay rules can be
    // matched against this site's type without a second lookup.
    const { data: siteData } = await supabase
      .from('sites')
      .select('id, site_number, site_type, base_rate')
      .eq('id', siteId)
      .single()

    // THE CHOKEPOINT. Everything the availability search would have rejected — out of season,
    // a blocked date, an overlapping reservation, under the site's minimum stay — is rejected
    // here too, by the same code, because /book takes its dates from URL params and can be
    // reached without ever running a search. Previously only the double-booking case was
    // re-checked, so a hand-edited request could be charged for a date the park has closed.
    //
    // This sits BEFORE the Square call below and returns early, so a booking rejected here has
    // had no payment attempted against it. That ordering is the whole point: the alternative is
    // a guest charged for a stay the park will not honour.
    const bookability = await checkBookability(supabase, {
      arrival,
      departure,
      siteId,
      site: siteData,
    })

    if (!bookability.bookable) {
      return NextResponse.json(
        { error: bookability.message, reason: bookability.reason },
        // 409 for "someone got there first", which is worth retrying with another site; 400 for
        // dates that were never bookable in the first place.
        { status: bookability.reason === 'double-booked' ? 409 : 400 }
      )
    }

    // ── THE PRICING CHOKEPOINT ────────────────────────────────────────────────────────────
    // The companion to the bookability check above, and it exists for the same reason: /book
    // builds its quote from URL parameters (`?nightlyRate=…&totalPrice=…`) and can be reached
    // without ever running a search. Dates were already re-derived here. The PRICE was not —
    // this route charged `amountToPay` straight from the request body and never so much as
    // read base_rate, so retyping totalPrice in the address bar set your own price, down to
    // zero. A forged discount code was the same attack with a smaller ceiling.
    //
    // Everything below is read from the database. The request's own figures are untrusted from
    // here on: they are compared against the server's, never charged.
    const [{ data: pricingRules }, { data: settingsRow }, { data: activeFees }] = await Promise.all([
      supabase.from('pricing_rules').select('*').eq('is_active', true)
        .lte('start_date', departure).gte('end_date', arrival),
      supabase.from('settings').select('*').limit(1).single(),
      supabase.from('fees').select('*').eq('is_active', true),
    ])

    // Add-on prices come from the DB keyed by the requested ids, so a request cannot set the
    // price of a firewood bundle. An id that is not an active add-on is dropped entirely.
    let pricedAddons: Array<{ id: string; quantity: number; price: number; name?: string }> = []
    if (Array.isArray(addonItems) && addonItems.length > 0) {
      const { data: addonRows } = await supabase
        .from('addons').select('id, name, price')
        .in('id', addonItems.map((a: any) => a.id)).eq('is_active', true)
      pricedAddons = (addonItems as any[]).flatMap((item: any) => {
        const row = (addonRows || []).find((r: any) => r.id === item.id)
        const quantity = Math.max(0, parseInt(item.quantity) || 0)
        if (!row || quantity === 0) return []
        return [{ id: row.id, quantity, price: row.price, name: row.name }]
      })
    }

    // The discount, validated against the server's own row. Previously every one of these
    // checks ran only in the browser, against a row the browser read for itself.
    let serverDiscount = null as null | { code: string; discount_type: string; discount_value: number }
    if (discountCode) {
      const { data: discountRow } = await supabase
        .from('discounts').select('*').eq('code', String(discountCode).toUpperCase()).single()
      const verdict = checkDiscount(discountRow, new Date().toISOString().split('T')[0])
      if (!verdict.ok) {
        return NextResponse.json({ error: verdict.reason, reason: 'discount-invalid' }, { status: 400 })
      }
      serverDiscount = verdict.discount
    }

    // Turnover: the same-day conflicts that gate early check-in and late check-out. Read here
    // so those extras cannot be asserted onto a booking whose neighbours rule them out.
    const { data: turnoverRows } = await supabase
      .from('reservations').select('arrival_date, departure_date')
      .eq('site_id', siteId).neq('status', 'cancelled')
    const earlyBlocked = (turnoverRows || []).some((r: any) => r.departure_date === arrival)
    const lateBlocked = (turnoverRows || []).some((r: any) => r.arrival_date === departure)

    const serverNights = nightsBetween(arrival, departure)
    const serverNightlyRate = resolveNightlyRate(
      { id: siteId, site_type: siteData?.site_type || '', base_rate: siteData?.base_rate || 0 },
      pricingRules || [],
      ruleAppliesToSite,
    )

    const quote = computeBookingQuote({
      site: {
        site_type: siteData?.site_type || '',
        nightly_rate: serverNightlyRate,
        total_price: serverNightlyRate * serverNights,
        nights: serverNights,
      },
      adults, children,
      settings: settingsRow,
      fees: activeFees || [],
      addonSelections: pricedAddons,
      discount: serverDiscount,
      earlyRequested: !!earlyCheckin,
      lateRequested: !!lateCheckout,
      earlyBlocked, lateBlocked,
    })

    // What this payment collects, by the SERVER's reading of the deposit rules. The fee is
    // this payment's prorated share of the card-only fees already inside `total` — this
    // repo's model, NOT Cady's percentage surcharge. See lib/booking-quote.ts.
    const serverCashToPay = paymentType === 'deposit' ? quote.deposit : quote.cashTotal
    const serverSurcharge = cardOnlyFeeShare(serverCashToPay, quote.cashTotal, quote.cardOnlyFeesTotal)
    const serverChargeTotal = serverCashToPay + serverSurcharge

    // A disagreement is REPORTED, not silently charged. Charging a number other than the one
    // the camper was shown is its own bug — the fee pass fixed exactly that on the Pay in Full
    // button — so a mismatch means the page is stale (a rate or fee changed mid-session) or the
    // request was crafted. Either way the honest answer is to ask for a refresh rather than to
    // quietly bill a different figure.
    const clientChargeTotal = (Number(amountToPay) || 0) + (Number(surchargeAmount) || 0)
    if (clientChargeTotal !== serverChargeTotal) {
      console.warn('[pricing-chokepoint] client/server disagreement', {
        siteId, arrival, departure, paymentType,
        clientChargeTotal, serverChargeTotal,
        clientDiscount: discountAmount, serverDiscount: quote.discountAmount,
      })
      return NextResponse.json({
        error: 'Pricing has changed since this page was loaded. Please refresh and try again.',
        reason: 'price-mismatch',
      }, { status: 409 })
    }

    // Process payment with Square REST API
    const squareResponse = await fetch(
     `${SQUARE_API_BASE}/v2/payments`,
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
            // The server's figure, not the request's. They are equal by the time we get
            // here — a mismatch returned 409 above — but this reads from the authoritative
            // side so that stays true if the guard is ever loosened.
            amount: serverChargeTotal,
            currency: 'USD',
          },
          location_id: process.env.SQUARE_LOCATION_ID,
          buyer_email_address: guestEmail,
          note: `${guestName} | Site ${siteData?.site_number || siteId} | ${arrival} to ${departure}`,
          reference_id: `${guestName.replace(/\s+/g, '-').toUpperCase()}-${arrival}`,
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
      // Every money column below is the SERVER's figure. They equal the request's — a
      // disagreement was rejected at the pricing chokepoint — but the ledger, the folio and
      // every revenue report read these, so they are written from the authoritative side.
      base_nightly_rate: serverNightlyRate,
      extra_guest_fee_total: quote.extraGuestFee,
      fees_total: quote.feesTotal - quote.cardOnlyFeesTotal,
      surcharge_amount: serverSurcharge,
      addons_total: quote.addonTotal,
      early_checkin: quote.earlyFee > 0,
      early_checkin_fee: quote.earlyFee,
      late_checkout: quote.lateFee > 0,
      late_checkout_fee: quote.lateFee,
      discount_amount: quote.discountAmount,
      total_price: quote.cashTotal,
      amount_paid: serverCashToPay,
      payment_type: paymentType,
      payment_method: 'card', // online bookings are always paid by card
      square_payment_id: squarePaymentId,
      waiver_signed: waiverSigned || false,
    }

    // Insert the reservation, retrying once on a transient failure. Brief Supabase
    // connection blips are common and usually clear on a second attempt — this turns
    // most would-be "charged but no booking" cases back into successful bookings.
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

    // If the insert STILL failed after the retry, the card was already charged but
    // no reservation exists. We do NOT auto-refund. Instead we record the orphaned
    // charge to failed_bookings and email staff so it can be completed by hand or
    // refunded from Square.
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
        const resend = new Resend(process.env.RESEND_API_KEY)
        const alertFrom = 'alerts@cadyhollow.com'
        await resend.emails.send({
          from: `Cady Hollow Alerts <${alertFrom}>`,
          to: 'cadyhollowcg@gmail.com',
          subject: `\u26a0\ufe0f Charged but NO booking: ${guestName} ($${(amountToPay / 100).toFixed(2)})`,
          html: `<h2>Online booking failed after the card was charged</h2>
<p>A guest's card was charged but the reservation could not be created. They have <strong>not</strong> received a confirmation. <strong>Do not charge them again.</strong></p>
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

    // Update discount usage.
    //
    // This was an UPDATE with no .eq() filter that assigned a query BUILDER as the column
    // value — so it never incremented anything, and had it run it would have written to every
    // discount row. max_uses was therefore unenforceable no matter how carefully the browser
    // checked it. It now calls the RPC properly, and only for a code the server itself
    // validated above. Failure is logged rather than thrown: the camper has already been
    // charged by this point and a miscounted redemption must not fail their booking.
    if (serverDiscount) {
      const { error: usageError } = await supabase.rpc('increment_discount_usage', {
        p_code: serverDiscount.code,
      })
      if (usageError) console.error('increment_discount_usage failed:', usageError, serverDiscount.code)
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

    // Send confirmation emails.
    //
    // Direct function call, not an HTTP self-fetch to /api/email. The payload below is the exact
    // JSON body that fetch used to POST, so the emails are unchanged; only the transport is gone.
    // This is what lets /api/email sit behind the admin session — a camper's confirmation no
    // longer depends on a publicly reachable route.
    //
    // The try/catch stays deliberately: the card has ALREADY been charged and the reservation
    // ALREADY written by this point, so a Resend outage must never fail the booking. Swallowing
    // here means the guest is booked and charged even if the email doesn't go out, which is the
    // correct trade — the alternative is a paid-but-errored booking.
    try {
      await sendConfirmationEmails({
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
        earlyCheckin, earlyCheckinFee,
        lateCheckout, lateCheckoutFee,
        totalPrice,
        amountPaid: amountToPay,
        surchargeAmount: surchargeAmount || 0,
        paymentType,
        confirmationNumber: reservation.id.slice(0, 8).toUpperCase(),
        addonDetails,
        extraGuestFee,
        discountAmount,
        discountCode: discountCode || null,
        feesTotal: feesTotal || 0,
        lines,
        nightlyRate,
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
