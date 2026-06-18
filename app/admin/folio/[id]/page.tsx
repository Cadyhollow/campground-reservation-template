'use client'
import { useEffect, useState } from 'react'
import { createClient } from '@supabase/supabase-js'
import { useParams, useRouter } from 'next/navigation'

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
)

const FALLBACK_CATEGORIES = ['Camping Supplies', 'Food & Drink', 'Rentals', 'Fees', 'General']

type LineItem = {
  id: string
  description: string
  quantity: number
  unit_price: number
  tax_amount: number
  line_total: number
  category: string
  charged_at: string
  product_id: string | null
  voided: boolean
  notes: string | null
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

type Reservation = {
  id: string
  guest_name: string
  guest_email: string
  site_number: string
  site_type: string
  arrival_date: string
  departure_date: string
  total_price: number
  amount_paid: number
  fees_total: number
  num_adults: number
  num_children: number
  base_nightly_rate: number
  extra_guest_fee_total: number
  addons_total: number
  early_checkin_fee: number
  late_checkout_fee: number
  discount_amount: number
}

type Folio = {
  id: string
  reservation_id: string | null
  guest_name: string
  guest_email: string
  folio_type: string
  status: string
  notes: string
}

function fmtLedgerDate(ts: string) {
  if (!ts) return ''
  const d = new Date(ts)
  if (isNaN(d.getTime())) return ''
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

export default function FolioPage() {
  const params = useParams()
  const router = useRouter()
  const reservationId = params.id as string
  const isNew = reservationId === 'new'

  const [reservation, setReservation] = useState<Reservation | null>(null)
  const [folio, setFolio] = useState<Folio | null>(null)
  const [lineItems, setLineItems] = useState<LineItem[]>([])
  const [payments, setPayments] = useState<Payment[]>([])
  const [products, setProducts] = useState<Product[]>([])
  const [reservationAddons, setReservationAddons] = useState<{ name: string; quantity: number; amount: number }[]>([])
  const [cardSurcharge, setCardSurcharge] = useState(0)
  const [loading, setLoading] = useState(true)
  const [posEnabled, setPosEnabled] = useState(false)
  const [maxCreditAmount, setMaxCreditAmount] = useState(0)
  const [activeCategory, setActiveCategory] = useState('')
  const [categories, setCategories] = useState<string[]>(FALLBACK_CATEGORIES)
  const [activeTab, setActiveTab] = useState<'tab'|'items'>('tab')
  const [showPayment, setShowPayment] = useState(false)
  const [paymentMethod, setPaymentMethod] = useState('cash')
  const [paymentAmount, setPaymentAmount] = useState('')
  const [paymentNote, setPaymentNote] = useState('')
  const [savingPayment, setSavingPayment] = useState(false)
  const [walkUpName, setWalkUpName] = useState('')
  const [showCustomItem, setShowCustomItem] = useState(false)
  const [lastAdded, setLastAdded] = useState<string|null>(null)
  const [cashTendered, setCashTendered] = useState('')
  const [waiveFee, setWaiveFee] = useState(false)
  const [feeAlreadyIncluded, setFeeAlreadyIncluded] = useState(false)
  const [terminalDeviceId, setTerminalDeviceId] = useState('')
  const [terminalStatus, setTerminalStatus] = useState('')
  const [sendingToTerminal, setSendingToTerminal] = useState(false)
  const [customDesc, setCustomDesc] = useState('')
  const [customPrice, setCustomPrice] = useState('')
  const [customQty, setCustomQty] = useState('1')
  const [cardEntryMode, setCardEntryMode] = useState<'terminal' | 'manual'>('terminal')
  const [squareCardLoaded, setSquareCardLoaded] = useState(false)
  const [squareCardRef, setSquareCardRef] = useState<any>(null)
  const [squareInstanceRef, setSquareInstanceRef] = useState<any>(null)
  const [chargingCard, setChargingCard] = useState(false)
  const [showRefund, setShowRefund] = useState(false)
  const [refundPayment, setRefundPayment] = useState<any>(null)
  const [refundAmount, setRefundAmount] = useState('')
  const [refundReason, setRefundReason] = useState('')
  const [processingRefund, setProcessingRefund] = useState(false)
  const [refundError, setRefundError] = useState('')
  const [refundSuccess, setRefundSuccess] = useState(false)
  const [showEarlier, setShowEarlier] = useState(false)

  useEffect(() => { init() }, [reservationId])

  async function init() {
    setLoading(true)
    const [{ data: prods }, { data: settings }, { data: cats }] = await Promise.all([
      supabase.from('products').select('*').eq('active', true).order('display_order'),
      (supabase.from('settings').select('card_surcharge_percent, square_terminal_device_id, pos_enabled, max_credit_amount').single()) as any,
      supabase.from('product_categories').select('name').order('display_order'),
    ])
    if (cats && cats.length > 0) setCategories(cats.map((c: any) => c.name))
    setProducts(prods || [])
    if (settings?.card_surcharge_percent) setCardSurcharge(Number(settings.card_surcharge_percent))
    if (settings?.square_terminal_device_id) setTerminalDeviceId(settings.square_terminal_device_id)
    if (settings?.pos_enabled) setPosEnabled(true)
    if (settings?.max_credit_amount !== undefined) setMaxCreditAmount(settings.max_credit_amount || 0)

    if (isNew) { setLoading(false); return }

    // First try: treat the ID as a reservation ID
    const { data: res } = await supabase.from('reservations').select('*').eq('id', reservationId).single()
    if (res) {
      setReservation(res)
      // Load the reservation's add-ons by name so charges can be itemized
      const [{ data: raRows }, { data: addonDefs }] = await Promise.all([
        supabase.from('reservation_addons').select('addon_id, quantity, price_at_booking').eq('reservation_id', res.id),
        supabase.from('addons').select('id, name'),
      ])
      if (raRows && raRows.length > 0) {
        const nameById = new Map((addonDefs || []).map((a: any) => [a.id, a.name]))
        setReservationAddons(raRows.map((r: any) => ({
          name: nameById.get(r.addon_id) || 'Add-on',
          quantity: r.quantity || 1,
          amount: (r.price_at_booking || 0) * (r.quantity || 1),
        })))
      }
    }

    const { data: existingFolio } = await supabase.from('folios').select('*').eq('reservation_id', reservationId).single()
    if (existingFolio) {
      setFolio(existingFolio)
      await loadFolioData(existingFolio.id)
    } else if (res) {
      const { data: newFolio } = await supabase.from('folios').insert({
        reservation_id: res.id,
        guest_name: res.guest_name,
        guest_email: res.guest_email || '',
        folio_type: 'reservation',
        status: 'open',
      }).select().single()
      if (newFolio) {
        setFolio(newFolio)
        await loadFolioData(newFolio.id)
      }
    } else {
      // Second try: treat the ID as a direct folio ID (walk-up folios)
      const { data: directFolio } = await supabase.from('folios').select('*').eq('id', reservationId).single()
      if (directFolio) {
        setFolio(directFolio)
        await loadFolioData(directFolio.id)
      }
    }
    setLoading(false)
  }

  async function loadSquareCard() {
    if (squareCardLoaded) return
    const existing = document.getElementById('admin-square-card-container')
    if (!existing) return
    try {
      let sq = squareInstanceRef
      if (!sq) {
        const script = document.createElement('script')
        script.src = process.env.NEXT_PUBLIC_SQUARE_ENVIRONMENT === 'production'
          ? 'https://web.squarecdn.com/v1/square.js'
          : 'https://sandbox.web.squarecdn.com/v1/square.js'
        await new Promise((resolve) => { script.onload = resolve; document.head.appendChild(script) })
        sq = (window as any).Square.payments(process.env.NEXT_PUBLIC_SQUARE_APP_ID!, 'L42H3PRBWB5CJ')
        setSquareInstanceRef(sq)
      }
      const card = await sq.card()
      await card.attach('#admin-square-card-container')
      setSquareCardRef(card)
      setSquareCardLoaded(true)
    } catch (e) { console.error('Square card load error:', e) }
  }

  async function chargeManualCard() {
    if (!squareCardRef || !folio) return
    setChargingCard(true)
    try {
      const result = await squareCardRef.tokenize()
      if (result.status !== 'OK') {
        setChargingCard(false)
        return
      }
      const baseAmount = Math.round(parseFloat(paymentAmount) * 100)
      const surchargeAmount = cardSurcharge > 0 && !waiveFee
        ? Math.round(baseAmount * (cardSurcharge / 100))
        : 0
      const totalAmount = baseAmount + surchargeAmount

      const res = await fetch('/api/admin-card-payment', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sourceId: result.token,
          folioId: folio.id,
          amount: totalAmount,
          surchargeAmount,
          note: paymentNote,
          guestName: folio.guest_name,
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
        await loadFolioData(folio.id)
      } else {
        alert(data.error || 'Card payment failed')
      }
    } catch (e) { console.error('Card charge error:', e) }
    setChargingCard(false)
  }

  async function loadFolioData(folioId: string) {
    const [{ data: items }, { data: pmts }] = await Promise.all([
      supabase.from('folio_line_items').select('*').eq('folio_id', folioId).order('charged_at'),
      supabase.from('folio_payments').select('*').eq('folio_id', folioId).eq('status', 'completed').order('paid_at'),
    ])
    setLineItems(items || [])
    setPayments(pmts || [])
  }

  async function createWalkUpFolio() {
    const { data: newFolio } = await supabase.from('folios').insert({
      reservation_id: null,
      guest_name: walkUpName.trim() || 'Walk-up Guest',
      guest_email: '',
      folio_type: 'walkin',
      status: 'open',
    }).select().single()
    if (newFolio) {
      setFolio(newFolio)
      await loadFolioData(newFolio.id)
      setActiveTab('items')
    }
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
    setLastAdded(product.name)
    setTimeout(() => setLastAdded(null), 2000)
  }

  async function addCustomItem() {
    if (!folio || !customDesc.trim()) return
    const price = Math.round(parseFloat(customPrice) * 100) || 0
    const qty = parseInt(customQty) || 1
    const lineTotal = price * qty
    await supabase.from('folio_line_items').insert({
      folio_id: folio.id,
      product_id: null,
      description: customDesc.trim(),
      quantity: qty,
      unit_price: price,
      tax_amount: 0,
      line_total: lineTotal,
      category: 'General',
    })
    const addedDesc = customDesc.trim()
    setCustomDesc('')
    setCustomPrice('')
    setCustomQty('1')
    setShowCustomItem(false)
    await loadFolioData(folio.id)
    setActiveTab('tab')
    setActiveCategory('')
    setLastAdded(addedDesc)
    setTimeout(() => setLastAdded(null), 2000)
  }

  async function removeLineItem(id: string) {
    if (!folio) return
    if (!confirm('Remove this item?')) return
    await supabase.from('folio_line_items').delete().eq('id', id)
    await loadFolioData(folio.id)
  }

  async function voidPayment(id: string) {
    if (!confirm('Void this payment? This cannot be undone.')) return
    await supabase.from('folio_payments').update({ status: 'voided' }).eq('id', id)
    await loadFolioData(folio!.id)
  }

  function openRefund(payment: any) {
    const suggestedAmount = ((payment.amount - (payment.surcharge_amount || 0)) * 0.9 / 100).toFixed(2)
    setRefundPayment(payment)
    setRefundAmount(suggestedAmount)
    setRefundReason('')
    setRefundError('')
    setShowRefund(true)
  }

  async function processRefund() {
    if (!refundPayment || !refundAmount || !folio) return
    setProcessingRefund(true)
    setRefundError('')
    const res = await fetch('/api/refund', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        paymentId: refundPayment.id,
        refundAmount: parseFloat(refundAmount),
        reason: refundReason,
        folioId: folio.id,
      }),
    })
    const data = await res.json()
    setProcessingRefund(false)
    if (data.success) {
      setRefundSuccess(true)
      await loadFolioData(folio.id)
      setTimeout(() => {
        setShowRefund(false)
        setRefundPayment(null)
        setRefundSuccess(false)
      }, 3000)
    } else {
      setRefundError(data.error || 'Refund failed. Please try again.')
    }
  }

  async function collectPayment() {
    // Credit cap check for guest account folios
    if (folio?.folio_type === 'guest_account') {
      const paymentAmt = Math.round(parseFloat(paymentAmount || '0') * 100)
      const currentPaid = payments.reduce((sum, p) => sum + p.amount - (p.surcharge_amount || 0), 0)
      const currentBalance = grandTotal - currentPaid
      const resultingBalance = currentBalance - paymentAmt
      if (resultingBalance < 0) {
        const creditAmount = Math.abs(resultingBalance)
        if (maxCreditAmount === 0) {
          if (!confirm(`Warning: This payment of $${(paymentAmt/100).toFixed(2)} exceeds the balance due of $${(currentBalance/100).toFixed(2)} by $${(creditAmount/100).toFixed(2)}. Credits are not enabled for this account. Did you intend to give $${(creditAmount/100).toFixed(2)} change? Click OK to proceed anyway.`)) return
        } else if (creditAmount > maxCreditAmount) {
          if (!confirm(`Warning: This payment would create a credit of $${(creditAmount/100).toFixed(2)}, which exceeds the maximum allowed credit of $${(maxCreditAmount/100).toFixed(2)}. Click OK to proceed anyway.`)) return
        }
      }
    }
    if (!folio) return
    const baseAmount = paymentMethod === 'cash' && cashTendered !== '' ? Math.min(Math.round(parseFloat(cashTendered) * 100), Math.round(parseFloat(paymentAmount) * 100)) : Math.round(parseFloat(paymentAmount) * 100)
    if (!baseAmount || baseAmount <= 0) return
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
      note: paymentNote + (surchargeAmount > 0 ? ` (incl. ${cardSurcharge}% card fee: $${(surchargeAmount/100).toFixed(2)})` : ''),
    })
    setSavingPayment(false)
    setShowPayment(false)
    setPaymentAmount('')
    setPaymentNote('')
    setPaymentMethod('cash')
    setCashTendered('')
    setWaiveFee(false)
    setFeeAlreadyIncluded(false)
    await loadFolioData(folio.id)
  }

  // Totals — single source of truth
  const activeItems = lineItems.filter(i => !i.voided)
  async function sendToTerminal() {
    if (!folio) return
    const amount = Math.max(0, (reservation ? Math.max(0, reservation.total_price - reservation.amount_paid) : 0) + activeItems.reduce((sum, i) => sum + i.line_total, 0) - payments.reduce((sum, p) => sum + p.amount - (p.surcharge_amount || 0), 0))
    if (!amount || amount <= 0) return
    const surchargeAmount = cardSurcharge > 0 ? Math.round(amount * (cardSurcharge / 100)) : 0
    const totalAmount = amount + surchargeAmount
    setSendingToTerminal(true)
    setTerminalStatus('')
    const res = await fetch('/api/terminal/charge', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        folioId: folio.id,
        amount: totalAmount,
        surchargeAmount,
        note: (folio?.guest_name || '') + (reservation ? ' · Site ' + reservation.site_number : ''),
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
          supabase.from('folio_line_items').select('*').eq('folio_id', folio.id).order('charged_at'),
          supabase.from('folio_payments').select('*').eq('folio_id', folio.id).eq('status', 'completed').order('paid_at'),
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

  const itemsTotal = activeItems.reduce((sum, i) => sum + i.line_total, 0)
  const paymentsTotal = payments.reduce((sum, p) => sum + p.amount - (p.surcharge_amount || 0), 0)
  const reservationBalance = reservation ? Math.max(0, reservation.total_price - reservation.amount_paid) : 0
  // Display-only: reflect folio payments applied toward the reservation, without
  // altering reservationBalance (which is load-bearing for grandTotal/totalDue).
  const reservationEffectivePaid = reservation ? Math.min(reservation.total_price, reservation.amount_paid + paymentsTotal) : 0
  const reservationDisplayBalance = reservation ? Math.max(0, reservation.total_price - reservationEffectivePaid) : 0
  // Cash balance removes proportional fees from remaining balance
  const feesTotal = reservation?.fees_total || 0
  const feeAlreadyPaid = reservation && feesTotal > 0 ? Math.round(reservation.amount_paid * feesTotal / reservation.total_price) : 0
  const cashReservationBalance = reservation ? Math.max(0, reservationBalance - (feesTotal - feeAlreadyPaid)) : 0
  const hasFeeDiscount = feesTotal > 0 && cashReservationBalance < reservationBalance
  const grandTotal = reservationBalance + itemsTotal
  const totalDue = Math.max(0, grandTotal - paymentsTotal)
  const overpaid = paymentsTotal > grandTotal ? paymentsTotal - grandTotal : 0

  // ---- Reservation charge itemization (display-only; reconciles to total_price) ----
  const resNights = reservation
    ? Math.max(1, Math.round((new Date(reservation.departure_date + 'T00:00:00').getTime() - new Date(reservation.arrival_date + 'T00:00:00').getTime()) / 86400000))
    : 0
  const rExtraGuest = reservation?.extra_guest_fee_total || 0
  const rAddons = reservation?.addons_total || 0
  const rEarly = reservation?.early_checkin_fee || 0
  const rLate = reservation?.late_checkout_fee || 0
  const rFees = reservation?.fees_total || 0
  const rDiscount = reservation?.discount_amount || 0
  // Site charge is the reconciling remainder so the itemized lines always sum to total_price
  const rSiteCharge = reservation ? (reservation.total_price - rExtraGuest - rAddons - rEarly - rLate - rFees + rDiscount) : 0
  const rNightly = reservation ? (reservation.base_nightly_rate || 0) * resNights : 0
  const addonLinesSum = reservationAddons.reduce((s, a) => s + a.amount, 0)
  const useAddonDetail = reservationAddons.length > 0 && addonLinesSum === rAddons
  type ResLine = { label: string; amount: number; negative?: boolean }
  const resLines: ResLine[] = []
  if (reservation) {
    // Nightly line uses the authoritative stored per-night rate when available
    if (rNightly > 0) {
      resLines.push({ label: `${resNights} night${resNights !== 1 ? 's' : ''} × $${((reservation.base_nightly_rate || 0) / 100).toFixed(2)}`, amount: rNightly })
    } else {
      resLines.push({ label: `Site charge · ${resNights} night${resNights !== 1 ? 's' : ''}`, amount: rSiteCharge })
    }
    if (rExtraGuest > 0) resLines.push({ label: 'Extra guest fees', amount: rExtraGuest })
    if (useAddonDetail) {
      reservationAddons.forEach(a => resLines.push({ label: a.name + (a.quantity > 1 ? ` ×${a.quantity}` : ''), amount: a.amount }))
    } else if (rAddons > 0) {
      resLines.push({ label: 'Add-ons', amount: rAddons })
    }
    if (rEarly > 0) resLines.push({ label: 'Early check-in', amount: rEarly })
    if (rLate > 0) resLines.push({ label: 'Late check-out', amount: rLate })
    if (rFees > 0) resLines.push({ label: 'Fees', amount: rFees })
    if (rDiscount > 0) resLines.push({ label: 'Discount', amount: rDiscount, negative: true })
    // Reconcile: surface any amount baked into total_price that the stored breakdown didn't account for
    const shown = resLines.reduce((s, l) => s + (l.negative ? -l.amount : l.amount), 0)
    const leftover = reservation.total_price - shown
    if (leftover > 0) resLines.push({ label: 'Other charges', amount: leftover })
    else if (leftover < 0) resLines.push({ label: 'Adjustment', amount: -leftover, negative: true })
  }
  const fullCharges = (reservation ? reservation.total_price : 0) + itemsTotal
  const fullPaid = (reservation ? reservation.amount_paid : 0) + paymentsTotal
  const isGuestAcct = folio?.folio_type === 'guest_account'
  let balanceLabel = 'Balance due'
  let balanceAmount = totalDue
  let balanceColor = '#dc2626'
  if (overpaid > 0) {
    balanceLabel = isGuestAcct ? 'Credit on account' : 'Change due'
    balanceAmount = overpaid
    balanceColor = isGuestAcct ? '#15803d' : '#6b7280'
  } else if (totalDue === 0) {
    balanceLabel = 'Paid in full'
    balanceAmount = 0
    balanceColor = '#15803d'
  }

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
    negative?: boolean
    itemId?: string
    payment?: Payment
    isOpening?: boolean
    balanceAfter: number
  }
  const LEDGER_OPENING_TS = -8640000000000000
  const ledgerEvents: LedgerEvent[] = []
  let _lOrder = 0
  if (reservation) {
    resLines.forEach((l, i) => {
      ledgerEvents.push({ key: `res-${i}`, kind: 'charge', ts: LEDGER_OPENING_TS, order: _lOrder++, label: l.label, sub: 'At booking', amount: l.amount, negative: l.negative, isOpening: true, balanceAfter: 0 })
    })
    if (reservation.amount_paid > 0) {
      ledgerEvents.push({ key: 'res-deposit', kind: 'payment', ts: LEDGER_OPENING_TS, order: _lOrder++, label: 'Paid at booking', sub: 'At booking', amount: reservation.amount_paid, isOpening: true, balanceAfter: 0 })
    }
  }
  activeItems.forEach((item) => {
    ledgerEvents.push({ key: `item-${item.id}`, kind: 'charge', ts: item.charged_at ? new Date(item.charged_at).getTime() : 0, order: _lOrder++, label: item.description + (item.quantity > 1 ? ` ×${item.quantity}` : ''), sub: fmtLedgerDate(item.charged_at), note: item.notes, taxAmount: item.tax_amount, amount: item.line_total, itemId: item.id, balanceAfter: 0 })
  })
  payments.forEach((p) => {
    ledgerEvents.push({ key: `pay-${p.id}`, kind: 'payment', ts: p.paid_at ? new Date(p.paid_at).getTime() : 0, order: _lOrder++, label: p.method.charAt(0).toUpperCase() + p.method.slice(1), sub: fmtLedgerDate(p.paid_at), note: p.note, amount: p.amount - (p.surcharge_amount || 0), payment: p, balanceAfter: 0 })
  })
  ledgerEvents.sort((a, b) => a.ts - b.ts || a.order - b.order)
  let _lBal = 0
  ledgerEvents.forEach(ev => {
    if (ev.kind === 'charge') _lBal += ev.negative ? -ev.amount : ev.amount
    else _lBal -= ev.amount
    ev.balanceAfter = _lBal
  })
  let ledgerFoldIndex = -1
  for (let i = 0; i < ledgerEvents.length - 1; i++) {
    if (ledgerEvents[i].balanceAfter === 0) ledgerFoldIndex = i
  }
  const ledgerHasFold = ledgerFoldIndex >= 0
  const ledgerFoldedCount = ledgerHasFold ? ledgerFoldIndex + 1 : 0
  const ledgerFoldDate = ledgerHasFold ? (ledgerEvents[ledgerFoldIndex].isOpening ? 'at booking' : ledgerEvents[ledgerFoldIndex].sub) : ''
  const visibleLedger = ledgerHasFold && !showEarlier ? ledgerEvents.slice(ledgerFoldIndex + 1) : ledgerEvents

  // Card surcharge preview
  const paymentAmountCents = Math.round(parseFloat(paymentAmount) * 100) || 0
  const surchargePreview = paymentMethod === 'card' && cardSurcharge > 0 && !waiveFee
    ? Math.round(paymentAmountCents * (cardSurcharge / 100))
    : 0
  const totalWithSurcharge = paymentAmountCents + surchargePreview

  const filteredProducts = products.filter(p => p.category === activeCategory)

  if (loading) return <div style={{ padding: '3rem', textAlign: 'center', color: '#6b7280' }}>Loading folio...</div>

  if (isNew && !folio) {
    return (
      <div style={{ padding: '2rem', maxWidth: 480, margin: '0 auto', fontFamily: 'sans-serif', minHeight: '100vh', background: '#FBF7EE' }}>
        <button onClick={() => router.back()} style={{ background: 'none', border: 'none', color: '#6b7280', cursor: 'pointer', fontSize: 14, marginBottom: 24 }}>← Back</button>
        <h1 style={{ fontSize: 22, fontWeight: 700, marginBottom: 8 }}>New Walk-Up Sale</h1>
        <p style={{ color: '#6b7280', fontSize: 14, marginBottom: 24 }}>Start a tab for a visitor, family member, or anyone not attached to a reservation.</p>
        <label style={{ fontSize: 13, fontWeight: 600, color: '#374151', display: 'block', marginBottom: 6 }}>Guest name (optional)</label>
        <input
          style={{ width: '100%', border: '1px solid #d1d5db', borderRadius: 8, padding: '10px 12px', fontSize: 15, boxSizing: 'border-box', marginBottom: 16 }}
          placeholder="e.g. Smith family, Site 12 visitor..."
          value={walkUpName}
          onChange={e => setWalkUpName(e.target.value)}
        />
        <button onClick={createWalkUpFolio} style={{ width: '100%', background: '#2E6B8A', color: '#fff', border: 'none', borderRadius: 8, padding: '12px', fontWeight: 700, fontSize: 16, cursor: 'pointer' }}>
          Open Tab
        </button>
      </div>
    )
  }

  return (
    <div style={{ fontFamily: 'sans-serif', minHeight: '100vh', background: '#FBF7EE' }}>
      {/* Header */}
      <div style={{ background: '#fff', borderBottom: '1px solid #ECE3D2', padding: '0.875rem 1.25rem', display: 'flex', alignItems: 'center', gap: 12, boxShadow: '0 1px 4px rgba(0,0,0,0.05)' }}>
        <button onClick={() => router.back()} style={{ background: 'none', border: 'none', color: '#6b7280', cursor: 'pointer', fontSize: 14, whiteSpace: 'nowrap' }}>← Back</button>
        <div style={{ flex: 1, minWidth: 0 }}>
          <h1 style={{ margin: 0, fontSize: 17, fontWeight: 700, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{folio?.guest_name || reservation?.guest_name}</h1>
          {reservation && (
            <p style={{ margin: 0, fontSize: 12, color: '#6b7280' }}>
              Site {reservation.site_number} · {reservation.arrival_date} → {reservation.departure_date}
            </p>
          )}
          {folio?.folio_type === 'walkin' && <p style={{ margin: 0, fontSize: 12, color: '#6b7280' }}>Walk-up sale</p>}
        </div>
        <div style={{ textAlign: 'right', flexShrink: 0 }}>
          <div style={{ fontSize: 15, fontWeight: 700, color: overpaid > 0 ? (isGuestAcct ? '#15803d' : '#6b7280') : totalDue > 0 ? '#dc2626' : '#15803d' }}>
            {overpaid > 0 ? (isGuestAcct ? `Credit $${(overpaid/100).toFixed(2)}` : `Change $${(overpaid/100).toFixed(2)}`) : `$${(totalDue/100).toFixed(2)}`}
          </div>
          <div style={{ fontSize: 11, color: '#9ca3af' }}>
            {overpaid > 0 ? (isGuestAcct ? 'credit on account' : 'give change') : totalDue > 0 ? 'balance due' : '✓ paid in full'}
          </div>
        </div>
      </div>

      {/* Mobile tab switcher */}
      <div style={{ display: 'flex', borderBottom: '1px solid #ECE3D2', background: '#fff', boxShadow: '0 1px 3px rgba(0,0,0,0.04)' }}>
        <button
          onClick={() => setActiveTab('tab')}
          style={{ flex: 1, padding: '12px', fontSize: 14, fontWeight: 600, border: 'none', background: 'none', cursor: 'pointer', borderBottom: activeTab === 'tab' ? '2px solid #15803d' : '2px solid transparent', color: activeTab === 'tab' ? '#15803d' : '#6b7280' }}
        >
          Guest Tab
        </button>
        {posEnabled && (
          <button
            onClick={() => { setActiveTab('items'); setActiveCategory('') }}
            style={{ flex: 1, padding: '12px', fontSize: 14, fontWeight: 600, border: 'none', background: 'none', cursor: 'pointer', borderBottom: activeTab === 'items' ? '2px solid #15803d' : '2px solid transparent', color: activeTab === 'items' ? '#15803d' : '#6b7280' }}
          >
            Add Items
          </button>
        )}
      </div>

      <div style={{ display: 'flex', minHeight: 'calc(100vh - 120px)' }}>
        {/* Left: Folio tab — receipt style */}
        <div style={{ flex: 1, padding: '1.25rem', overflowY: 'auto', display: activeTab === 'tab' ? 'block' : 'none', background: '#FBF7EE' }}>

          {/* LEDGER — charges & payments in chronological order with a running balance */}
          {ledgerEvents.length > 0 && (
            <div style={{ background: '#fff', border: '1px solid #ECE3D2', borderRadius: 12, marginBottom: 14, overflow: 'hidden' }}>
              <div style={{ display: 'flex', alignItems: 'center', padding: '0.7rem 1rem', borderBottom: '1px solid #F3EEE2' }}>
                <div style={{ flex: 1, fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', color: '#A1937C' }}>Account</div>
                <div style={{ width: 80, textAlign: 'right', fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.04em', color: '#C2B7A1' }}>Amount</div>
                <div style={{ width: 92, textAlign: 'right', fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.04em', color: '#C2B7A1' }}>Balance</div>
                <div style={{ width: 78, flexShrink: 0 }} />
              </div>

              {ledgerHasFold && (
                <button
                  onClick={() => setShowEarlier(s => !s)}
                  style={{ width: '100%', display: 'flex', alignItems: 'center', gap: 8, padding: '9px 16px', background: '#FBF8F1', border: 'none', borderBottom: '1px solid #F3EEE2', cursor: 'pointer', textAlign: 'left', color: '#8A7E6B', fontSize: 13 }}
                >
                  <span style={{ fontSize: 12 }}>{showEarlier ? '▾' : '▸'}</span>
                  <span>{showEarlier ? `Hide earlier activity · settled ${ledgerFoldDate}` : `Show earlier activity · settled ${ledgerFoldDate} · ${ledgerFoldedCount} ${ledgerFoldedCount === 1 ? 'entry' : 'entries'}`}</span>
                </button>
              )}

              {visibleLedger.map((ev) => {
                const isPay = ev.kind === 'payment'
                const balPositive = ev.balanceAfter > 0
                const balZero = ev.balanceAfter === 0
                const balText = balZero ? 'settled' : balPositive ? 'balance due' : (isGuestAcct ? 'credit' : 'change')
                const balColor = (balZero || !balPositive) ? '#15803d' : '#b45309'
                return (
                  <div key={ev.key} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 16px', borderBottom: '1px solid #FBF8F1', background: isPay ? '#F4FBF6' : '#fff', borderLeft: isPay ? '3px solid #15803d' : '3px solid transparent' }}>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 14, fontWeight: 500, color: ev.negative ? '#15803d' : '#374151' }}>{ev.label}</div>
                      <div style={{ fontSize: 11, color: isPay ? '#7BA88C' : '#A1937C' }}>{ev.sub}{ev.isOpening ? '' : (isPay ? ' · payment' : ' · charge')}</div>
                      {ev.note && <div style={{ fontSize: 11, color: '#6b7280', fontStyle: 'italic', marginTop: 1 }}>{ev.note}</div>}
                      {ev.taxAmount && ev.taxAmount > 0 ? <div style={{ fontSize: 11, color: '#9ca3af' }}>incl. ${(ev.taxAmount/100).toFixed(2)} tax</div> : null}
                    </div>
                    <div style={{ width: 80, textAlign: 'right', fontSize: 14, fontWeight: 500, color: isPay ? '#15803d' : (ev.negative ? '#15803d' : '#111827') }}>
                      {(isPay || ev.negative) ? '−' : ''}${(ev.amount/100).toFixed(2)}
                    </div>
                    <div style={{ width: 92, textAlign: 'right' }}>
                      <div style={{ fontSize: 13, fontWeight: 500, color: balColor }}>${(Math.abs(ev.balanceAfter)/100).toFixed(2)}</div>
                      <div style={{ fontSize: 10, color: '#A1937C' }}>{balText}</div>
                    </div>
                    <div style={{ width: 78, flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 6 }}>
                      {ev.itemId && (
                        <button onClick={() => removeLineItem(ev.itemId!)} style={{ background: 'none', border: 'none', color: '#dc2626', cursor: 'pointer', fontSize: 18, padding: '0 2px', lineHeight: 1 }}>×</button>
                      )}
                      {ev.payment && ev.payment.status === 'completed' && (
                        <>
                          <button onClick={() => openRefund(ev.payment)} style={{ background: 'none', border: '1px solid #e5e7eb', borderRadius: 5, color: '#6b7280', cursor: 'pointer', fontSize: 11, padding: '2px 7px', fontWeight: 600 }}>Refund</button>
                          <button onClick={() => voidPayment(ev.payment!.id)} style={{ background: 'none', border: 'none', color: '#dc2626', cursor: 'pointer', fontSize: 18, padding: '0 2px', lineHeight: 1 }}>×</button>
                        </>
                      )}
                    </div>
                  </div>
                )
              })}
            </div>
          )}

          {/* Added confirmation toast */}
          {lastAdded && (
            <div style={{ position: 'fixed', bottom: 100, left: '50%', transform: 'translateX(-50%)', background: '#15803d', color: '#fff', borderRadius: 12, padding: '12px 24px', fontSize: 15, fontWeight: 600, zIndex: 60, display: 'flex', alignItems: 'center', gap: 8, boxShadow: '0 4px 16px rgba(0,0,0,0.2)', whiteSpace: 'nowrap' }}>
              <span>✓</span> {lastAdded} added to tab
            </div>
          )}

          {/* Empty state */}
          {!reservation && activeItems.length === 0 && payments.length === 0 && (
            <div style={{ textAlign: 'center', color: '#9ca3af', padding: '3rem 0', fontSize: 14 }}>
              No charges yet. Tap "Add Items" to get started.
            </div>
          )}

          {/* TOTALS — bottom line of the receipt */}
          {(reservation || activeItems.length > 0 || payments.length > 0) && (
            <div style={{ background: '#fff', border: '1px solid #ECE3D2', borderRadius: 12, padding: '0.9rem 1.1rem', marginBottom: 14 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', padding: '5px 0', fontSize: 14 }}>
                <span style={{ color: '#8A7E6B' }}>Total</span>
                <span style={{ fontWeight: 600, color: '#111827' }}>${(fullCharges/100).toFixed(2)}</span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', padding: '5px 0', fontSize: 14 }}>
                <span style={{ color: '#8A7E6B' }}>Paid</span>
                <span style={{ fontWeight: 600, color: fullPaid > 0 ? '#15803d' : '#111827' }}>${(fullPaid/100).toFixed(2)}</span>
              </div>
              <div style={{ height: 1, background: '#ECE3D2', margin: '8px 0' }} />
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
                <span style={{ fontSize: 16, fontWeight: 700, color: '#4b3f30' }}>{balanceLabel}</span>
                <span style={{ fontSize: 32, fontWeight: 800, color: balanceColor }}>${(balanceAmount/100).toFixed(2)}</span>
              </div>
              {overpaid > 0 && (
                <div style={{ fontSize: 12, color: '#6b7280', textAlign: 'right', marginTop: 2 }}>
                  {isGuestAcct ? 'This camper has a credit balance' : 'Folio complete'}
                </div>
              )}
            </div>
          )}

          {/* Collect payment button */}
          {totalDue > 0 && (
            <button
              onClick={() => { setPaymentAmount((totalDue/100).toFixed(2)); setPaymentMethod('cash'); setWaiveFee(false); setFeeAlreadyIncluded(false); setShowPayment(true) }}
              style={{ width: '100%', background: '#2E6B8A', color: '#fff', border: 'none', borderRadius: 10, padding: '14px', fontWeight: 700, fontSize: 16, cursor: 'pointer' }}
            >
              Collect Payment · ${(totalDue/100).toFixed(2)}
            </button>
          )}

          {/* Receipt buttons */}
          {payments.length > 0 && (
            <ReceiptButtons folioId={folio?.id || ''} guestEmail={folio?.guest_email || reservation?.guest_email || ''} receiptType='reservation' />
          )}
        </div>

        {/* Right: Product picker — only shown when POS enabled */}
        <div style={{ flex: 1, background: '#FBF7EE', display: posEnabled && activeTab === 'items' ? 'flex' : 'none', flexDirection: 'column' }}>
          {/* Category or Items view */}
          {activeCategory === '' ? (
            <div style={{ flex: 1, overflowY: 'auto', padding: '1rem', display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 10, alignContent: 'start' }}>
              <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em', color: '#A1937C', marginBottom: 4 }}>Select a category</div>
              {categories.map(cat => (
                <button
                  key={cat}
                  onClick={() => setActiveCategory(cat)}
                  style={{ background: '#2E6B8A', color: '#fff', border: 'none', borderRadius: 12, padding: '18px 20px', fontSize: 16, fontWeight: 700, cursor: 'pointer', textAlign: 'left', display: 'flex', alignItems: 'center', justifyContent: 'space-between', boxShadow: '0 2px 6px rgba(46,107,138,0.3)', transition: 'background 0.15s' }}
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
              <div style={{ padding: '0.75rem 1rem', borderBottom: '1px solid #ECE3D2', background: 'rgba(255,255,255,0.5)', display: 'flex', alignItems: 'center', gap: 10 }}>
                <button
                  onClick={() => setActiveCategory('')}
                  style={{ background: '#2E6B8A', color: '#fff', border: 'none', borderRadius: 8, padding: '6px 14px', fontSize: 13, fontWeight: 600, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 6 }}
                >
                  ‹ Back
                </button>
                <span style={{ fontWeight: 700, fontSize: 14, color: '#1e3f52' }}>{activeCategory}</span>
              </div>
              <div style={{ flex: 1, overflowY: 'auto', padding: '0.875rem', display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: 12, alignContent: 'start' }}>
                {filteredProducts.map(product => (
                  <VariableProductTile key={product.id} product={product} onAdd={addProduct} />
                ))}
                {filteredProducts.length === 0 && (
                  <div style={{ gridColumn: '1/-1', textAlign: 'center', color: '#4a6275', fontSize: 13, padding: '2rem 0' }}>
                    No products in this category
                  </div>
                )}
              </div>
            </>
          )}

          <div style={{ borderTop: '1px solid #ECE3D2', padding: '0.875rem' }}>
            {!showCustomItem ? (
              <button onClick={() => setShowCustomItem(true)} style={{ width: '100%', background: 'none', border: '1px dashed #d1d5db', borderRadius: 8, padding: '10px', fontSize: 13, color: '#6b7280', cursor: 'pointer' }}>
                + Custom charge
              </button>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                <input style={si} placeholder="Description" value={customDesc} onChange={e => setCustomDesc(e.target.value)} />
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                  <input style={si} placeholder="Price $" value={customPrice} onChange={e => setCustomPrice(e.target.value)} />
                  <input style={si} placeholder="Qty" value={customQty} onChange={e => setCustomQty(e.target.value)} />
                </div>
                <div style={{ display: 'flex', gap: 8 }}>
                  <button onClick={() => setShowCustomItem(false)} style={{ flex: 1, background: 'none', border: '1px solid #e5e7eb', borderRadius: 7, padding: '8px', fontSize: 13, cursor: 'pointer' }}>Cancel</button>
                  <button onClick={addCustomItem} style={{ flex: 1, background: '#2E6B8A', color: '#fff', border: 'none', borderRadius: 7, padding: '8px', fontSize: 13, fontWeight: 600, cursor: 'pointer' }}>Add</button>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Payment modal */}
      {/* Terminal status */}
      {/* Refund Modal */}
      {showRefund && refundPayment && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 50, display: 'flex', alignItems: 'flex-end', justifyContent: 'center' }}>
          <div style={{ background: '#fff', borderRadius: '16px 16px 0 0', padding: '1.5rem', width: '100%', maxWidth: 520 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem' }}>
              <h2 style={{ margin: 0, fontSize: 18, fontWeight: 700 }}>Issue Refund</h2>
              <button onClick={() => setShowRefund(false)} style={{ background: 'none', border: 'none', fontSize: 22, cursor: 'pointer', color: '#6b7280' }}>×</button>
            </div>
            <div style={{ background: '#f9fafb', border: '1px solid #e5e7eb', borderRadius: 8, padding: '12px 14px', marginBottom: 16 }}>
              <div style={{ fontSize: 13, color: '#6b7280' }}>Original payment</div>
              <div style={{ fontSize: 15, fontWeight: 700, color: '#111827', marginTop: 2 }}>
                ${((refundPayment.amount - (refundPayment.surcharge_amount || 0)) / 100).toFixed(2)} · {refundPayment.method}
                {refundPayment.method === 'card' && refundPayment.square_payment_id
                  ? <span style={{ fontSize: 11, color: '#15803d', marginLeft: 8 }}>✓ Will refund to card via Square</span>
                  : refundPayment.method === 'card'
                  ? <span style={{ fontSize: 11, color: '#f59e0b', marginLeft: 8 }}>⚠ No Square ID — record manually</span>
                  : <span style={{ fontSize: 11, color: '#6b7280', marginLeft: 8 }}>Cash/check — record return manually</span>
                }
              </div>
              {refundPayment.note && <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 2 }}>{refundPayment.note}</div>}
            </div>
            <label style={ml}>Refund amount ($)</label>
            <div style={{ position: 'relative', marginBottom: 12 }}>
              <span style={{ position: 'absolute', left: 14, top: '50%', transform: 'translateY(-50%)', color: '#6b7280', fontSize: 18 }}>$</span>
              <input
                style={{ ...si, paddingLeft: 30, fontSize: 22, fontWeight: 700, height: 52 }}
                type='number'
                step='0.01'
                min='0'
                max={((refundPayment.amount - (refundPayment.surcharge_amount || 0)) / 100).toFixed(2)}
                value={refundAmount}
                onChange={e => setRefundAmount(e.target.value)}
              />
            </div>
            <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
              {[100, 90, 50].map(pct => (
                <button key={pct} onClick={() => setRefundAmount(((refundPayment.amount - (refundPayment.surcharge_amount || 0)) * pct / 10000).toFixed(2))}
                  style={{ flex: 1, background: '#f3f4f6', border: '1px solid #e5e7eb', borderRadius: 7, padding: '7px', fontSize: 13, fontWeight: 600, cursor: 'pointer', color: '#374151' }}>
                  {pct}%
                </button>
              ))}
            </div>
            <label style={ml}>Reason</label>
            <input style={{ ...si, marginBottom: 16 }} placeholder='e.g. Cancellation — outside 7 days' value={refundReason} onChange={e => setRefundReason(e.target.value)} />
            {refundError && <div style={{ background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 8, padding: '10px 14px', marginBottom: 12, fontSize: 13, color: '#dc2626' }}>{refundError}</div>}
            {refundSuccess ? (
              <div style={{ textAlign: 'center', padding: '1.5rem 0' }}>
                <div style={{ fontSize: 48, marginBottom: 12 }}>✅</div>
                <div style={{ fontSize: 20, fontWeight: 700, color: '#15803d', marginBottom: 6 }}>Refund Successful!</div>
                <div style={{ fontSize: 14, color: '#6b7280' }}>${refundAmount} has been refunded{refundPayment?.method === 'card' ? ' to the card' : ' — return cash to guest'}</div>
              </div>
            ) : (
              <button
                onClick={processRefund}
                disabled={processingRefund || !refundAmount || parseFloat(refundAmount) <= 0}
                style={{ width: '100%', background: processingRefund || !refundAmount ? '#d1d5db' : '#dc2626', color: '#fff', border: 'none', borderRadius: 10, padding: '14px', fontWeight: 700, fontSize: 16, cursor: 'pointer' }}
              >
                {processingRefund ? 'Processing...' : `Issue Refund · $${refundAmount || '0.00'}`}
              </button>
            )}
            {refundPayment.method !== 'card' && (
              <p style={{ fontSize: 12, color: '#9ca3af', textAlign: 'center', marginTop: 8 }}>
                Cash/check refunds are recorded here. Please return ${refundAmount} to the guest manually.
              </p>
            )}
          </div>
        </div>
      )}

      {terminalStatus === 'waiting' && (
        <div style={{ position: 'fixed', bottom: 20, left: '50%', transform: 'translateX(-50%)', background: '#2E6B8A', color: '#fff', borderRadius: 12, padding: '14px 24px', fontSize: 15, fontWeight: 600, zIndex: 60, display: 'flex', alignItems: 'center', gap: 10 }}>
          <div style={{ width: 10, height: 10, borderRadius: '50%', background: '#fff', animation: 'pulse 1s infinite' }} />
          Waiting for customer to tap card on Terminal...
          <style>{`@keyframes pulse { 0%,100%{opacity:1} 50%{opacity:0.3} }`}</style>
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

      {showPayment && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 50, display: 'flex', alignItems: 'flex-end', justifyContent: 'center' }}>
          <div style={{ background: '#fff', borderRadius: '16px 16px 0 0', padding: '1.5rem', width: '100%', maxWidth: 520 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1.25rem' }}>
              <h2 style={{ margin: 0, fontSize: 18, fontWeight: 700 }}>Collect Payment</h2>
              <button onClick={() => { setShowPayment(false); setCashTendered('') }} style={{ background: 'none', border: 'none', fontSize: 22, cursor: 'pointer', color: '#6b7280' }}>×</button>
            </div>

            <label style={ml}>Payment method</label>
            <div style={{ display: 'grid', gridTemplateColumns: feeAlreadyIncluded ? (paymentMethod === 'card' ? '1fr' : '1fr 1fr') : '1fr 1fr 1fr', gap: 8, marginBottom: 16 }}>
              {(feeAlreadyIncluded ? (paymentMethod === 'card' ? ['card'] : ['cash', 'check']) : ['cash', 'card', 'check']).map(m => (
                <button key={m} onClick={() => setPaymentMethod(m)} style={{ padding: '12px', border: `2px solid ${paymentMethod === m ? '#2E6B8A' : '#e5e7eb'}`, borderRadius: 8, background: paymentMethod === m ? '#e8f2f7' : '#fff', fontWeight: 600, fontSize: 14, cursor: 'pointer', textTransform: 'capitalize', color: paymentMethod === m ? '#2E6B8A' : '#374151' }}>
                  {m}
                </button>
              ))}
            </div>

            {paymentMethod === 'card' && (
              <div style={{ marginBottom: 16 }}>
                {/* Card mode selector */}
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 12 }}>
                  {terminalDeviceId && (
                    <button onClick={() => setCardEntryMode('terminal')}
                      style={{ padding: '10px', border: '2px solid', borderColor: cardEntryMode === 'terminal' ? '#2E6B8A' : '#e5e7eb', borderRadius: 8, background: cardEntryMode === 'terminal' ? '#e8f2f7' : '#fff', fontWeight: 600, fontSize: 13, cursor: 'pointer', color: cardEntryMode === 'terminal' ? '#2E6B8A' : '#374151' }}>
                      💳 Use Terminal
                    </button>
                  )}
                  <button onClick={() => { setCardEntryMode('manual'); setTimeout(loadSquareCard, 100) }}
                    style={{ padding: '10px', border: '2px solid', borderColor: cardEntryMode === 'manual' ? '#2E6B8A' : '#e5e7eb', borderRadius: 8, background: cardEntryMode === 'manual' ? '#e8f2f7' : '#fff', fontWeight: 600, fontSize: 13, cursor: 'pointer', color: cardEntryMode === 'manual' ? '#2E6B8A' : '#374151', gridColumn: terminalDeviceId ? 'auto' : '1 / -1' }}>
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
            ) : (
              <>
                {paymentMethod === 'card' && cardSurcharge > 0 && !feeAlreadyIncluded && (
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
            <label style={ml}>{paymentMethod === 'cash' ? 'Amount due' : 'Amount'}</label>
                <div style={{ position: 'relative', marginBottom: 8 }}>
                  <span style={{ position: 'absolute', left: 14, top: '50%', transform: 'translateY(-50%)', color: '#6b7280', fontSize: 18 }}>$</span>
                  <input
                    style={{ ...si, paddingLeft: 30, fontSize: 24, fontWeight: 700, height: 56, background: paymentMethod === 'cash' ? '#f9fafb' : '#fff', color: paymentMethod === 'cash' ? '#6b7280' : '#111827' }}
                    type="number"
                    step="0.01"
                    value={paymentAmount}
                    readOnly={paymentMethod === 'cash'}
                    onChange={e => setPaymentAmount(e.target.value)}
                  />
                </div>
              </>
            )}
            {paymentMethod === 'cash' && (
              <>
                <label style={ml}>Cash tendered</label>
                <div style={{ position: 'relative', marginBottom: 8 }}>
                  <span style={{ position: 'absolute', left: 14, top: '50%', transform: 'translateY(-50%)', color: '#6b7280', fontSize: 18 }}>$</span>
                  <input
                    style={{ ...si, paddingLeft: 30, fontSize: 24, fontWeight: 700, height: 56 }}
                    type="number"
                    step="0.01"
                    value={cashTendered}
                    onChange={e => setCashTendered(e.target.value)}
                    placeholder="0.00"
                    autoFocus
                  />
                </div>
                {parseFloat(cashTendered) > 0 && (
                  <div style={{ background: parseFloat(cashTendered) >= parseFloat(paymentAmount) ? '#f0fdf4' : '#fef2f2', border: '1px solid', borderColor: parseFloat(cashTendered) >= parseFloat(paymentAmount) ? '#bbf7d0' : '#fecaca', borderRadius: 8, padding: '10px 14px', marginBottom: 12, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <span style={{ fontWeight: 600, fontSize: 14, color: parseFloat(cashTendered) >= parseFloat(paymentAmount) ? '#15803d' : '#dc2626' }}>
                      {parseFloat(cashTendered) >= parseFloat(paymentAmount) ? 'Change due' : 'Amount short'}
                    </span>
                    <span style={{ fontWeight: 800, fontSize: 18, color: parseFloat(cashTendered) >= parseFloat(paymentAmount) ? '#15803d' : '#dc2626' }}>
                      <span>$</span>{Math.abs(parseFloat(cashTendered) - parseFloat(paymentAmount)).toFixed(2)}
                    </span>
                  </div>
                )}
              </>
            )}

            {paymentMethod === 'card' && cardEntryMode === 'manual' && (
              <div style={{ marginBottom: 16 }}>
                <label style={ml}>Card Details</label>
                <div id='admin-square-card-container' style={{ minHeight: 89, border: '1px solid #d1d5db', borderRadius: 8, padding: 4 }} />
                {!squareCardLoaded && <p style={{ fontSize: 12, color: '#9ca3af', marginTop: 4 }}>Loading card form...</p>}
                {cardSurcharge > 0 && !waiveFee && (
                  <div style={{ background: '#fffbeb', border: '1px solid #fde68a', borderRadius: 8, padding: '8px 12px', marginTop: 8, fontSize: 12 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                      <span style={{ color: '#92400e' }}>{cardSurcharge}% card fee</span>
                      <span style={{ color: '#92400e', fontWeight: 600 }}>+${(Math.round(Math.round(parseFloat(paymentAmount || '0') * 100) * cardSurcharge / 100) / 100).toFixed(2)}</span>
                    </div>
                  </div>
                )}
                <label style={{ ...ml, marginTop: 12 }}>Note (optional)</label>
                <input style={{ ...si, marginBottom: 12 }} placeholder='e.g. phone reservation' value={paymentNote} onChange={e => setPaymentNote(e.target.value)} />
                <button
                  onClick={chargeManualCard}
                  disabled={chargingCard || !squareCardLoaded || !paymentAmount}
                  style={{ width: '100%', background: chargingCard || !squareCardLoaded || !paymentAmount ? '#d1d5db' : '#2E6B8A', color: '#fff', border: 'none', borderRadius: 10, padding: '14px', fontWeight: 700, fontSize: 16, cursor: 'pointer' }}
                >
                  {chargingCard ? 'Processing...' : `Charge Card · $${paymentAmount || '0.00'}`}
                </button>
              </div>
            )}
            {!(paymentMethod === 'card' && terminalDeviceId && cardEntryMode === 'terminal') && !(paymentMethod === 'card' && cardEntryMode === 'manual') && (
              <>
              {/* Card surcharge preview */}
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
              <input style={{ ...si, marginBottom: 16 }} placeholder="e.g. check #1042" value={paymentNote} onChange={e => setPaymentNote(e.target.value)} />
  
              <button
                onClick={collectPayment}
                disabled={savingPayment}
                style={{ width: '100%', background: '#2E6B8A', color: '#fff', border: 'none', borderRadius: 10, padding: '14px', fontWeight: 700, fontSize: 16, cursor: 'pointer' }}
              >
                {savingPayment ? 'Recording...' : paymentMethod === 'card' && surchargePreview > 0
                  ? `Charge card · $${(totalWithSurcharge/100).toFixed(2)}`
                  : paymentMethod === 'cash' && cashTendered !== ''
                  ? `Record cash · $${Math.min(parseFloat(cashTendered), parseFloat(paymentAmount)).toFixed(2)}`
                  : `Record ${paymentMethod} · $${paymentAmount}`}
              </button>
              </>
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
      <button
        onClick={() => window.location.href = '/admin/folio/new'}
        style={{ width: '100%', background: '#15803d', color: '#fff', border: 'none', borderRadius: 8, padding: '12px', fontSize: 14, fontWeight: 700, cursor: 'pointer' }}
      >
        + New Sale
      </button>
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
