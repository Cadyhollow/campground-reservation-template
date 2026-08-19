'use client'
import { useCallback, useEffect, useState } from 'react'
import { useParams, useRouter } from 'next/navigation'

type Doc = {
  id: string
  docType: string
  documentTitle: string
  documentText: string
  status: string
  signedAt: string | null
}
type PacketData = { parkName: string; documents: Doc[] }
type View = 'loading' | 'not_found' | 'error' | 'ready' | 'signed'

export default function PacketPage() {
  const params = useParams()
  const router = useRouter()
  const packetId = params.packetId as string

  const [view, setView] = useState<View>('loading')
  const [errorMsg, setErrorMsg] = useState('')
  const [data, setData] = useState<PacketData | null>(null)
  const [typedName, setTypedName] = useState('')
  const [agreed, setAgreed] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [submitError, setSubmitError] = useState('')

  // useCallback because load() is ALSO called after a successful submit (to re-fetch the signed
  // view with its dates), so it cannot simply be inlined into the effect. Declaring it properly
  // is what lets the effect list it as a dependency instead of suppressing the warning.
  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/packet/${packetId}`)
      if (res.status === 404) { setView('not_found'); return }
      const d = await res.json()
      if (d.status === 'signed') { setData(d); setView('signed') }
      else if (d.status === 'pending') { setData(d); setView('ready') }
      else { setErrorMsg('Unable to load this packet.'); setView('error') }
    } catch {
      setErrorMsg('Unable to load this packet. Please check your connection.'); setView('error')
    }
  }, [packetId])

  useEffect(() => { void load() }, [load])

  async function submit() {
    setSubmitError('')
    if (!typedName.trim()) { setSubmitError('Please type your full name.'); return }
    if (!agreed) { setSubmitError('Please check the box to agree.'); return }
    setSubmitting(true)
    try {
      const res = await fetch(`/api/packet/${packetId}/sign`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ signedName: typedName.trim(), agreed: true }),
      })
      const d = await res.json()
      if (d.success) {
        // In-person kiosk (admin iPad): return to admin and drop the sign URL from
        // history instead of showing the camper-facing confirmation. Remote campers
        // (no kiosk flag) get the normal signed view.
        if (new URLSearchParams(window.location.search).get('kiosk') === '1') {
          router.replace('/admin/seasonals')
          return
        }
        await load() // re-fetch → signed view with dates
      }
      else { setSubmitError(d.error || 'Could not record your signature.') }
    } catch {
      setSubmitError('Something went wrong. Please try again.')
    }
    setSubmitting(false)
  }

  const wrap: React.CSSProperties = { fontFamily: 'sans-serif', minHeight: '100vh', background: '#FBF7EE', display: 'flex', justifyContent: 'center', padding: '1.25rem' }
  const card: React.CSSProperties = { background: '#fff', border: '1px solid #ECE3D2', borderRadius: 14, maxWidth: 620, width: '100%', padding: '1.5rem', alignSelf: 'flex-start', boxShadow: '0 1px 4px rgba(0,0,0,0.05)' }
  const eyebrow: React.CSSProperties = { fontSize: 12, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', color: '#A1937C', marginBottom: 4 }

  const printCss = `
    @media print {
      .no-print { display: none !important; }
      body { background: #fff !important; }
      .packet-card { box-shadow: none !important; border: none !important; max-width: none !important; padding: 0 !important; }
      .packet-doc { max-height: none !important; overflow: visible !important; border: none !important; background: #fff !important; padding: 0 !important; }
      .packet-doc + .packet-doc { page-break-before: always; }
    }
  `

  if (view === 'loading') {
    return <div style={wrap}><div style={{ ...card, textAlign: 'center', color: '#8A7E6B' }}>Loading…</div></div>
  }

  if (view === 'not_found' || view === 'error') {
    return (
      <div style={wrap}><div style={{ ...card, textAlign: 'center' }}>
        <div style={{ fontSize: 40, marginBottom: 10 }}>🔗</div>
        <h1 style={{ fontSize: 18, fontWeight: 700, margin: '0 0 6px' }}>Link not found</h1>
        <p style={{ color: '#6b7280', fontSize: 14, margin: 0 }}>
          {view === 'error' ? errorMsg : 'This signing link is invalid or has expired. Please contact the campground for a new link.'}
        </p>
      </div></div>
    )
  }

  const docs = data?.documents || []

  // ── SIGNED: confirmation + print-friendly copy of exactly what was signed ──
  if (view === 'signed') {
    const signedAt = docs.find(d => d.signedAt)?.signedAt
    const signedDate = signedAt ? new Date(signedAt).toLocaleString('en-US', { dateStyle: 'long', timeStyle: 'short' }) : ''
    return (
      <div style={wrap}>
        <style>{printCss}</style>
        <div style={card} className="packet-card">
          <div style={{ textAlign: 'center', marginBottom: 20 }} className="no-print">
            <div style={{ fontSize: 44, marginBottom: 8 }}>✅</div>
            <h1 style={{ fontSize: 20, fontWeight: 700, margin: '0 0 6px', color: '#15803d' }}>Signed — thank you!</h1>
            <p style={{ color: '#6b7280', fontSize: 14, margin: 0 }}>
              Both documents are signed and recorded{signedDate ? ` (${signedDate})` : ''}. You can print a copy for your records.
            </p>
            <button onClick={() => window.print()}
              style={{ marginTop: 14, backgroundColor: '#2E6B8A', color: '#fff', border: 'none', borderRadius: 10, padding: '11px 22px', fontWeight: 700, fontSize: 15, cursor: 'pointer' }}>
              🖨 Print packet
            </button>
          </div>

          <div style={eyebrow}>{data?.parkName}</div>
          <h2 style={{ fontSize: 18, fontWeight: 700, margin: '0 0 16px' }}>Signed packet</h2>

          {docs.map(doc => (
            <div key={doc.id} style={{ marginBottom: 22 }}>
              <h3 style={{ fontSize: 16, fontWeight: 700, margin: '0 0 8px' }}>{doc.documentTitle}</h3>
              <div className="packet-doc" style={{ background: '#FBF8F1', border: '1px solid #F3EEE2', borderRadius: 10, padding: '1rem', fontSize: 13.5, lineHeight: 1.55, color: '#374151', whiteSpace: 'pre-wrap' }}>
                {doc.documentText || '—'}
              </div>
              <p style={{ fontSize: 12, color: '#15803d', margin: '8px 0 0', fontWeight: 600 }}>
                ✓ Signed{signedDate ? ` · ${signedDate}` : ''}
              </p>
            </div>
          ))}
        </div>
      </div>
    )
  }

  // ── READY: both documents, one submit signs all ──
  return (
    <div style={wrap}>
      <div style={card}>
        <div style={eyebrow}>{data?.parkName}</div>
        <h1 style={{ fontSize: 22, fontWeight: 700, margin: '0 0 4px' }}>Your seasonal packet</h1>
        <p style={{ color: '#6b7280', fontSize: 14, margin: '0 0 18px' }}>
          You are signing {docs.length} document{docs.length === 1 ? '' : 's'}. Please read each one below, then type your name and submit once to sign them all.
        </p>

        {docs.map((doc, i) => (
          <div key={doc.id} style={{ marginBottom: 18 }}>
            <div style={{ fontSize: 12, fontWeight: 700, color: '#A1937C', marginBottom: 4 }}>
              Document {i + 1} of {docs.length}
            </div>
            <h2 style={{ fontSize: 17, fontWeight: 700, margin: '0 0 8px' }}>{doc.documentTitle}</h2>
            <div style={{ background: '#FBF8F1', border: '1px solid #F3EEE2', borderRadius: 10, padding: '1rem', maxHeight: '38vh', overflowY: 'auto', fontSize: 14, lineHeight: 1.55, color: '#374151', whiteSpace: 'pre-wrap' }}>
              {doc.documentText || 'No document text is available. Please contact the campground.'}
            </div>
          </div>
        ))}

        <div style={{ borderTop: '1px solid #ECE3D2', margin: '20px 0 18px' }} />

        <label style={{ display: 'block', fontSize: 13, fontWeight: 600, color: '#374151', marginBottom: 6 }}>Type your full name to sign</label>
        <input
          value={typedName}
          onChange={e => setTypedName(e.target.value)}
          placeholder="Full name"
          style={{ width: '100%', border: '1px solid #d1d5db', borderRadius: 8, padding: '12px 14px', fontSize: 16, boxSizing: 'border-box', marginBottom: 14 }}
        />

        <div
          onClick={() => setAgreed(a => !a)}
          role="checkbox"
          aria-checked={agreed}
          tabIndex={0}
          onKeyDown={e => { if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); setAgreed(a => !a) } }}
          style={{ display: 'flex', alignItems: 'flex-start', gap: 12, cursor: 'pointer', marginBottom: 18, padding: '14px', border: `2px solid ${agreed ? '#15803d' : '#d1d5db'}`, borderRadius: 10, background: agreed ? '#f0fdf4' : '#fff', transition: 'border-color 0.15s, background 0.15s' }}
        >
          <span style={{ width: 24, height: 24, borderRadius: 6, flexShrink: 0, marginTop: 1, border: `2px solid ${agreed ? '#15803d' : '#9ca3af'}`, background: agreed ? '#15803d' : '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fff', fontSize: 16, fontWeight: 700, lineHeight: 1 }}>
            {agreed ? '✓' : ''}
          </span>
          <span style={{ fontSize: 14, color: '#374151', lineHeight: 1.45 }}>
            I have read and agree to {docs.length === 1 ? 'the document' : 'both documents'} above, and I understand that typing my name and submitting this form constitutes my legal signature on {docs.length === 1 ? 'it' : 'each of them'}.
          </span>
        </div>

        {submitError && <div style={{ background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 8, padding: '10px 14px', marginBottom: 12, fontSize: 13, color: '#dc2626' }}>{submitError}</div>}

        <button
          onClick={submit}
          disabled={submitting || !typedName.trim() || !agreed}
          style={{ width: '100%', backgroundColor: submitting || !typedName.trim() || !agreed ? '#d1d5db' : '#15803d', color: '#fff', border: 'none', borderRadius: 10, padding: '15px', fontWeight: 700, fontSize: 16, cursor: submitting || !typedName.trim() || !agreed ? 'default' : 'pointer' }}
        >
          {submitting ? 'Signing…' : `Sign ${docs.length === 1 ? 'document' : 'both documents'}`}
        </button>
        <p style={{ fontSize: 11, color: '#9ca3af', textAlign: 'center', marginTop: 10, marginBottom: 0 }}>
          Your name, the date, and each document&apos;s text are recorded as your electronic signature.
        </p>
      </div>
    </div>
  )
}
