import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url)
    const id = searchParams.get('id')

    if (!id) {
      return new NextResponse(errorPage('Invalid unsubscribe link.'), { headers: { 'Content-Type': 'text/html' } })
    }

    const { data: guest } = await supabase
      .from('guests')
      .select('name, park_name:settings(park_name)')
      .eq('id', id)
      .single()

    await supabase
      .from('guests')
      .update({ email_opt_out: true })
      .eq('id', id)

    const { data: settings } = await supabase.from('settings').select('park_name').single()
    const campgroundName = settings?.park_name || 'Our Campground'
    const guestName = guest?.name || 'there'

    return new NextResponse(successPage(guestName, campgroundName), {
      headers: { 'Content-Type': 'text/html' }
    })
  } catch (error: any) {
    return new NextResponse(errorPage(error.message), { headers: { 'Content-Type': 'text/html' } })
  }
}

function successPage(name: string, campground: string) {
  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Unsubscribed</title></head>
<body style="margin:0;padding:0;background:#f3f4f6;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;">
<div style="max-width:480px;margin:40px auto;background:#fff;border-radius:16px;padding:48px 40px;text-align:center;box-shadow:0 4px 24px rgba(0,0,0,0.08);">
  <div style="font-size:48px;margin-bottom:16px;">✅</div>
  <h1 style="margin:0 0 12px;font-size:22px;font-weight:700;color:#111827;">You've been unsubscribed</h1>
  <p style="margin:0;font-size:15px;color:#6b7280;line-height:1.6;">Hi ${name}, you've been removed from ${campground}'s marketing emails. You'll still receive important emails about your reservations and account.</p>
  <p style="margin:24px 0 0;font-size:13px;color:#9ca3af;">Changed your mind? Contact us directly and we'll add you back.</p>
</div>
</body>
</html>`
}

function errorPage(msg: string) {
  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><title>Error</title></head>
<body style="margin:0;padding:40px;font-family:sans-serif;text-align:center;">
<h2>Something went wrong</h2><p style="color:#6b7280;">${msg}</p>
</body>
</html>`
}
