'use client'
import { useEffect, useState } from 'react'
import { createClient } from '@supabase/supabase-js'

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
)

export default function TerminalSettingsPage() {
  const [deviceId, setDeviceId] = useState('')
  const [deviceName, setDeviceName] = useState('')
  const [loading, setLoading] = useState(true)
  const [pairing, setPairing] = useState(false)
  const [pairCode, setPairCode] = useState('')
  const [pairExpiry, setPairExpiry] = useState('')
  const [deviceCodeId, setDeviceCodeId] = useState('')
  const [pairStatus, setPairStatus] = useState('')
  const [polling, setPolling] = useState(false)
  const [newDeviceName, setNewDeviceName] = useState('ResoNation Terminal')
  const [unpairing, setUnpairing] = useState(false)

  useEffect(() => { fetchSettings() }, [])

  async function fetchSettings() {
    setLoading(true)
    const { data } = await supabase.from('settings').select('square_terminal_device_id, square_terminal_name').single()
    if (data) {
      setDeviceId(data.square_terminal_device_id || '')
      setDeviceName(data.square_terminal_name || '')
    }
    setLoading(false)
  }

  async function generatePairCode() {
    setPairing(true)
    setPairStatus('')
    const res = await fetch('/api/terminal/pair', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deviceName: newDeviceName }),
    })
    const data = await res.json()
    if (data.success) {
      setPairCode(data.code)
      setDeviceCodeId(data.deviceCodeId)
      setPairExpiry(data.expiresAt ? new Date(data.expiresAt).toLocaleTimeString() : '')
      setPairStatus('waiting')
      startPolling(data.deviceCodeId)
    } else {
      setPairStatus('error: ' + (data.error || 'Failed to generate code'))
    }
    setPairing(false)
  }

  async function startPolling(codeId: string) {
    setPolling(true)
    let attempts = 0
    const maxAttempts = 60 // poll for up to 5 minutes
    const interval = setInterval(async () => {
      attempts++
      const res = await fetch('/api/terminal/pair?deviceCodeId=' + codeId)
      const data = await res.json()
      if (data.isPaired) {
        clearInterval(interval)
        setPolling(false)
        setPairStatus('paired')
        setPairCode('')
        setDeviceId(data.deviceId)
        setDeviceName(newDeviceName)
      } else if (attempts >= maxAttempts) {
        clearInterval(interval)
        setPolling(false)
        setPairStatus('timeout')
      }
    }, 5000) // check every 5 seconds
  }

  async function unpairDevice() {
    if (!confirm('Unpair this Terminal? You will need to pair it again to use it.')) return
    setUnpairing(true)
    await supabase.from('settings').update({
      square_terminal_device_id: '',
      square_terminal_name: '',
    }).neq('id', '00000000-0000-0000-0000-000000000000')
    setDeviceId('')
    setDeviceName('')
    setPairStatus('')
    setPairCode('')
    setUnpairing(false)
  }

  if (loading) return <div style={{ padding: '3rem', textAlign: 'center', color: '#6b7280' }}>Loading...</div>

  return (
    <div style={{ padding: '2rem', maxWidth: 600, margin: '0 auto', fontFamily: 'sans-serif' }}>
      <div style={{ marginBottom: '1.5rem' }}>
        <h1 style={{ fontSize: 24, fontWeight: 700, margin: 0 }}>Square Terminal</h1>
        <p style={{ color: '#6b7280', margin: '4px 0 0', fontSize: 14 }}>Pair your Square Terminal for card payments at the counter</p>
      </div>

      {/* Current status */}
      <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 12, padding: '1.5rem', marginBottom: 20 }}>
        <h3 style={{ margin: '0 0 1rem', fontSize: 15, fontWeight: 700 }}>Terminal Status</h3>
        {deviceId ? (
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 16 }}>
              <div style={{ width: 12, height: 12, borderRadius: '50%', background: '#15803d', flexShrink: 0 }} />
              <div>
                <div style={{ fontWeight: 600, fontSize: 15 }}>{deviceName || 'Square Terminal'}</div>
                <div style={{ fontSize: 12, color: '#6b7280', marginTop: 2 }}>Device ID: {deviceId}</div>
              </div>
            </div>
            <div style={{ background: '#f0fdf4', border: '1px solid #bbf7d0', borderRadius: 8, padding: '12px 16px', marginBottom: 16 }}>
              <p style={{ margin: 0, fontSize: 14, color: '#15803d', fontWeight: 600 }}>✓ Terminal is paired and ready</p>
              <p style={{ margin: '4px 0 0', fontSize: 13, color: '#6b7280' }}>Card charges from folios will be sent to this Terminal automatically.</p>
            </div>
            <button
              onClick={unpairDevice}
              disabled={unpairing}
              style={{ background: 'none', border: '1px solid #fca5a5', borderRadius: 8, padding: '8px 18px', fontSize: 13, color: '#dc2626', cursor: 'pointer', fontWeight: 600 }}
            >
              {unpairing ? 'Unpairing...' : 'Unpair Terminal'}
            </button>
          </div>
        ) : (
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <div style={{ width: 12, height: 12, borderRadius: '50%', background: '#d1d5db', flexShrink: 0 }} />
            <span style={{ fontSize: 14, color: '#6b7280' }}>No Terminal paired</span>
          </div>
        )}
      </div>

      {/* Pair new terminal */}
      {!deviceId && (
        <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 12, padding: '1.5rem', marginBottom: 20 }}>
          <h3 style={{ margin: '0 0 1rem', fontSize: 15, fontWeight: 700 }}>Pair a New Terminal</h3>

          {!pairCode ? (
            <div>
              <label style={lbl}>Device name</label>
              <input style={inp} value={newDeviceName} onChange={e => setNewDeviceName(e.target.value)} placeholder='e.g. Front Desk Terminal' />
              <p style={{ fontSize: 13, color: '#6b7280', margin: '8px 0 16px' }}>
                Make sure your Square Terminal is powered on and showing the pairing screen.
              </p>
              <button
                onClick={generatePairCode}
                disabled={pairing}
                style={{ background: '#2E6B8A', color: '#fff', border: 'none', borderRadius: 8, padding: '11px 24px', fontWeight: 700, fontSize: 15, cursor: 'pointer' }}
              >
                {pairing ? 'Generating code...' : 'Generate Pairing Code'}
              </button>
              {pairStatus.startsWith('error') && (
                <p style={{ color: '#dc2626', fontSize: 13, marginTop: 8 }}>{pairStatus}</p>
              )}
            </div>
          ) : pairStatus === 'paired' ? (
            <div style={{ background: '#f0fdf4', border: '1px solid #bbf7d0', borderRadius: 8, padding: '1.5rem', textAlign: 'center' }}>
              <div style={{ fontSize: 48, marginBottom: 8 }}>🎉</div>
              <h3 style={{ color: '#15803d', margin: '0 0 8px' }}>Terminal Paired Successfully!</h3>
              <p style={{ color: '#6b7280', fontSize: 14, margin: 0 }}>Your Square Terminal is ready to accept card payments.</p>
            </div>
          ) : pairStatus === 'timeout' ? (
            <div>
              <p style={{ color: '#dc2626', fontSize: 14 }}>Pairing timed out. Please try again.</p>
              <button onClick={() => { setPairCode(''); setPairStatus('') }} style={{ background: '#2E6B8A', color: '#fff', border: 'none', borderRadius: 8, padding: '9px 18px', fontWeight: 600, fontSize: 14, cursor: 'pointer' }}>Try Again</button>
            </div>
          ) : (
            <div style={{ textAlign: 'center' }}>
              <p style={{ fontSize: 14, color: '#6b7280', marginBottom: 8 }}>Enter this code on your Square Terminal:</p>
              <div style={{ fontSize: 56, fontWeight: 900, letterSpacing: 8, color: '#2E6B8A', fontFamily: 'monospace', margin: '16px 0' }}>{pairCode}</div>
              {pairExpiry && <p style={{ fontSize: 12, color: '#9ca3af', marginBottom: 16 }}>Expires at {pairExpiry}</p>}
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8 }}>
                <div style={{ width: 10, height: 10, borderRadius: '50%', background: '#2E6B8A', animation: 'pulse 1.5s infinite' }} />
                <span style={{ fontSize: 14, color: '#6b7280' }}>Waiting for Terminal to confirm pairing...</span>
              </div>
              <style>{`@keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.3; } }`}</style>
            </div>
          )}
        </div>
      )}

      {/* Instructions */}
      <div style={{ background: '#f8fafc', border: '1px solid #e5e7eb', borderRadius: 12, padding: '1.5rem' }}>
        <h3 style={{ margin: '0 0 1rem', fontSize: 15, fontWeight: 700 }}>How to pair your Terminal</h3>
        <ol style={{ margin: 0, paddingLeft: 20, fontSize: 14, color: '#374151', lineHeight: 2 }}>
          <li>Power on your Square Terminal</li>
          <li>On the Terminal, tap <strong>Sign In</strong> → <strong>Use a device code</strong></li>
          <li>Click <strong>Generate Pairing Code</strong> above</li>
          <li>Enter the code shown on your iPad into the Terminal</li>
          <li>The Terminal will confirm pairing automatically</li>
          <li>You're ready to accept card payments! 🎉</li>
        </ol>
      </div>
    </div>
  )
}

const lbl: React.CSSProperties = { display: 'block', fontSize: 13, fontWeight: 600, color: '#374151', marginBottom: 4, marginTop: 8 }
const inp: React.CSSProperties = { width: '100%', border: '1px solid #d1d5db', borderRadius: 7, padding: '8px 10px', fontSize: 14, boxSizing: 'border-box' }