import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url)
  const arrival = searchParams.get('arrival')

  if (!arrival) {
    return NextResponse.json({ error: 'Missing arrival date' }, { status: 400 })
  }

  // Check for a date-specific cancellation rule first
  const { data: rules } = await supabase
    .from('cancellation_rules')
    .select('*')
    .eq('is_active', true)
    .lte('start_date', arrival)
    .gte('end_date', arrival)
    .order('start_date', { ascending: false })

  const rule = rules && rules.length > 0 ? rules[0] : null

  // If a specific rule exists, return it
  if (rule) {
    return NextResponse.json({ policy: rule })
  }

  // Otherwise fall back to the cancellation_policy from settings
  const { data: settings } = await supabase
    .from('settings')
    .select('cancellation_policy')
    .limit(1)
    .single()

  return NextResponse.json({
    policy: {
      name: 'Standard Policy',
      deposit_refundable: true,
      refund_percent: null,
      cancellation_deadline_days: null,
      policy_text: settings?.cancellation_policy || 'Please contact us for cancellation information.',
    }
  })
}