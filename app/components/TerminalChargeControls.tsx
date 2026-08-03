'use client'
import { useEffect, useState } from 'react'

/*
 * Live state of a terminal charge, plus the two ways out of a hang: Cancel and Retry.
 *
 * Before this, a charge sent to the terminal showed "waiting..." and nothing else. The status
 * poll had been returning 405 since terminal support was added, so the operator could not tell
 * a sleeping terminal from a card that would not read from a charge that had actually gone
 * through — and there was no way to clear a stuck charge without walking to the device. The
 * workaround that emerged was recording a payment by hand, which puts money in the books that
 * never moved. Making Cancel and Retry the obvious next step is the point of this component.
 */

type Props = {
  checkoutId: string | null
  /** Re-send the same amount to the terminal. Called after a successful cancel. */
  onRetry: () => void | Promise<void>
  /** Fired once Square reports the charge completed. */
  onCompleted?: () => void | Promise<void>
  /** Fired after the charge is cancelled, so the caller can drop out of "waiting". */
  onCanceled?: () => void
  compact?: boolean
}

const LABEL: Record<string, string> = {
  pending: 'Sent to terminal — waiting for the customer to tap',
  in_progress: 'Customer is paying on the terminal…',
  canceling: 'Cancelling…',
  canceled: 'Charge cancelled — nothing was taken',
  completed: 'Payment completed',
  failed: 'Terminal charge did not complete',
}

export default function TerminalChargeControls({
  checkoutId, onRetry, onCompleted, onCanceled, compact,
}: Props) {
  const [state, setState] = useState<string>('pending')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState<'' | 'cancel' | 'retry'>('')
  // Counted in polls rather than wall-clock so a backgrounded tab does not "time out" while
  // the customer is mid-tap.
  const [polls, setPolls] = useState(0)

  useEffect(() => {
    if (!checkoutId) return
    setState('pending'); setError(''); setPolls(0)
    let stop = false
    const id = setInterval(async () => {
      if (stop) return
      try {
        const r = await fetch('/api/terminal/charge?checkoutId=' + checkoutId)
        const d = await r.json()
        if (!r.ok) { setError(d.error || 'Could not read status'); return }
        setPolls(p => p + 1)
        setState(d.state)
        if (d.state === 'completed') { stop = true; clearInterval(id); await onCompleted?.() }
        if (d.state === 'canceled') { stop = true; clearInterval(id); onCanceled?.() }
      } catch {
        setError('Lost contact with the terminal service')
      }
    }, 2500)
    return () => { stop = true; clearInterval(id) }
  }, [checkoutId])

  async function cancel() {
    if (!checkoutId) return
    setBusy('cancel'); setError('')
    try {
      const r = await fetch('/api/terminal/cancel', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ checkoutId }),
      })
      const d = await r.json()
      if (!r.ok) { setError(d.error || 'Could not cancel'); setBusy(''); return }
      setState('canceled')
      onCanceled?.()
    } catch { setError('Could not reach the terminal service') }
    setBusy('')
  }

  // Retry is cancel-then-charge, never charge-on-top: leaving the old checkout open would let
  // a customer tap the stale one and pay twice.
  async function retry() {
    setBusy('retry'); setError('')
    if (checkoutId && state !== 'canceled') {
      try {
        const r = await fetch('/api/terminal/cancel', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ checkoutId }),
        })
        const d = await r.json()
        // A completed charge must not be retried — that would charge the customer twice.
        if (!r.ok && d.state === 'completed') {
          setState('completed'); setError(d.error); setBusy(''); return
        }
      } catch { /* fall through: the new charge is what matters */ }
    }
    await onRetry()
    setBusy('')
  }

  if (!checkoutId) return null

  const settled = state === 'completed' || state === 'canceled'
  const slow = !settled && polls >= 12 // ~30s without resolution

  return (
    <div style={{
      border: '1px solid #e5e7eb', borderRadius: 8, padding: compact ? '8px 10px' : '12px 14px',
      background: state === 'completed' ? '#f0fdf4' : state === 'canceled' ? '#f9fafb' : '#fffbeb',
      fontSize: 13,
    }}>
      <div style={{ fontWeight: 600, color: '#111827' }}>
        {LABEL[state] || 'Terminal charge'}
      </div>

      {slow && (
        <div style={{ color: '#92400e', marginTop: 4 }}>
          Taking longer than usual. If the terminal is asleep or the card will not read, cancel
          and retry — do not record the payment by hand.
        </div>
      )}

      {error && <div style={{ color: '#b91c1c', marginTop: 6 }}>{error}</div>}

      {!settled && (
        <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
          <button onClick={cancel} disabled={busy !== ''}
            style={{ padding: '6px 10px', borderRadius: 6, border: '1px solid #e5e7eb', background: '#fff', cursor: 'pointer', fontWeight: 600 }}>
            {busy === 'cancel' ? 'Cancelling…' : 'Cancel charge'}
          </button>
          <button onClick={retry} disabled={busy !== ''}
            style={{ padding: '6px 10px', borderRadius: 6, border: 'none', background: '#15803d', color: '#fff', cursor: 'pointer', fontWeight: 600 }}>
            {busy === 'retry' ? 'Retrying…' : 'Retry on terminal'}
          </button>
        </div>
      )}

      {state === 'canceled' && (
        <div style={{ marginTop: 10 }}>
          <button onClick={retry} disabled={busy !== ''}
            style={{ padding: '6px 10px', borderRadius: 6, border: 'none', background: '#15803d', color: '#fff', cursor: 'pointer', fontWeight: 600 }}>
            {busy === 'retry' ? 'Sending…' : 'Retry on terminal'}
          </button>
        </div>
      )}
    </div>
  )
}
