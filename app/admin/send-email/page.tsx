'use client'
import { useRouter } from 'next/navigation'
import { useEffect, useState, useRef } from 'react'
import { createClient } from '@supabase/supabase-js'

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
)

type Recipient = {
  id: string
  name: string
  email: string
  site_number: string
  is_seasonal: boolean
  is_monthly: boolean
  email_opt_out: boolean
  checked: boolean
}

type Group = 'seasonal' | 'monthly' | 'tonight' | 'alltime' | 'individual'

export default function SendEmailPage() {
  const router = useRouter()

  useEffect(() => {
    supabase.from('settings').select('plan').single().then(({ data }) => {
      if (!['ridgeline', 'summit'].includes(data?.plan)) router.replace('/admin')
    })
  }, [])

  const [recipients, setRecipients] = useState<Recipient[]>([])
  const [selectedGroup, setSelectedGroup] = useState<Group | null>(null)
  const [loading, setLoading] = useState(false)
  const [dateFrom, setDateFrom] = useState('')
  const [dateTo, setDateTo] = useState('')
  const [subject, setSubject] = useState('')
  const [message, setMessage] = useState('')
  const [buttonLabel, setButtonLabel] = useState('')
  const [buttonUrl, setButtonUrl] = useState('')
  const [bypassOptOut, setBypassOptOut] = useState(false)
  const [headerImageUrl, setHeaderImageUrl] = useState('')
  const [imageAltText, setImageAltText] = useState('')
  const [uploading, setUploading] = useState(false)
  const [sending, setSending] = useState(false)
  const [sent, setSent] = useState(false)
  const [sentCount, setSentCount] = useState(0)
  const [error, setError] = useState('')
  const [showConfirm, setShowConfirm] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const checkedRecipients = recipients.filter(r => r.checked && r.email)
  const optedOutCount = recipients.filter(r => r.checked && r.email_opt_out && !bypassOptOut).length
  const willSendTo = checkedRecipients.filter(r => bypassOptOut || !r.email_opt_out)

  async function loadGroup(group: Group) {
    setSelectedGroup(group)
    setLoading(true)
    setRecipients([])

    if (group === 'seasonal') {
      const { data } = await supabase.from('guests').select('*').eq('is_seasonal', true).order('site_number')
      setRecipients(toRecipients(data || []))
    } else if (group === 'monthly') {
      const { data } = await supabase.from('guests').select('*').eq('is_monthly', true).order('site_number')
      setRecipients(toRecipients(data || []))
    } else if (group === 'tonight') {
      const today = new Date().toISOString().split('T')[0]
      const { data } = await supabase
        .from('reservations')
        .select('guest_name, guest_email, site_name')
        .lte('arrival_date', today)
        .gte('departure_date', today)
        .neq('status', 'cancelled')
      const unique = dedupeByEmail(data || [])
      setRecipients(unique.map(r => ({
        id: r.guest_email, name: r.guest_name, email: r.guest_email,
        site_number: r.site_name, is_seasonal: false, is_monthly: false,
        email_opt_out: false, checked: true,
      })))
    } else if (group === 'individual') {
      const { data } = await supabase.from('guests').select('*').order('name')
      setRecipients(toRecipients(data || [], false))
    }

    setLoading(false)
  }

  async function loadAllTime() {
    if (!dateFrom || !dateTo) return
    setLoading(true)
    const { data } = await supabase
      .from('reservations')
      .select('guest_name, guest_email, site_name')
      .gte('arrival_date', dateFrom)
      .lte('departure_date', dateTo)
      .neq('status', 'cancelled')
    const unique = dedupeByEmail(data || [])
    setRecipients(unique.map(r => ({
      id: r.guest_email, name: r.guest_name, email: r.guest_email,
      site_number: r.site_name, is_seasonal: false, is_monthly: false,
      email_opt_out: false, checked: true,
    })))
    setLoading(false)
  }

  function toRecipients(data: any[], checked = true): Recipient[] {
    return dedupeByEmail(data).map(g => ({
      id: g.id, name: g.name, email: g.email || '',
      site_number: g.site_number || '', is_seasonal: g.is_seasonal || false,
      is_monthly: g.is_monthly || false, email_opt_out: g.email_opt_out || false,
      checked: checked && !!g.email,
    }))
  }

  function dedupeByEmail(data: any[]): any[] {
    const seen = new Set()
    return data.filter(r => {
      const email = r.email || r.guest_email
      if (!email || seen.has(email.toLowerCase())) return false
      seen.add(email.toLowerCase())
      return true
    })
  }

  function toggleAll(checked: boolean) {
    setRecipients(prev => prev.map(r => ({ ...r, checked: checked && !!r.email })))
  }

  function toggleOne(index: number) {
    setRecipients(prev => { const u = [...prev]; u[index] = { ...u[index], checked: !u[index].checked }; return u })
  }

  async function uploadImage(file: File) {
    if (!file) return
    if (file.size > 1024 * 1024) { setError('Image must be under 1MB'); return }
    setUploading(true)
    const ext = file.name.split('.').pop()
    const path = `broadcast-images/${Date.now()}.${ext}`
    const { error: upErr } = await supabase.storage.from('site-photos').upload(path, file, { contentType: file.type })
    if (upErr) { setError('Image upload failed: ' + upErr.message); setUploading(false); return }
    const { data: urlData } = supabase.storage.from('site-photos').getPublicUrl(path)
    setHeaderImageUrl(urlData.publicUrl)
    setUploading(false)
  }

  async function send() {
    if (!subject || !message) { setError('Subject and message are required'); return }
    if (willSendTo.length === 0) { setError('No recipients selected'); return }
    setSending(true)
    setError('')

    const res = await fetch('/api/broadcast-email', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        recipients: willSendTo.map(r => ({ name: r.name, email: r.email, id: r.id })),
        subject, message, buttonLabel, buttonUrl,
        headerImageUrl, imageAltText, bypassOptOut,
      }),
    })

    const data = await res.json()
    setSending(false)
    if (data.success) {
      setSent(true)
      setSentCount(data.sentCount || willSendTo.length)
    } else {
      setError(data.error || 'Failed to send')
    }
    setShowConfirm(false)
  }

  if (sent) return (
    <div style={{ padding: '3rem', textAlign: 'center', fontFamily: 'sans-serif' }}>
      <div style={{ fontSize: 48, marginBottom: 16 }}>✅</div>
      <h2 style={{ fontSize: 24, fontWeight: 700, color: '#111827' }}>Email sent!</h2>
      <p style={{ color: '#6b7280', fontSize: 15 }}>Successfully delivered to {sentCount} recipient{sentCount !== 1 ? 's' : ''}.</p>
      <button onClick={() => { setSent(false); setSubject(''); setMessage(''); setRecipients([]); setSelectedGroup(null); setHeaderImageUrl(''); setButtonLabel(''); setButtonUrl('') }}
        style={{ marginTop: 24, background: '#2E6B8A', color: '#fff', border: 'none', borderRadius: 8, padding: '10px 28px', fontSize: 14, fontWeight: 600, cursor: 'pointer' }}>
        Send Another Email
      </button>
    </div>
  )

  return (
    <div style={{ padding: '2rem', maxWidth: 900, margin: '0 auto', fontFamily: 'sans-serif' }}>
      <div style={{ marginBottom: '1.5rem' }}>
        <h1 style={{ fontSize: 24, fontWeight: 700, margin: 0 }}>Send Email</h1>
        <p style={{ color: '#6b7280', margin: '4px 0 0', fontSize: 14 }}>Compose and send emails to your guests</p>
      </div>

      {/* Step 1: Recipients */}
      <div style={card}>
        <h3 style={cardTitle}>Step 1 — Choose Recipients</h3>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, marginBottom: 16 }}>
          {([
            { key: 'seasonal', label: '⛺ All Seasonals' },
            { key: 'monthly', label: '📅 All Monthlies' },
            { key: 'tonight', label: '🌙 Staying Tonight' },
            { key: 'alltime', label: '📋 All Guests Ever' },
            { key: 'individual', label: '👤 Select Individuals' },
          ] as { key: Group; label: string }[]).map(g => (
            <button key={g.key} onClick={() => g.key === 'alltime' ? setSelectedGroup('alltime') : loadGroup(g.key)}
              style={{ padding: '8px 16px', fontSize: 13, fontWeight: 600, borderRadius: 8, cursor: 'pointer', border: '2px solid', borderColor: selectedGroup === g.key ? '#2E6B8A' : '#e5e7eb', background: selectedGroup === g.key ? '#EBF4F8' : '#fff', color: selectedGroup === g.key ? '#2E6B8A' : '#374151' }}>
              {g.label}
            </button>
          ))}
        </div>

        {/* Date range for all time */}
        {selectedGroup === 'alltime' && (
          <div style={{ display: 'flex', gap: 12, alignItems: 'flex-end', marginBottom: 16 }}>
            <div>
              <label style={lbl}>From</label>
              <input style={{ ...inp, width: 160 }} type='date' value={dateFrom} onChange={e => setDateFrom(e.target.value)} />
            </div>
            <div>
              <label style={lbl}>To</label>
              <input style={{ ...inp, width: 160 }} type='date' value={dateTo} onChange={e => setDateTo(e.target.value)} />
            </div>
            <button onClick={loadAllTime} disabled={!dateFrom || !dateTo || loading}
              style={{ background: '#2E6B8A', color: '#fff', border: 'none', borderRadius: 7, padding: '8px 18px', fontSize: 13, fontWeight: 600, cursor: 'pointer', height: 36 }}>
              {loading ? 'Loading...' : 'Load Guests'}
            </button>
          </div>
        )}

        {/* Recipient list */}
        {loading && <div style={{ color: '#6b7280', fontSize: 13 }}>Loading recipients...</div>}
        {recipients.length > 0 && (
          <div style={{ border: '1px solid #e5e7eb', borderRadius: 10, overflow: 'hidden' }}>
            {/* Check/uncheck all */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 14px', background: '#f9fafb', borderBottom: '1px solid #e5e7eb' }}>
              <input type='checkbox' checked={recipients.every(r => r.checked || !r.email)} onChange={e => toggleAll(e.target.checked)}
                style={{ width: 16, height: 16, cursor: 'pointer', appearance: 'auto' as any }} />
              <span style={{ fontSize: 13, fontWeight: 600, color: '#374151' }}>
                {recipients.filter(r => r.checked).length} of {recipients.filter(r => r.email).length} selected
              </span>
              {optedOutCount > 0 && !bypassOptOut && (
                <span style={{ fontSize: 12, color: '#9ca3af', marginLeft: 8 }}>({optedOutCount} opted out — will be skipped)</span>
              )}
            </div>
            <div style={{ maxHeight: 280, overflowY: 'auto' }}>
              {recipients.map((r, i) => (
                <div key={r.id} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '8px 14px', borderBottom: '1px solid #f3f4f6', background: r.checked ? '#fff' : '#f9fafb', opacity: !r.email ? 0.5 : 1 }}>
                  <input type='checkbox' checked={r.checked} disabled={!r.email} onChange={() => toggleOne(i)}
                    style={{ width: 16, height: 16, cursor: r.email ? 'pointer' : 'default', appearance: 'auto' as any }} />
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: 13, fontWeight: 600, color: '#111827' }}>{r.name}</div>
                    <div style={{ fontSize: 11, color: '#9ca3af' }}>{r.email || 'No email'}{r.site_number ? ' · Site ' + r.site_number : ''}</div>
                  </div>
                  {r.email_opt_out && <span style={{ fontSize: 11, color: '#dc2626', background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 4, padding: '2px 6px' }}>Opted out</span>}
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Step 2: Compose */}
      <div style={card}>
        <h3 style={cardTitle}>Step 2 — Compose Email</h3>

        {/* Header image */}
        <div style={{ marginBottom: 16 }}>
          <label style={lbl}>Header Image (optional)</label>
          <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
            <button onClick={() => fileInputRef.current?.click()} disabled={uploading}
              style={{ background: '#f3f4f6', color: '#374151', border: '1px solid #e5e7eb', borderRadius: 7, padding: '7px 16px', fontSize: 13, fontWeight: 600, cursor: 'pointer' }}>
              {uploading ? 'Uploading...' : '📷 Upload Image'}
            </button>
            <input ref={fileInputRef} type='file' accept='image/jpeg,image/png' style={{ display: 'none' }} onChange={e => { if (e.target.files?.[0]) uploadImage(e.target.files[0]) }} />
            {headerImageUrl && <span style={{ fontSize: 12, color: '#15803d' }}>✓ Image uploaded</span>}
            {headerImageUrl && <button onClick={() => setHeaderImageUrl('')} style={{ fontSize: 12, color: '#dc2626', background: 'none', border: 'none', cursor: 'pointer' }}>Remove</button>}
          </div>
          {headerImageUrl && (
            <div style={{ marginTop: 10 }}>
              <img src={headerImageUrl} alt='Header preview' style={{ maxWidth: '100%', maxHeight: 200, borderRadius: 8, objectFit: 'cover' }} />
              <div style={{ marginTop: 8 }}>
                <label style={lbl}>Image alt text</label>
                <input style={inp} value={imageAltText} onChange={e => setImageAltText(e.target.value)} placeholder='e.g. Summer bonfire at Cady Hollow' />
              </div>
            </div>
          )}
        </div>

        <div style={{ marginBottom: 14 }}>
          <label style={lbl}>Subject line</label>
          <input style={inp} value={subject} onChange={e => setSubject(e.target.value)} placeholder='e.g. Join us for our annual bonfire!' />
        </div>

        <div style={{ marginBottom: 14 }}>
          <label style={lbl}>Message</label>
          <textarea style={{ ...inp, height: 160, resize: 'vertical' }} value={message} onChange={e => setMessage(e.target.value)} placeholder='Write your message here...' />
        </div>

        {/* Optional button */}
        <div style={{ marginBottom: 8 }}>
          <label style={lbl}>Call-to-action button (optional)</label>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 2fr', gap: 10 }}>
            <input style={inp} value={buttonLabel} onChange={e => setButtonLabel(e.target.value)} placeholder='e.g. Book Now' />
            <input style={inp} value={buttonUrl} onChange={e => setButtonUrl(e.target.value)} placeholder='e.g. https://book.cadyhollow.com' />
          </div>
        </div>
      </div>

      {/* Step 3: Send options */}
      <div style={card}>
        <h3 style={cardTitle}>Step 3 — Send Options</h3>
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12, marginBottom: 16, background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 10, padding: 14 }}>
          <input type='checkbox' id='bypass' checked={bypassOptOut} onChange={e => setBypassOptOut(e.target.checked)}
            style={{ width: 16, height: 16, marginTop: 2, cursor: 'pointer', appearance: 'auto' as any }} />
          <label htmlFor='bypass' style={{ fontSize: 13, color: '#374151', cursor: 'pointer', lineHeight: 1.5 }}>
            <strong style={{ color: '#dc2626' }}>Emergency override</strong> — send to ALL selected recipients including those who opted out.
            Only use for urgent operational messages (power outages, safety alerts, schedule changes).
          </label>
        </div>

        {error && <div style={{ fontSize: 13, color: '#dc2626', marginBottom: 12 }}>{error}</div>}

        <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
          <button
            onClick={() => { setError(''); if (!subject || !message) { setError('Subject and message are required'); return } if (willSendTo.length === 0) { setError('No recipients selected'); return } setShowConfirm(true) }}
            disabled={sending || willSendTo.length === 0}
            style={{ background: willSendTo.length > 0 ? '#2E6B8A' : '#d1d5db', color: '#fff', border: 'none', borderRadius: 8, padding: '11px 28px', fontWeight: 700, fontSize: 15, cursor: willSendTo.length > 0 ? 'pointer' : 'default' }}>
            {sending ? 'Sending...' : `Send to ${willSendTo.length} recipient${willSendTo.length !== 1 ? 's' : ''}`}
          </button>
          {optedOutCount > 0 && !bypassOptOut && (
            <span style={{ fontSize: 13, color: '#9ca3af' }}>{optedOutCount} opted-out recipient{optedOutCount !== 1 ? 's' : ''} will be skipped</span>
          )}
        </div>
      </div>

      {/* Confirm modal */}
      {showConfirm && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 50 }}>
          <div style={{ background: '#fff', borderRadius: 16, padding: 32, maxWidth: 440, width: '90%', boxShadow: '0 20px 60px rgba(0,0,0,0.2)' }}>
            <h3 style={{ margin: '0 0 12px', fontSize: 18, fontWeight: 700 }}>Confirm Send</h3>
            <p style={{ margin: '0 0 8px', fontSize: 14, color: '#374151' }}>
              You are about to send <strong>"{subject}"</strong> to <strong>{willSendTo.length} recipient{willSendTo.length !== 1 ? 's' : ''}</strong>.
            </p>
            {bypassOptOut && <p style={{ margin: '0 0 16px', fontSize: 13, color: '#dc2626', fontWeight: 600 }}>⚠️ Emergency override is ON — opted-out guests will receive this email.</p>}
            <div style={{ display: 'flex', gap: 12, marginTop: 20 }}>
              <button onClick={send} disabled={sending}
                style={{ flex: 1, background: '#2E6B8A', color: '#fff', border: 'none', borderRadius: 8, padding: '10px 0', fontWeight: 700, fontSize: 14, cursor: 'pointer' }}>
                {sending ? 'Sending...' : 'Yes, Send Now'}
              </button>
              <button onClick={() => setShowConfirm(false)}
                style={{ flex: 1, background: 'none', border: '1px solid #d1d5db', borderRadius: 8, padding: '10px 0', fontSize: 14, cursor: 'pointer' }}>
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

const card: React.CSSProperties = { background: '#fff', border: '1px solid #e5e7eb', borderRadius: 12, padding: '1.5rem', marginBottom: 20 }
const cardTitle: React.CSSProperties = { margin: '0 0 1rem', fontSize: 15, fontWeight: 700, color: '#111827' }
const lbl: React.CSSProperties = { display: 'block', fontSize: 13, fontWeight: 600, color: '#374151', marginBottom: 4, marginTop: 8 }
const inp: React.CSSProperties = { width: '100%', border: '1px solid #d1d5db', borderRadius: 7, padding: '8px 10px', fontSize: 14, boxSizing: 'border-box' }
