// Validating ONE discount code, server-side.
//
// Security PR 7-1. The booking page used to answer "is this code any good?" by reading the
// whole `discounts` table with the anon key — `select('*')` with no filter reaching the wire
// beyond the code the camper typed, which meant anyone with the site open could pull every
// code the park has ever issued, active or not, along with its value and its remaining uses.
// That is the enumeration this endpoint closes.
//
// The server was already the authority on whether a discount is APPLIED: /api/payment re-reads
// the row and re-runs checkDiscount() before it charges anything, so a forged code could not
// actually reduce a charge. What remained was the preview — and the read behind it. Now the
// browser asks about the one code in the box and is told about that code only.
//
// Deliberately PUBLIC and deliberately unauthenticated: campers are not logged in. That is a
// decision, not an oversight — proxy.ts only matches /admin/:path*, so a route that wants auth
// has to call requireRole() itself, and this one must not. What keeps it safe is its
// shape rather than a gate: exact-match on a single code, .single(), and a response that
// carries nothing the camper could not read off the next line of their own booking summary.
// There is no list form, no prefix match and no way to ask about a code you did not type.

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { checkDiscount } from '@/lib/booking-quote'

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

// Long enough for any real code, short enough that the filter can't be used to push
// arbitrary strings into PostgREST.
const MAX_CODE_LENGTH = 64

export async function POST(request: NextRequest) {
  let body: { code?: unknown }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ valid: false, error: 'Invalid or expired discount code.' })
  }

  const raw = typeof body?.code === 'string' ? body.code.trim().toUpperCase() : ''
  if (!raw || raw.length > MAX_CODE_LENGTH) {
    return NextResponse.json({ valid: false, error: 'Invalid or expired discount code.' })
  }

  const { data: row } = await supabase
    .from('discounts')
    // Named columns: everything checkDiscount() needs to judge the row, and nothing more.
    // `times_used` and `max_uses` are read here but never returned — the verdict is returned.
    .select('code, discount_type, discount_value, is_active, valid_from, valid_until, max_uses, times_used')
    .eq('code', raw)
    .single()

  // The same four rules the browser used to apply to a row it had read for itself, and the
  // same rules /api/payment applies before charging — one function, so the preview and the
  // charge cannot disagree about whether a code counts.
  const verdict = checkDiscount(row, new Date().toISOString().split('T')[0])

  // 200 either way. An unusable code is a normal answer to a normal question, not a request
  // error, and the page renders the reason as the same inline message it always did.
  if (!verdict.ok) {
    return NextResponse.json({ valid: false, error: verdict.reason })
  }

  // Just this code's terms — the type and value the camper is about to see subtracted anyway.
  // Enough for the page to preview the reduction with the shared quote arithmetic; not a row,
  // not a list, and nothing about any other code.
  return NextResponse.json({ valid: true, discount: verdict.discount })
}
