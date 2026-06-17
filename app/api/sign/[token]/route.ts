import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'

// Service-role client: this route is the trusted server boundary for the
// public signing page. The browser never touches the signatures table directly.
const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

// GET /api/sign/[token] — load the document to display for signing
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ token: string }> }
) {
  const { token } = await params
  if (!token) {
    return NextResponse.json({ error: 'Missing token' }, { status: 400 })
  }

  const { data: sig, error } = await supabase
    .from('signatures')
    .select('id, doc_type, status, signer_name, signed_at')
    .eq('sign_token', token)
    .single()

  if (error || !sig) {
    return NextResponse.json({ status: 'not_found' }, { status: 404 })
  }
  if (sig.status === 'signed') {
    return NextResponse.json({ status: 'signed', signedAt: sig.signed_at, signerName: sig.signer_name })
  }
  if (sig.status === 'voided') {
    return NextResponse.json({ status: 'voided' })
  }

  // Pending: fetch the document text to show. For booking waivers, that text
  // lives in settings.waiver_text (the same text shown on the online booking page).
  const { data: settings } = await supabase
    .from('settings')
    .select('park_name, waiver_text, waiver_enabled')
    .limit(1)
    .single()

  return NextResponse.json({
    status: 'pending',
    docType: sig.doc_type,
    signerName: sig.signer_name || '',
    parkName: settings?.park_name || 'Campground',
    documentTitle: 'Liability Waiver',
    documentText: settings?.waiver_text || '',
  })
}

// POST /api/sign/[token] — record the signature (typed name + agree + evidence)
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ token: string }> }
) {
  const { token } = await params
  if (!token) {
    return NextResponse.json({ error: 'Missing token' }, { status: 400 })
  }

  const body = await request.json()
  const signedName: string = (body.signedName || '').trim()
  const agreed: boolean = body.agreed === true

  if (!signedName || !agreed) {
    return NextResponse.json({ error: 'Please type your name and check the agreement box.' }, { status: 400 })
  }

  // Look up the pending signature
  const { data: sig, error } = await supabase
    .from('signatures')
    .select('id, status, reservation_id, doc_type')
    .eq('sign_token', token)
    .single()

  if (error || !sig) {
    return NextResponse.json({ error: 'This signing link is no longer valid.' }, { status: 404 })
  }
  if (sig.status === 'signed') {
    return NextResponse.json({ error: 'This document has already been signed.' }, { status: 409 })
  }
  if (sig.status === 'voided') {
    return NextResponse.json({ error: 'This signing link has been canceled.' }, { status: 409 })
  }

  // Snapshot the exact text being agreed to, right now, at signing time.
  const { data: settings } = await supabase
    .from('settings')
    .select('waiver_text')
    .limit(1)
    .single()
  const snapshot = settings?.waiver_text || ''

  // Capture evidence
  const ip = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || request.headers.get('x-real-ip') || ''
  const userAgent = request.headers.get('user-agent') || ''

  const { error: updateErr } = await supabase
    .from('signatures')
    .update({
      status: 'signed',
      agreed: true,
      signed_name: signedName,
      signed_text_snapshot: snapshot,
      signed_at: new Date().toISOString(),
      ip_address: ip,
      user_agent: userAgent,
    })
    .eq('id', sig.id)

  if (updateErr) {
    return NextResponse.json({ error: 'Could not record your signature. Please try again.' }, { status: 500 })
  }

  // Sync the denormalized flag on the reservation so existing pages keep working.
  if (sig.reservation_id) {
    await supabase
      .from('reservations')
      .update({ waiver_signed: true, waiver_signed_at: new Date().toISOString() })
      .eq('id', sig.reservation_id)
  }

  return NextResponse.json({ success: true })
}
