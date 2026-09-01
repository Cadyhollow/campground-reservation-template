'use client'
import { use, useEffect, useState } from 'react'
import Link from 'next/link'
import MeterCapture, { type CaptureMeter } from '../../MeterCapture'
import { rateFromSettings, type ElectricRate } from '@/lib/electric-billing'

// ONE METER, ON A GIVEN DAY — the move-out read.
//
// A camper leaves on the 14th and their meter has to be read that day, outside any walk. This is
// the same capture screen with a queue of one, and it saves a reading with session_id NULL.
//
// ⚠ IT CARRIES FORWARD LIKE ANY OTHER READING. The next reading of this meter — the month-end
// walk included — takes ITS value as the previous, because "previous" is the last reading, not
// the last bill. That is what stops the fortnight from the 14th to the 30th being billed twice.
//
// It stages no draft on its own: a draft belongs to a walk and its billing month. The reading is
// permanent and visible, and the owner bills it from the Electric Billing page — where a
// mid-month final bill has to be reviewed anyway.
export default function SingleMeterReadPage({ params }: { params: Promise<{ meterId: string }> }) {
  const { meterId } = use(params)
  const [state, setState] = useState<{ meter: CaptureMeter | null; rate: ElectricRate; loading: boolean; error: string }>(
    { meter: null, rate: rateFromSettings(null), loading: true, error: '' }
  )

  useEffect(() => {
    let live = true
    fetch('/api/meters')
      .then(r => r.json().then(d => ({ ok: r.ok, d })))
      .then(({ ok, d }) => {
        if (!live) return
        if (!ok) { setState(s => ({ ...s, loading: false, error: d.error || 'Could not load the meters.' })); return }
        const found = (d.meters as CaptureMeter[]).find(m => m.meter.id === meterId) || null
        setState({ meter: found, rate: d.rate, loading: false, error: found ? '' : 'That meter was not found, or has been retired.' })
      })
      .catch(() => live && setState(s => ({ ...s, loading: false, error: 'Could not reach the server.' })))
    return () => { live = false }
  }, [meterId])

  if (state.loading) return <div style={pad}>Loading the meter…</div>
  if (state.error || !state.meter) {
    return (
      <div style={pad}>
        <p style={{ color: 'var(--danger)', fontWeight: 600 }}>{state.error || 'Meter not found.'}</p>
        <Link href="/admin/seasonals/meters" style={{ color: 'var(--link)', fontWeight: 600 }}>Back to meter readings</Link>
      </div>
    )
  }

  return (
    <MeterCapture
      meters={[state.meter]}
      sessionId={null}
      rate={state.rate}
      title={`Single read · meter ${state.meter.meter.meter_number}`}
      subtitle="Saved with today's date · carries forward to the next reading"
      exitHref="/admin/seasonals/meters"
    />
  )
}

const pad: React.CSSProperties = { padding: '3rem 1.5rem', textAlign: 'center', color: 'var(--muted)' }
