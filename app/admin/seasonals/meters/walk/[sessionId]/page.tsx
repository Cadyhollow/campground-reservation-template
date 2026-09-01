'use client'
import { use, useEffect, useState } from 'react'
import Link from 'next/link'
import MeterCapture, { type CaptureMeter } from '../../MeterCapture'
import { rateFromSettings, type ElectricRate } from '@/lib/electric-billing'

// The walk itself. Everything it needs comes from one call to /api/meter-sessions/[id], including
// which meters have already been read — so closing the phone at meter 12 and reopening it later,
// or on a different device, resumes in the same place. Progress is in the database, not the tab.
export default function MeterWalkPage({ params }: { params: Promise<{ sessionId: string }> }) {
  const { sessionId } = use(params)
  const [state, setState] = useState<{
    session: { id: string; label: string; billing_month: string; read_date: string; status: string } | null
    meters: CaptureMeter[]
    rate: ElectricRate
    loading: boolean
    error: string
  }>({ session: null, meters: [], rate: rateFromSettings(null), loading: true, error: '' })

  useEffect(() => {
    let live = true
    fetch(`/api/meter-sessions/${sessionId}`)
      .then(r => r.json().then(d => ({ ok: r.ok, d })))
      .then(({ ok, d }) => {
        if (!live) return
        if (!ok) { setState(s => ({ ...s, loading: false, error: d.error || 'Could not load this walk.' })); return }
        setState({ session: d.session, meters: d.meters, rate: d.rate, loading: false, error: '' })
      })
      .catch(() => live && setState(s => ({ ...s, loading: false, error: 'Could not reach the server.' })))
    return () => { live = false }
  }, [sessionId])

  if (state.loading) return <div style={pad}>Loading the walk…</div>
  if (state.error || !state.session) {
    return (
      <div style={pad}>
        <p style={{ color: 'var(--danger)', fontWeight: 600 }}>{state.error || 'Walk not found.'}</p>
        <Link href="/admin/seasonals/meters" style={{ color: 'var(--link)', fontWeight: 600 }}>Back to meter readings</Link>
      </div>
    )
  }

  const readDate = new Date(state.session.read_date + 'T12:00:00')
    .toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })

  return (
    <MeterCapture
      meters={state.meters}
      sessionId={sessionId}
      rate={state.rate}
      title={state.session.label || state.session.billing_month}
      subtitle={`Bills to ${state.session.billing_month} · read ${readDate}`}
      exitHref="/admin/seasonals/meters"
    />
  )
}

const pad: React.CSSProperties = { padding: '3rem 1.5rem', textAlign: 'center', color: 'var(--muted)' }
