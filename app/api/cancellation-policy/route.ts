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

  const { data: rules } = await supabase
    .from('cancellation_rules')
    .select('*')
    .eq('is_active', true)
    .lte('start_date', arrival)
    .gte('end_date', arrival)
    .order('start_date', { ascending: false })

  const rule = rules && rules.length > 0 ? rules[0] : null

  if (!rule) {
    return NextResponse.json({
      policy: {
        name: 'Standard Policy',
        deposit_refundable: true,
        refund_percent: 90,
        cancellation_deadline_days: 7,
        policy_text: 'Cancellations made 7 or more days before arrival will receive a 90% refund. A 10% booking fee is retained on all cancellations. Cancellations made less than 7 days before arrival are non-refundable.',
      }
    })
  }

  return NextResponse.json({ policy: rule })
}