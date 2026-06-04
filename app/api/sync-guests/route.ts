import { createClient } from '@supabase/supabase-js'
import { NextResponse } from 'next/server'

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

export async function POST() {
  try {
    // Get all non-cancelled reservations with site info
    const { data: reservations, error: resError } = await supabase
      .from('reservations')
      .select('guest_name, guest_email, guest_phone, site_id, arrival_date, departure_date, sites(site_number)')
      .neq('status', 'cancelled')
      .not('guest_email', 'is', null)
      .neq('guest_email', '')

    if (resError) throw resError

    // Get all existing guests
    const { data: existingGuests, error: guestError } = await supabase
      .from('guests')
      .select('id, email, last_visit')

    if (guestError) throw guestError

    // Build a map of email -> guest for fast lookup
    const existingMap: { [email: string]: { id: string; last_visit: string | null } } = {}
    for (const g of existingGuests || []) {
      if (g.email) existingMap[g.email.toLowerCase()] = { id: g.id, last_visit: g.last_visit }
    }

    // Build best record per email from reservations
    // (most recent arrival date wins for last_visit and site_number)
    const bestRecord: {
      [email: string]: {
        name: string
        email: string
        phone: string
        site_number: string
        last_visit: string
      }
    } = {}

    for (const r of reservations || []) {
      const email = (r.guest_email || '').toLowerCase().trim()
      if (!email) continue
      const siteNum = (r.sites as any)?.site_number || ''
      const existing = bestRecord[email]
      if (!existing || r.arrival_date > existing.last_visit) {
        bestRecord[email] = {
          name: r.guest_name || '',
          email: r.guest_email || '',
          phone: r.guest_phone || '',
          site_number: siteNum,
          last_visit: r.arrival_date,
        }
      }
    }

    let added = 0
    let updated = 0

    for (const [email, record] of Object.entries(bestRecord)) {
      const existing = existingMap[email]

      if (!existing) {
        // New guest — insert
        await supabase.from('guests').insert({
          name: record.name,
          email: record.email,
          phone: record.phone,
          site_number: record.site_number,
          last_visit: record.last_visit,
          is_seasonal: false,
        })
        added++
      } else {
        // Existing guest — only update last_visit and site_number if more recent
        const existingLastVisit = existing.last_visit || '0000-00-00'
        if (record.last_visit > existingLastVisit) {
          await supabase.from('guests')
            .update({
              last_visit: record.last_visit,
              site_number: record.site_number,
            })
            .eq('id', existing.id)
          updated++
        }
      }
    }

    return NextResponse.json({ success: true, added, updated })
  } catch (err: any) {
    return NextResponse.json({ success: false, error: err.message }, { status: 500 })
  }
}
