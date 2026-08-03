import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { resolveCancellationPolicy } from '@/lib/cancellation-policy'

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

// Resolves the cancellation policy for an arrival date. Always answers with numbers.
//
// This used to return refund_percent: null and cancellation_deadline_days: null whenever no
// date-specific rule matched — which is most bookings, since a park configures holiday
// exceptions and leaves the rest to the standard terms. A null policy cannot be computed
// with, which is why the refund UI ignored this endpoint and hardcoded × 0.9. The resolver
// now falls back to the same numeric defaults the cancellation_rules columns carry, so there
// is always a machine-readable policy and a park's own rule genuinely changes the refund.
export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url)
  const arrival = searchParams.get('arrival')

  if (!arrival) {
    return NextResponse.json({ error: 'Missing arrival date' }, { status: 400 })
  }

  const policy = await resolveCancellationPolicy(supabase, arrival)

  // Shape unchanged for the booking page, which reads policy.policy_text and
  // policy.deposit_refundable — those keys still mean what they meant.
  return NextResponse.json({ policy })
}
