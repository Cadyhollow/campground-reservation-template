'use client'
import { useEffect, useState } from 'react'
import { createClient } from '@supabase/supabase-js'

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
)

type Guest = {
  id: string
  name: string
  email: string
  phone: string
  site_number: string
  is_seasonal: boolean
}

type CamperRow = {
  guest: Guest
  folioId: string
  folioBalance: number
  recentCharges: { description: string; line_total: number; charged_at: string }[]
  previousReading: string
  currentReading: string
  kwhUsed: number
  calculatedAmount: number
  finalAmount: string
  skip: boolean
  sent: boolean
  sending: boolean
  error: string
}

export default function ElectricBillingPage() {
  const [campers, setCampers] = useState<CamperRow[]>([])
  const [loading, setLoading] = useState(true)
  const [ratePerKwh, setRatePerKwh] = useState('0.27')
  const [minimumCharge, setMinimumCharge] = useState('15.00')
  const [billingMonth, setBillingMonth] = useState(() => {
    const now = new Date()
    return now.toLocaleString('default', { month: 'long' }) + ' ' + now.getFullYear()
  })
  const [emailMessage, setEmailMessage] = useState('Please find your monthly electric statement below. If you have any questions, please don\'t hesitate to reach out.')
  const [sendingAll, setSendingAll] = useState(false)

  useEffect(() => { fetchCampers(); fetchMessage() }, [])

  async function fetchMessage() {
    const { data } = await supabase.from('settings').select('electric_bill_message').single()
    if (data?.electric_bill_message) setEmailMessage(data.electric_bill_message)
  }

  async function saveMessage() {
    await supabase.from('settings').update({ electric_bill_message: emailMessage }).eq('id', (await supabase.from('settings').select('id').single()).data?.id)
    alert('Message saved!')
  }

  async function fetchCampers() {
    setLoading(true)
    const { data: guests } = await supabase
      .from('guests')
      .select('*')
      .eq('is_seasonal', true)

    const sortedGuests = (guests || []).sort((a, b) => parseInt(a.site_number) - parseInt(b.site_number))
    if (sortedGuests.length === 0) { setLoading(false); return }

    const rows: CamperRow[] = await Promise.all(sortedGuests.map(async (guest: Guest) => {
      const { data: folio } = await supabase
        .from('folios')
        .select('id')
        .eq('guest_id', guest.id)
        .eq('folio_type', 'guest_account')
        .eq('status', 'open')
        .single()

      let folioBalance = 0
      let recentCharges: any[] = []

      if (folio) {
        const [{ data: items }, { data: pmts }] = await Promise.all([
          supabase.from('folio_line_items').select('*').eq('folio_id', folio.id).order('charged_at'),
          supabase.from('folio_payments').select('*').eq('folio_id', folio.id).eq('status', 'completed'),
        ])
        const itemsTotal = (items || []).reduce((sum: number, i: any) => sum + i.line_total, 0)
        const paymentsTotal = (pmts || []).reduce((sum: number, p: any) => sum + p.amount - (p.surcharge_amount || 0), 0)
        folioBalance = Math.max(0, itemsTotal - paymentsTotal)
        recentCharges = items || []
      }

      return {
        guest,
        folioId: folio?.id || '',
        folioBalance,
        recentCharges,
        previousReading: '',
        currentReading: '',
        kwhUsed: 0,
        calculatedAmount: 0,
        finalAmount: '',
        skip: false,
        sent: false,
        sending: false,
        error: '',
      }
    }))

    setCampers(rows)
    setLoading(false)
  }

  function updateReading(index: number, field: 'previousReading' | 'currentReading', value: string) {
    setCampers(prev => {
      const updated = [...prev]
      updated[index] = { ...updated[index], [field]: value }
      const prev_r = parseFloat(field === 'previousReading' ? value : updated[index].previousReading) || 0
      const curr_r = parseFloat(field === 'currentReading' ? value : updated[index].currentReading) || 0
      const kwh = Math.max(0, curr_r - prev_r)
      const rate = parseFloat(ratePerKwh) || 0.27
      const minCharge = Math.round((parseFloat(minimumCharge) || 15) * 100)
      const calculated = Math.max(minCharge, Math.round(kwh * rate * 100))
      updated[index].kwhUsed = kwh
      updated[index].calculatedAmount = calculated
      if (updated[index].finalAmount === '' || updated[index].finalAmount === (updated[index].calculatedAmount / 100).toFixed(2)) {
        updated[index].finalAmount = (calculated / 100).toFixed(2)
      }
      return updated
    })
  }

  function updateFinalAmount(index: number, value: string) {
    setCampers(prev => {
      const updated = [...prev]
      updated[index] = { ...updated[index], finalAmount: value }
      return updated
    })
  }

  function toggleSkip(index: number) {
    setCampers(prev => {
      const updated = [...prev]
      updated[index] = { ...updated[index], skip: !updated[index].skip }
      return updated
    })
  }

  async function sendBill(index: number) {
    const row = campers[index]
    if (row.skip || row.sent) return
    if (!row.guest.email) {
      setCampers(prev => { const u = [...prev]; u[index] = { ...u[index], error: 'No email on file' }; return u })
      return
    }
    const finalAmountCents = Math.round(parseFloat(row.finalAmount) * 100) || row.calculatedAmount
    if (!finalAmountCents) {
      setCampers(prev => { const u = [...prev]; u[index] = { ...u[index], error: 'Enter meter readings first' }; return u })
      return
    }

    setCampers(prev => { const u = [...prev]; u[index] = { ...u[index], sending: true, error: '' }; return u })

    // Add electric charge to folio
    let folioId = row.folioId
    if (!folioId) {
      const { data: newFolio } = await supabase.from('folios').insert({
        guest_id: row.guest.id,
        guest_name: row.guest.name,
        guest_email: row.guest.email,
        folio_type: 'guest_account',
        status: 'open',
        label: 'Seasonal Account',
      }).select().single()
      if (newFolio) folioId = newFolio.id
    }

    const { data: lineItem } = await supabase.from('folio_line_items').insert({
      folio_id: folioId,
      product_id: null,
      description: billingMonth + ' Electric',
      quantity: 1,
      unit_price: finalAmountCents,
      tax_amount: 0,
      line_total: finalAmountCents,
      category: 'Fees',
    }).select().single()

    // Save meter reading record
    await supabase.from('electric_readings').insert({
      guest_id: row.guest.id,
      billing_month: billingMonth,
      previous_reading: parseFloat(row.previousReading) || 0,
      current_reading: parseFloat(row.currentReading) || 0,
      kwh_used: row.kwhUsed,
      rate_per_kwh: parseFloat(ratePerKwh) || 0.27,
      minimum_charge: Math.round((parseFloat(minimumCharge) || 15) * 100),
      calculated_amount: row.calculatedAmount,
      final_amount: finalAmountCents,
      folio_line_item_id: lineItem?.id || null,
    })

    // Reload folio data for email
    const { data: allItems } = await supabase.from('folio_line_items').select('*').eq('folio_id', folioId).order('charged_at')
    const { data: allPayments } = await supabase.from('folio_payments').select('*').eq('folio_id', folioId).eq('status', 'completed')
    const itemsTotal = (allItems || []).reduce((sum: number, i: any) => sum + i.line_total, 0)
    const paymentsTotal = (allPayments || []).reduce((sum: number, p: any) => sum + p.amount - (p.surcharge_amount || 0), 0)
    const newBalance = Math.max(0, itemsTotal - paymentsTotal)

    // Send email
    const res = await fetch('/api/electric-bill-email', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        guestName: row.guest.name,
        guestEmail: row.guest.email,
        siteNumber: row.guest.site_number,
        billingMonth,
        emailMessage,
        electricAmount: finalAmountCents,
        lineItems: allItems || [],
        totalBalance: newBalance,
      }),
    })

    const data = await res.json()
    setCampers(prev => {
      const u = [...prev]
      u[index] = { ...u[index], sending: false, sent: data.success, error: data.success ? '' : (data.error || 'Failed to send') }
      return u
    })
  }

  async function sendAllBills() {
    setSendingAll(true)
    for (let i = 0; i < campers.length; i++) {
      if (!campers[i].skip && !campers[i].sent) {
        await sendBill(i)
      }
    }
    setSendingAll(false)
  }

  const readyToSend = campers.filter(c => !c.skip && !c.sent && c.finalAmount).length

  if (loading) return <div style={{ padding: '3rem', textAlign: 'center', color: '#6b7280' }}>Loading seasonal campers...</div>

  return (
    <div style={{ padding: '2rem', maxWidth: 1100, margin: '0 auto', fontFamily: 'sans-serif' }}>
      <div style={{ marginBottom: '1.5rem' }}>
        <h1 style={{ fontSize: 24, fontWeight: 700, margin: 0 }}>Electric Billing</h1>
        <p style={{ color: '#6b7280', margin: '4px 0 0', fontSize: 14 }}>Generate and send monthly electric bills to seasonal campers</p>
      </div>

      {/* Settings */}
      <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 12, padding: '1.5rem', marginBottom: 20 }}>
        <h3 style={{ margin: '0 0 1rem', fontSize: 15, fontWeight: 700 }}>Billing Settings</h3>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 16, marginBottom: 16 }}>
          <div>
            <label style={lbl}>Billing month</label>
            <input style={inp} value={billingMonth} onChange={e => setBillingMonth(e.target.value)} placeholder='e.g. May 2026' />
          </div>
          <div>
            <label style={lbl}>Rate per kWh ($)</label>
            <input style={inp} type='number' step='0.01' value={ratePerKwh} onChange={e => setRatePerKwh(e.target.value)} />
          </div>
          <div>
            <label style={lbl}>Minimum charge ($)</label>
            <input style={inp} type='number' step='0.01' value={minimumCharge} onChange={e => setMinimumCharge(e.target.value)} />
          </div>
        </div>
        <div>
          <label style={lbl}>Custom email message</label>
          <textarea style={{ ...inp, height: 80, resize: 'vertical' }} value={emailMessage} onChange={e => setEmailMessage(e.target.value)} />
          <button onClick={saveMessage} style={{ marginTop: 8, background: '#2E6B8A', color: '#fff', border: 'none', borderRadius: 7, padding: '7px 18px', fontSize: 13, fontWeight: 600, cursor: 'pointer' }}>Save Message</button>
        </div>
      </div>

      {/* Camper rows */}
      {campers.length === 0 ? (
        <div style={{ textAlign: 'center', color: '#9ca3af', padding: '3rem 0' }}>No seasonal campers found. Add them in the Guest Directory first.</div>
      ) : (
        <>
          <div style={{ overflowX: 'auto', marginBottom: 20 }}>
          <div style={{ border: '1px solid #e5e7eb', borderRadius: 12, overflow: 'hidden', background: '#fff', minWidth: 900 }}>
            {/* Header */}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 70px 100px 100px 60px 90px 100px 100px 70px', gap: 6, padding: '10px 12px', background: '#f9fafb', borderBottom: '1px solid #e5e7eb', fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', color: '#6b7280' }}>
              <div>Guest</div>
              <div>Site</div>
              <div>Prev reading</div>
              <div>Curr reading</div>
              <div>kWh</div>
              <div>Calculated</div>
              <div>Final amount</div>
              <div>Balance due</div>
              <div>Skip</div>
            </div>

            {campers.map((row, i) => (
              <div key={row.guest.id} style={{ borderBottom: i < campers.length - 1 ? '1px solid #f3f4f6' : 'none', background: row.skip ? '#f9fafb' : row.sent ? '#f0fdf4' : '#fff' }}>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 70px 100px 100px 60px 90px 100px 100px 70px', gap: 6, padding: '10px 12px', alignItems: 'center' }}>
                  <div>
                    <div style={{ fontWeight: 600, fontSize: 13, color: row.skip ? '#9ca3af' : '#111827' }}>{row.guest.name}</div>
                    <div style={{ fontSize: 11, color: '#9ca3af' }}>{row.guest.email || 'No email'}</div>
                  </div>
                  <div style={{ fontSize: 13, fontWeight: 600, color: '#6b7280' }}>Site {row.guest.site_number}</div>
                  <input
                    style={{ ...si, opacity: row.skip ? 0.4 : 1 }}
                    type='number'
                    placeholder='0'
                    value={row.previousReading}
                    disabled={row.skip || row.sent}
                    onChange={e => updateReading(i, 'previousReading', e.target.value)}
                  />
                  <input
                    style={{ ...si, opacity: row.skip ? 0.4 : 1 }}
                    type='number'
                    placeholder='0'
                    value={row.currentReading}
                    disabled={row.skip || row.sent}
                    onChange={e => updateReading(i, 'currentReading', e.target.value)}
                  />
                  <div style={{ fontSize: 13, fontWeight: 600, color: '#374151' }}>{row.kwhUsed > 0 ? row.kwhUsed.toFixed(1) : '—'}</div>
                  <div style={{ fontSize: 13, color: '#6b7280' }}>{row.calculatedAmount > 0 ? '$' + (row.calculatedAmount/100).toFixed(2) : '—'}</div>
                  <div style={{ position: 'relative' }}>
                    <span style={{ position: 'absolute', left: 8, top: '50%', transform: 'translateY(-50%)', color: '#6b7280', fontSize: 13 }}>$</span>
                    <input
                      style={{ ...si, paddingLeft: 20, opacity: row.skip ? 0.4 : 1 }}
                      type='number'
                      step='0.01'
                      placeholder='0.00'
                      value={row.finalAmount}
                      disabled={row.skip || row.sent}
                      onChange={e => updateFinalAmount(i, e.target.value)}
                    />
                  </div>
                  <div style={{ fontSize: 13, fontWeight: 700, color: row.folioBalance > 0 ? '#dc2626' : '#15803d' }}>
                    {row.folioBalance > 0 ? '$' + (row.folioBalance/100).toFixed(2) + ' due' : '✓ Current'}
                  </div>
                  <button
                    onClick={() => toggleSkip(i)}
                    disabled={row.sent}
                    style={{ fontSize: 11, fontWeight: 600, border: '1px solid', borderColor: row.skip ? '#d1d5db' : '#fca5a5', borderRadius: 6, padding: '4px 8px', cursor: 'pointer', background: row.skip ? '#f3f4f6' : '#fef2f2', color: row.skip ? '#6b7280' : '#dc2626' }}
                  >
                    {row.skip ? 'Skipped' : 'Skip'}
                  </button>
                </div>
                {/* Send row */}
                {!row.skip && (
                  <div style={{ padding: '0 16px 12px', display: 'flex', alignItems: 'center', gap: 12 }}>
                    <button
                      onClick={() => sendBill(i)}
                      disabled={row.sending || row.sent || !row.finalAmount}
                      style={{ background: row.sent ? '#15803d' : '#2E6B8A', color: '#fff', border: 'none', borderRadius: 7, padding: '7px 18px', fontSize: 13, fontWeight: 600, cursor: row.sent || !row.finalAmount ? 'default' : 'pointer', opacity: !row.finalAmount ? 0.5 : 1 }}
                    >
                      {row.sending ? 'Sending...' : row.sent ? '✓ Sent!' : '✉ Send Bill'}
                    </button>
                    {row.error && <span style={{ fontSize: 12, color: '#dc2626' }}>{row.error}</span>}
                    {!row.guest.email && <span style={{ fontSize: 12, color: '#9ca3af' }}>No email on file</span>}
                  </div>
                )}
              </div>
            ))}
          </div>
          </div>

          {/* Send all button */}
          <div style={{ display: 'flex', justifyContent: 'flex-end', alignItems: 'center', gap: 16 }}>
            <span style={{ fontSize: 14, color: '#6b7280' }}>{readyToSend} bill{readyToSend !== 1 ? 's' : ''} ready to send</span>
            <button
              onClick={sendAllBills}
              disabled={sendingAll || readyToSend === 0}
              style={{ background: readyToSend > 0 ? '#2E6B8A' : '#d1d5db', color: '#fff', border: 'none', borderRadius: 8, padding: '11px 28px', fontWeight: 700, fontSize: 15, cursor: readyToSend > 0 ? 'pointer' : 'default' }}
            >
              {sendingAll ? 'Sending all...' : 'Send All Bills'}
            </button>
          </div>
        </>
      )}
    </div>
  )
}

const lbl: React.CSSProperties = { display: 'block', fontSize: 13, fontWeight: 600, color: '#374151', marginBottom: 4, marginTop: 8 }
const inp: React.CSSProperties = { width: '100%', border: '1px solid #d1d5db', borderRadius: 7, padding: '8px 10px', fontSize: 14, boxSizing: 'border-box' }
const si: React.CSSProperties = { width: '100%', border: '1px solid #d1d5db', borderRadius: 6, padding: '6px 8px', fontSize: 13, boxSizing: 'border-box' }