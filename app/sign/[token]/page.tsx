'use client'
import { useEffect, useState } from 'react'
import { useParams } from 'next/navigation'

type LoadState =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'already_signed'; signedAt?: string; signerName?: string }
  | { kind: 'voided' }
  | { kind: 'not_found' }
  | { kind: 'ready'; parkName: string; documentTitle: string; documentText: string; signerName: string }

export default function SignPage() {
  const params = useParams()
  const token = params.token as string

  const [state, setState] = useState<LoadState>({ kind: 'loading' })
  const [typedName, setTypedName] = useState('')
  const [agreed, setAgreed] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [submitError, setSubmitError] = useState('')
  const [done, setDone] = useState(false)

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch(`/api/sign/${token}`)
        if (res.status === 404) { setState({ kind: 'not_found' }); return }
        const data = await res.json()
        if (data.status === 'signed') {
          setState({ kind: 'already_signed', signedAt: data.signedAt, signerName: data.signerName })
        } else if (data.status === 'voided') {
          setState({ kind: 'voided' })
        } else if (data.status === 'pending') {
          setState({
            kind: 'ready',
            parkName: data.parkName,
            documentTitle: data.documentTitle,
            documentText: data.documentText,
            signerName: data.signerName,
          })
          if (data.signerName) setTypedName(data.signerName)
        } else {
          setState({ kind: 'error', message: 'Unable to load this document.' })
        }
      } catch {
        setState({ kind: 'error', message: 'Unable to load this document. Please check your connection.' })
      }
    })()
  }, [token])

  async function submit() {
    setSubmitError('')
    if (!typedName.trim()) { setSubmitError('Please type your full name.'); return }
    if (!agreed) { setSubmitError('Please check the box to agree.'); return }
    setSubmitting(true)
    try {
      const res = await fetch(`/api/sign/${token}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ signedName: typedName.trim(), agreed: true }),
      })
      const data = await res.json()
      if (data.success) { setDone(true) }
      else { setSubmitError(data.error || 'Could not record your signature.') }
    } catch {
      setSubmitError('Something went wrong. Please try again.')
    }
    setSubmitting(false)
  }

  const wrap: React.CSSProperties = { fontFamily: 'sans-serif', minHeight: '100vh', background: '#FBF7EE', display: 'flex', justifyContent: 'center', padding: '1.25rem' }
  const card: React.CSSProperties = { background: '#fff', border: '1px solid #ECE3D2', borderRadius: 14, maxWidth: 600, width: '100%', padding: '1.5rem', alignSelf: 'flex-start', boxShadow: '0 1px 4px rgba(0,0,0,0.05)' }

  if (state.kind === 'loading') {
    return <div style={wrap}><div style={{ ...card, textAlign: 'center', color: '#8A7E6B' }}>Loading…</div></div>
  }

  if (state.kind === 'not_found' || state.kind === 'error') {
    return (
      <div style={wrap}><div style={{ ...card, textAlign: 'center' }}>
        <div style={{ fontSize: 40, marginBottom: 10 }}>🔗</div>
        <h1 style={{ fontSize: 18, fontWeight: 700, margin: '0 0 6px' }}>Link not found</h1>
        <p style={{ color: '#6b7280', fontSize: 14, margin: 0 }}>
          {state.kind === 'error' ? state.message : 'This signing link is invalid or has expired. Please contact the campground for a new link.'}
        </p>
      </div></div>
    )
  }

  if (state.kind === 'voided') {
    return (
      <div style={wrap}><div style={{ ...card, textAlign: 'center' }}>
        <div style={{ fontSize: 40, marginBottom: 10 }}>🚫</div>
        <h1 style={{ fontSize: 18, fontWeight: 700, margin: '0 0 6px' }}>Link canceled</h1>
        <p style={{ color: '#6b7280', fontSize: 14, margin: 0 }}>This signing link has been canceled. Please contact the campground.</p>
      </div></div>
    )
  }

  if (state.kind === 'already_signed') {
    return (
      <div style={wrap}><div style={{ ...card, textAlign: 'center' }}>
        <div style={{ fontSize: 40, marginBottom: 10 }}>✅</div>
        <h1 style={{ fontSize: 18, fontWeight: 700, margin: '0 0 6px' }}>Already signed</h1>
        <p style={{ color: '#6b7280', fontSize: 14, margin: 0 }}>
          This document was already signed{state.signerName ? ` by ${state.signerName}` : ''}. No further action is needed.
        </p>
      </div></div>
    )
  }

  if (done) {
    return (
      <div style={wrap}><div style={{ ...card, textAlign: 'center' }}>
        <div style={{ fontSize: 48, marginBottom: 12 }}>✅</div>
        <h1 style={{ fontSize: 20, fontWeight: 700, margin: '0 0 8px', color: '#15803d' }}>Signed — thank you!</h1>
        <p style={{ color: '#6b7280', fontSize: 14, margin: '0 0 18px' }}>Your signature has been recorded. You're all set.</p>
        <button
          onClick={() => {
            const ret = new URLSearchParams(window.location.search).get('return')
            if (ret) window.location.href = ret
            else window.close()
          }}
          style={{ backgroundColor: '#2E6B8A', color: '#fff', border: 'none', borderRadius: 10, padding: '12px 24px', fontWeight: 700, fontSize: 15, cursor: 'pointer' }}
        >
          ← Done
        </button>
        <p style={{ fontSize: 12, color: '#9ca3af', marginTop: 10, marginBottom: 0 }}>You can close this page.</p>
      </div></div>
    )
  }

  // ready
  return (
    <div style={wrap}>
      <div style={card}>
        <div style={{ fontSize: 12, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', color: '#A1937C', marginBottom: 4 }}>{state.parkName}</div>
        <h1 style={{ fontSize: 22, fontWeight: 700, margin: '0 0 16px' }}>{state.documentTitle}</h1>

        <div style={{ background: '#FBF8F1', border: '1px solid #F3EEE2', borderRadius: 10, padding: '1rem', maxHeight: '45vh', overflowY: 'auto', fontSize: 14, lineHeight: 1.55, color: '#374151', whiteSpace: 'pre-wrap', marginBottom: 18 }}>
          {state.documentText || 'No document text is available. Please contact the campground.'}
        </div>

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
            I have read and agree to the {state.documentTitle.toLowerCase()} above, and I understand that typing my name and submitting this form constitutes my legal signature.
          </span>
        </div>

        {submitError && <div style={{ background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 8, padding: '10px 14px', marginBottom: 12, fontSize: 13, color: '#dc2626' }}>{submitError}</div>}

        <button
          onClick={submit}
          disabled={submitting || !typedName.trim() || !agreed}
          style={{ width: '100%', backgroundColor: submitting || !typedName.trim() || !agreed ? '#d1d5db' : '#15803d', color: '#fff', border: 'none', borderRadius: 10, padding: '15px', fontWeight: 700, fontSize: 16, cursor: submitting || !typedName.trim() || !agreed ? 'default' : 'pointer' }}
        >
          {submitting ? 'Signing…' : 'Sign'}
        </button>
        <p style={{ fontSize: 11, color: '#9ca3af', textAlign: 'center', marginTop: 10, marginBottom: 0 }}>
          Your name, the date, and this document's text are recorded as your electronic signature.
        </p>
      </div>
    </div>
  )
}
