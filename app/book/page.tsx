'use client'

import { useState, useEffect, useRef, Suspense } from 'react'
import { useSearchParams } from 'next/navigation'
import Image from 'next/image'
import { supabase } from '@/lib/supabase'

type Addon = {
  id: string
  name: string
  description: string
  price: number
  is_early_checkin: boolean
}

type Fee = {
  id: string
  name: string
  type: 'percentage' | 'flat'
  amount: number
  applies_to: string
  is_active: boolean
  card_only: boolean
}

const CAMPER_TYPES = [
  {
    value: 'travel_trailer',
    label: 'Travel Trailer',
    svg: (
      <svg viewBox="0 0 80 40" fill="none" xmlns="http://www.w3.org/2000/svg" className="w-full h-full">
        <rect x="8" y="8" width="58" height="22" rx="3" fill="currentColor" opacity="0.15" stroke="currentColor" strokeWidth="2"/>
        <rect x="12" y="12" width="10" height="8" rx="1" fill="currentColor" opacity="0.4"/>
        <rect x="26" y="12" width="10" height="8" rx="1" fill="currentColor" opacity="0.4"/>
        <rect x="40" y="12" width="10" height="8" rx="1" fill="currentColor" opacity="0.4"/>
        <line x1="8" y1="30" x2="4" y2="30" stroke="currentColor" strokeWidth="2"/>
        <circle cx="22" cy="33" r="4" fill="currentColor" opacity="0.6"/>
        <circle cx="52" cy="33" r="4" fill="currentColor" opacity="0.6"/>
        <line x1="66" y1="19" x2="74" y2="19" stroke="currentColor" strokeWidth="2"/>
      </svg>
    ),
  },
  {
    value: 'fifth_wheel',
    label: 'Fifth Wheel',
    svg: (
      <svg viewBox="0 0 80 40" fill="none" xmlns="http://www.w3.org/2000/svg" className="w-full h-full">
        <rect x="8" y="10" width="56" height="20" rx="3" fill="currentColor" opacity="0.15" stroke="currentColor" strokeWidth="2"/>
        <rect x="48" y="4" width="16" height="10" rx="2" fill="currentColor" opacity="0.25" stroke="currentColor" strokeWidth="1.5"/>
        <rect x="12" y="14" width="9" height="7" rx="1" fill="currentColor" opacity="0.4"/>
        <rect x="25" y="14" width="9" height="7" rx="1" fill="currentColor" opacity="0.4"/>
        <circle cx="20" cy="33" r="4" fill="currentColor" opacity="0.6"/>
        <circle cx="50" cy="33" r="4" fill="currentColor" opacity="0.6"/>
        <line x1="64" y1="9" x2="72" y2="9" stroke="currentColor" strokeWidth="2"/>
      </svg>
    ),
  },
  {
    value: 'class_a',
    label: 'Class A',
    svg: (
      <svg viewBox="0 0 80 40" fill="none" xmlns="http://www.w3.org/2000/svg" className="w-full h-full">
        <rect x="6" y="8" width="62" height="22" rx="2" fill="currentColor" opacity="0.15" stroke="currentColor" strokeWidth="2"/>
        <rect x="6" y="8" width="12" height="22" rx="2" fill="currentColor" opacity="0.1"/>
        <rect x="8" y="11" width="8" height="10" rx="1" fill="currentColor" opacity="0.5"/>
        <rect x="22" y="13" width="8" height="7" rx="1" fill="currentColor" opacity="0.35"/>
        <rect x="34" y="13" width="8" height="7" rx="1" fill="currentColor" opacity="0.35"/>
        <rect x="46" y="13" width="8" height="7" rx="1" fill="currentColor" opacity="0.35"/>
        <circle cx="18" cy="33" r="4" fill="currentColor" opacity="0.6"/>
        <circle cx="56" cy="33" r="4" fill="currentColor" opacity="0.6"/>
      </svg>
    ),
  },
  {
    value: 'class_c',
    label: 'Class C',
    svg: (
      <svg viewBox="0 0 80 40" fill="none" xmlns="http://www.w3.org/2000/svg" className="w-full h-full">
        <rect x="14" y="10" width="54" height="20" rx="2" fill="currentColor" opacity="0.15" stroke="currentColor" strokeWidth="2"/>
        <rect x="6" y="16" width="14" height="14" rx="2" fill="currentColor" opacity="0.2" stroke="currentColor" strokeWidth="1.5"/>
        <rect x="8" y="18" width="8" height="7" rx="1" fill="currentColor" opacity="0.45"/>
        <rect x="30" y="13" width="8" height="7" rx="1" fill="currentColor" opacity="0.35"/>
        <rect x="42" y="13" width="8" height="7" rx="1" fill="currentColor" opacity="0.35"/>
        <circle cx="22" cy="33" r="4" fill="currentColor" opacity="0.6"/>
        <circle cx="56" cy="33" r="4" fill="currentColor" opacity="0.6"/>
      </svg>
    ),
  },
  {
    value: 'van',
    label: 'Van',
    svg: (
      <svg viewBox="0 0 80 40" fill="none" xmlns="http://www.w3.org/2000/svg" className="w-full h-full">
        <rect x="10" y="12" width="52" height="18" rx="3" fill="currentColor" opacity="0.15" stroke="currentColor" strokeWidth="2"/>
        <path d="M10 20 Q10 12 18 12" stroke="currentColor" strokeWidth="2" fill="none"/>
        <rect x="13" y="14" width="9" height="8" rx="1" fill="currentColor" opacity="0.5"/>
        <rect x="26" y="15" width="8" height="6" rx="1" fill="currentColor" opacity="0.35"/>
        <rect x="38" y="15" width="8" height="6" rx="1" fill="currentColor" opacity="0.35"/>
        <circle cx="22" cy="33" r="4" fill="currentColor" opacity="0.6"/>
        <circle cx="52" cy="33" r="4" fill="currentColor" opacity="0.6"/>
      </svg>
    ),
  },
  {
    value: 'other',
    label: 'Other',
    svg: (
      <svg viewBox="0 0 80 40" fill="none" xmlns="http://www.w3.org/2000/svg" className="w-full h-full">
        <rect x="10" y="10" width="52" height="20" rx="4" fill="currentColor" opacity="0.15" stroke="currentColor" strokeWidth="2" strokeDasharray="4 2"/>
        <text x="36" y="24" textAnchor="middle" fill="currentColor" fontSize="12" fontWeight="bold" opacity="0.5">?</text>
        <circle cx="22" cy="33" r="4" fill="currentColor" opacity="0.4"/>
        <circle cx="52" cy="33" r="4" fill="currentColor" opacity="0.4"/>
      </svg>
    ),
  },
]

