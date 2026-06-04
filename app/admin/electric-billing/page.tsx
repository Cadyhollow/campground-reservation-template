'use client'
import { useRouter } from 'next/navigation'
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

type ElectricReading = {
  id: string
  billing_month: string
  previous_reading: number
  current_reading: number
  kwh_used: number
  rate_per_kwh: number
  final_amount: number
  created_at: string
  notes: string
}

type FolioPayment = {
  id: string
  amount: number
  surcharge_amount: number
  method: string
  paid_at: string
  note: string
  receipt_sent_at: string | null
}

type CamperRow = {
  guest: Guest
  folioId: string
  folioBalance: number
  recentCharges: { id: string; description: string; line_total: number; charged_at: string }[]
  folioPayments: FolioPayment[]
  previousReading: string
  currentReading: string
  kwhUsed: number
  calculatedAmount: number
  finalAmount: string
  skip: boolean
  sent: boolean
  sending: boolean
  error: string
  showHistory: boolean
  showPayment: boolean
  paymentAmount: string
  paymentMethod: string
  paymentNote: string
  savingPayment: boolean
  lastPaymentRecorded: FolioPayment | null
  showReceiptConfirm: boolean
  sendingReceipt: boolean
  receiptSent: boolean
  readings: ElectricReading[]
  historyLoaded: boolean
  editEmailMode: boolean
  editEmailValue: string
  showBillConfirm: boolean
}

function generateMonthOptions(): string[] {
  const months = ['January','February','March','April','May','June','July','August','September','October','November','December']
  const now = new Date()
  const currentYear = now.getFullYear()
  const options: string[] = []
  for (const year of [currentYear, currentYear + 1]) {
    for (const month of months) {
      options.push(`${month} ${year}`)
    }
  }
  return options
}

function getCurrentMonthOption(): string {
  const now = new Date()
  return now.toLocaleString('default', { month: 'long' }) + ' ' + now.getFullYear()
}

function parseMonthValue(s: string): number {
  const months = ['January','February','March','April','May','June','July','August','September','October','November','December']
  const p = s.split(' ')
  return p.length === 2 ? parseInt(p[1]) * 12 + months.indexOf(p[0]) : 0
}

