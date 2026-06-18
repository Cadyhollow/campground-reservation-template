'use client'
import { useEffect, useState } from 'react'
import { createClient } from '@supabase/supabase-js'
import { useParams, useRouter } from 'next/navigation'

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
)

const FALLBACK_CATEGORIES = ['Camping Supplies', 'Food & Drink', 'Rentals', 'Fees', 'General']

type Guest = {
  id: string
  name: string
  email: string
  phone: string
  site_number: string
  is_seasonal: boolean
  season_start: string | null
  season_end: string | null
  notes: string
}

type LineItem = {
  id: string
  description: string
  quantity: number
  unit_price: number
  tax_amount: number
  line_total: number
  category: string
  charged_at: string
  notes?: string | null
}

type Payment = {
  id: string
  method: string
  amount: number
  surcharge_amount: number
  status: string
  note: string
  paid_at: string
}

type Product = {
  id: string
  name: string
  category: string
  price: number
  tax_class: string
  active: boolean
  variable_price: boolean
}

type Folio = {
  id: string
  guest_name: string
  guest_email: string
  status: string
}

function fmtLedgerDate(ts: string) {
  if (!ts) return ''
  const d = new Date(ts)
  if (isNaN(d.getTime())) return ''
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

export default function GuestAccountPage() {
  const params = useParams()
  const router = useRouter()
  const guestId = params.id as string

  const [guest, setGuest] = useState<Guest | null>(null)
  const [folio, setFolio] = useState<Folio | null>(null)
  const [lineItems, setLineItems] = useState<LineItem[]>([])
  const [payments, setPayments] = useState<Payment[]>([])
  const [products, setProducts] = useState<Product[]>([])
  const [categories, setCategories] = useState<string[]>(FALLBACK_CATEGORIES)
  const [cardSurcharge, setCardSurcharge] = useState(0)
  const [loading, setLoading] = useState(true)
  const [activeTab, setActiveTab] = useState<'tab'|'items'>('tab')
  const [activeCategory, setActiveCategory] = useState('')
  const [showPayment, setShowPayment] = useState(false)
  const [paymentMethod, setPaymentMethod] = useState('cash')
  const [paymentAmount, setPaymentAmount] = useState('')
  const [cashTendered, setCashTendered] = useState('')
  const [maxCreditAmount, setMaxCreditAmount] = useState(0)
  const [waiveFee, setWaiveFee] = useState(false)
  const [terminalDeviceId, setTerminalDeviceId] = useState('')
  const [cardEntryMode, setCardEntryMode] = useState('terminal')
  const [terminalStatus, setTerminalStatus] = useState('idle')
  const [paymentNote, setPaymentNote] = useState('')
  const [savingPayment, setSavingPayment] = useState(false)
  const [showCustomItem, setShowCustomItem] = useState(false)
  const [customDesc, setCustomDesc] = useState('')
  const [customPrice, setCustomPrice] = useState('')
  const [customQty, setCustomQty] = useState('1')
  const [showEarlier, setShowEarlier] = useState(false)

  useEffect(() => { init() }, [guestId])

  async function init() {
    setLoading(true)
    const [{ data: guestData }, { data: prods }, { data: settings }, { data: cats }] = await Promise.all([
      supabase.from('guests').select('*').eq('id', guestId).single(),
      supabase.from('products').select('*').eq('active', true).order('display_order'),
      (supabase.from('settings').select('card_surcharge_percent, max_credit_amount, square_terminal_device_id').single()) as any,
      supabase.from('product_categories').select('name').order('display_order'),
    ])
    if (guestData) setGuest(guestData)
    setProducts(prods || [])
    if (settings?.card_surcharge_percent) setCardSurcharge(Number(settings.card_surcharge_percent))
    if (settings?.square_terminal_device_id) setTerminalDeviceId(settings.square_terminal_device_id)
    if (settings?.max_credit_amount !== undefined) setMaxCreditAmount(settings.max_credit_amount || 0)
    if (cats && cats.length > 0) setCategories(cats.map((c: any) => c.name))

    // Find or create a standing folio for this guest using guest_id
    const { data: existingFolio } = await supabase
      .from('folios')
      .select('*')
      .eq('guest_id', guestId)
      .eq('folio_type', 'guest_account')
      .eq('status', 'open')
      .single()

    if (existingFolio) {
      setFolio(existingFolio)
      await loadFolioData(existingFolio.id)
    } else if (guestData) {
      const { data: newFolio } = await supabase.from('folios').insert({
        reservation_id: null,
        guest_id: guestId,
        guest_name: guestData.name,
        guest_email: guestData.email || '',
        folio_type: 'guest_account',
        status: 'open',
        label: guestData.is_seasonal ? 'Seasonal Account' : 'Guest Account',
      }).select().single()
      if (newFolio) {
        setFolio(newFolio)
        await loadFolioData(newFolio.id)
      }
    }
    setLoading(false)
  }

  async function loadFolioData(folioId: string) {
    const [{ data: items }, { data: pmts }] = await Promise.all([
      supabase.from('folio_line_items').select('*').eq('folio_id', folioId).order('charged_at'),
      supabase.from('folio_payments').select('*').eq('folio_id', folioId).eq('status', 'completed').order('paid_at'),
    ])
    setLineItems(items || [])
    setPayments(pmts || [])
  }

  async function addProduct(product: Product, overridePrice?: number, qty: number = 1, notes: string = '') {
    if (!folio) return
    const price = overridePrice ?? product.price
    const taxAmount = product.tax_class === 'standard' ? Math.round(price * 0.06) : 0
    const lineTotal = (price + taxAmount) * qty
    await supabase.from('folio_line_items').insert({
      folio_id: folio.id,
      product_id: product.id,
      description: product.name,
      quantity: qty,
      unit_price: price,
      tax_amount: taxAmount,
      line_total: lineTotal,
      category: product.category,
      notes: notes.trim() || null,
    })
    await loadFolioData(folio.id)
    setActiveTab('tab')
    setActiveCategory('')
  }

  async function addCustomItem() {
    if (!folio || !customDesc.trim()) return
    const price = Math.round(parseFloat(customPrice) * 100) || 0
    const qty = parseInt(customQty) || 1
    await supabase.from('folio_line_items').insert({
      folio_id: folio.id,
      product_id: null,
      description: customDesc.trim(),
      quantity: qty,
      unit_price: price,
      tax_amount: 0,
      line_total: price * qty,
      category: 'General',
    })
    setCustomDesc('')
    setCustomPrice('')
    setCustomQty('1')
    setShowCustomItem(false)
    await loadFolioData(folio.id)
    setActiveTab('tab')
    setActiveCategory('')
  }

  async function removeLineItem(id: string) {
    if (!confirm('Remove this item?')) return
    await supabase.from('folio_line_items').delete().eq('id', id)
    await loadFolioData(folio!.id)
  }

  async function voidPayment(id: string) {
    if (!confirm('Void this payment?')) return
    await supabase.from('folio_payments').update({ status: 'voided' }).eq('id', id)
    await loadFolioData(folio!.id)
  }

  async function sendToTerminal() {
    if (!folio) return
    const surchargeAmount = cardSurcharge > 0 && !waiveFee
      ? Math.round(paymentAmountCents * (cardSurcharge / 100))
      : 0
    const totalCharge = paymentAmountCents + surchargeAmount
    setTerminalStatus('waiting')
    try {
      const res = await fetch('/api/terminal/charge', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          amount: totalCharge,
          folioId: folio.id,
          note: paymentNote || 'Guest account payment',
          surchargeAmount,
        }),
      })
      const data = await res.json()
      if (!data.checkoutId) { setTerminalStatus('error'); return }
      const poll = setInterval(async () => {
        const pr = await fetch('/api/terminal/charge?checkoutId=' + data.checkoutId)
        const pd = await pr.json()
        if (pd.status === 'COMPLETED') {
          clearInterval(poll)
          setShowPayment(false)
          setPaymentAmount('')
          setPaymentNote('')
          setTerminalStatus('idle')
          setCardEntryMode('terminal')
          await loadFolioData(folio.id)
        } else if (pd.status === 'CANCELED' || pd.status === 'CANCEL_REQUESTED') {
          clearInterval(poll)
          setTerminalStatus('error')
        }
      }, 2000)
    } catch {
      setTerminalStatus('error')
    }
  }

  async function collectPayment() {
    if (!folio) return
    const isPrepay = totalDue === 0
    const baseAmount = isPrepay
      ? Math.round(parseFloat(paymentAmount || '0') * 100)
      : paymentMethod === 'cash' && cashTendered !== ''
      ? Math.min(Math.round(parseFloat(cashTendered) * 100), Math.round(parseFloat(paymentAmount) * 100))
      : Math.round(parseFloat(paymentAmount) * 100)
    if (!baseAmount || baseAmount <= 0) return
    // Prepayment onto a zero balance becomes credit in full — enforce the credit cap (warn, allow override).
    if (isPrepay && maxCreditAmount > 0 && baseAmount > maxCreditAmount) {
      if (!confirm('This will add a credit of $' + (baseAmount/100).toFixed(2) + ', which exceeds the $' + (maxCreditAmount/100).toFixed(2) + ' credit limit for this account. Add it anyway?')) {
        return
      }
    }
    const surchargeAmount = paymentMethod === 'card' && cardSurcharge > 0 && !waiveFee
      ? Math.round(baseAmount * (cardSurcharge / 100))
      : 0
    const totalAmount = baseAmount + surchargeAmount
    setSavingPayment(true)
    await supabase.from('folio_payments').insert({
      folio_id: folio.id,
      method: paymentMethod,
      amount: totalAmount,
      surcharge_amount: surchargeAmount,
      status: 'completed',
      note: paymentNote + (surchargeAmount > 0 ? ' (incl. ' + cardSurcharge + '% card fee: $' + (surchargeAmount/100).toFixed(2) + ')' : ''),
    })
    setSavingPayment(false)
    setShowPayment(false)
    setPaymentAmount('')
    setCashTendered('')
    setPaymentNote('')
    setPaymentMethod('cash')
    setWaiveFee(false)
    await loadFolioData(folio.id)
  }

  const itemsTotal = lineItems.reduce((sum, i) => sum + i.line_total, 0)
  const paymentsTotal = payments.reduce((sum, p) => sum + p.amount - (p.surcharge_amount || 0), 0)
  const totalDue = Math.max(0, itemsTotal - paymentsTotal)
  const overpaid = paymentsTotal > itemsTotal ? paymentsTotal - itemsTotal : 0
  const paymentAmountCents = Math.round(parseFloat(paymentAmount) * 100) || 0
  const surchargePreview = paymentMethod === 'card' && cardSurcharge > 0 && !waiveFee ? Math.round(paymentAmountCents * (cardSurcharge / 100)) : 0
  const totalWithSurcharge = paymentAmountCents + surchargePreview
  // ---- Chronological ledger: charges + payments interleaved with a running balance ----
  type LedgerEvent = {
    key: string
    kind: 'charge' | 'payment'
    ts: number
    order: number
    label: string
    sub: string
    note?: string | null
    taxAmount?: number
    amount: number
    itemId?: string
    paymentId?: string
    balanceAfter: number
  }
  const ledgerEvents: LedgerEvent[] = []
  let _lOrder = 0
  lineItems.forEach((item) => {
    ledgerEvents.push({ key: `item-${item.id}`, kind: 'charge', ts: item.charged_at ? new Date(item.charged_at).getTime() : 0, order: _lOrder++, label: item.description + (item.quantity > 1 ? ` ×${item.quantity}` : ''), sub: fmtLedgerDate(item.charged_at), note: item.notes, taxAmount: item.tax_amount, amount: item.line_total, itemId: item.id, balanceAfter: 0 })
  })
  payments.forEach((p) => {
    ledgerEvents.push({ key: `pay-${p.id}`, kind: 'payment', ts: p.paid_at ? new Date(p.paid_at).getTime() : 0, order: _lOrder++, label: p.method.charAt(0).toUpperCase() + p.method.slice(1), sub: fmtLedgerDate(p.paid_at), note: p.note, amount: p.amount - (p.surcharge_amount || 0), paymentId: p.id, balanceAfter: 0 })
  })
  ledgerEvents.sort((a, b) => a.ts - b.ts || a.order - b.order)
  let _lBal = 0
  ledgerEvents.forEach(ev => {
    if (ev.kind === 'charge') _lBal += ev.amount
    else _lBal -= ev.amount
    ev.balanceAfter = _lBal
  })
  let ledgerFoldIndex = -1
  for (let i = 0; i < ledgerEvents.length - 1; i++) {
    if (ledgerEvents[i].balanceAfter === 0) ledgerFoldIndex = i
  }
  const ledgerHasFold = ledgerFoldIndex >= 0
  const ledgerFoldedCount = ledgerHasFold ? ledgerFoldIndex + 1 : 0
  const ledgerFoldDate = ledgerHasFold ? ledgerEvents[ledgerFoldIndex].sub : ''
  const visibleLedger = ledgerHasFold && !showEarlier ? ledgerEvents.slice(ledgerFoldIndex + 1) : ledgerEvents

  const filteredProducts = products.filter(p => p.category === activeCategory)

  if (loading) return <div style={{ padding: '3rem', textAlign: 'center', color: '#6b7280' }}>Loading account...</div>
  if (!guest) return <div style={{ padding: '3rem', textAlign: 'center', color: '#6b7280' }}>Guest not found.</div>

  return (
    <div style={{ fontFamily: 'sans-serif', minHeight: '100vh', background: '#C9D2D9' }}>
      {/* Header */}
      <div style={{ background: '#fff', borderBottom: '1px solid #b8c4cc', padding: '0.875rem 1.25rem', display: 'flex', alignItems: 'center', gap: 12, boxShadow: '0 1px 4px rgba(0,0,0,0.08)' }}>
        <button onClick={() => router.back()} style={{ background: 'none', border: 'none', color: '#6b7280', cursor: 'pointer', fontSize: 14, whiteSpace: 'nowrap' }}>← Back</button>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <h1 style={{ margin: 0, fontSize: 17, fontWeight: 700 }}>{guest.name}</h1>
            {guest.is_seasonal && <span style={{ fontSize: 11, background: '#e8f2f7', color: '#2E6B8A', borderRadius: 4, padding: '2px 7px', fontWeight: 600 }}>Seasonal</span>}
            {guest.site_number && <span style={{ fontSize: 11, background: '#f3f4f6', color: '#6b7280', borderRadius: 4, padding: '2px 7px' }}>Site {guest.site_number}</span>}
          </div>
          {guest.email && <p style={{ margin: 0, fontSize: 12, color: '#6b7280' }}>{guest.email}{guest.phone ? ' · ' + guest.phone : ''}</p>}
        </div>
        <div style={{ textAlign: 'right', flexShrink: 0 }}>
          <div style={{ fontSize: 20, fontWeight: 800, color: overpaid > 0 ? '#6b7280' : totalDue > 0 ? '#dc2626' : '#15803d' }}>
            {overpaid > 0 ? 'Credit: $' + (overpaid/100).toFixed(2) : '$' + (totalDue/100).toFixed(2)}
          </div>
          <div style={{ fontSize: 11, color: '#6b7280' }}>
            {overpaid > 0 ? 'credit on account' : totalDue > 0 ? 'balance due' : '✓ paid in full'}
          </div>
        </div>
      </div>

      {/* Tab switcher */}
      <div style={{ display: 'flex', borderBottom: '1px solid #b8c4cc', background: '#fff', boxShadow: '0 1px 3px rgba(0,0,0,0.06)' }}>
        <button onClick={() => setActiveTab('tab')} style={{ flex: 1, padding: '12px', fontSize: 14, fontWeight: 600, border: 'none', background: 'none', cursor: 'pointer', borderBottom: activeTab === 'tab' ? '2px solid #2E6B8A' : '2px solid transparent', color: activeTab === 'tab' ? '#2E6B8A' : '#6b7280' }}>Account</button>
        <button onClick={() => { setActiveTab('items'); setActiveCategory('') }} style={{ flex: 1, padding: '12px', fontSize: 14, fontWeight: 600, border: 'none', background: 'none', cursor: 'pointer', borderBottom: activeTab === 'items' ? '2px solid #2E6B8A' : '2px solid transparent', color: activeTab === 'items' ? '#2E6B8A' : '#6b7280' }}>Add Items</button>
      </div>

      <div style={{ display: 'flex', minHeight: 'calc(100vh - 120px)' }}>
        {/* Account tab */}
        <div style={{ flex: 1, padding: '1.25rem', overflowY: 'auto', display: activeTab === 'tab' ? 'block' : 'none', background: '#C9D2D9' }}>

          {ledgerEvents.length > 0 && (
            <div style={{ background: '#fff', border: '1px solid #b8c4cc', borderRadius: 10, marginBottom: 12, overflow: 'hidden' }}>
              <div style={{ display: 'flex', alignItems: 'center', padding: '0.625rem 1rem', borderBottom: '1px solid #f3f4f6' }}>
                <div style={{ flex: 1, fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', color: '#6b7280' }}>Account</div>
                <div style={{ width: 80, textAlign: 'right', fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.04em', color: '#9ca3af' }}>Amount</div>
                <div style={{ width: 92, textAlign: 'right', fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.04em', color: '#9ca3af' }}>Balance</div>
                <div style={{ width: 28, flexShrink: 0 }} />
              </div>

              {ledgerHasFold && (
                <button
                  onClick={() => setShowEarlier(s => !s)}
                  style={{ width: '100%', display: 'flex', alignItems: 'center', gap: 8, padding: '9px 14px', background: '#eef2f5', border: 'none', borderBottom: '1px solid #f3f4f6', cursor: 'pointer', textAlign: 'left', color: '#4a6275', fontSize: 13 }}
                >
                  <span style={{ fontSize: 12 }}>{showEarlier ? '▾' : '▸'}</span>
                  <span>{showEarlier ? `Hide earlier activity · settled ${ledgerFoldDate}` : `Show earlier activity · settled ${ledgerFoldDate} · ${ledgerFoldedCount} ${ledgerFoldedCount === 1 ? 'entry' : 'entries'}`}</span>
                </button>
              )}

              {visibleLedger.map((ev) => {
                const isPay = ev.kind === 'payment'
                const balPositive = ev.balanceAfter > 0
                const balZero = ev.balanceAfter === 0
                const balText = balZero ? 'settled' : balPositive ? 'balance due' : 'credit'
                const balColor = (balZero || !balPositive) ? '#15803d' : '#b45309'
                return (
                  <div key={ev.key} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 14px', borderBottom: '1px solid #f3f4f6', background: isPay ? '#f0fdf4' : '#fff', borderLeft: isPay ? '3px solid #15803d' : '3px solid transparent' }}>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 14, fontWeight: 500 }}>{ev.label}</div>
                      <div style={{ fontSize: 11, color: '#9ca3af' }}>{ev.sub}{isPay ? ' · payment' : ' · charge'}</div>
                      {ev.note && <div style={{ fontSize: 11, color: '#6b7280', fontStyle: 'italic', marginTop: 1 }}>{ev.note}</div>}
                      {ev.taxAmount && ev.taxAmount > 0 ? <div style={{ fontSize: 11, color: '#9ca3af' }}>incl. ${(ev.taxAmount/100).toFixed(2)} tax</div> : null}
                    </div>
                    <div style={{ width: 80, textAlign: 'right', fontSize: 14, fontWeight: 600, color: isPay ? '#15803d' : '#111827' }}>
                      {isPay ? '−' : ''}${(ev.amount/100).toFixed(2)}
                    </div>
                    <div style={{ width: 92, textAlign: 'right' }}>
                      <div style={{ fontSize: 13, fontWeight: 600, color: balColor }}>${(Math.abs(ev.balanceAfter)/100).toFixed(2)}</div>
                      <div style={{ fontSize: 10, color: '#9ca3af' }}>{balText}</div>
                    </div>
                    <div style={{ width: 28, flexShrink: 0, textAlign: 'right' }}>
                      {ev.itemId && (
                        <button onClick={() => removeLineItem(ev.itemId!)} style={{ background: 'none', border: 'none', color: '#dc2626', cursor: 'pointer', fontSize: 18, padding: '0 2px', lineHeight: '1' }}>×</button>
                      )}
                      {ev.paymentId && (
                        <button onClick={() => voidPayment(ev.paymentId!)} style={{ background: 'none', border: 'none', color: '#dc2626', cursor: 'pointer', fontSize: 18, padding: '0 2px', lineHeight: '1' }}>×</button>
                      )}
                    </div>
                  </div>
                )
              })}

              <div style={{ borderTop: '1px solid #e5e7eb', padding: '10px 14px' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, padding: '2px 0' }}>
                  <span style={{ color: '#6b7280' }}>Total charges</span>
                  <span style={{ fontWeight: 600 }}>${(itemsTotal/100).toFixed(2)}</span>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, padding: '2px 0' }}>
                  <span style={{ color: '#6b7280' }}>Total payments</span>
                  <span style={{ fontWeight: 600, color: '#15803d' }}>${(paymentsTotal/100).toFixed(2)}</span>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', borderTop: '1px solid #f3f4f6', marginTop: 6, paddingTop: 6 }}>
                  <span style={{ fontSize: 14, fontWeight: 700, color: '#374151' }}>{overpaid > 0 ? 'Credit on account' : totalDue > 0 ? 'Balance due' : 'Settled'}</span>
                  <span style={{ fontSize: 20, fontWeight: 800, color: totalDue > 0 ? '#dc2626' : '#15803d' }}>${((overpaid > 0 ? overpaid : totalDue)/100).toFixed(2)}</span>
                </div>
              </div>
            </div>
          )}

          {ledgerEvents.length === 0 && (
            <div style={{ textAlign: 'center', color: '#4a6275', padding: '3rem 0', fontSize: 14 }}>
              No charges yet. Tap Add Items to get started.
            </div>
          )}

          <button onClick={() => { setPaymentAmount(totalDue > 0 ? (totalDue/100).toFixed(2) : ''); setCashTendered(''); setShowPayment(true) }} style={{ width: '100%', background: '#2E6B8A', color: '#fff', border: 'none', borderRadius: 10, padding: '14px', fontWeight: 700, fontSize: 16, cursor: 'pointer', marginTop: 8 }}>
            {totalDue > 0 ? `Collect Payment · $${(totalDue/100).toFixed(2)}` : 'Add Payment / Credit'}
          </button>

          {overpaid > 0 && (
            <div style={{ background: '#f0fdf4', border: '1px solid #bbf7d0', borderRadius: 10, padding: '1rem', marginTop: 8, textAlign: 'center' }}>
              <div style={{ fontSize: 16, fontWeight: 700, color: '#15803d' }}>Credit on account: ${(overpaid/100).toFixed(2)}</div>
            </div>
          )}

          {(lineItems.length > 0 || payments.length > 0) && (
            <ReceiptButtons folioId={folio?.id || ''} guestEmail={folio?.guest_email || guest?.email || ''} receiptType='account' />
          )}
        </div>

        {/* Add Items panel */}
        <div style={{ width: 'min(420px, 100%)', background: '#C9D2D9', borderLeft: '1px solid #b8c4cc', display: activeTab === 'items' ? 'flex' : 'none', flexDirection: 'column' }}>
          {activeCategory === '' ? (
            <div style={{ flex: 1, overflowY: 'auto', padding: '1rem', display: 'flex', flexDirection: 'column', gap: 10 }}>
              <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em', color: '#4a6275', marginBottom: 4 }}>Select a category</div>
              {categories.map(cat => (
                <button key={cat} onClick={() => setActiveCategory(cat)}
                  style={{ background: '#2E6B8A', color: '#fff', border: 'none', borderRadius: 12, padding: '18px 20px', fontSize: 16, fontWeight: 700, cursor: 'pointer', textAlign: 'left', display: 'flex', alignItems: 'center', justifyContent: 'space-between', boxShadow: '0 2px 6px rgba(46,107,138,0.3)' }}
                  onMouseEnter={e => (e.currentTarget.style.background = '#245875')}
                  onMouseLeave={e => (e.currentTarget.style.background = '#2E6B8A')}
                >
                  <span>{cat}</span>
                  <span style={{ fontSize: 20, opacity: 0.7 }}>›</span>
                </button>
              ))}
            </div>
          ) : (
            <>
              <div style={{ padding: '0.75rem 1rem', borderBottom: '1px solid #b8c4cc', background: 'rgba(255,255,255,0.5)', display: 'flex', alignItems: 'center', gap: 10 }}>
                <button onClick={() => setActiveCategory('')} style={{ background: '#2E6B8A', color: '#fff', border: 'none', borderRadius: 8, padding: '6px 14px', fontSize: 13, fontWeight: 600, cursor: 'pointer' }}>‹ Back</button>
                <span style={{ fontWeight: 700, fontSize: 14, color: '#1e3f52' }}>{activeCategory}</span>
              </div>
              <div style={{ flex: 1, overflowY: 'auto', padding: '0.875rem', display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, alignContent: 'start' }}>
                {filteredProducts.map(product => (
                  <VariableProductTile key={product.id} product={product} onAdd={addProduct} />
                ))}
                {filteredProducts.length === 0 && (
                  <div style={{ gridColumn: '1/-1', textAlign: 'center', color: '#4a6275', fontSize: 13, padding: '2rem 0' }}>No products in this category</div>
                )}
              </div>
            </>
          )}
          <div style={{ borderTop: '1px solid #b8c4cc', padding: '0.875rem', background: 'rgba(255,255,255,0.3)' }}>
            {!showCustomItem ? (
              <button onClick={() => setShowCustomItem(true)} style={{ width: '100%', background: 'none', border: '1px dashed #7a9ab0', borderRadius: 8, padding: '10px', fontSize: 13, color: '#4a6275', cursor: 'pointer' }}>+ Custom charge</button>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                <input style={si} placeholder='Description' value={customDesc} onChange={e => setCustomDesc(e.target.value)} />
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                  <input style={si} placeholder='Price $' value={customPrice} onChange={e => setCustomPrice(e.target.value)} />
                  <input style={si} placeholder='Qty' value={customQty} onChange={e => setCustomQty(e.target.value)} />
                </div>
                <div style={{ display: 'flex', gap: 8 }}>
                  <button onClick={() => setShowCustomItem(false)} style={{ flex: 1, background: 'none', border: '1px solid #b8c4cc', borderRadius: 7, padding: '8px', fontSize: 13, cursor: 'pointer' }}>Cancel</button>
                  <button onClick={addCustomItem} style={{ flex: 1, background: '#2E6B8A', color: '#fff', border: 'none', borderRadius: 7, padding: '8px', fontSize: 13, fontWeight: 600, cursor: 'pointer' }}>Add</button>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Payment modal */}
      {showPayment && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 50, display: 'flex', alignItems: 'flex-end', justifyContent: 'center' }}>
          <div style={{ background: '#fff', borderRadius: '16px 16px 0 0', padding: '1.5rem', width: '100%', maxWidth: 520 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1.25rem' }}>
              <h2 style={{ margin: 0, fontSize: 18, fontWeight: 700 }}>Collect Payment</h2>
              <button onClick={() => { setShowPayment(false); setCashTendered('') }} style={{ background: 'none', border: 'none', fontSize: 22, cursor: 'pointer', color: '#6b7280' }}>×</button>
            </div>
            <label style={ml}>Payment method</label>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8, marginBottom: 16 }}>
              {['cash', 'card', 'check'].map(m => (
                <button key={m} onClick={() => setPaymentMethod(m)} style={{ padding: '12px', border: '2px solid ' + (paymentMethod === m ? '#2E6B8A' : '#e5e7eb'), borderRadius: 8, background: paymentMethod === m ? '#e8f2f7' : '#fff', fontWeight: 600, fontSize: 14, cursor: 'pointer', textTransform: 'capitalize', color: paymentMethod === m ? '#2E6B8A' : '#374151' }}>
                  {m}
                </button>
              ))}
            </div>
            {paymentMethod === 'card' && terminalDeviceId && (
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 14 }}>
                <button onClick={() => setCardEntryMode('terminal')} style={{ padding: '11px', border: '2px solid ' + (cardEntryMode === 'terminal' ? '#2E6B8A' : '#e5e7eb'), borderRadius: 8, background: cardEntryMode === 'terminal' ? '#e8f2f7' : '#fff', fontWeight: 600, fontSize: 13, cursor: 'pointer', color: cardEntryMode === 'terminal' ? '#2E6B8A' : '#374151' }}>
                  Use Terminal
                </button>
                <button onClick={() => setCardEntryMode('manual')} style={{ padding: '11px', border: '2px solid ' + (cardEntryMode === 'manual' ? '#2E6B8A' : '#e5e7eb'), borderRadius: 8, background: cardEntryMode === 'manual' ? '#e8f2f7' : '#fff', fontWeight: 600, fontSize: 13, cursor: 'pointer', color: cardEntryMode === 'manual' ? '#2E6B8A' : '#374151' }}>
                  Enter Manually
                </button>
              </div>
            )}
            {paymentMethod === 'card' && cardSurcharge > 0 && (
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14, padding: '10px 14px', background: waiveFee ? '#f0fdf4' : '#fffbeb', border: '1px solid', borderColor: waiveFee ? '#bbf7d0' : '#fde68a', borderRadius: 8 }}>
                <div>
                  <div style={{ fontSize: 13, fontWeight: 600, color: '#374151' }}>Card fee ({cardSurcharge}%)</div>
                  <div style={{ fontSize: 12, color: '#6b7280' }}>{waiveFee ? 'Fee waived for this payment' : 'Applied to card payments'}</div>
                </div>
                <button
                  type='button'
                  onClick={() => setWaiveFee(!waiveFee)}
                  style={{ width: 40, height: 22, borderRadius: 11, border: 'none', cursor: 'pointer', backgroundColor: waiveFee ? '#15803d' : '#d1d5db', position: 'relative', flexShrink: 0 }}
                >
                  <span style={{ position: 'absolute', top: 3, left: waiveFee ? 21 : 3, width: 16, height: 16, borderRadius: '50%', backgroundColor: 'white', transition: 'left 0.2s' }} />
                </button>
              </div>
            )}
            <label style={ml}>{totalDue === 0 ? 'Amount to add' : paymentMethod === 'cash' ? 'Amount due' : 'Amount'}</label>
            <div style={{ position: 'relative', marginBottom: 8 }}>
              <span style={{ position: 'absolute', left: 14, top: '50%', transform: 'translateY(-50%)', color: '#6b7280', fontSize: 18 }}>$</span>
              <input style={{ ...si, paddingLeft: 30, fontSize: 24, fontWeight: 700, height: 56, background: (paymentMethod === 'cash' && totalDue !== 0) ? '#f9fafb' : '#fff', color: (paymentMethod === 'cash' && totalDue !== 0) ? '#6b7280' : '#111827' }} type='number' step='0.01' value={paymentAmount} readOnly={paymentMethod === 'cash' && totalDue !== 0} placeholder={totalDue === 0 ? '0.00' : undefined} onChange={e => setPaymentAmount(e.target.value)} />
            </div>
            {paymentMethod === 'cash' && totalDue !== 0 && (
              <>
                <label style={ml}>Cash tendered</label>
                <div style={{ position: 'relative', marginBottom: 8 }}>
                  <span style={{ position: 'absolute', left: 14, top: '50%', transform: 'translateY(-50%)', color: '#6b7280', fontSize: 18 }}>$</span>
                  <input style={{ ...si, paddingLeft: 30, fontSize: 24, fontWeight: 700, height: 56 }} type='number' step='0.01' value={cashTendered} onChange={e => setCashTendered(e.target.value)} placeholder='0.00' autoFocus />
                </div>
                {parseFloat(cashTendered) > 0 && (
                  <>
                    <div style={{ background: parseFloat(cashTendered) >= parseFloat(paymentAmount) ? '#f0fdf4' : '#fef2f2', border: '1px solid', borderColor: parseFloat(cashTendered) >= parseFloat(paymentAmount) ? '#bbf7d0' : '#fecaca', borderRadius: 8, padding: '10px 14px', marginBottom: 8, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <span style={{ fontWeight: 600, fontSize: 14, color: parseFloat(cashTendered) >= parseFloat(paymentAmount) ? '#15803d' : '#dc2626' }}>
                        {parseFloat(cashTendered) >= parseFloat(paymentAmount) ? 'Change due' : 'Amount short'}
                      </span>
                      <span style={{ fontWeight: 800, fontSize: 18, color: parseFloat(cashTendered) >= parseFloat(paymentAmount) ? '#15803d' : '#dc2626' }}>
                        <span>$</span>{Math.abs(parseFloat(cashTendered) - parseFloat(paymentAmount)).toFixed(2)}
                      </span>
                    </div>
                    {maxCreditAmount > 0 && parseFloat(cashTendered) > parseFloat(paymentAmount) && (() => {
                      const overpayment = Math.round((parseFloat(cashTendered) - parseFloat(paymentAmount)) * 100)
                      const exceedsCap = overpayment > maxCreditAmount
                      return (
                        <div style={{ marginBottom: 12 }}>
                          <div style={{ display: 'flex', gap: 8, marginBottom: exceedsCap ? 6 : 0 }}>
                            <button
                              type='button'
                              onClick={() => setCashTendered('')}
                              style={{ flex: 1, background: '#f3f4f6', border: '1px solid #e5e7eb', borderRadius: 8, padding: '10px', fontSize: 13, fontWeight: 600, color: '#374151', cursor: 'pointer' }}>
                              Give <span>$</span>{(overpayment/100).toFixed(2)} Change
                            </button>
                            <button
                              type='button'
                              onClick={() => !exceedsCap && setPaymentAmount(cashTendered)}
                              style={{ flex: 1, background: exceedsCap ? '#f9fafb' : '#f0fdf4', border: '1px solid', borderColor: exceedsCap ? '#e5e7eb' : '#bbf7d0', borderRadius: 8, padding: '10px', fontSize: 13, fontWeight: 600, color: exceedsCap ? '#9ca3af' : '#15803d', cursor: exceedsCap ? 'not-allowed' : 'pointer', opacity: exceedsCap ? 0.7 : 1 }}>
                              Apply <span>$</span>{(overpayment/100).toFixed(2)} as Credit
                            </button>
                          </div>
                          {exceedsCap && (
                            <div style={{ background: '#fef3c7', border: '1px solid #fde68a', borderRadius: 6, padding: '6px 10px', fontSize: 12, color: '#92400e' }}>
                              Overpayment of <span>$</span>{(overpayment/100).toFixed(2)} exceeds the <span>$</span>{(maxCreditAmount/100).toFixed(2)} credit limit — please give change instead.
                            </div>
                          )}
                        </div>
                      )
                    })()}
                  </>
                )}
              </>
            )}
            {paymentMethod === 'card' && cardSurcharge > 0 && paymentAmountCents > 0 && (
              <div style={{ background: '#fffbeb', border: '1px solid #fde68a', borderRadius: 8, padding: '10px 14px', marginBottom: 12, fontSize: 13 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                  <span style={{ color: '#92400e' }}>{cardSurcharge}% card fee</span>
                  <span style={{ color: '#92400e', fontWeight: 600 }}>+${(surchargePreview/100).toFixed(2)}</span>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 4, fontWeight: 700 }}>
                  <span style={{ color: '#92400e' }}>Total charged to card</span>
                  <span style={{ color: '#92400e' }}>${(totalWithSurcharge/100).toFixed(2)}</span>
                </div>
              </div>
            )}
            <label style={ml}>Note (optional)</label>
            <input style={{ ...si, marginBottom: 16 }} placeholder='e.g. May electric bill' value={paymentNote} onChange={e => setPaymentNote(e.target.value)} />
            {paymentMethod === 'card' && cardEntryMode === 'terminal' && terminalDeviceId ? (
              <div>
                {terminalStatus === 'waiting' ? (
                  <div style={{ background: '#f0f9ff', border: '1px solid #bae6fd', borderRadius: 12, padding: '1.5rem', textAlign: 'center' }}>
                    <div style={{ fontSize: 32, marginBottom: 8 }}>🖥</div>
                    <div style={{ fontWeight: 700, fontSize: 15, color: '#0369a1', marginBottom: 4 }}>Waiting for Terminal...</div>
                    <div style={{ fontSize: 13, color: '#0284c7' }}>Have guest tap, swipe, or insert card</div>
                  </div>
                ) : terminalStatus === 'error' ? (
                  <div style={{ background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 12, padding: '1rem', textAlign: 'center' }}>
                    <div style={{ fontWeight: 700, color: '#dc2626', marginBottom: 6 }}>Payment canceled or failed</div>
                    <button onClick={() => setTerminalStatus('idle')} style={{ background: '#fff', border: '1px solid #d1d5db', borderRadius: 8, padding: '8px 16px', fontSize: 13, cursor: 'pointer' }}>Try again</button>
                  </div>
                ) : (
                  <div style={{ background: '#f0f9ff', border: '1px solid #bae6fd', borderRadius: 12, padding: '1.25rem', textAlign: 'center' }}>
                    <div style={{ fontSize: 28, marginBottom: 6 }}>💳</div>
                    <div style={{ fontWeight: 700, fontSize: 14, color: '#0369a1', marginBottom: 2 }}>Send to Square Terminal</div>
                    <div style={{ fontSize: 13, color: '#6b7280', marginBottom: 12 }}>
                      Amount: <strong>${(paymentAmountCents/100).toFixed(2)}</strong>
                      {surchargePreview > 0 && !waiveFee && <> + {cardSurcharge}% fee = <strong>${(totalWithSurcharge/100).toFixed(2)}</strong></>}
                    </div>
                    <button
                      onClick={sendToTerminal}
                      disabled={!paymentAmountCents}
                      style={{ width: '100%', background: paymentAmountCents ? '#2E6B8A' : '#d1d5db', color: '#fff', border: 'none', borderRadius: 10, padding: '14px', fontWeight: 700, fontSize: 16, cursor: paymentAmountCents ? 'pointer' : 'default' }}
                    >
                      Send to Terminal →
                    </button>
                  </div>
                )}
              </div>
            ) : (
              <button onClick={collectPayment} disabled={savingPayment} style={{ width: '100%', background: '#2E6B8A', color: '#fff', border: 'none', borderRadius: 10, padding: '14px', fontWeight: 700, fontSize: 16, cursor: 'pointer' }}>
                {savingPayment ? 'Recording...' : paymentMethod === 'card' && surchargePreview > 0 ? 'Charge card · $' + (totalWithSurcharge/100).toFixed(2) : paymentMethod === 'cash' && cashTendered !== '' ? 'Record cash · $' + Math.min(parseFloat(cashTendered), parseFloat(paymentAmount)).toFixed(2) : 'Record ' + paymentMethod + ' · $' + paymentAmount}
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

function VariableProductTile({ product, onAdd }: { product: any, onAdd: (p: any, price?: number, qty?: number, notes?: string) => void }) {
  const [customPrice, setCustomPrice] = useState('')
  const [qty, setQty] = useState(1)
  const [notes, setNotes] = useState('')

  function handleAdd(overridePrice?: number) {
    onAdd(product, overridePrice, qty, notes)
    setQty(1)
    setNotes('')
    setCustomPrice('')
  }

  const tileStyle: React.CSSProperties = { background: '#f9fafb', border: '1px solid #e5e7eb', borderRadius: 12, padding: '14px', display: 'flex', flexDirection: 'column', gap: 10 }

  const qtyRow = (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      <button
        onClick={() => setQty(q => Math.max(1, q - 1))}
        style={{ width: 40, height: 40, borderRadius: 8, border: '1px solid #d1d5db', background: '#fff', fontSize: 20, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#374151', flexShrink: 0 }}
      >−</button>
      <span style={{ minWidth: 28, textAlign: 'center', fontWeight: 700, fontSize: 18 }}>{qty}</span>
      <button
        onClick={() => setQty(q => q + 1)}
        style={{ width: 40, height: 40, borderRadius: 8, border: '1px solid #d1d5db', background: '#fff', fontSize: 20, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#374151', flexShrink: 0 }}
      >+</button>
    </div>
  )

  if (!product.variable_price) {
    return (
      <div style={tileStyle}>
        <div style={{ fontWeight: 700, fontSize: 15 }}>{product.name}</div>
        <div style={{ fontSize: 18, color: '#15803d', fontWeight: 700 }}>${(product.price/100).toFixed(2)}{product.tax_class === 'standard' && <span style={{ fontSize: 11, color: '#9ca3af', fontWeight: 400 }}> + tax</span>}</div>
        {qtyRow}
        <input
          placeholder="Note (optional)"
          value={notes}
          onChange={e => setNotes(e.target.value)}
          style={{ width: '100%', border: '1px solid #d1d5db', borderRadius: 8, padding: '10px 12px', fontSize: 13, color: '#374151', boxSizing: 'border-box' }}
        />
        <button
          onClick={() => handleAdd()}
          style={{ width: '100%', background: '#2E6B8A', color: '#fff', border: 'none', borderRadius: 8, padding: '12px', fontSize: 15, fontWeight: 700, cursor: 'pointer' }}
        >
          Add to Tab
        </button>
      </div>
    )
  }

  return (
    <div style={tileStyle}>
      <div style={{ fontWeight: 700, fontSize: 15 }}>{product.name}</div>
      <div style={{ position: 'relative' }}>
        <span style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: '#6b7280', fontSize: 16 }}>$</span>
        <input
          type='number'
          min='0'
          step='0.01'
          placeholder='0.00'
          value={customPrice}
          onChange={e => setCustomPrice(e.target.value)}
          style={{ width: '100%', border: '1px solid #d1d5db', borderRadius: 8, padding: '10px 10px 10px 26px', fontSize: 16, boxSizing: 'border-box' }}
        />
      </div>
      {qtyRow}
      <input
        placeholder="Note (optional)"
        value={notes}
        onChange={e => setNotes(e.target.value)}
        style={{ width: '100%', border: '1px solid #d1d5db', borderRadius: 8, padding: '10px 12px', fontSize: 13, color: '#374151', boxSizing: 'border-box' }}
      />
      <button
        onClick={() => { if (customPrice) handleAdd(Math.round(parseFloat(customPrice) * 100)) }}
        disabled={!customPrice || parseFloat(customPrice) <= 0}
        style={{ width: '100%', background: customPrice && parseFloat(customPrice) > 0 ? '#2E6B8A' : '#d1d5db', color: '#fff', border: 'none', borderRadius: 8, padding: '12px', fontSize: 15, fontWeight: 700, cursor: customPrice ? 'pointer' : 'default' }}
      >
        Add to Tab
      </button>
    </div>
  )
}

function ReceiptButtons({ folioId, guestEmail, receiptType }: { folioId: string, guestEmail: string, receiptType: string }) {
  const [sending, setSending] = useState(false)
  const [sent, setSent] = useState(false)
  const [error, setError] = useState('')

  async function sendReceipt() {
    if (!guestEmail) { setError('No email on file for this guest'); return }
    setSending(true)
    setError('')
    const res = await fetch('/api/receipt', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ folioId, receiptType }),
    })
    const data = await res.json()
    setSending(false)
    if (data.success) { setSent(true); setTimeout(() => setSent(false), 3000) }
    else setError(data.error || 'Failed to send receipt')
  }

  return (
    <div style={{ marginTop: 12, display: 'flex', gap: 8, flexDirection: 'column' }}>
      <div style={{ display: 'flex', gap: 8 }}>
        <button
          onClick={sendReceipt}
          disabled={sending}
          style={{ flex: 1, background: sent ? '#15803d' : '#fff', color: sent ? '#fff' : '#2E6B8A', border: '1px solid #2E6B8A', borderRadius: 8, padding: '10px', fontSize: 13, fontWeight: 600, cursor: 'pointer' }}
        >
          {sending ? 'Sending...' : sent ? '✓ Receipt sent!' : '✉ Send Receipt'}
        </button>
        <button
          onClick={() => window.print()}
          style={{ flex: 1, background: '#fff', color: '#6b7280', border: '1px solid #d1d5db', borderRadius: 8, padding: '10px', fontSize: 13, fontWeight: 600, cursor: 'pointer' }}
        >
          🖨 Print
        </button>
      </div>
      {!guestEmail && <p style={{ fontSize: 12, color: '#9ca3af', margin: 0, textAlign: 'center' }}>No email on file — print only</p>}
      {error && <p style={{ fontSize: 12, color: '#dc2626', margin: 0 }}>{error}</p>}
    </div>
  )
}

const si: React.CSSProperties = { width: '100%', border: '1px solid #d1d5db', borderRadius: 7, padding: '8px 10px', fontSize: 14, boxSizing: 'border-box' }
const ml: React.CSSProperties = { display: 'block', fontSize: 13, fontWeight: 600, color: '#374151', marginBottom: 6 }