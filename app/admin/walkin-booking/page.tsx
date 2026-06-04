'use client'
import { useEffect, useState, useRef } from 'react'
import { createClient } from '@supabase/supabase-js'
import { useRouter } from 'next/navigation'
import toast, { Toaster } from 'react-hot-toast'

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
)

type Site = {
  id: string
  site_number: string
  site_type: string
  base_rate: number
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

type Payment = {
  id: string
  method: string
  amount: number
  surcharge_amount: number
  status: string
  note: string
  paid_at: string
}

type LineItem = {
  id: string
  description: string
  quantity: number
  unit_price: number
  tax_amount: number
  line_total: number
}

const FALLBACK_CATEGORIES = ['Camping Supplies', 'Food & Drink', 'Rentals', 'Fees', 'General']

function siteTypeLabel(type: string) {
  if (type === 'rv_site') return 'RV'
  if (type === 'cabin') return 'Cabin'
  if (type === 'tent') return 'Tent'
  if (type === 'yurt') return 'Yurt'
  if (type === 'tiny_home') return 'Tiny Home'
  if (type === 'lodge') return 'Lodge'
  if (type === 'glamping') return 'Glamping'
  if (type === 'treehouse') return 'Treehouse'
  return type
}

export default function WalkInBookingPage() {
  const router = useRouter()
  const [phase, setPhase] = useState<'booking'|'payment'>('booking')
  const [sites, setSites] = useState<Site[]>([])
  const [products, setProducts] = useState<Product[]>([])
  const [categories, setCategories] = useState<string[]>(FALLBACK_CATEGORIES)
  const [cardSurcharge, setCardSurcharge] = useState(0)
  const [cardOnlyFeeTotal, setCardOnlyFeeTotal] = useState(0)
  const [allFees, setAllFees] = useState<any[]>([])
  const [pricingRules, setPricingRules] = useState<any[]>([])
  const [saving, setSaving] = useState(false)
  const [reservationId, setReservationId] = useState('')
  const [folioId, setFolioId] = useState('')
  const [lineItems, setLineItems] = useState<LineItem[]>([])
  const [payments, setPayments] = useState<Payment[]>([])
  const [activeCategory, setActiveCategory] = useState('')
  const [showCustomItem, setShowCustomItem] = useState(false)
  const [customDesc, setCustomDesc] = useState('')
  const [customPrice, setCustomPrice] = useState('')
  const [customQty, setCustomQty] = useState('1')
  const [showPayment, setShowPayment] = useState(false)
  const [paymentMethod, setPaymentMethod] = useState('cash')
  const [waiveFee, setWaiveFee] = useState(false)
  const [lockedMethod, setLockedMethod] = useState('')
  const [paymentAmount, setPaymentAmount] = useState('')
  const [cashTendered, setCashTendered] = useState('')
  const [paymentNote, setPaymentNote] = useState('')
  const [savingPayment, setSavingPayment] = useState(false)
  const [terminalDeviceId, setTerminalDeviceId] = useState('')
  const [terminalStatus, setTerminalStatus] = useState('')
  const [sendingToTerminal, setSendingToTerminal] = useState(false)
  const [cardEntryMode, setCardEntryMode] = useState<'terminal'|'manual'>('terminal')
  const [squareCardRef, setSquareCardRef] = useState<any>(null)
  const [squareCardLoaded, setSquareCardLoaded] = useState(false)
  const [squareInstance, setSquareInstance] = useState<any>(null)
  const [chargingCard, setChargingCard] = useState(false)
  const cardLoadingRef = useRef(false)
  const [priceOverride, setPriceOverride] = useState('')
  const [adultsDisplay, setAdultsDisplay] = useState('2')
  const [childrenDisplay, setChildrenDisplay] = useState('')

  const [form, setForm] = useState({
    guest_name: '',
    guest_email: '',
    guest_phone: '',
    site_id: '',
    arrival_date: '',
    departure_date: '',
    num_adults: 2,
    num_children: 0,
    camper_type: '',
    camper_length: '',
    camper_amperage: '',
    notes: '',
  })

  useEffect(() => { fetchData() }, [])

  async function fetchData() {
    const [{ data: siteData }, { data: prods }, { data: settings }, { data: cats }, { data: feesData }, { data: rulesData }] = await Promise.all([
      supabase.from('sites').select('*').eq('is_available', true).order('display_order'),
      supabase.from('products').select('*').eq('active', true).order('display_order'),
      supabase.from('settings').select('card_surcharge_percent, square_terminal_device_id').single(),
      supabase.from('product_categories').select('name').order('display_order'),
      supabase.from('fees').select('*').eq('is_active', true),
      supabase.from('pricing_rules').select('*').eq('is_active', true),
    ])
    setSites(siteData || [])
    setProducts(prods || [])
    if (settings?.card_surcharge_percent) setCardSurcharge(Number(settings.card_surcharge_percent))
    if (settings?.square_terminal_device_id) setTerminalDeviceId(settings.square_terminal_device_id)
    if (cats && cats.length > 0) setCategories(cats.map((c: any) => c.name))
    if (feesData) setAllFees(feesData)
    if (rulesData) setPricingRules(rulesData)
  }

  async function refetchSites(arrivalDate: string, departureDate: string) {
    const { data: allSites } = await supabase.from('sites').select('*').eq('is_available', true).order('display_order')
    if (!arrivalDate || !departureDate || !allSites) { setSites(allSites || []); return }
    const { data: conflicts } = await supabase
      .from('reservations')
      .select('site_id')
      .neq('status', 'cancelled')
      .lt('arrival_date', departureDate)
      .gt('departure_date', arrivalDate)
    const conflictIds = new Set((conflicts || []).map((r: any) => r.site_id))
    setSites(allSites.filter((s: any) => !conflictIds.has(s.id)))
  }

  const selectedSite = sites.find(s => s.id === form.site_id)
  const isRvSite = selectedSite?.site_type === 'rv_site'
  const applicablePricingRules = selectedSite && form.arrival_date && form.departure_date ? pricingRules.filter(rule => {
    const withinDates = rule.start_date <= form.departure_date && rule.end_date >= form.arrival_date
    if (!withinDates) return false
    if (rule.site_ids) return rule.site_ids.split(',').includes(selectedSite.id)
    if (rule.site_id) return rule.site_id === selectedSite.id
    if (rule.site_type) return rule.site_type === selectedSite.site_type
    return false
  }) : []
  const bestPricingRule = applicablePricingRules.sort((a: any, b: any) => b.priority - a.priority)[0]
  const nightlyRate = selectedSite ? (bestPricingRule ? bestPricingRule.nightly_rate : selectedSite.base_rate) : 0
  const nights = form.arrival_date && form.departure_date
    ? Math.round((new Date(form.departure_date).getTime() - new Date(form.arrival_date).getTime()) / (1000 * 60 * 60 * 24))
    : 0
  const calculatedTotal = selectedSite ? nightlyRate * nights : 0
  const total = priceOverride !== '' ? Math.round(parseFloat(priceOverride) * 100) : calculatedTotal

  // Card-only fee calculation for cash/card split
  const applicableFees = selectedSite ? allFees.filter((f: any) => {
    if (f.applies_to === 'all') return true
    const targets = f.applies_to.split(',').map((s: string) => s.trim())
    return targets.includes(selectedSite.site_type)
  }) : []
  const cardOnlyFees = applicableFees.filter((f: any) => f.card_only && f.is_active)


  async function createBooking() {
    if (!form.guest_name.trim()) { toast.error('Guest name is required'); return }
    if (!form.site_id) { toast.error('Please select a site'); return }
    if (!form.arrival_date || !form.departure_date) { toast.error('Please enter dates'); return }
    if (nights <= 0) { toast.error('Departure must be after arrival'); return }
    setSaving(true)
    const response = await fetch('/api/manual-booking', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        site_id: form.site_id,
        arrival_date: form.arrival_date,
        departure_date: form.departure_date,
        num_adults: form.num_adults,
        num_children: form.num_children,
        guest_name: form.guest_name,
        guest_email: form.guest_email,
        guest_phone: form.guest_phone,
        camper_type: isRvSite ? form.camper_type : '',
        camper_length: isRvSite && form.camper_length ? parseInt(form.camper_length) : 0,
        camper_amperage: isRvSite ? form.camper_amperage : '',
        base_nightly_rate: selectedSite?.base_rate || 0,
        extra_guest_fee_total: 0,
        addons_total: 0,
        total_price: total,
        amount_paid: 0,
        payment_type: 'unpaid',
        notes: form.notes,
        addonItems: [],
      }),
    })
    const data = await response.json()
    if (!response.ok || !data.success) {
      toast.error(data.error || 'Error creating reservation')
      setSaving(false)
      return
    }
    // Create folio for this reservation
    const { data: newFolio } = await supabase.from('folios').insert({
      reservation_id: data.reservationId,
      guest_name: form.guest_name,
      guest_email: form.guest_email || '',
      folio_type: 'walkup',
      status: 'open',
    }).select().single()
    if (newFolio) {
      setFolioId(newFolio.id)
      await loadFolioData(newFolio.id)
    }
    setReservationId(data.reservationId)
    setSaving(false)
    setPhase('payment')
    toast.success('Reservation created!')
  }

  async function loadFolioData(fId: string) {
    const [{ data: items }, { data: pmts }] = await Promise.all([
      supabase.from('folio_line_items').select('*').eq('folio_id', fId).order('charged_at'),
      supabase.from('folio_payments').select('*').eq('folio_id', fId).eq('status', 'completed').order('paid_at'),
    ])
    setLineItems(items || [])
    setPayments(pmts || [])
  }

  async function addProduct(product: Product, overridePrice?: number) {
    if (!folioId) return
    const price = overridePrice ?? product.price
    const taxAmount = product.tax_class === 'standard' ? Math.round(price * 0.06) : 0
    await supabase.from('folio_line_items').insert({
      folio_id: folioId,
      product_id: product.id,
      description: product.name,
      quantity: 1,
      unit_price: price,
      tax_amount: taxAmount,
      line_total: price + taxAmount,
      category: product.category,
    })
    await loadFolioData(folioId)
    setActiveCategory('')
  }

  async function addCustomItem() {
    if (!folioId || !customDesc.trim()) return
    const price = Math.round(parseFloat(customPrice) * 100) || 0
    const qty = parseInt(customQty) || 1
    await supabase.from('folio_line_items').insert({
      folio_id: folioId,
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
    await loadFolioData(folioId)
    setActiveCategory('')
  }

  async function removeLineItem(id: string) {
    if (!confirm('Remove this item?')) return
    await supabase.from('folio_line_items').delete().eq('id', id)
    await loadFolioData(folioId)
  }

  async function loadSquareCard() {
    if (cardLoadingRef.current) return
    const container = document.getElementById('walkin-square-card')
    if (!container) return
    cardLoadingRef.current = true
    container.innerHTML = ''
    try {
      let sq = squareInstance
      if (!sq) {
        if (!(window as any).Square) {
          const script = document.createElement('script')
          script.src = process.env.NEXT_PUBLIC_SQUARE_ENVIRONMENT === 'production'
            ? 'https://web.squarecdn.com/v1/square.js'
            : 'https://sandbox.web.squarecdn.com/v1/square.js'
          await new Promise((resolve) => { script.onload = resolve; document.head.appendChild(script) })
        }
        sq = (window as any).Square.payments(process.env.NEXT_PUBLIC_SQUARE_APP_ID!, 'L42H3PRBWB5CJ')
        setSquareInstance(sq)
      }
      const card = await sq.card()
      await card.attach('#walkin-square-card')
      setSquareCardRef(card)
      setSquareCardLoaded(true)
    } catch (e) { console.error('Square card load error:', e); cardLoadingRef.current = false }
  }

  async function chargeManualCard() {
    if (!squareCardRef || !folioId) return
    setChargingCard(true)
    try {
      const result = await squareCardRef.tokenize()
      if (result.status !== 'OK') { setChargingCard(false); return }
      const baseAmount = Math.round(parseFloat(paymentAmount) * 100)
      const surchargeAmount = cardSurcharge > 0 && !waiveFee
        ? Math.round(baseAmount * (cardSurcharge / 100)) : 0
      const totalAmount = baseAmount + surchargeAmount
      const res = await fetch('/api/admin-card-payment', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sourceId: result.token,
          folioId,
          amount: totalAmount,
          surchargeAmount,
          guestName: form.guest_name || '',
        }),
      })
      const data = await res.json()
      if (data.success) {
        setShowPayment(false)
        setPaymentAmount('')
        setPaymentNote('')
        setCardEntryMode('terminal')
        setSquareCardLoaded(false)
        setSquareCardRef(null)
        cardLoadingRef.current = false
        await loadFolioData(folioId)
      } else {
        alert(data.error || 'Card payment failed')
      }
    } catch (e) { console.error('Card charge error:', e) }
    setChargingCard(false)
  }

  async function sendToTerminal() {
    if (!folioId) return
    const surchargeAmount = cardSurcharge > 0 ? Math.round(totalDue * (cardSurcharge / 100)) : 0
    const totalAmount = totalDue + surchargeAmount
    setSendingToTerminal(true)
    setTerminalStatus('')
    const res = await fetch('/api/terminal/charge', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        folioId,
        amount: totalAmount,
        surchargeAmount,
        note: form.guest_name + (selectedSite ? ' · Site ' + selectedSite.site_number : ''),
      }),
    })
    const data = await res.json()
    setSendingToTerminal(false)
    if (data.success) {
      setTerminalStatus('waiting')
      setShowPayment(false)
      let attempts = 0
      const prevCount = payments.length
      const interval = setInterval(async () => {
        attempts++
        const [{ data: items }, { data: pmts }] = await Promise.all([
          supabase.from('folio_line_items').select('*').eq('folio_id', folioId).order('charged_at'),
          supabase.from('folio_payments').select('*').eq('folio_id', folioId).eq('status', 'completed').order('paid_at'),
        ])
        setLineItems(items || [])
        setPayments(pmts || [])
        if (pmts && pmts.length > prevCount) {
          clearInterval(interval)
          setTerminalStatus('completed')
          setTimeout(() => setTerminalStatus(''), 3000)
        }
        if (attempts >= 60) { clearInterval(interval); setTerminalStatus('timeout') }
      }, 3000)
    } else {
      setTerminalStatus('error: ' + (data.error || 'Failed to send to Terminal'))
    }
  }

  async function collectPayment() {
    if (!folioId) return
    const baseAmount = paymentMethod === 'cash' && cashTendered !== ''
      ? Math.min(Math.round(parseFloat(cashTendered) * 100), Math.round(parseFloat(paymentAmount) * 100))
      : Math.round(parseFloat(paymentAmount) * 100)
    if (!baseAmount || baseAmount <= 0) return
    const surchargeAmount = paymentMethod === 'card' && cardSurcharge > 0
      ? Math.round(baseAmount * (cardSurcharge / 100))
      : 0
    const totalAmount = baseAmount + surchargeAmount
    setSavingPayment(true)
    await supabase.from('folio_payments').insert({
      folio_id: folioId,
      method: paymentMethod,
      amount: totalAmount,
      surcharge_amount: surchargeAmount,
      status: 'completed',
      note: paymentNote + (surchargeAmount > 0 ? ' (incl. ' + cardSurcharge + '% card fee: $' + (surchargeAmount/100).toFixed(2) + ')' : ''),
    })
    // Update reservation amount_paid
    const newAmountPaid = payments.reduce((sum, p) => sum + p.amount - (p.surcharge_amount || 0), 0) + baseAmount
    await supabase.from('reservations').update({ amount_paid: newAmountPaid, payment_type: 'full' }).eq('id', reservationId)
    setSavingPayment(false)
    setShowPayment(false)
    setPaymentAmount('')
    setCashTendered('')
    setPaymentNote('')
    setPaymentMethod('cash')
    await loadFolioData(folioId)
  }

  const itemsTotal = lineItems.reduce((sum, i) => sum + i.line_total, 0)
  const paymentsTotal = payments.reduce((sum, p) => sum + p.amount - (p.surcharge_amount || 0), 0)
  const totalDue = Math.max(0, total + itemsTotal - paymentsTotal)
  const realCardOnlyFeeTotal = cardOnlyFees.reduce((sum: number, f: any) =>
    sum + (f.type === 'percentage' ? Math.round(totalDue * f.amount / 100) : f.amount), 0)
  const overpaid = cashTendered !== '' && parseFloat(cashTendered) > parseFloat(paymentAmount) ? Math.round((parseFloat(cashTendered) - parseFloat(paymentAmount)) * 100) : 0
  const paymentAmountCents = Math.round(parseFloat(paymentAmount) * 100) || 0
  const surchargePreview = paymentMethod === 'card' && cardSurcharge > 0 && !waiveFee ? Math.round(paymentAmountCents * (cardSurcharge / 100)) : 0
  const totalWithSurcharge = paymentAmountCents + surchargePreview
  const filteredProducts = products.filter(p => p.category === activeCategory)

  // PHASE 1 — Booking form
  if (phase === 'booking') return (
    <div style={{ padding: '2rem', maxWidth: 700, margin: '0 auto', fontFamily: 'sans-serif' }}>
      <Toaster />
      <div style={{ marginBottom: '1.5rem' }}>
        <h1 style={{ fontSize: 24, fontWeight: 700, margin: 0 }}>Walk-In Booking</h1>
        <p style={{ color: '#6b7280', margin: '4px 0 0', fontSize: 14 }}>Create a reservation and collect payment in one step</p>
      </div>

      <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 12, padding: '1.5rem', marginBottom: 16 }}>
        <h3 style={{ margin: '0 0 1rem', fontSize: 15, fontWeight: 700, color: '#374151' }}>Guest Information</h3>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
          <div style={{ gridColumn: '1/-1' }}>
            <label style={lbl}>Guest name *</label>
            <input style={inp} value={form.guest_name} onChange={e => setForm({ ...form, guest_name: e.target.value })} placeholder='Full name' />
          </div>
          <div>
            <label style={lbl}>Phone</label>
            <input style={inp} value={form.guest_phone} onChange={e => setForm({ ...form, guest_phone: e.target.value })} placeholder='(555) 555-5555' />
          </div>
          <div>
            <label style={lbl}>Email</label>
            <input style={inp} value={form.guest_email} onChange={e => setForm({ ...form, guest_email: e.target.value })} placeholder='optional' />
          </div>
        </div>
      </div>

      <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 12, padding: '1.5rem', marginBottom: 16 }}>
        <h3 style={{ margin: '0 0 1rem', fontSize: 15, fontWeight: 700, color: '#374151' }}>Stay Details</h3>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
          <div>
            <label style={lbl}>Arrival date *</label>
            <input style={inp} type='date' value={form.arrival_date} onChange={e => {
              const newArrival = e.target.value
              setForm(prev => ({ ...prev, arrival_date: newArrival, site_id: '' }))
              if (newArrival && form.departure_date) refetchSites(newArrival, form.departure_date)
            }} />
          </div>
          <div>
            <label style={lbl}>Departure date *</label>
            <input style={inp} type='date' value={form.departure_date} onChange={e => {
              const newDep = e.target.value
              setForm(prev => ({ ...prev, departure_date: newDep, site_id: '' }))
              if (form.arrival_date && newDep) refetchSites(form.arrival_date, newDep)
            }} />
          </div>
          <div style={{ gridColumn: '1/-1' }}>
            <label style={lbl}>Site *</label>
            {!form.arrival_date || !form.departure_date ? (
              <div style={{...inp, color:'#9ca3af', background:'#f9fafb'}}>Enter dates above to see available sites</div>
            ) : sites.length === 0 ? (
              <div style={{...inp, color:'#dc2626', background:'#fef2f2'}}>No sites available for these dates</div>
            ) : (
              <select style={inp} value={form.site_id} onChange={e => setForm({ ...form, site_id: e.target.value })}>
                <option value=''>Select a site...</option>
                {sites.map(s => {
                  const applicable = pricingRules.filter(rule => {
                    const withinDates = rule.start_date <= form.departure_date && rule.end_date >= form.arrival_date
                    if (!withinDates) return false
                    if (rule.site_ids) return rule.site_ids.split(',').includes(s.id)
                    if (rule.site_id) return rule.site_id === s.id
                    if (rule.site_type) return rule.site_type === s.site_type
                    return false
                  })
                  const best = applicable.sort((a: any, b: any) => b.priority - a.priority)[0]
                  const rate = best ? best.nightly_rate : s.base_rate
                  return <option key={s.id} value={s.id}>{siteTypeLabel(s.site_type)} {s.site_number} — ${(rate/100).toFixed(2)}/night{best?' ★':''}</option>
                })}
              </select>
            )}
          </div>
          <div>
            <label style={lbl}>Adults</label>
            <input style={inp} type='text' inputMode='numeric' value={adultsDisplay} placeholder='2' onChange={e => { const val = e.target.value.replace(/[^0-9]/g, ''); setAdultsDisplay(val); setForm({ ...form, num_adults: parseInt(val) || 1 }) }} onBlur={() => { if (!adultsDisplay) setAdultsDisplay('1') }} />
          </div>
          <div>
            <label style={lbl}>Children</label>
            <input style={inp} type='text' inputMode='numeric' value={childrenDisplay} placeholder='0' onChange={e => { const val = e.target.value.replace(/[^0-9]/g, ''); setChildrenDisplay(val); setForm({ ...form, num_children: parseInt(val) || 0 }) }} />
          </div>
        </div>

        {isRvSite && (
          <div style={{ marginTop: 12, display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 12 }}>
            <div>
              <label style={lbl}>Camper type</label>
              <select style={inp} value={form.camper_type} onChange={e => setForm({ ...form, camper_type: e.target.value })}>
                <option value=''>Select...</option>
                <option>Travel Trailer</option>
                <option>Fifth Wheel</option>
                <option>Class A</option>
                <option>Class C</option>
                <option>Van</option>
                <option>Other</option>
              </select>
            </div>
            <div>
              <label style={lbl}>Length (ft)</label>
              <input style={inp} type='number' min='0' value={form.camper_length} onChange={e => setForm({ ...form, camper_length: e.target.value })} placeholder='e.g. 32' />
            </div>
            <div>
              <label style={lbl}>Amperage</label>
              <select style={inp} value={form.camper_amperage} onChange={e => setForm({ ...form, camper_amperage: e.target.value })}>
                <option value=''>Select...</option>
                <option>30amp</option>
                <option>50amp</option>
                <option>20amp</option>
              </select>
            </div>
          </div>
        )}
      </div>

      {selectedSite && nights > 0 && (
        <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 12, padding: '1.5rem', marginBottom: 16 }}>
          <h3 style={{ margin: '0 0 1rem', fontSize: 15, fontWeight: 700, color: '#374151' }}>Pricing</h3>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
            <span style={{ fontSize: 14, color: '#6b7280' }}>{nights} night{nights !== 1 ? 's' : ''} × ${(nightlyRate/100).toFixed(2)}{bestPricingRule ? ' ★' : ''}</span>
            <span style={{ fontWeight: 700, fontSize: 16 }}>${(calculatedTotal/100).toFixed(2)}</span>
          </div>
          <div>
            <label style={lbl}>Price override (optional)</label>
            <div style={{ position: 'relative' }}>
              <span style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: '#6b7280' }}>$</span>
              <input style={{ ...inp, paddingLeft: 24 }} type='number' min='0' step='0.01' placeholder={(calculatedTotal/100).toFixed(2)} value={priceOverride} onChange={e => setPriceOverride(e.target.value)} />
            </div>
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 12, paddingTop: 12, borderTop: '1px solid #f3f4f6', fontWeight: 700, fontSize: 17 }}>
            <span>Total</span>
            <span style={{ color: '#2E6B8A' }}>${(total/100).toFixed(2)}</span>
          </div>
        </div>
      )}

      <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 12, padding: '1.5rem', marginBottom: 24 }}>
        <label style={lbl}>Notes (optional)</label>
        <textarea style={{ ...inp, height: 72, resize: 'vertical' }} value={form.notes} onChange={e => setForm({ ...form, notes: e.target.value })} placeholder='Any notes about this stay...' />
      </div>

      <button onClick={createBooking} disabled={saving} style={{ width: '100%', background: '#2E6B8A', color: '#fff', border: 'none', borderRadius: 10, padding: '14px', fontWeight: 700, fontSize: 16, cursor: 'pointer' }}>
        {saving ? 'Creating reservation...' : 'Create Reservation & Collect Payment →'}
      </button>
    </div>
  )

  // PHASE 2 — Payment
  return (
    <div style={{ fontFamily: 'sans-serif', minHeight: '100vh', background: '#C9D2D9' }}>
      <Toaster />
      <div style={{ background: '#fff', borderBottom: '1px solid #b8c4cc', padding: '0.875rem 1.25rem', display: 'flex', alignItems: 'center', gap: 12, boxShadow: '0 1px 4px rgba(0,0,0,0.08)' }}>
        <div style={{ flex: 1 }}>
          <h1 style={{ margin: 0, fontSize: 17, fontWeight: 700 }}>{form.guest_name}</h1>
          <p style={{ margin: 0, fontSize: 12, color: '#6b7280' }}>
            {siteTypeLabel(selectedSite?.site_type || '')} {selectedSite?.site_number} · {form.arrival_date} → {form.departure_date}
          </p>
        </div>
        <div style={{ textAlign: 'right', flexShrink: 0 }}>
          <div style={{ fontSize: 20, fontWeight: 800, color: overpaid > 0 ? '#6b7280' : totalDue > 0 ? '#dc2626' : '#15803d' }}>
            {overpaid > 0 ? 'Change: $' + (overpaid/100).toFixed(2) : '$' + (totalDue/100).toFixed(2)}
          </div>
          <div style={{ fontSize: 11, color: '#6b7280' }}>
            {overpaid > 0 ? 'give change' : totalDue > 0 ? 'balance due' : '✓ paid in full'}
          </div>
        </div>
      </div>

      <div style={{ display: 'flex', borderBottom: '1px solid #b8c4cc', background: '#fff' }}>
        <button onClick={() => setActiveCategory('')} style={{ flex: 1, padding: '12px', fontSize: 14, fontWeight: 600, border: 'none', background: 'none', cursor: 'pointer', borderBottom: activeCategory !== 'ITEMS' ? '2px solid #2E6B8A' : '2px solid transparent', color: activeCategory !== 'ITEMS' ? '#2E6B8A' : '#6b7280' }}>Guest Tab</button>
        <button onClick={() => setActiveCategory('')} style={{ flex: 1, padding: '12px', fontSize: 14, fontWeight: 600, border: 'none', background: 'none', cursor: 'pointer', borderBottom: activeCategory === 'ITEMS' ? '2px solid #2E6B8A' : '2px solid transparent', color: activeCategory === 'ITEMS' ? '#2E6B8A' : '#6b7280' }}>Add Items</button>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 380px', minHeight: 'calc(100vh - 120px)' }}>
        {/* Left: Tab */}
        <div style={{ padding: '1.25rem', overflowY: 'auto', background: '#C9D2D9' }}>

          {/* Reservation stay charge */}
          <div style={{ background: '#fffbeb', border: '1px solid #fde68a', borderRadius: 10, padding: '0.875rem 1rem', marginBottom: 12 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div>
                <div style={{ fontWeight: 600, fontSize: 14 }}>Reservation balance</div>
                <div style={{ fontSize: 12, color: '#92400e', marginTop: 2 }}>
                  {nights} night stay · {siteTypeLabel(selectedSite?.site_type || '')} {selectedSite?.site_number}
                </div>
              </div>
              <div style={{ fontWeight: 800, fontSize: 17, color: '#92400e' }}>${(total/100).toFixed(2)}</div>
            </div>
          </div>

          {lineItems.length > 0 && (
            <div style={{ background: '#fff', border: '1px solid #b8c4cc', borderRadius: 10, marginBottom: 12, overflow: 'hidden' }}>
              <div style={{ padding: '0.625rem 1rem', borderBottom: '1px solid #f3f4f6', fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', color: '#6b7280' }}>Charges</div>
              {lineItems.map((item, i) => (
                <div key={item.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 14px', borderBottom: i < lineItems.length - 1 ? '1px solid #f9fafb' : 'none' }}>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: 14, fontWeight: 500 }}>{item.description}</div>
                  </div>
                  <div style={{ fontWeight: 600, fontSize: 14 }}>${(item.line_total/100).toFixed(2)}</div>
                  <button onClick={() => removeLineItem(item.id)} style={{ background: 'none', border: 'none', color: '#dc2626', cursor: 'pointer', fontSize: 18, padding: '0 2px' }}>×</button>
                </div>
              ))}
              <div style={{ display: 'flex', justifyContent: 'space-between', padding: '10px 14px', borderTop: '1px solid #f3f4f6', fontWeight: 700, fontSize: 14 }}>
                <span>Total</span>
                <span>${(itemsTotal/100).toFixed(2)}</span>
              </div>
            </div>
          )}

          {payments.length > 0 && (
            <div style={{ background: '#fff', border: '1px solid #b8c4cc', borderRadius: 10, marginBottom: 12, overflow: 'hidden' }}>
              <div style={{ padding: '0.625rem 1rem', borderBottom: '1px solid #f3f4f6', fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', color: '#6b7280' }}>Payments</div>
              {payments.map((p, i) => (
                <div key={p.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '10px 14px', borderBottom: i < payments.length - 1 ? '1px solid #f9fafb' : 'none' }}>
                  <div style={{ fontSize: 14, fontWeight: 500, textTransform: 'capitalize' }}>{p.method}</div>
                  <div style={{ fontWeight: 600, fontSize: 14, color: '#15803d' }}>-${(p.amount/100).toFixed(2)}</div>
                </div>
              ))}
            </div>
          )}

          {totalDue > 0 && (
            <div style={{ marginTop: 8 }}>
              {realCardOnlyFeeTotal > 0 ? (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  <div style={{ fontSize: 12, color: '#4a6275', textAlign: 'center', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em' }}>Select payment method</div>
                  <button
                    onClick={() => { setPaymentAmount((totalDue/100).toFixed(2)); setPaymentMethod('cash'); setWaiveFee(true); setLockedMethod('cash_check'); setShowPayment(true) }}
                    style={{ width: '100%', background: '#2E6B8A', color: '#fff', border: 'none', borderRadius: 10, padding: '14px', fontWeight: 700, fontSize: 16, cursor: 'pointer', display: 'flex', justifyContent: 'space-between', alignItems: 'center', paddingLeft: 20, paddingRight: 20 }}
                  >
                    <span>💵 Cash / Check</span>
                    <span>${(totalDue/100).toFixed(2)}</span>
                  </button>
                  <button
                    onClick={() => { setPaymentAmount(((totalDue + realCardOnlyFeeTotal)/100).toFixed(2)); setPaymentMethod('card'); setWaiveFee(true); setLockedMethod('card'); setShowPayment(true) }}
                    style={{ width: '100%', background: '#1e3f52', color: '#fff', border: 'none', borderRadius: 10, padding: '14px', fontWeight: 700, fontSize: 16, cursor: 'pointer', display: 'flex', justifyContent: 'space-between', alignItems: 'center', paddingLeft: 20, paddingRight: 20 }}
                  >
                    <span>💳 Card</span>
                    <span>${((totalDue + realCardOnlyFeeTotal)/100).toFixed(2)}</span>
                  </button>
                </div>
              ) : (
                <button onClick={() => { setPaymentAmount((totalDue/100).toFixed(2)); setShowPayment(true) }} style={{ width: '100%', background: '#2E6B8A', color: '#fff', border: 'none', borderRadius: 10, padding: '14px', fontWeight: 700, fontSize: 16, cursor: 'pointer', marginTop: 8 }}>
                  Collect Payment · ${(totalDue/100).toFixed(2)}
                </button>
              )}
            </div>
          )}

          {totalDue === 0 && paymentsTotal > 0 && (
            <div style={{ background: '#f0fdf4', border: '1px solid #bbf7d0', borderRadius: 10, padding: '1rem', marginTop: 8, textAlign: 'center' }}>
              <div style={{ fontSize: 16, fontWeight: 700, color: '#15803d' }}>✓ Paid in full</div>
              <button onClick={() => router.push('/admin/reservations')} style={{ marginTop: 12, background: '#2E6B8A', color: '#fff', border: 'none', borderRadius: 8, padding: '10px 24px', fontWeight: 600, fontSize: 14, cursor: 'pointer' }}>
                Done — View Reservations
              </button>
            </div>
          )}

          {overpaid > 0 && (
            <div style={{ background: '#f0fdf4', border: '1px solid #bbf7d0', borderRadius: 10, padding: '1rem', marginTop: 8, textAlign: 'center' }}>
              <div style={{ fontSize: 16, fontWeight: 700, color: '#15803d' }}>Give change: ${(overpaid/100).toFixed(2)}</div>
              <button onClick={() => router.push('/admin/reservations')} style={{ marginTop: 12, background: '#2E6B8A', color: '#fff', border: 'none', borderRadius: 8, padding: '10px 24px', fontWeight: 600, fontSize: 14, cursor: 'pointer' }}>
                Done — View Reservations
              </button>
            </div>
          )}
        </div>

        {/* Right: Product picker */}
        <div style={{ background: '#C9D2D9', borderLeft: '1px solid #b8c4cc', display: 'flex', flexDirection: 'column' }}>
          {activeCategory === '' ? (
            <div style={{ flex: 1, overflowY: 'auto', padding: '1rem', display: 'flex', flexDirection: 'column', gap: 10 }}>
              <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em', color: '#4a6275', marginBottom: 4 }}>Add items</div>
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
              <button onClick={() => { setShowPayment(false); setCashTendered(''); setWaiveFee(false); setLockedMethod('') }} style={{ background: 'none', border: 'none', fontSize: 22, cursor: 'pointer', color: '#6b7280' }}>×</button>
            </div>
            <label style={ml}>Payment method</label>
            <div style={{ display: 'grid', gridTemplateColumns: lockedMethod === 'cash_check' ? '1fr 1fr' : '1fr', gap: 8, marginBottom: 16 }}>
              {(lockedMethod === 'cash_check' ? ['cash', 'check'] : lockedMethod === 'card' ? ['card'] : ['cash', 'card', 'check']).map(m => (
                <button key={m} onClick={() => setPaymentMethod(m)} style={{ padding: '12px', border: '2px solid ' + (paymentMethod === m ? '#2E6B8A' : '#e5e7eb'), borderRadius: 8, background: paymentMethod === m ? '#e8f2f7' : '#fff', fontWeight: 600, fontSize: 14, cursor: 'pointer', textTransform: 'capitalize', color: paymentMethod === m ? '#2E6B8A' : '#374151' }}>
                  {m}
                </button>
              ))}
            </div>
            {paymentMethod === 'card' && (
              <div style={{ marginBottom: 12 }}>
                <div style={{ display: 'grid', gridTemplateColumns: terminalDeviceId ? '1fr 1fr' : '1fr', gap: 8 }}>
                  {terminalDeviceId && (
                    <button onClick={() => setCardEntryMode('terminal')}
                      style={{ padding: '10px', border: '2px solid', borderColor: cardEntryMode === 'terminal' ? '#2E6B8A' : '#e5e7eb', borderRadius: 8, background: cardEntryMode === 'terminal' ? '#e8f2f7' : '#fff', fontWeight: 600, fontSize: 13, cursor: 'pointer', color: cardEntryMode === 'terminal' ? '#2E6B8A' : '#374151' }}>
                      💳 Use Terminal
                    </button>
                  )}
                  <button onClick={() => { setCardEntryMode('manual'); setTimeout(loadSquareCard, 100) }}
                    style={{ padding: '10px', border: '2px solid', borderColor: cardEntryMode === 'manual' ? '#2E6B8A' : '#e5e7eb', borderRadius: 8, background: cardEntryMode === 'manual' ? '#e8f2f7' : '#fff', fontWeight: 600, fontSize: 13, cursor: 'pointer', color: cardEntryMode === 'manual' ? '#2E6B8A' : '#374151' }}>
                    ⌨️ Enter Card Manually
                  </button>
                </div>
              </div>
            )}
            {paymentMethod === 'card' && cardEntryMode === 'terminal' && terminalDeviceId ? (
              <div style={{ background: '#e8f2f7', border: '1px solid #b8d4e8', borderRadius: 10, padding: '1.25rem', marginBottom: 16, textAlign: 'center' }}>
                <div style={{ fontSize: 32, marginBottom: 8 }}>💳</div>
                <div style={{ fontWeight: 700, fontSize: 16, color: '#1e3f52', marginBottom: 4 }}>Send to Square Terminal</div>
                <div style={{ fontSize: 13, color: '#4a6275', marginBottom: 12 }}>
                  Amount: <strong>${(totalDue/100).toFixed(2)}</strong>
                  {cardSurcharge > 0 && <span> + {cardSurcharge}% fee = <strong>${((totalDue + Math.round(totalDue * cardSurcharge / 100))/100).toFixed(2)}</strong></span>}
                </div>
                <button
                  onClick={() => { setShowPayment(false); sendToTerminal() }}
                  disabled={sendingToTerminal}
                  style={{ background: '#2E6B8A', color: '#fff', border: 'none', borderRadius: 8, padding: '12px 28px', fontWeight: 700, fontSize: 15, cursor: 'pointer' }}
                >
                  {sendingToTerminal ? 'Sending...' : 'Send to Terminal →'}
                </button>
              </div>
            ) : paymentMethod === 'card' && cardEntryMode === 'manual' ? (
              <div style={{ marginBottom: 16 }}>
                <label style={ml}>Card Details</label>
                <div id='walkin-square-card' style={{ minHeight: 89, border: '1px solid #d1d5db', borderRadius: 8, padding: 4, marginBottom: 8 }} />
                {!squareCardLoaded && <p style={{ fontSize: 12, color: '#9ca3af' }}>Loading card form...</p>}
                {cardSurcharge > 0 && !waiveFee && paymentAmount && (
                  <div style={{ background: '#fffbeb', border: '1px solid #fde68a', borderRadius: 8, padding: '8px 12px', marginBottom: 8, fontSize: 12 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                      <span style={{ color: '#92400e' }}>{cardSurcharge}% card fee</span>
                      <span style={{ color: '#92400e', fontWeight: 600 }}>+${(Math.round(Math.round(parseFloat(paymentAmount) * 100) * cardSurcharge / 100) / 100).toFixed(2)}</span>
                    </div>
                  </div>
                )}
                <label style={ml}>Note (optional)</label>
                <input style={{ ...si, marginBottom: 12 }} placeholder='e.g. phone reservation' value={paymentNote} onChange={e => setPaymentNote(e.target.value)} />
                <button onClick={chargeManualCard} disabled={chargingCard || !squareCardLoaded || !paymentAmount}
                  style={{ width: '100%', background: chargingCard || !squareCardLoaded || !paymentAmount ? '#d1d5db' : '#2E6B8A', color: '#fff', border: 'none', borderRadius: 10, padding: '14px', fontWeight: 700, fontSize: 16, cursor: 'pointer' }}>
                  {chargingCard ? 'Processing...' : `Charge Card · $${paymentAmount || '0.00'}`}
                </button>
              </div>
            ) : (
              <>
            <label style={ml}>{paymentMethod === 'cash' ? 'Amount due' : 'Amount'}</label>
            <div style={{ position: 'relative', marginBottom: 8 }}>
              <span style={{ position: 'absolute', left: 14, top: '50%', transform: 'translateY(-50%)', color: '#6b7280', fontSize: 18 }}>$</span>
              <input style={{ ...si, paddingLeft: 30, fontSize: 24, fontWeight: 700, height: 56, background: paymentMethod === 'cash' ? '#f9fafb' : '#fff', color: paymentMethod === 'cash' ? '#6b7280' : '#111827' }} type='number' step='0.01' value={paymentAmount} readOnly={paymentMethod === 'cash'} onChange={e => setPaymentAmount(e.target.value)} />
            </div>
            {paymentMethod === 'cash' && (
              <>
                <label style={ml}>Cash tendered</label>
                <div style={{ position: 'relative', marginBottom: 8 }}>
                  <span style={{ position: 'absolute', left: 14, top: '50%', transform: 'translateY(-50%)', color: '#6b7280', fontSize: 18 }}>$</span>
                  <input style={{ ...si, paddingLeft: 30, fontSize: 24, fontWeight: 700, height: 56 }} type='number' step='0.01' value={cashTendered} onChange={e => setCashTendered(e.target.value)} placeholder='0.00' autoFocus />
                </div>
                {parseFloat(cashTendered) > 0 && (
                  <div style={{ background: parseFloat(cashTendered) >= parseFloat(paymentAmount) ? '#f0fdf4' : '#fef2f2', border: '1px solid', borderColor: parseFloat(cashTendered) >= parseFloat(paymentAmount) ? '#bbf7d0' : '#fecaca', borderRadius: 8, padding: '10px 14px', marginBottom: 12, display: 'flex', justifyContent: 'space-between' }}>
                    <span style={{ fontWeight: 600, color: parseFloat(cashTendered) >= parseFloat(paymentAmount) ? '#15803d' : '#dc2626' }}>
                      {parseFloat(cashTendered) >= parseFloat(paymentAmount) ? 'Change due' : 'Amount short'}
                    </span>
                    <span style={{ fontWeight: 800, fontSize: 18, color: parseFloat(cashTendered) >= parseFloat(paymentAmount) ? '#15803d' : '#dc2626' }}>
                      ${Math.abs(parseFloat(cashTendered) - parseFloat(paymentAmount)).toFixed(2)}
                    </span>
                  </div>
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
            <input style={{ ...si, marginBottom: 16 }} placeholder='e.g. check #1042' value={paymentNote} onChange={e => setPaymentNote(e.target.value)} />
            <button onClick={collectPayment} disabled={savingPayment} style={{ width: '100%', background: '#2E6B8A', color: '#fff', border: 'none', borderRadius: 10, padding: '14px', fontWeight: 700, fontSize: 16, cursor: 'pointer' }}>
              {savingPayment ? 'Recording...' : paymentMethod === 'card' && surchargePreview > 0 ? 'Charge card · $' + (totalWithSurcharge/100).toFixed(2) : paymentMethod === 'cash' && cashTendered !== '' ? 'Record cash · $' + Math.min(parseFloat(cashTendered), parseFloat(paymentAmount)).toFixed(2) : 'Record ' + paymentMethod + ' · $' + paymentAmount}
            </button>
              </>
            )}
          </div>
        </div>
      )}
      {terminalStatus === 'waiting' && (
        <div style={{ position: 'fixed', bottom: 20, left: '50%', transform: 'translateX(-50%)', background: '#2E6B8A', color: '#fff', borderRadius: 12, padding: '14px 24px', fontSize: 15, fontWeight: 600, zIndex: 60, display: 'flex', alignItems: 'center', gap: 10 }}>
          <div style={{ width: 10, height: 10, borderRadius: '50%', background: '#fff', animation: 'pulse 1s infinite' }} />
          Waiting for customer to tap card on Terminal...
          <style>{"\@keyframes pulse { 0%,100%{opacity:1} 50%{opacity:0.3} }"}</style>
        </div>
      )}
      {terminalStatus === 'completed' && (
        <div style={{ position: 'fixed', bottom: 20, left: '50%', transform: 'translateX(-50%)', background: '#15803d', color: '#fff', borderRadius: 12, padding: '14px 24px', fontSize: 15, fontWeight: 600, zIndex: 60 }}>
          ✓ Card payment completed!
        </div>
      )}
      {terminalStatus.startsWith('error') && (
        <div style={{ position: 'fixed', bottom: 20, left: '50%', transform: 'translateX(-50%)', background: '#dc2626', color: '#fff', borderRadius: 12, padding: '14px 24px', fontSize: 14, fontWeight: 600, zIndex: 60 }}>
          {terminalStatus}
        </div>
      )}
    </div>
  )
}

function VariableProductTile({ product, onAdd }: { product: any, onAdd: (p: any, price?: number) => void }) {
  const [customPrice, setCustomPrice] = useState('')
  if (!product.variable_price) {
    return (
      <button onClick={() => onAdd(product)} style={{ background: '#fff', border: '1px solid #b8c4cc', borderRadius: 10, padding: '14px 10px', cursor: 'pointer', textAlign: 'left', display: 'flex', flexDirection: 'column', gap: 4 }}>
        <div style={{ fontWeight: 600, fontSize: 13 }}>{product.name}</div>
        <div style={{ fontSize: 15, color: '#2E6B8A', fontWeight: 700 }}>${(product.price/100).toFixed(2)}</div>
        {product.tax_class === 'standard' && <div style={{ fontSize: 10, color: '#9ca3af' }}>+ tax</div>}
      </button>
    )
  }
  return (
    <div style={{ background: '#fff', border: '1px solid #b8c4cc', borderRadius: 10, padding: '10px', display: 'flex', flexDirection: 'column', gap: 6 }}>
      <div style={{ fontWeight: 600, fontSize: 13 }}>{product.name}</div>
      <div style={{ position: 'relative' }}>
        <span style={{ position: 'absolute', left: 8, top: '50%', transform: 'translateY(-50%)', color: '#6b7280', fontSize: 13 }}>$</span>
        <input type='number' min='0' step='0.01' placeholder='0.00' value={customPrice} onChange={e => setCustomPrice(e.target.value)} style={{ width: '100%', border: '1px solid #d1d5db', borderRadius: 6, padding: '6px 6px 6px 20px', fontSize: 13, boxSizing: 'border-box' }} />
      </div>
      <button onClick={() => { if (customPrice) { onAdd(product, Math.round(parseFloat(customPrice) * 100)); setCustomPrice('') } }} disabled={!customPrice || parseFloat(customPrice) <= 0} style={{ background: customPrice && parseFloat(customPrice) > 0 ? '#2E6B8A' : '#d1d5db', color: '#fff', border: 'none', borderRadius: 6, padding: '6px', fontSize: 12, fontWeight: 600, cursor: customPrice ? 'pointer' : 'default' }}>Add</button>
    </div>
  )
}

const si: React.CSSProperties = { width: '100%', border: '1px solid #d1d5db', borderRadius: 7, padding: '8px 10px', fontSize: 14, boxSizing: 'border-box' }
const lbl: React.CSSProperties = { display: 'block', fontSize: 13, fontWeight: 600, color: '#374151', marginBottom: 4, marginTop: 12 }
const inp: React.CSSProperties = { width: '100%', border: '1px solid #d1d5db', borderRadius: 7, padding: '8px 10px', fontSize: 14, boxSizing: 'border-box' }
const ml: React.CSSProperties = { display: 'block', fontSize: 13, fontWeight: 600, color: '#374151', marginBottom: 6 }