function parseTime(timeStr: string): { hours: number; minutes: number } | null {
  if (!timeStr) return null
  const clean = timeStr.trim().toUpperCase()
  const match12 = clean.match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/)
  if (match12) {
    let hours = parseInt(match12[1])
    const minutes = parseInt(match12[2])
    const period = match12[3]
    if (period === 'PM' && hours !== 12) hours += 12
    if (period === 'AM' && hours === 12) hours = 0
    return { hours, minutes }
  }
  const match24 = clean.match(/^(\d{1,2}):(\d{2})$/)
  if (match24) {
    return { hours: parseInt(match24[1]), minutes: parseInt(match24[2]) }
  }
  return null
}

function BookingForm() {
  const searchParams = useSearchParams()
  const cardRef = useRef<any>(null)
  const squareRef = useRef<any>(null)
  const signatureCanvasRef = useRef<HTMLCanvasElement>(null)
  const isDrawing = useRef(false)

  const [addons, setAddons] = useState<Addon[]>([])
  const [fees, setFees] = useState<Fee[]>([])
  const [selectedAddons, setSelectedAddons] = useState<{ [id: string]: number }>({})
  const [discountCode, setDiscountCode] = useState('')
  const [discountResult, setDiscountResult] = useState<any>(null)
  const [discountError, setDiscountError] = useState('')
  const [checkingDiscount, setCheckingDiscount] = useState(false)
  const [form, setForm] = useState({
    guest_name: '',
    guest_email: '',
    guest_phone: '',
    camper_type: '',
    camper_length: '',
    camper_amperage: '',
  })
  const [step, setStep] = useState(1)
  const [paymentLoading, setPaymentLoading] = useState(false)
  const [paymentError, setPaymentError] = useState('')
  const [squareLoaded, setSquareLoaded] = useState(false)
  const [selectedPaymentType, setSelectedPaymentType] = useState<'deposit' | 'full' | null>(null)
  const [cancellationPolicy, setCancellationPolicy] = useState<any>(null)
  const [waiverSigned, setWaiverSigned] = useState(false)
  const [waiverChecked, setWaiverChecked] = useState(false)
  const [hasSignature, setHasSignature] = useState(false)
  const [settings, setSettings] = useState<any>(null)
  const [sameDayBlocked, setSameDayBlocked] = useState(false)
  const [sameDayMessage, setSameDayMessage] = useState('')

  const site = {
    id: searchParams.get('siteId') || '',
    site_number: searchParams.get('siteNumber') || '',
    site_type: searchParams.get('siteType') || '',
    amp_service: searchParams.get('ampService') || '',
    hookups: searchParams.get('hookups') || '',
    max_rv_length: searchParams.get('maxLength') ? parseInt(searchParams.get('maxLength')!) : null,
    nightly_rate: parseInt(searchParams.get('nightlyRate') || '0'),
    total_price: parseInt(searchParams.get('totalPrice') || '0'),
    nights: parseInt(searchParams.get('nights') || '0'),
  }

  const arrival = searchParams.get('arrival') || ''
  const departure = searchParams.get('departure') || ''
  const adults = parseInt(searchParams.get('adults') || '2')
  const children = parseInt(searchParams.get('children') || '0')

  useEffect(() => { fetchAddons(); fetchSettings(); fetchFees() }, [])
  useEffect(() => { if (step >= 3 && !squareLoaded) loadSquare() }, [step])
  useEffect(() => { if (arrival) fetchCancellationPolicy() }, [arrival])

  async function fetchSettings() {
    const { data } = await supabase
      .from('settings')
      .select('park_name, park_location, logo_url, logo_shape, waiver_enabled, waiver_text, same_day_cutoff_time, same_day_cutoff_message, early_checkin_enabled, early_checkin_price, early_checkin_time, early_checkin_show_customers, late_checkout_enabled, late_checkout_price, late_checkout_time, late_checkout_show_customers, check_in_time, check_out_time')
      .limit(1)
      .single()
    if (data) {
      setSettings(data)
      checkSameDayCutoff(data, arrival)
    }
  }

  const [earlyChecked, setEarlyChecked] = useState(false)
  const [lateChecked, setLateChecked] = useState(false)
  const [earlyBlocked, setEarlyBlocked] = useState(false)
  const [lateBlocked, setLateBlocked] = useState(false)

  useEffect(() => {
    async function checkTurnover() {
      if (!site.id || (!arrival && !departure)) return
      const { data } = await supabase
        .from('reservations')
        .select('arrival_date, departure_date')
        .eq('site_id', site.id)
        .neq('status', 'cancelled')
      if (!data) return
      setEarlyBlocked(data.some((r: any) => r.departure_date === arrival))
      setLateBlocked(data.some((r: any) => r.arrival_date === departure))
    }
    checkTurnover()
  }, [site.id, arrival, departure])

  function fmtTime(t: string) {
    if (!t) return ''
    const [h, m] = t.split(':').map(Number)
    const ampm = h >= 12 ? 'PM' : 'AM'
    const hr = h % 12 === 0 ? 12 : h % 12
    return `${hr}:${String(m).padStart(2, '0')} ${ampm}`
  }

  async function fetchFees() {
    const { data } = await supabase.from('fees').select('*').eq('is_active', true)
    setFees(data || [])
  }

  function checkSameDayCutoff(settingsData: any, arrivalDate: string) {
    if (!arrivalDate || !settingsData?.same_day_cutoff_time) return
    const today = new Date()
    const todayStr = today.toISOString().split('T')[0]
    if (arrivalDate !== todayStr) return
    const cutoff = parseTime(settingsData.same_day_cutoff_time)
    if (!cutoff) return
    const currentTotalMinutes = today.getHours() * 60 + today.getMinutes()
    const cutoffTotalMinutes = cutoff.hours * 60 + cutoff.minutes
    if (currentTotalMinutes >= cutoffTotalMinutes) {
      setSameDayBlocked(true)
      setSameDayMessage(settingsData.same_day_cutoff_message || 'Same-day reservations are not available online. Please call us.')
    }
  }

  async function fetchAddons() {
    const { data } = await supabase.from('addons').select('*').eq('is_active', true).order('display_order')
    setAddons(data || [])
  }

  async function fetchCancellationPolicy() {
    const res = await fetch(`/api/cancellation-policy?arrival=${arrival}`)
    const data = await res.json()
    setCancellationPolicy(data.policy)
  }

  async function loadSquare() {
    if (squareLoaded) return
    const script = document.createElement('script')
    script.src = process.env.NEXT_PUBLIC_SQUARE_ENVIRONMENT === 'production'
      ? 'https://web.squarecdn.com/v1/square.js'
      : 'https://sandbox.web.squarecdn.com/v1/square.js'
    script.onload = async () => {
      try {
        const payments = (window as any).Square.payments(
          process.env.NEXT_PUBLIC_SQUARE_APP_ID!,
          'L42H3PRBWB5CJ'
        )
        squareRef.current = payments
        const card = await payments.card()
        await card.attach('#square-card-container')
        cardRef.current = card
        setSquareLoaded(true)
      } catch (e) { console.error('Square load error:', e) }
    }
    document.head.appendChild(script)
  }

  const waiverText = (settings?.waiver_text || '').replace(/\[CAMPGROUND NAME\]/g, settings?.park_name || 'the campground')
  const waiverEnabled = settings?.waiver_enabled !== false

  function startDrawing(e: any) {
    isDrawing.current = true
    const canvas = signatureCanvasRef.current!
    const rect = canvas.getBoundingClientRect()
    const ctx = canvas.getContext('2d')!
    ctx.beginPath()
    const x = (e.touches ? e.touches[0].clientX : e.clientX) - rect.left
    const y = (e.touches ? e.touches[0].clientY : e.clientY) - rect.top
    ctx.moveTo(x, y)
  }

  function draw(e: any) {
    if (!isDrawing.current) return
    e.preventDefault()
    const canvas = signatureCanvasRef.current!
    const rect = canvas.getBoundingClientRect()
    const ctx = canvas.getContext('2d')!
    ctx.lineWidth = 2
    ctx.lineCap = 'round'
    ctx.strokeStyle = '#ffffff'
    const x = (e.touches ? e.touches[0].clientX : e.clientX) - rect.left
    const y = (e.touches ? e.touches[0].clientY : e.clientY) - rect.top
    ctx.lineTo(x, y)
    ctx.stroke()
    setHasSignature(true)
  }

  function stopDrawing() { isDrawing.current = false }

  function clearSignature() {
    const canvas = signatureCanvasRef.current!
    const ctx = canvas.getContext('2d')!
    ctx.clearRect(0, 0, canvas.width, canvas.height)
    setHasSignature(false)
    setWaiverSigned(false)
  }

  function acceptWaiver() {
    if (!hasSignature) { alert('Please sign the waiver before accepting.'); return }
    if (!waiverChecked) { alert('Please check the box to confirm you have read and agree to the waiver.'); return }
    setWaiverSigned(true)
    setStep(3)
  }

  function proceedFromAddons() {
    if (!waiverEnabled) {
      setWaiverSigned(true)
      setStep(3)
    }
  }

  async function checkDiscount() {
    if (!discountCode) return
    setCheckingDiscount(true)
    setDiscountError('')
    setDiscountResult(null)
    const { data } = await supabase.from('discounts').select('*').eq('code', discountCode.toUpperCase()).eq('is_active', true).single()
    if (!data) { setDiscountError('Invalid or expired discount code.'); setCheckingDiscount(false); return }
    const today = new Date().toISOString().split('T')[0]
    if (data.valid_from && today < data.valid_from) { setDiscountError('This code is not yet valid.'); setCheckingDiscount(false); return }
    if (data.valid_until && today > data.valid_until) { setDiscountError('This discount code has expired.'); setCheckingDiscount(false); return }
    if (data.max_uses && data.times_used >= data.max_uses) { setDiscountError('This discount code has reached its maximum uses.'); setCheckingDiscount(false); return }
    setDiscountResult(data)
    setCheckingDiscount(false)
  }

  const addonTotal = Object.entries(selectedAddons).reduce((sum, [id, qty]) => {
    const addon = addons.find(a => a.id === id)
    return sum + (addon ? addon.price * qty : 0)
  }, 0)

  const extraAdults = Math.max(0, adults - 2)
  const extraChildren = Math.max(0, children - 2)
  const extraGuestFee = (extraAdults * 1000 + extraChildren * 500) * site.nights

  function feeAppliesToSite(fee: Fee): boolean {
    if (fee.applies_to === 'all') return true
    const targets = fee.applies_to.split(',').map(s => s.trim())
    return targets.includes(site.site_type)
  }

  function feeAppliesToAddons(fee: Fee): boolean {
    if (fee.applies_to === 'all') return true
    const targets = fee.applies_to.split(',').map(s => s.trim())
    return targets.includes('addons')
  }

  function calculateFeeAmount(fee: Fee): number {
    let base = 0
    if (feeAppliesToSite(fee)) base += site.total_price + extraGuestFee
    if (feeAppliesToAddons(fee)) base += addonTotal
    if (base === 0) return 0
    if (fee.type === 'percentage') return Math.round(base * fee.amount / 100)
    return fee.amount * 100
  }

  const feeBreakdown = fees.map(fee => ({
    ...fee,
    calculatedAmount: calculateFeeAmount(fee),
  })).filter(fee => fee.calculatedAmount > 0)

  const feesTotal = feeBreakdown.reduce((sum, fee) => sum + fee.calculatedAmount, 0)
  const cardOnlyFeesTotal = feeBreakdown.filter(fee => fee.card_only).reduce((sum, fee) => sum + fee.calculatedAmount, 0)

  const earlyFee = (earlyChecked && !earlyBlocked && settings?.early_checkin_enabled && settings?.early_checkin_show_customers) ? (settings.early_checkin_price || 0) : 0
  const lateFee = (lateChecked && !lateBlocked && settings?.late_checkout_enabled && settings?.late_checkout_show_customers) ? (settings.late_checkout_price || 0) : 0
  const subtotal = site.total_price + extraGuestFee + addonTotal + earlyFee + lateFee
  const discountAmount = discountResult
    ? discountResult.discount_type === 'percent'
      ? Math.round(subtotal * discountResult.discount_value / 100)
      : discountResult.discount_value
    : 0
  const total = Math.max(0, subtotal + feesTotal - discountAmount)
  const proportionalFees = site.nights > 0 ? Math.round(feesTotal / site.nights) : 0
const deposit = site.nightly_rate + proportionalFees

  const siteTypeLabel = (type: string) => ({ rv_site: 'RV Site', cabin: 'Cabin', tent: 'Tent Site' }[type] || type)

  const isRvSite = site.site_type === 'rv_site'

  function validateAndContinue() {
    if (!form.guest_name.trim()) { alert('Please enter your name.'); return }
    if (!form.guest_email.trim() || !form.guest_email.includes('@')) { alert('Please enter a valid email.'); return }
    if (!form.guest_phone.trim()) { alert('Please enter your phone number.'); return }
    if (isRvSite) {
      if (!form.camper_type) { alert('Please select your camper type.'); return }
      if (!form.camper_length || parseInt(form.camper_length) < 1) { alert('Please enter your camper length.'); return }
      if (!form.camper_amperage) { alert('Please select your amperage.'); return }
    }
    setStep(2)
  }

  async function handlePayment(paymentType: 'deposit' | 'full') {
    if (!cardRef.current) { setPaymentError('Payment form not ready. Please wait a moment and try again.'); return }
    setPaymentLoading(true)
    setPaymentError('')
    setSelectedPaymentType(paymentType)

    try {
      const result = await cardRef.current.tokenize()
      if (result.status !== 'OK') { setPaymentError('Card details invalid. Please check and try again.'); setPaymentLoading(false); return }

      const amountToPay = paymentType === 'deposit' ? deposit : total
      const addonItems = Object.entries(selectedAddons)
        .filter(([_, qty]) => qty > 0)
        .map(([id, quantity]) => {
          const addon = addons.find(a => a.id === id)
          return { id, quantity, price: addon?.price || 0 }
        })

      const signatureData = waiverEnabled ? (signatureCanvasRef.current?.toDataURL() || '') : ''

      const response = await fetch('/api/payment', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sourceId: result.token,
          siteId: site.id,
          arrival, departure, adults, children,
          guestName: form.guest_name,
          guestEmail: form.guest_email,
          guestPhone: form.guest_phone,
          camperType: form.camper_type,
          camperLength: parseInt(form.camper_length) || 0,
          camperAmperage: form.camper_amperage,
          nightlyRate: site.nightly_rate,
          totalPrice: total,
          amountToPay, paymentType, addonItems,
          discountCode: discountResult?.code || null,
          discountAmount, extraGuestFee, addonTotal,
          earlyCheckin: earlyFee > 0, earlyCheckinFee: earlyFee,
          lateCheckout: lateFee > 0, lateCheckoutFee: lateFee,
          feesTotal,
          cardOnlyFeesTotal,
          nights: site.nights,
          waiverSigned: waiverSigned,
          signatureData,
        }),
      })

      const data = await response.json()
      if (!response.ok || !data.success) { setPaymentError(data.error || 'Payment failed. Please try again.'); setPaymentLoading(false); return }
      window.location.href = `/confirmation?reservationId=${data.reservationId}`
    } catch (error: any) {
      setPaymentError(error.message || 'An unexpected error occurred.')
      setPaymentLoading(false)
    }
  }

  const logoShapeClass =
    settings?.logo_shape === 'circle' ? 'rounded-full' :
    settings?.logo_shape === 'rounded' ? 'rounded-xl' :
    settings?.logo_shape === 'square' ? 'rounded-none' : 'rounded-none'

  const camperTypeLabel = (val: string) =>
    CAMPER_TYPES.find(t => t.value === val)?.label || val

  if (sameDayBlocked) {
    return (
      <main className="min-h-screen flex flex-col" style={{ backgroundColor: '#1C1C1C' }}>
        <div className="px-4 py-4 flex items-center gap-4" style={{ backgroundColor: '#2B2B2B' }}>
          {settings?.logo_url && (
            <div className={`w-12 h-12 overflow-hidden flex items-center justify-center shrink-0 ${logoShapeClass}`}>
              <Image src={settings.logo_url} alt={settings?.park_name || 'Campground'} width={48} height={48} className="object-contain w-full h-full" />
            </div>
          )}
          <div>
            <h1 className="text-white font-bold">{settings?.park_name || 'Campground'}</h1>
            <p className="text-sm" style={{ color: 'var(--accent-color)' }}>Online Reservations</p>
          </div>
        </div>
        <div className="flex-1 flex items-center justify-center px-4 py-16">
          <div className="max-w-md w-full rounded-2xl p-8 text-center" style={{ backgroundColor: '#2B2B2B' }}>
            <div className="text-5xl mb-4">📞</div>
            <h2 className="text-white text-2xl font-bold mb-3">Same-Day Reservations</h2>
            <p className="text-gray-300 text-base leading-relaxed">{sameDayMessage}</p>
            <button onClick={() => window.history.back()} className="mt-8 px-6 py-3 rounded-xl text-white font-semibold transition-colors" style={{ backgroundColor: 'var(--accent-color)' }}>← Go Back</button>
          </div>
        </div>
      </main>
    )
  }

  return (
    <main className="min-h-screen" style={{ backgroundColor: '#1C1C1C' }}>
      {/* Header */}
      <div className="px-4 py-4 flex items-center gap-4" style={{ backgroundColor: '#2B2B2B' }}>
        {settings?.logo_url && (
          <div className={`w-12 h-12 overflow-hidden flex items-center justify-center shrink-0 ${logoShapeClass}`}>
            <Image src={settings.logo_url} alt={settings?.park_name || 'Campground'} width={48} height={48} className="object-contain w-full h-full" />
          </div>
        )}
        <div>
          <h1 className="text-white font-bold">{settings?.park_name || 'Campground'}</h1>
          <p className="text-sm" style={{ color: 'var(--accent-color)' }}>Complete your reservation</p>
        </div>
      </div>

      <div className="max-w-5xl mx-auto px-4 py-8 grid grid-cols-1 lg:grid-cols-3 gap-8">
        <div className="lg:col-span-2 space-y-6">

          {/* Step 1 - Guest Details */}
          <div className="rounded-2xl p-6" style={{ backgroundColor: '#2B2B2B' }}>
            <h2 className="text-white font-bold text-lg mb-4">{step === 1 ? '1. Your Information' : '✓ Your Information'}</h2>
            {step === 1 ? (
              <div className="space-y-4">
                <div>
                  <label className="block text-sm font-medium text-gray-300 mb-1">Full Name *</label>
                  <input className="w-full bg-gray-800 border border-gray-600 rounded-lg px-3 py-2 text-white text-sm" placeholder="Jane Smith" value={form.guest_name} onChange={e => setForm({ ...form, guest_name: e.target.value })} />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-300 mb-1">Email Address *</label>
                  <input className="w-full bg-gray-800 border border-gray-600 rounded-lg px-3 py-2 text-white text-sm" placeholder="jane@email.com" type="email" value={form.guest_email} onChange={e => setForm({ ...form, guest_email: e.target.value })} />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-300 mb-1">Phone Number *</label>
                  <input className="w-full bg-gray-800 border border-gray-600 rounded-lg px-3 py-2 text-white text-sm" placeholder="(555) 555-5555" type="tel" value={form.guest_phone} onChange={e => setForm({ ...form, guest_phone: e.target.value })} />
                </div>

                {/* Camper Type Visual Selector — RV sites only */}
                {isRvSite && (
                  <>
                    <div>
                      <label className="block text-sm font-medium text-gray-300 mb-2">Camper Type *</label>
                      <div className="grid grid-cols-3 gap-2 sm:grid-cols-6">
                        {CAMPER_TYPES.map(type => (
                          <button
                            key={type.value}
                            type="button"
                            onClick={() => setForm({ ...form, camper_type: type.value })}
                            className="flex flex-col items-center gap-1.5 p-2 rounded-xl border-2 transition-all"
                            style={{
                              borderColor: form.camper_type === type.value ? 'var(--accent-color)' : '#4B5563',
                              backgroundColor: form.camper_type === type.value ? 'rgba(var(--accent-rgb, 45,106,79), 0.15)' : '#374151',
                              color: form.camper_type === type.value ? 'var(--accent-color)' : '#9CA3AF',
                            }}
                          >
                            <div className="w-14 h-8">{type.svg}</div>
                            <span className="text-xs font-medium text-center leading-tight">{type.label}</span>
                          </button>
                        ))}
                      </div>
                    </div>

                    {/* Camper Length + Amperage */}
                    <div className="grid grid-cols-2 gap-3">
                      <div>
                        <label className="block text-sm font-medium text-gray-300 mb-1">Camper Length (ft) *</label>
                        <input
                          className="w-full bg-gray-800 border border-gray-600 rounded-lg px-3 py-2 text-white text-sm"
                          placeholder="e.g. 32"
                          type="number"
                          min="1"
                          max="100"
                          value={form.camper_length}
                          onChange={e => setForm({ ...form, camper_length: e.target.value })}
                        />
                      </div>
                      <div>
                        <label className="block text-sm font-medium text-gray-300 mb-1">Amperage *</label>
                        <select
                          className="w-full bg-gray-800 border border-gray-600 rounded-lg px-3 py-2 text-white text-sm"
                          value={form.camper_amperage}
                          onChange={e => setForm({ ...form, camper_amperage: e.target.value })}
                        >
                          <option value="">Select...</option>
                          <option value="50amp">50 Amp</option>
                          <option value="30amp">30 Amp</option>
                          <option value="20amp">20 Amp</option>
                        </select>
                      </div>
                    </div>
                  </>
                )}

                <button onClick={validateAndContinue} className="w-full py-3 rounded-xl text-white font-semibold transition-colors mt-2" style={{ backgroundColor: 'var(--accent-color)' }}>
                  Continue to Add-Ons →
                </button>
              </div>
            ) : (
              <div className="text-gray-300 text-sm space-y-1">
                <p className="text-white font-medium">{form.guest_name}</p>
                <p>{form.guest_email}</p>
                <p>{form.guest_phone}</p>
                {isRvSite && form.camper_type && <p className="text-gray-400">{camperTypeLabel(form.camper_type)} · {form.camper_length} ft · {form.camper_amperage.replace('amp', ' Amp')}</p>}
                <button onClick={() => { setStep(1); setWaiverSigned(false) }} className="text-xs mt-2" style={{ color: 'var(--accent-color)' }}>Edit</button>
              </div>
            )}
          </div>

          {/* Step 2 - Add-Ons, Discount & Waiver */}
          {step >= 2 && (
            <div className="rounded-2xl p-6" style={{ backgroundColor: '#2B2B2B' }}>
              <h2 className="text-white font-bold text-lg mb-4">2. Add-Ons (Optional)</h2>
              {addons.length === 0 ? (
                <p className="text-gray-400 text-sm mb-6">No add-ons available.</p>
              ) : (
                <div className="space-y-3 mb-6">
                  {addons.map(addon => (
                    <div key={addon.id} className="flex items-center justify-between p-3 rounded-lg bg-gray-800">
                      <div>
                        <p className="text-white font-medium text-sm">{addon.name}</p>
                        {addon.description && <p className="text-gray-400 text-xs">{addon.description}</p>}
                        <p className="text-sm mt-0.5" style={{ color: 'var(--accent-color)' }}>${(addon.price / 100).toFixed(2)}</p>
                      </div>
                      <div className="flex items-center gap-2">
                        <button onClick={() => setSelectedAddons(prev => ({ ...prev, [addon.id]: Math.max(0, (prev[addon.id] || 0) - 1) }))} className="w-8 h-8 rounded-full bg-gray-700 text-white font-bold hover:bg-gray-600">-</button>
                        <span className="text-white w-6 text-center">{selectedAddons[addon.id] || 0}</span>
                        <button onClick={() => setSelectedAddons(prev => ({ ...prev, [addon.id]: (prev[addon.id] || 0) + 1 }))} className="w-8 h-8 rounded-full text-white font-bold" style={{ backgroundColor: 'var(--accent-color)' }}>+</button>
                      </div>
                    </div>
                  ))}
                </div>
              )}

              {settings?.early_checkin_enabled && settings?.early_checkin_show_customers && (
                <div className={`flex items-center justify-between p-3 rounded-lg mb-3 ${earlyBlocked ? 'bg-gray-800 opacity-50' : 'bg-gray-800'}`}>
                  <div>
                    <p className="text-white font-medium text-sm">Early Check-In</p>
                    <p className="text-gray-400 text-xs">Arrive as early as {fmtTime(settings.early_checkin_time)}</p>
                    <p className="text-sm mt-0.5" style={{ color: 'var(--accent-color)' }}>${(settings.early_checkin_price / 100).toFixed(2)}</p>
                    {earlyBlocked && <p className="text-amber-400 text-xs mt-1">Not available for these dates — another guest is using this site.</p>}
                  </div>
                  <button type="button" disabled={earlyBlocked} onClick={() => setEarlyChecked(!earlyChecked)} className="w-6 h-6 shrink-0 rounded border-2 flex items-center justify-center transition-colors disabled:cursor-not-allowed" style={{ borderColor: 'var(--accent-color)', backgroundColor: (earlyChecked && !earlyBlocked) ? 'var(--accent-color)' : 'transparent' }}>{(earlyChecked && !earlyBlocked) && <span className="text-white text-sm font-bold leading-none">✓</span>}</button>
                </div>
              )}

              {settings?.late_checkout_enabled && settings?.late_checkout_show_customers && (
                <div className={`flex items-center justify-between p-3 rounded-lg mb-3 ${lateBlocked ? 'bg-gray-800 opacity-50' : 'bg-gray-800'}`}>
                  <div>
                    <p className="text-white font-medium text-sm">Late Check-Out</p>
                    <p className="text-gray-400 text-xs">Stay until {fmtTime(settings.late_checkout_time)}</p>
                    <p className="text-sm mt-0.5" style={{ color: 'var(--accent-color)' }}>${(settings.late_checkout_price / 100).toFixed(2)}</p>
                    {lateBlocked && <p className="text-amber-400 text-xs mt-1">Not available for these dates — another guest is using this site.</p>}
                  </div>
                  <button type="button" disabled={lateBlocked} onClick={() => setLateChecked(!lateChecked)} className="w-6 h-6 shrink-0 rounded border-2 flex items-center justify-center transition-colors disabled:cursor-not-allowed" style={{ borderColor: 'var(--accent-color)', backgroundColor: (lateChecked && !lateBlocked) ? 'var(--accent-color)' : 'transparent' }}>{(lateChecked && !lateBlocked) && <span className="text-white text-sm font-bold leading-none">✓</span>}</button>
                </div>
              )}

              {/* Discount Code */}
              <div className="pt-4 border-t border-gray-700 mb-6">
                <h3 className="text-white font-medium mb-3">Discount Code</h3>
                <div className="flex gap-2">
                  <input className="flex-1 bg-gray-800 border border-gray-600 rounded-lg px-3 py-2 text-white text-sm uppercase" placeholder="Enter code..." value={discountCode} onChange={e => { setDiscountCode(e.target.value.toUpperCase()); setDiscountResult(null); setDiscountError('') }} />
                  <button onClick={checkDiscount} disabled={checkingDiscount} className="px-4 py-2 rounded-lg text-white text-sm font-medium" style={{ backgroundColor: 'var(--accent-color)' }}>{checkingDiscount ? '...' : 'Apply'}</button>
                </div>
                {discountError && <p className="text-red-400 text-sm mt-2">{discountError}</p>}
                {discountResult && <p className="text-green-400 text-sm mt-2">✓ {discountResult.discount_type === 'percent' ? `${discountResult.discount_value}% discount applied!` : `$${(discountResult.discount_value / 100).toFixed(2)} discount applied!`}</p>}
              </div>

              {/* Waiver */}
              {waiverEnabled && !waiverSigned && waiverText && (
                <div className="pt-4 border-t border-gray-700">
                  <h3 className="text-white font-bold text-lg mb-3">3. Liability Waiver</h3>
                  <p className="text-gray-400 text-sm mb-3">Please read and sign the following waiver before proceeding to payment.</p>
                  <div className="bg-gray-800 rounded-lg p-4 mb-4 h-48 overflow-y-auto">
                    <p className="text-gray-300 text-xs leading-relaxed whitespace-pre-line">{waiverText}</p>
                  </div>
                  <div className="mb-4">
                    <div className="flex items-center justify-between mb-2">
                      <label className="text-sm font-medium text-gray-300">Sign below:</label>
                      <button onClick={clearSignature} className="text-xs text-gray-400 hover:text-white">Clear</button>
                    </div>
                    <canvas
                      ref={signatureCanvasRef}
                      width={600}
                      height={150}
                      className="w-full rounded-lg border border-gray-600 cursor-crosshair touch-none"
                      style={{ backgroundColor: '#1a1a2e' }}
                      onMouseDown={startDrawing}
                      onMouseMove={draw}
                      onMouseUp={stopDrawing}
                      onMouseLeave={stopDrawing}
                      onTouchStart={startDrawing}
                      onTouchMove={draw}
                      onTouchEnd={stopDrawing}
                    />
                    {!hasSignature && <p className="text-gray-500 text-xs mt-1">Draw your signature above using your mouse or finger</p>}
                  </div>
                  <div className="flex items-start gap-3 mb-4">
                    <button
                      type="button"
                      onClick={() => setWaiverChecked(!waiverChecked)}
                      className="w-5 h-5 mt-0.5 shrink-0 rounded border-2 flex items-center justify-center transition-colors"
                      style={{ borderColor: waiverChecked ? '#14b8a6' : '#6b7280', backgroundColor: waiverChecked ? '#14b8a6' : 'transparent' }}
                    >
                      {waiverChecked && <span className="text-white text-xs font-bold">✓</span>}
                    </button>
                    <label className="text-gray-300 text-sm">
                      I have read, understand, and agree to the {settings?.park_name || 'Campground'} Liability Waiver above. I acknowledge that my electronic signature is legally binding.
                    </label>
                  </div>
                  <button onClick={acceptWaiver} className="w-full py-3 rounded-xl text-white font-semibold transition-colors" style={{ backgroundColor: 'var(--accent-color)' }}>
                    Accept Waiver & Continue to Payment →
                  </button>
                </div>
              )}

              {(!waiverEnabled || !waiverText) && !waiverSigned && (
                <div className="pt-4 border-t border-gray-700">
                  <button onClick={proceedFromAddons} className="w-full py-3 rounded-xl text-white font-semibold transition-colors" style={{ backgroundColor: 'var(--accent-color)' }}>
                    Continue to Payment →
                  </button>
                </div>
              )}

              {waiverEnabled && waiverSigned && (
                <div className="pt-4 border-t border-gray-700">
                  <p className="text-green-400 font-medium">✓ Liability waiver signed</p>
                  <button onClick={() => { setWaiverSigned(false); setStep(2) }} className="text-xs mt-1" style={{ color: 'var(--accent-color)' }}>Re-sign</button>
                </div>
              )}
            </div>
          )}

          {/* Step 3 - Payment */}
          {step >= 3 && waiverSigned && (
            <div className="rounded-2xl p-6" style={{ backgroundColor: '#2B2B2B' }}>
              <h2 className="text-white font-bold text-lg mb-4">{waiverEnabled ? '4. Payment' : '3. Payment'}</h2>
              <div className="mb-6 space-y-2 text-sm">
                <div className="flex justify-between text-gray-300">
                  <span>{siteTypeLabel(site.site_type)} {site.site_number} × {site.nights} nights</span>
                  <span>${(site.total_price / 100).toFixed(2)}</span>
                </div>
                {extraGuestFee > 0 && <div className="flex justify-between text-gray-300"><span>Extra guest fees</span><span>${(extraGuestFee / 100).toFixed(2)}</span></div>}
                {Object.entries(selectedAddons).filter(([_, qty]) => qty > 0).map(([id, qty]) => {
                  const addon = addons.find(a => a.id === id)
                  if (!addon) return null
                  return (
                    <div key={id} className="flex justify-between">
                      <p className="text-gray-400">{addon.name}{qty > 1 ? ` ×${qty}` : ''}</p>
                      <p className="text-white font-medium">${((addon.price * qty) / 100).toFixed(2)}</p>
                    </div>
                  )
                })}
                {feeBreakdown.map(fee => (
                  <div key={fee.id} className="flex justify-between text-gray-300">
                    <span>{fee.name}</span>
                    <span>${(fee.calculatedAmount / 100).toFixed(2)}</span>
                  </div>
                ))}
                {discountAmount > 0 && <div className="flex justify-between text-green-400"><span>Discount ({discountResult.code})</span><span>-${(discountAmount / 100).toFixed(2)}</span></div>}
                <div className="border-t border-gray-700 pt-2 flex justify-between text-white font-bold">
                  <span>Total</span><span>${(total / 100).toFixed(2)}</span>
                </div>
              </div>
              <div className="rounded-lg p-4 bg-gray-800 mb-6">
                <p className="text-gray-300 text-xs leading-relaxed">
                  <span className="text-white font-medium">Cancellation Policy: </span>
                  {cancellationPolicy ? cancellationPolicy.policy_text : 'Cancellations must be made at least 7 days before arrival. A 10% booking fee is retained on all cancellations.'}
                </p>
                {cancellationPolicy && !cancellationPolicy.deposit_refundable && (
                  <p className="text-yellow-400 text-xs mt-2 font-medium">⚠ Deposit is non-refundable for these dates.</p>
                )}
              </div>
              <div className="mb-6">
                <h3 className="text-white font-medium mb-3">Card Details</h3>
                <div id="square-card-container" className="rounded-lg overflow-hidden" style={{ minHeight: '89px' }} />
                {!squareLoaded && <p className="text-gray-400 text-sm mt-2">Loading payment form...</p>}
              </div>
              {paymentError && <div className="rounded-lg p-4 bg-red-900 mb-4"><p className="text-red-300 text-sm">{paymentError}</p></div>}
              <div className="space-y-3">
                <h3 className="text-white font-medium">Choose Payment Option</h3>
                <button
                  disabled={paymentLoading || !squareLoaded}
                  className="w-full py-3 rounded-xl font-semibold border-2 transition-colors disabled:opacity-50"
                  style={{ borderColor: 'var(--accent-color)', color: 'var(--accent-color)', backgroundColor: 'transparent' }}
                  onClick={() => handlePayment('deposit')}
                >
                  {paymentLoading && selectedPaymentType === 'deposit' ? 'Processing...' : `Pay Deposit — $${(deposit / 100).toFixed(2)}`}
                  <span className="block text-xs font-normal mt-0.5 text-gray-400">First night only · Balance due at check-in</span>
                </button>
                <button
                  disabled={paymentLoading || !squareLoaded}
                  className="w-full py-3 rounded-xl text-white font-semibold transition-colors disabled:opacity-50"
                  style={{ backgroundColor: 'var(--accent-color)' }}
                  onClick={() => handlePayment('full')}
                >
                  {paymentLoading && selectedPaymentType === 'full' ? 'Processing...' : `Pay in Full — $${(total / 100).toFixed(2)}`}
                </button>
              </div>
            </div>
          )}
        </div>

        {/* Sidebar */}
        <div className="lg:col-span-1">
          <div className="rounded-2xl p-6 sticky top-6" style={{ backgroundColor: '#2B2B2B' }}>
            <h3 className="text-white font-bold mb-4">Booking Summary</h3>
            <div className="space-y-3 text-sm">
              <div><p className="text-gray-400">Site</p><p className="text-white font-medium">{siteTypeLabel(site.site_type)} {site.site_number}</p></div>
              <div><p className="text-gray-400">Arrival</p><p className="text-white font-medium">{arrival}</p><p className="text-gray-300 text-xs">Check-in: {settings?.check_in_time || '2:00 PM'}</p></div>
              <div><p className="text-gray-400">Departure</p><p className="text-white font-medium">{departure}</p><p className="text-gray-300 text-xs">Check-out: {settings?.check_out_time || '12:00 PM'}</p></div>
              <div><p className="text-gray-400">Guests</p><p className="text-white font-medium">{adults} adult{adults !== 1 ? 's' : ''}{children > 0 ? `, ${children} child${children !== 1 ? 'ren' : ''}` : ''}</p></div>
              <div><p className="text-gray-400">Duration</p><p className="text-white font-medium">{site.nights} night{site.nights !== 1 ? 's' : ''}</p></div>
              <div className="border-t border-gray-700 pt-3"><p className="text-gray-400">Rate</p><p className="text-white font-medium">${(site.nightly_rate / 100).toFixed(2)}/night</p></div>
              {isRvSite && form.camper_type && (
                <div className="border-t border-gray-700 pt-3">
                  <p className="text-gray-400">Camper</p>
                  <p className="text-white font-medium">{camperTypeLabel(form.camper_type)}</p>
                  {form.camper_length && <p className="text-gray-400 text-xs">{form.camper_length} ft · {form.camper_amperage.replace('amp', ' Amp')}</p>}
                </div>
              )}
              {Object.entries(selectedAddons).filter(([_, qty]) => qty > 0).map(([id, qty]) => {
                const addon = addons.find(a => a.id === id)
                if (!addon) return null
                return (
                  <div key={id} className="flex justify-between">
                    <p className="text-gray-400">{addon.name}{qty > 1 ? ` ×${qty}` : ''}</p>
                    <p className="text-white font-medium">${((addon.price * qty) / 100).toFixed(2)}</p>
                  </div>
                )
              })}
              {earlyFee > 0 && (
                <div className="flex justify-between">
                  <p className="text-gray-400">Early Check-In</p>
                  <p className="text-white font-medium">${(earlyFee / 100).toFixed(2)}</p>
                </div>
              )}
              {lateFee > 0 && (
                <div className="flex justify-between">
                  <p className="text-gray-400">Late Check-Out</p>
                  <p className="text-white font-medium">${(lateFee / 100).toFixed(2)}</p>
                </div>
              )}
              {feeBreakdown.map(fee => (
                <div key={fee.id} className="flex justify-between">
                  <p className="text-gray-400">{fee.name}</p>
                  <p className="text-white font-medium">${(fee.calculatedAmount / 100).toFixed(2)}</p>
                </div>
              ))}
              {discountAmount > 0 && (
                <div className="flex justify-between">
                  <p className="text-green-400">Discount</p>
                  <p className="text-green-400 font-medium">-${(discountAmount / 100).toFixed(2)}</p>
                </div>
              )}
              <div className="border-t border-gray-700 pt-3">
                <div className="flex justify-between">
                  <p className="text-white font-bold">Total</p>
                  <p className="font-bold text-lg" style={{ color: 'var(--accent-color)' }}>${(total / 100).toFixed(2)}</p>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </main>
  )
}

export default function BookPage() {
  return (
    <Suspense fallback={<div className="min-h-screen flex items-center justify-center" style={{ backgroundColor: '#1C1C1C' }}><p className="text-gray-400">Loading...</p></div>}>
      <BookingForm />
    </Suspense>
  )
}