export default function ElectricBillingPage() {
  const router = useRouter()

  useEffect(() => {
    supabase.from('settings').select('plan, pos_enabled, seasonal_enabled').single().then(({ data }) => {
      if (data?.plan !== 'summit' || !data?.seasonal_enabled) router.replace('/admin')
    })
  }, [])

  const [campers, setCampers] = useState<CamperRow[]>([])
  const [loading, setLoading] = useState(true)
  const [ratePerKwh, setRatePerKwh] = useState('0.27')
  const [minimumCharge, setMinimumCharge] = useState('15.00')
  const [activeTab, setActiveTab] = useState<'billing' | 'history'>('billing')
  const [billingMonth, setBillingMonth] = useState(getCurrentMonthOption)
  const [emailMessage, setEmailMessage] = useState("Please find your monthly electric statement below. If you have any questions, please don't hesitate to reach out.")
  const [sendingAll, setSendingAll] = useState(false)
  const [autoPopulating, setAutoPopulating] = useState(false)

  const monthOptions = generateMonthOptions()

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
    const { data: guests } = await supabase.from('guests').select('*').eq('is_seasonal', true)
    const sortedGuests = (guests || []).sort((a, b) => parseInt(a.site_number) - parseInt(b.site_number))
    if (sortedGuests.length === 0) { setLoading(false); return }

    const rows: CamperRow[] = await Promise.all(sortedGuests.map(async (guest: Guest) => {
      const { data: folio } = await supabase
        .from('folios').select('id').eq('guest_id', guest.id)
        .eq('folio_type', 'guest_account').eq('status', 'open').single()

      let folioBalance = 0
      let recentCharges: any[] = []
      let folioPayments: FolioPayment[] = []

      if (folio) {
        const [{ data: items }, { data: pmts }] = await Promise.all([
          supabase.from('folio_line_items').select('*').eq('folio_id', folio.id).order('charged_at'),
          supabase.from('folio_payments').select('*').eq('folio_id', folio.id).eq('status', 'completed').order('paid_at', { ascending: false }),
        ])
        const itemsTotal = (items || []).reduce((sum: number, i: any) => sum + i.line_total, 0)
        const paymentsTotal = (pmts || []).reduce((sum: number, p: any) => sum + p.amount - (p.surcharge_amount || 0), 0)
        folioBalance = itemsTotal - paymentsTotal
        recentCharges = items || []
        folioPayments = pmts || []
      }

      // Check if the most recent payment has a receipt sent
      const mostRecentPayment = folioPayments.length > 0 ? folioPayments[0] : null
      const receiptAlreadySent = mostRecentPayment?.receipt_sent_at ? true : false

      return {
        guest, folioId: folio?.id || '', folioBalance, recentCharges, folioPayments,
        previousReading: '', currentReading: '', kwhUsed: 0, calculatedAmount: 0, finalAmount: '',
        skip: false, sent: false, sending: false, error: '',
        showHistory: false, showPayment: false, paymentAmount: '', paymentMethod: 'cash', paymentNote: '', savingPayment: false, editEmailMode: false, editEmailValue: '', showBillConfirm: false,
        lastPaymentRecorded: mostRecentPayment, showReceiptConfirm: false, sendingReceipt: false, receiptSent: receiptAlreadySent,
        readings: [], historyLoaded: false,
      }
    }))

    // Auto-populate previous readings for the current billing month
    const currentMonth = billingMonth
    const selectedVal = parseMonthValue(currentMonth)
    const populatedRows = await Promise.all(rows.map(async (row) => {
      const { data: readings } = await supabase
        .from('electric_readings')
        .select('billing_month, previous_reading, current_reading, created_at')
        .eq('guest_id', row.guest.id)
        .order('created_at', { ascending: false })
      if (!readings || readings.length === 0) return row
      const thisMonthReading = readings.find(r => r.billing_month === currentMonth)
      if (thisMonthReading) {
        return { ...row, previousReading: String(thisMonthReading.previous_reading), currentReading: String(thisMonthReading.current_reading), sent: true }
      }
      const priorReadings = readings.filter(r => parseMonthValue(r.billing_month) < selectedVal)
      if (priorReadings.length === 0) return row
      return { ...row, previousReading: String(priorReadings[0].current_reading) }
    }))

    setCampers(populatedRows)
    setLoading(false)
  }

 async function handleMonthChange(newMonth: string) {
    setBillingMonth(newMonth)
    if (campers.length === 0) return
    setAutoPopulating(true)
    const selectedVal = parseMonthValue(newMonth)

    const updatedCampers = await Promise.all(campers.map(async (row) => {
      const { data: readings } = await supabase
        .from('electric_readings')
        .select('billing_month, previous_reading, current_reading, created_at')
        .eq('guest_id', row.guest.id)
        .order('created_at', { ascending: false })

      if (!readings || readings.length === 0) return row

      // If this month already has a recorded reading, show that exact data
      const thisMonthReading = readings.find(r => r.billing_month === newMonth)
      if (thisMonthReading) {
        return {
          ...row,
          previousReading: String(thisMonthReading.previous_reading),
          currentReading: String(thisMonthReading.current_reading),
          sent: true,
        }
      }

      // Otherwise find the most recent reading before this month and pre-fill prev reading
      const priorReadings = readings.filter(r => parseMonthValue(r.billing_month) < selectedVal)
      if (priorReadings.length === 0) return row
      return {
        ...row,
        previousReading: String(priorReadings[0].current_reading),
        currentReading: '',
        kwhUsed: 0,
        calculatedAmount: 0,
        finalAmount: '',
        sent: false,
      }
    }))

    setCampers(updatedCampers)
    setAutoPopulating(false)
  }

  async function loadHistory(index: number) {
    const row = campers[index]
    if (row.historyLoaded) {
      setCampers(prev => { const u = [...prev]; u[index] = { ...u[index], showHistory: !u[index].showHistory }; return u })
      return
    }
    const { data } = await supabase.from('electric_readings').select('*').eq('guest_id', row.guest.id).order('created_at', { ascending: false })
    setCampers(prev => { const u = [...prev]; u[index] = { ...u[index], readings: data || [], historyLoaded: true, showHistory: true }; return u })
  }

  async function recordPayment(index: number) {
    const row = campers[index]
    if (!row.folioId || !row.paymentAmount) return
    setCampers(prev => { const u = [...prev]; u[index] = { ...u[index], savingPayment: true }; return u })

    const amountCents = Math.round(parseFloat(row.paymentAmount) * 100)
    const { data: newPayment } = await supabase.from('folio_payments').insert({
      folio_id: row.folioId, method: row.paymentMethod, amount: amountCents,
      surcharge_amount: 0, status: 'completed', note: row.paymentNote || null,
    }).select().single()

    const [{ data: items }, { data: pmts }] = await Promise.all([
      supabase.from('folio_line_items').select('*').eq('folio_id', row.folioId),
      supabase.from('folio_payments').select('*').eq('folio_id', row.folioId).eq('status', 'completed'),
    ])
    const itemsTotal = (items || []).reduce((sum: number, i: any) => sum + i.line_total, 0)
    const paymentsTotal = (pmts || []).reduce((sum: number, p: any) => sum + p.amount - (p.surcharge_amount || 0), 0)
    const newBalance = Math.max(0, itemsTotal - paymentsTotal)

    setCampers(prev => {
      const u = [...prev]
      u[index] = { ...u[index], folioBalance: newBalance, folioPayments: pmts || [], savingPayment: false, showPayment: false, paymentAmount: '', paymentNote: '', lastPaymentRecorded: newPayment || null, showReceiptConfirm: false, receiptSent: false }
      return u
    })
  }

  async function sendReceipt(index: number) {
    const row = campers[index]
    if (!row.lastPaymentRecorded || !row.guest.email) return
    setCampers(prev => { const u = [...prev]; u[index] = { ...u[index], sendingReceipt: true }; return u })

    const res = await fetch('/api/electric-payment-receipt', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        guestName: row.guest.name, guestEmail: row.guest.email, siteNumber: row.guest.site_number,
        paymentAmount: row.lastPaymentRecorded.amount, paymentMethod: row.lastPaymentRecorded.method,
        paymentNote: row.lastPaymentRecorded.note, paidAt: row.lastPaymentRecorded.paid_at,
        remainingBalance: row.folioBalance, paymentId: row.lastPaymentRecorded.id,
      }),
    })
    const data = await res.json()
    if (data.success) {
      // Update the payment in local state with the receipt timestamp
      const now = new Date().toISOString()
      setCampers(prev => {
        const u = [...prev]
        u[index] = {
          ...u[index],
          sendingReceipt: false,
          receiptSent: true,
          showReceiptConfirm: false,
          lastPaymentRecorded: u[index].lastPaymentRecorded
            ? { ...u[index].lastPaymentRecorded, receipt_sent_at: now }
            : null,
          folioPayments: u[index].folioPayments.map(p =>
            p.id === u[index].lastPaymentRecorded?.id ? { ...p, receipt_sent_at: now } : p
          ),
        }
        return u
      })
    } else {
      setCampers(prev => { const u = [...prev]; u[index] = { ...u[index], sendingReceipt: false, showReceiptConfirm: false }; return u })
    }
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
    setCampers(prev => { const u = [...prev]; u[index] = { ...u[index], finalAmount: value }; return u })
  }

  function toggleSkip(index: number) {
    setCampers(prev => { const u = [...prev]; u[index] = { ...u[index], skip: !u[index].skip }; return u })
  }

  function updatePaymentField(index: number, field: string, value: string) {
    setCampers(prev => { const u = [...prev]; u[index] = { ...u[index], [field]: value }; return u })
  }

  async function resendBill(index: number, overrideEmail?: string) {
    const row = campers[index]
    const emailToUse = overrideEmail || row.guest.email
    if (!emailToUse) return
    setCampers(prev => { const u = [...prev]; u[index] = { ...u[index], sending: true, error: '', editEmailMode: false }; return u })

    // Just re-send the email — don't touch the database
    const { data: allItems } = await supabase.from('folio_line_items').select('*').eq('folio_id', row.folioId).order('charged_at')
    const { data: allPayments } = await supabase.from('folio_payments').select('*').eq('folio_id', row.folioId).eq('status', 'completed')
    const itemsTotal = (allItems || []).reduce((sum: number, i: any) => sum + i.line_total, 0)
    const paymentsTotal = (allPayments || []).reduce((sum: number, p: any) => sum + p.amount - (p.surcharge_amount || 0), 0)
    const balance = Math.max(0, itemsTotal - paymentsTotal)

    const thisElectricDesc = billingMonth + ' Electric'
    const electricItem = (allItems || []).find((i: any) => i.description === thisElectricDesc)
    const electricAmount = electricItem?.line_total || row.calculatedAmount

    const { data: prevBills } = await supabase.from('electric_readings').select('created_at')
      .eq('guest_id', row.guest.id).neq('billing_month', billingMonth)
      .order('created_at', { ascending: false }).limit(1)
    const previousBillSentAt = prevBills && prevBills.length > 0 ? prevBills[0].created_at : null

    const newLineItems = (allItems || []).filter((item: any) => {
      if (item.description === thisElectricDesc) return false
      if (!previousBillSentAt) return true
      return new Date(item.charged_at) > new Date(previousBillSentAt)
    })
    const newLineItemsTotal = newLineItems.reduce((s: number, i: any) => s + i.line_total, 0)
    const previousBalance = balance - electricAmount - newLineItemsTotal

    // Payments received since last bill
    const paymentsReceivedAmt = (allPayments || [])
      .filter((p: any) => !previousBillSentAt || new Date(p.paid_at) > new Date(previousBillSentAt))
      .reduce((s: number, p: any) => s + p.amount - (p.surcharge_amount || 0), 0)
    const chargesBeforeResend = (allItems || [])
      .filter((i: any) => i.description !== thisElectricDesc && (!previousBillSentAt || new Date(i.charged_at) <= new Date(previousBillSentAt)))
      .reduce((s: number, i: any) => s + i.line_total, 0)
    const paymentsBeforeResend = (allPayments || [])
      .filter((p: any) => !previousBillSentAt || new Date(p.paid_at) <= new Date(previousBillSentAt))
      .reduce((s: number, p: any) => s + p.amount - (p.surcharge_amount || 0), 0)
    const balanceForwardResend = chargesBeforeResend - paymentsBeforeResend
    const liveBalanceResend = itemsTotal - paymentsTotal

    const res = await fetch('/api/electric-bill-email', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        guestName: row.guest.name, guestEmail: emailToUse, siteNumber: row.guest.site_number,
        billingMonth, emailMessage, electricAmount,
        newCharges: newLineItems, paymentsReceived: paymentsReceivedAmt,
        totalBalance: liveBalanceResend, balanceForward: balanceForwardResend,
      }),
    })
    const data = await res.json()
    setCampers(prev => { const u = [...prev]; u[index] = { ...u[index], sending: false, error: data.success ? '' : (data.error || 'Failed to send') }; return u })
  }

  async function sendBill(index: number) {
    const row = campers[index]
    if (row.skip || row.sent) return
    if (!row.guest.email) { setCampers(prev => { const u = [...prev]; u[index] = { ...u[index], error: 'No email on file' }; return u }); return }
    const finalAmountCents = Math.round(parseFloat(row.finalAmount) * 100) || row.calculatedAmount
    if (!finalAmountCents) { setCampers(prev => { const u = [...prev]; u[index] = { ...u[index], error: 'Enter meter readings first' }; return u }); return }
    setCampers(prev => { const u = [...prev]; u[index] = { ...u[index], sending: true, error: '' }; return u })

    let folioId = row.folioId
    if (!folioId) {
      const { data: newFolio } = await supabase.from('folios').insert({
        guest_id: row.guest.id, guest_name: row.guest.name, guest_email: row.guest.email,
        folio_type: 'guest_account', status: 'open', label: 'Seasonal Account',
      }).select().single()
      if (newFolio) folioId = newFolio.id
    }

    const { data: lineItem } = await supabase.from('folio_line_items').insert({
      folio_id: folioId, product_id: null, description: billingMonth + ' Electric',
      quantity: 1, unit_price: finalAmountCents, tax_amount: 0, line_total: finalAmountCents, category: 'Fees',
    }).select().single()

    await supabase.from('electric_readings').insert({
      guest_id: row.guest.id, billing_month: billingMonth,
      previous_reading: parseFloat(row.previousReading) || 0,
      current_reading: parseFloat(row.currentReading) || 0,
      kwh_used: row.kwhUsed, rate_per_kwh: parseFloat(ratePerKwh) || 0.27,
      minimum_charge: Math.round((parseFloat(minimumCharge) || 15) * 100),
      calculated_amount: row.calculatedAmount, final_amount: finalAmountCents,
      folio_line_item_id: lineItem?.id || null,
    })

    const { data: allItems } = await supabase.from('folio_line_items').select('*').eq('folio_id', folioId).order('charged_at')
    const { data: allPayments } = await supabase.from('folio_payments').select('*').eq('folio_id', folioId).eq('status', 'completed').order('paid_at')
    const itemsTotal = (allItems || []).reduce((sum: number, i: any) => sum + i.line_total, 0)
    const paymentsTotal = (allPayments || []).reduce((sum: number, p: any) => sum + p.amount - (p.surcharge_amount || 0), 0)
    // Live folio balance — matches what shows in their guest folio exactly
    const liveBalance = itemsTotal - paymentsTotal

    // Find the date the previous electric bill was sent for this camper
    const { data: prevBills } = await supabase
      .from('electric_readings')
      .select('created_at')
      .eq('guest_id', row.guest.id)
      .neq('billing_month', billingMonth)
      .order('created_at', { ascending: false })
      .limit(1)
    const previousBillSentAt = prevBills && prevBills.length > 0 ? prevBills[0].created_at : null

    const thisElectricDesc = billingMonth + ' Electric'

    // Balance Forward = everything owed BEFORE this billing month
    // = all charges before this electric bill minus all payments before this electric bill
    const chargesBefore = (allItems || [])
      .filter((i: any) => i.description !== thisElectricDesc && (!previousBillSentAt || new Date(i.charged_at) <= new Date(previousBillSentAt)))
      .reduce((s: number, i: any) => s + i.line_total, 0)
    const paymentsBefore = (allPayments || [])
      .filter((p: any) => !previousBillSentAt || new Date(p.paid_at) <= new Date(previousBillSentAt))
      .reduce((s: number, p: any) => s + p.amount - (p.surcharge_amount || 0), 0)
    const balanceForward = chargesBefore - paymentsBefore

    // New charges since last bill (excluding this month's electric — shown separately)
    const newCharges = (allItems || []).filter((item: any) => {
      if (item.description === thisElectricDesc) return false
      if (!previousBillSentAt) return true
      return new Date(item.charged_at) > new Date(previousBillSentAt)
    })

    // Payments received since last bill
    const paymentsReceivedAmount = (allPayments || [])
      .filter((p: any) => !previousBillSentAt || new Date(p.paid_at) > new Date(previousBillSentAt))
      .reduce((s: number, p: any) => s + p.amount - (p.surcharge_amount || 0), 0)

    const res = await fetch('/api/electric-bill-email', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        guestName: row.guest.name, guestEmail: row.guest.email, siteNumber: row.guest.site_number,
        billingMonth, emailMessage, electricAmount: finalAmountCents,
        newCharges, paymentsReceived: paymentsReceivedAmount,
        totalBalance: liveBalance, balanceForward,
      }),
    })
    const data = await res.json()
    setCampers(prev => { const u = [...prev]; u[index] = { ...u[index], sending: false, sent: data.success, folioId, folioBalance: liveBalance, historyLoaded: false, error: data.success ? '' : (data.error || 'Failed to send') }; return u })
  }

  async function sendAllBills() {
    setSendingAll(true)
    for (let i = 0; i < campers.length; i++) {
      if (!campers[i].skip && !campers[i].sent) await sendBill(i)
    }
    setSendingAll(false)
  }

  const readyToSend = campers.filter(c => !c.skip && !c.sent && c.finalAmount).length

  if (loading) return <div style={{ padding: '3rem', textAlign: 'center', color: '#6b7280' }}>Loading seasonal campers...</div>

  return (
    <div style={{ padding: '2rem', maxWidth: 1200, margin: '0 auto', fontFamily: 'sans-serif' }}>
      <div style={{ marginBottom: '1.5rem' }}>
        <h1 style={{ fontSize: 24, fontWeight: 700, margin: 0 }}>Electric Billing</h1>
        <p style={{ color: '#6b7280', margin: '4px 0 0', fontSize: 14 }}>Generate and send monthly electric bills to seasonal campers</p>
      </div>

      <div style={{ display: 'flex', gap: 4, marginBottom: 20, borderBottom: '1px solid #e5e7eb' }}>
        {(['billing', 'history'] as const).map(tab => (
          <button key={tab} onClick={() => setActiveTab(tab)} style={{ padding: '10px 20px', fontSize: 14, fontWeight: 600, border: 'none', background: 'none', cursor: 'pointer', borderBottom: activeTab === tab ? '2px solid #2E6B8A' : '2px solid transparent', color: activeTab === tab ? '#2E6B8A' : '#6b7280', marginBottom: -1 }}>
            {tab === 'billing' ? 'Monthly Billing' : 'Account History'}
          </button>
        ))}
      </div>

      {activeTab === 'billing' && (
        <>
          <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 12, padding: '1.5rem', marginBottom: 20 }}>
            <h3 style={{ margin: '0 0 1rem', fontSize: 15, fontWeight: 700 }}>Billing Settings</h3>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 16, marginBottom: 16 }}>
              <div>
                <label style={lbl}>Billing month</label>
                <select style={inp} value={billingMonth} onChange={e => handleMonthChange(e.target.value)} disabled={autoPopulating}>
                  {monthOptions.map(m => <option key={m} value={m}>{m}</option>)}
                </select>
                {autoPopulating && <div style={{ fontSize: 11, color: '#2E6B8A', marginTop: 4 }}>⟳ Loading previous readings...</div>}
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

          {campers.length === 0 ? (
            <div style={{ textAlign: 'center', color: '#9ca3af', padding: '3rem 0' }}>No seasonal campers found.</div>
          ) : (
            <>
              <div style={{ overflowX: 'auto', marginBottom: 20 }}>
                <div style={{ border: '1px solid #e5e7eb', borderRadius: 12, overflow: 'hidden', background: '#fff', minWidth: 960 }}>
                  <div style={{ display: 'grid', gridTemplateColumns: '1.2fr 60px 100px 100px 60px 90px 100px 110px 80px', gap: 6, padding: '10px 14px', background: '#f9fafb', borderBottom: '1px solid #e5e7eb', fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', color: '#6b7280' }}>
                    <div>Guest</div><div>Site</div><div>Prev reading</div><div>Curr reading</div><div>kWh</div><div>Calculated</div><div>Final amount</div><div>Balance</div><div>Skip</div>
                  </div>

                  {campers.map((row, i) => (
                    <div key={row.guest.id} style={{ borderBottom: i < campers.length - 1 ? '1px solid #f3f4f6' : 'none', background: row.skip ? '#f9fafb' : row.sent ? '#f0fdf4' : '#fff' }}>
                      <div style={{ display: 'grid', gridTemplateColumns: '1.2fr 60px 100px 100px 60px 90px 100px 110px 80px', gap: 6, padding: '10px 14px', alignItems: 'center' }}>
                        <div>
                          <div style={{ fontWeight: 600, fontSize: 13, color: row.skip ? '#9ca3af' : '#111827' }}>{row.guest.name}</div>
                          <div style={{ fontSize: 11, color: '#9ca3af' }}>{row.guest.email || 'No email'}</div>
                        </div>
                        <div style={{ fontSize: 13, fontWeight: 600, color: '#6b7280' }}>{row.guest.site_number}</div>
                        <input style={{ ...si, opacity: row.skip ? 0.4 : 1 }} type='number' placeholder='0' value={row.previousReading} disabled={row.skip || row.sent} onChange={e => updateReading(i, 'previousReading', e.target.value)} />
                        <input style={{ ...si, opacity: row.skip ? 0.4 : 1 }} type='number' placeholder='0' value={row.currentReading} disabled={row.skip || row.sent} onChange={e => updateReading(i, 'currentReading', e.target.value)} />
                        <div style={{ fontSize: 13, fontWeight: 600, color: '#374151' }}>{row.kwhUsed > 0 ? row.kwhUsed.toFixed(1) : '—'}</div>
                        <div style={{ fontSize: 13, color: '#6b7280' }}>{row.calculatedAmount > 0 ? '$' + (row.calculatedAmount / 100).toFixed(2) : '—'}</div>
                        <div style={{ position: 'relative' }}>
                          <span style={{ position: 'absolute', left: 8, top: '50%', transform: 'translateY(-50%)', color: '#6b7280', fontSize: 13 }}>$</span>
                          <input style={{ ...si, paddingLeft: 20, opacity: row.skip ? 0.4 : 1 }} type='number' step='0.01' placeholder='0.00' value={row.finalAmount} disabled={row.skip || row.sent} onChange={e => updateFinalAmount(i, e.target.value)} />
                        </div>
                        <div style={{ fontSize: 13, fontWeight: 700, color: row.folioBalance > 0 ? '#dc2626' : '#15803d' }}>
                          {row.folioBalance > 0 ? '$' + (row.folioBalance / 100).toFixed(2) : '✓ Current'}
                        </div>
                        <button onClick={() => toggleSkip(i)} disabled={row.sent} style={{ fontSize: 11, fontWeight: 600, border: '1px solid', borderColor: row.skip ? '#d1d5db' : '#fca5a5', borderRadius: 6, padding: '4px 8px', cursor: 'pointer', background: row.skip ? '#f3f4f6' : '#fef2f2', color: row.skip ? '#6b7280' : '#dc2626' }}>
                          {row.skip ? 'Skipped' : 'Skip'}
                        </button>
                      </div>

                      {!row.skip && (
                        <div style={{ padding: '0 14px 12px', display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                          {!row.sent ? (
                            <button onClick={() => setCampers(prev => { const u = [...prev]; u[i] = { ...u[i], showBillConfirm: true }; return u })}
                              disabled={row.sending || !row.finalAmount}
                              style={{ background: '#2E6B8A', color: '#fff', border: 'none', borderRadius: 7, padding: '7px 16px', fontSize: 13, fontWeight: 600, cursor: !row.finalAmount ? 'default' : 'pointer', opacity: !row.finalAmount ? 0.5 : 1 }}>
                              {row.sending ? 'Sending...' : '✉ Send Bill'}
                            </button>
                          ) : (
                            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                              <span style={{ fontSize: 13, color: '#15803d', fontWeight: 600 }}>✓ Sent!</span>
                              {!row.editEmailMode ? (
                                <>
                                  <button onClick={() => setCampers(prev => { const u = [...prev]; u[i] = { ...u[i], showBillConfirm: true }; return u })}
                                    style={{ background: '#eff6ff', color: '#1d4ed8', border: '1px solid #bfdbfe', borderRadius: 7, padding: '5px 12px', fontSize: 12, fontWeight: 600, cursor: 'pointer' }}>
                                    Re-send
                                  </button>
                                  <button onClick={() => setCampers(prev => { const u = [...prev]; u[i] = { ...u[i], editEmailMode: true, editEmailValue: row.guest.email }; return u })}
                                    style={{ background: '#f5f3ff', color: '#6d28d9', border: '1px solid #ddd6fe', borderRadius: 7, padding: '5px 12px', fontSize: 12, fontWeight: 600, cursor: 'pointer' }}>
                                    Edit & Re-send
                                  </button>
                                  <button onClick={() => { if (confirm('Send a second bill for ' + billingMonth + ' to ' + row.guest.name + '?')) { setCampers(prev => { const u = [...prev]; u[i] = { ...u[i], sent: false }; return u }) } }}
                                    style={{ background: '#fff7ed', color: '#c2410c', border: '1px solid #fed7aa', borderRadius: 7, padding: '5px 12px', fontSize: 12, fontWeight: 600, cursor: 'pointer' }}>
                                    + Send Another
                                  </button>
                                </>
                              ) : (
                                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                                  <input type='email' value={row.editEmailValue}
                                    onChange={e => setCampers(prev => { const u = [...prev]; u[i] = { ...u[i], editEmailValue: e.target.value }; return u })}
                                    style={{ border: '1px solid #d1d5db', borderRadius: 6, padding: '5px 10px', fontSize: 13, width: 200 }}
                                    placeholder='Email address' />
                                  <button onClick={() => resendBill(i, row.editEmailValue)}
                                    style={{ background: '#2E6B8A', color: '#fff', border: 'none', borderRadius: 7, padding: '5px 12px', fontSize: 12, fontWeight: 600, cursor: 'pointer' }}>
                                    Send
                                  </button>
                                  <button onClick={() => setCampers(prev => { const u = [...prev]; u[i] = { ...u[i], editEmailMode: false }; return u })}
                                    style={{ background: 'none', border: '1px solid #e5e7eb', borderRadius: 7, padding: '5px 10px', fontSize: 12, color: '#6b7280', cursor: 'pointer' }}>
                                    Cancel
                                  </button>
                                </div>
                              )}
                            </div>
                          )}

                          {row.folioBalance > 0 && !row.showPayment && (
                            <button onClick={() => { updatePaymentField(i, 'showPayment', 'true'); updatePaymentField(i, 'paymentAmount', (row.folioBalance / 100).toFixed(2)) }}
                              style={{ background: '#f0fdf4', color: '#15803d', border: '1px solid #bbf7d0', borderRadius: 7, padding: '7px 16px', fontSize: 13, fontWeight: 600, cursor: 'pointer' }}>
                              💵 Record Payment
                            </button>
                          )}

                          {row.lastPaymentRecorded && !row.receiptSent && !row.showReceiptConfirm && (
                            <button onClick={() => setCampers(prev => { const u = [...prev]; u[i] = { ...u[i], showReceiptConfirm: true }; return u })}
                              style={{ background: '#fffbeb', color: '#92400e', border: '1px solid #fde68a', borderRadius: 7, padding: '7px 16px', fontSize: 13, fontWeight: 600, cursor: 'pointer' }}>
                              🧾 Send Receipt
                            </button>
                          )}
                          {row.receiptSent && <span style={{ fontSize: 12, color: '#15803d', fontWeight: 600 }}>✓ Receipt sent!</span>}

                          <button onClick={() => loadHistory(i)}
                            style={{ background: '#f3f4f6', color: '#374151', border: '1px solid #e5e7eb', borderRadius: 7, padding: '7px 16px', fontSize: 13, fontWeight: 600, cursor: 'pointer' }}>
                            {row.showHistory ? 'Hide History' : '📋 View History'}
                          </button>

                          {row.error && <span style={{ fontSize: 12, color: '#dc2626' }}>{row.error}</span>}
                          {!row.guest.email && <span style={{ fontSize: 12, color: '#9ca3af' }}>No email on file</span>}
                        </div>
                      )}

                      {row.showBillConfirm && (
                        <div style={{ margin: '0 14px 14px', background: '#eff6ff', border: '1px solid #bfdbfe', borderRadius: 10, padding: '14px' }}>
                          <div style={{ fontSize: 13, fontWeight: 700, color: '#1e40af', marginBottom: 6 }}>
                            {row.sent ? 'Re-send electric bill to ' + row.guest.name + '?' : 'Send electric bill to ' + row.guest.name + '?'}
                          </div>
                          <div style={{ fontSize: 13, color: '#1e3a8a', marginBottom: 12 }}>
                            A <strong>{billingMonth} electric bill for ${row.finalAmount}</strong> will be sent to <strong>{row.guest.email}</strong>
                          </div>
                          <div style={{ display: 'flex', gap: 10 }}>
                            <button onClick={() => { setCampers(prev => { const u = [...prev]; u[i] = { ...u[i], showBillConfirm: false }; return u }); row.sent ? resendBill(i) : sendBill(i) }}
                              style={{ background: '#2E6B8A', color: '#fff', border: 'none', borderRadius: 7, padding: '7px 16px', fontSize: 13, fontWeight: 600, cursor: 'pointer' }}>
                              Yes, Send Bill
                            </button>
                            <button onClick={() => setCampers(prev => { const u = [...prev]; u[i] = { ...u[i], showBillConfirm: false }; return u })}
                              style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 7, padding: '7px 16px', fontSize: 13, fontWeight: 600, color: '#6b7280', cursor: 'pointer' }}>
                              Cancel
                            </button>
                          </div>
                        </div>
                      )}

                      {row.showReceiptConfirm && row.lastPaymentRecorded && (
                        <div style={{ margin: '0 14px 14px', background: '#fffbeb', border: '1px solid #fde68a', borderRadius: 10, padding: '14px' }}>
                          <div style={{ fontSize: 13, fontWeight: 700, color: '#92400e', marginBottom: 6 }}>Send payment receipt to {row.guest.name}?</div>
                          <div style={{ fontSize: 13, color: '#78350f', marginBottom: 12 }}>
                            A receipt for <strong>${(row.lastPaymentRecorded.amount / 100).toFixed(2)}</strong> will be sent to <strong>{row.guest.email}</strong>
                          </div>
                          <div style={{ display: 'flex', gap: 10 }}>
                            <button onClick={() => sendReceipt(i)} disabled={row.sendingReceipt}
                              style={{ background: '#d97706', color: '#fff', border: 'none', borderRadius: 7, padding: '7px 18px', fontSize: 13, fontWeight: 600, cursor: 'pointer' }}>
                              {row.sendingReceipt ? 'Sending...' : 'Yes, Send Receipt'}
                            </button>
                            <button onClick={() => setCampers(prev => { const u = [...prev]; u[i] = { ...u[i], showReceiptConfirm: false }; return u })}
                              style={{ background: 'none', border: '1px solid #d1d5db', borderRadius: 7, padding: '7px 14px', fontSize: 13, cursor: 'pointer' }}>
                              Cancel
                            </button>
                          </div>
                        </div>
                      )}

                      {row.showPayment && (
                        <div style={{ margin: '0 14px 14px', background: '#f0fdf4', border: '1px solid #bbf7d0', borderRadius: 10, padding: '14px' }}>
                          <div style={{ fontSize: 13, fontWeight: 700, color: '#15803d', marginBottom: 10 }}>Record Payment — {row.guest.name}</div>
                          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'flex-end' }}>
                            <div>
                              <label style={{ ...lbl, marginTop: 0 }}>Amount ($)</label>
                              <input style={{ ...si, width: 110 }} type='number' step='0.01' value={row.paymentAmount} onChange={e => updatePaymentField(i, 'paymentAmount', e.target.value)} />
                            </div>
                            <div>
                              <label style={{ ...lbl, marginTop: 0 }}>Method</label>
                              <select style={{ ...si, width: 120 }} value={row.paymentMethod} onChange={e => updatePaymentField(i, 'paymentMethod', e.target.value)}>
                                <option value='cash'>Cash</option>
                                <option value='check'>Check</option>
                                <option value='card'>Card</option>
                                <option value='venmo'>Venmo</option>
                                <option value='other'>Other</option>
                              </select>
                            </div>
                            <div style={{ flex: 1, minWidth: 120 }}>
                              <label style={{ ...lbl, marginTop: 0 }}>Note (optional)</label>
                              <input style={si} placeholder='e.g. Check #1042' value={row.paymentNote} onChange={e => updatePaymentField(i, 'paymentNote', e.target.value)} />
                            </div>
                            <button onClick={() => recordPayment(i)} disabled={row.savingPayment || !row.paymentAmount}
                              style={{ background: '#15803d', color: '#fff', border: 'none', borderRadius: 7, padding: '7px 18px', fontSize: 13, fontWeight: 600, cursor: 'pointer', height: 34 }}>
                              {row.savingPayment ? 'Saving...' : 'Save Payment'}
                            </button>
                            <button onClick={() => updatePaymentField(i, 'showPayment', 'false')}
                              style={{ background: 'none', border: '1px solid #d1d5db', borderRadius: 7, padding: '7px 14px', fontSize: 13, cursor: 'pointer', height: 34 }}>
                              Cancel
                            </button>
                          </div>
                        </div>
                      )}

                      {row.showHistory && (
                        <div style={{ margin: '0 14px 14px', background: '#f8fafc', border: '1px solid #e5e7eb', borderRadius: 10, overflow: 'hidden' }}>
                          <div style={{ padding: '10px 14px', fontSize: 12, fontWeight: 700, color: '#374151', background: '#f1f5f9', borderBottom: '1px solid #e5e7eb' }}>
                            Billing History — {row.guest.name} · Site {row.guest.site_number}
                          </div>
                          {row.readings.length === 0 ? (
                            <div style={{ padding: '1rem', fontSize: 13, color: '#9ca3af' }}>No billing history yet.</div>
                          ) : (
                            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                              <thead>
                                <tr style={{ background: '#f9fafb' }}>
                                  {['Month', 'Prev', 'Curr', 'kWh', 'Rate', 'Billed', 'Date'].map(h => (
                                    <th key={h} style={{ padding: '7px 12px', textAlign: 'left', color: '#6b7280', fontWeight: 700, fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.04em', borderBottom: '1px solid #e5e7eb' }}>{h}</th>
                                  ))}
                                </tr>
                              </thead>
                              <tbody>
                                {row.readings.map((r, ri) => (
                                  <tr key={r.id} style={{ borderBottom: ri < row.readings.length - 1 ? '1px solid #f3f4f6' : 'none', background: ri % 2 === 0 ? '#fff' : '#fafafa' }}>
                                    <td style={{ padding: '8px 12px', fontWeight: 600, color: '#111827' }}>{r.billing_month}</td>
                                    <td style={{ padding: '8px 12px', color: '#6b7280' }}>{Number(r.previous_reading).toLocaleString()}</td>
                                    <td style={{ padding: '8px 12px', color: '#6b7280' }}>{Number(r.current_reading).toLocaleString()}</td>
                                    <td style={{ padding: '8px 12px', color: '#374151', fontWeight: 600 }}>{Number(r.kwh_used).toFixed(1)}</td>
                                    <td style={{ padding: '8px 12px', color: '#6b7280' }}>${Number(r.rate_per_kwh).toFixed(3)}</td>
                                    <td style={{ padding: '8px 12px', fontWeight: 700, color: '#15803d' }}>${(r.final_amount / 100).toFixed(2)}</td>
                                    <td style={{ padding: '8px 12px', color: '#9ca3af' }}>{new Date(r.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: '2-digit' })}</td>
                                  </tr>
                                ))}
                              </tbody>
                              <tfoot>
                                <tr style={{ background: '#f0fdf4', borderTop: '2px solid #bbf7d0' }}>
                                  <td colSpan={5} style={{ padding: '8px 12px', fontWeight: 700, fontSize: 12, color: '#15803d' }}>Total billed (all time)</td>
                                  <td style={{ padding: '8px 12px', fontWeight: 800, color: '#15803d' }}>${(row.readings.reduce((s, r) => s + r.final_amount, 0) / 100).toFixed(2)}</td>
                                  <td />
                                </tr>
                              </tfoot>
                            </table>
                          )}
                          {row.folioPayments.length > 0 && (
                            <div style={{ borderTop: '1px solid #e5e7eb' }}>
                              <div style={{ padding: '10px 14px', fontSize: 11, fontWeight: 700, color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.06em', background: '#f9fafb' }}>Payments received</div>
                              {row.folioPayments.map((p, pi) => (
                                <div key={p.id} style={{ borderBottom: pi < row.folioPayments.length - 1 ? '1px solid #f3f4f6' : 'none' }}>
                                  <div style={{ display: 'flex', justifyContent: 'space-between', padding: '7px 14px', fontSize: 12, alignItems: 'center' }}>
                                    <div>
                                      <span style={{ fontWeight: 600, color: '#374151', textTransform: 'capitalize' }}>{p.method}</span>
                                      {p.note && <span style={{ color: '#9ca3af', marginLeft: 8 }}>{p.note}</span>}
                                      <span style={{ color: '#9ca3af', marginLeft: 8 }}>{new Date(p.paid_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: '2-digit' })}</span>
                                      {p.receipt_sent_at
                                        ? <span style={{ marginLeft: 10, fontSize: 11, color: '#15803d' }}>🧾 Receipt sent {new Date(p.receipt_sent_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: '2-digit' })}</span>
                                        : <span style={{ marginLeft: 10, fontSize: 11, color: '#9ca3af' }}>No receipt sent</span>
                                      }
                                    </div>
                                    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                                      <span style={{ fontWeight: 700, color: '#15803d' }}>-${((p.amount - (p.surcharge_amount || 0)) / 100).toFixed(2)}</span>
                                      <button
                                        onClick={() => setCampers(prev => {
                                          const u = [...prev]
                                          u[i] = { ...u[i], lastPaymentRecorded: p, showReceiptConfirm: true, receiptSent: false }
                                          return u
                                        })}
                                        style={{ fontSize: 11, background: '#fffbeb', color: '#92400e', border: '1px solid #fde68a', borderRadius: 5, padding: '3px 8px', cursor: 'pointer', fontWeight: 600 }}>
                                        {p.receipt_sent_at ? '↩ Re-send' : '🧾 Send'}
                                      </button>
                                    </div>
                                  </div>
                                </div>
                              ))}
                            </div>
                          )}
                          {/* Balance due summary */}
                          <div style={{ padding: '10px 14px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderTop: '2px solid #e5e7eb', background: row.folioBalance < 0 ? '#f0fdf4' : row.folioBalance === 0 ? '#f0fdf4' : '#fef2f2' }}>
                            <span style={{ fontSize: 13, fontWeight: 700, color: row.folioBalance < 0 ? '#15803d' : row.folioBalance === 0 ? '#15803d' : '#dc2626' }}>
                              {row.folioBalance < 0 ? 'Credit on Account' : row.folioBalance === 0 ? '✓ Paid in Full' : 'Balance Due'}
                            </span>
                            <span style={{ fontSize: 15, fontWeight: 800, color: row.folioBalance < 0 ? '#15803d' : row.folioBalance === 0 ? '#15803d' : '#dc2626' }}>
                              {row.folioBalance < 0 ? '-$' + (Math.abs(row.folioBalance) / 100).toFixed(2) : '$' + (row.folioBalance / 100).toFixed(2)}
                            </span>
                          </div>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </div>

              <div style={{ display: 'flex', justifyContent: 'flex-end', alignItems: 'center', gap: 16 }}>
                <span style={{ fontSize: 14, color: '#6b7280' }}>{readyToSend} bill{readyToSend !== 1 ? 's' : ''} ready to send</span>
                <button onClick={sendAllBills} disabled={sendingAll || readyToSend === 0}
                  style={{ background: readyToSend > 0 ? '#2E6B8A' : '#d1d5db', color: '#fff', border: 'none', borderRadius: 8, padding: '11px 28px', fontWeight: 700, fontSize: 15, cursor: readyToSend > 0 ? 'pointer' : 'default' }}>
                  {sendingAll ? 'Sending all...' : 'Send All Bills'}
                </button>
              </div>
            </>
          )}
        </>
      )}

      {activeTab === 'history' && (
        <div>
          {campers.length === 0 ? (
            <div style={{ textAlign: 'center', color: '#9ca3af', padding: '3rem 0' }}>No seasonal campers found.</div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
              {campers.map((row) => (
                <GuestAccountCard key={row.guest.id} guest={row.guest} folioBalance={row.folioBalance} />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function GuestAccountCard({ guest, folioBalance }: { guest: Guest; folioBalance: number }) {
  const [readings, setReadings] = useState<any[]>([])
  const [payments, setPayments] = useState<any[]>([])
  const [loaded, setLoaded] = useState(false)
  const [open, setOpen] = useState(false)

  async function load() {
    if (loaded) { setOpen(!open); return }
    const [{ data: r }, { data: folio }] = await Promise.all([
      supabase.from('electric_readings').select('*').eq('guest_id', guest.id).order('created_at', { ascending: false }),
      supabase.from('folios').select('id').eq('guest_id', guest.id).eq('folio_type', 'guest_account').single(),
    ])
    let pmts: any[] = []
    if (folio) {
      const { data: pData } = await supabase.from('folio_payments').select('*').eq('folio_id', folio.id).eq('status', 'completed').order('paid_at', { ascending: false })
      pmts = pData || []
    }
    setReadings(r || [])
    setPayments(pmts)
    setLoaded(true)
    setOpen(true)
  }

  const totalBilled = readings.reduce((s, r) => s + r.final_amount, 0)
  const totalPaid = payments.reduce((s, p) => s + p.amount - (p.surcharge_amount || 0), 0)

  return (
    <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 12, overflow: 'hidden' }}>
      <div onClick={load} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '14px 20px', cursor: 'pointer' }}
        onMouseEnter={e => (e.currentTarget.style.background = '#f9fafb')}
        onMouseLeave={e => (e.currentTarget.style.background = '#fff')}>
        <div>
          <div style={{ fontWeight: 700, fontSize: 15, color: '#111827' }}>{guest.name}</div>
          <div style={{ fontSize: 12, color: '#9ca3af' }}>Site {guest.site_number} · {guest.email || 'No email'}</div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 20 }}>
          {loaded && <div style={{ fontSize: 12, color: '#6b7280' }}>{readings.length} bill{readings.length !== 1 ? 's' : ''} · ${(totalBilled / 100).toFixed(2)} billed · ${(totalPaid / 100).toFixed(2)} paid</div>}
          <div style={{ fontWeight: 800, fontSize: 16, color: folioBalance > 0 ? '#dc2626' : '#15803d' }}>
            {folioBalance > 0 ? '$' + (folioBalance / 100).toFixed(2) + ' due' : '✓ Current'}
          </div>
          <span style={{ color: '#9ca3af', fontSize: 18 }}>{open ? '▲' : '▼'}</span>
        </div>
      </div>
      {open && (
        <div style={{ borderTop: '1px solid #e5e7eb' }}>
          {readings.length === 0 ? (
            <div style={{ padding: '1rem 20px', fontSize: 13, color: '#9ca3af' }}>No billing history yet.</div>
          ) : (
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
              <thead>
                <tr style={{ background: '#f9fafb' }}>
                  {['Month', 'Prev Reading', 'Curr Reading', 'kWh Used', 'Rate', 'Amount Billed', 'Billed On'].map(h => (
                    <th key={h} style={{ padding: '8px 16px', textAlign: 'left', color: '#6b7280', fontWeight: 700, fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.04em', borderBottom: '1px solid #e5e7eb' }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {readings.map((r, i) => (
                  <tr key={r.id} style={{ borderBottom: '1px solid #f3f4f6', background: i % 2 === 0 ? '#fff' : '#fafafa' }}>
                    <td style={{ padding: '10px 16px', fontWeight: 600, color: '#111827' }}>{r.billing_month}</td>
                    <td style={{ padding: '10px 16px', color: '#6b7280' }}>{Number(r.previous_reading).toLocaleString()}</td>
                    <td style={{ padding: '10px 16px', color: '#6b7280' }}>{Number(r.current_reading).toLocaleString()}</td>
                    <td style={{ padding: '10px 16px', fontWeight: 600 }}>{Number(r.kwh_used).toFixed(1)}</td>
                    <td style={{ padding: '10px 16px', color: '#6b7280' }}>${Number(r.rate_per_kwh).toFixed(3)}/kWh</td>
                    <td style={{ padding: '10px 16px', fontWeight: 700, color: '#15803d' }}>${(r.final_amount / 100).toFixed(2)}</td>
                    <td style={{ padding: '10px 16px', color: '#9ca3af' }}>{new Date(r.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr style={{ background: '#f0fdf4', borderTop: '2px solid #bbf7d0' }}>
                  <td colSpan={5} style={{ padding: '10px 16px', fontWeight: 700, color: '#15803d' }}>All-time totals</td>
                  <td style={{ padding: '10px 16px', fontWeight: 800, color: '#15803d' }}>${(totalBilled / 100).toFixed(2)}</td>
                  <td />
                </tr>
              </tfoot>
            </table>
          )}
          {payments.length > 0 && (
            <div style={{ borderTop: '1px solid #e5e7eb', padding: '0 0 4px' }}>
              <div style={{ padding: '10px 16px', fontSize: 11, fontWeight: 700, color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.06em', background: '#f9fafb', borderBottom: '1px solid #f3f4f6' }}>Payments received</div>
              {payments.map((p, pi) => (
                <div key={p.id} style={{ display: 'flex', justifyContent: 'space-between', padding: '8px 16px', borderBottom: pi < payments.length - 1 ? '1px solid #f3f4f6' : 'none', fontSize: 13 }}>
                  <div>
                    <span style={{ fontWeight: 600, textTransform: 'capitalize' }}>{p.method}</span>
                    {p.note && <span style={{ color: '#9ca3af', marginLeft: 10 }}>{p.note}</span>}
                  </div>
                  <div style={{ display: 'flex', gap: 20, alignItems: 'center' }}>
                    <span style={{ color: '#9ca3af', fontSize: 12 }}>{new Date(p.paid_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}</span>
                    <span style={{ fontWeight: 700, color: '#15803d' }}>-${((p.amount - (p.surcharge_amount || 0)) / 100).toFixed(2)}</span>
                  </div>
                </div>
              ))}
              <div style={{ display: 'flex', justifyContent: 'space-between', padding: '10px 16px', borderTop: '2px solid #bbf7d0', background: '#f0fdf4' }}>
                <span style={{ fontWeight: 700, color: '#15803d' }}>Total paid</span>
                <span style={{ fontWeight: 800, color: '#15803d' }}>${(totalPaid / 100).toFixed(2)}</span>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

const lbl: React.CSSProperties = { display: 'block', fontSize: 13, fontWeight: 600, color: '#374151', marginBottom: 4, marginTop: 8 }
const inp: React.CSSProperties = { width: '100%', border: '1px solid #d1d5db', borderRadius: 7, padding: '8px 10px', fontSize: 14, boxSizing: 'border-box' }
const si: React.CSSProperties = { width: '100%', border: '1px solid #d1d5db', borderRadius: 6, padding: '6px 8px', fontSize: 13, boxSizing: 'border-box' }
