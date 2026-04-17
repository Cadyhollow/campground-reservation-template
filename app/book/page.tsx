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

const WAIVER_TEXT = `CADY HOLLOW CAMPGROUND LIABILITY WAIVER

In consideration of myself and all persons entering under my supervision including visitors, the undersigned hereby waive, release and forever discharge Cady Hollow Campground, its owners, affiliates, managers, members, agents, attorneys, employees, staff, volunteers, heirs, executors, administrators, representatives, predecessors, successors and assigns from any claims resulting from physical or personal injury, pain, suffering, illness, disfigurement, temporary or permanent disability, loss or death, and any property damage that may occur caused by fire, theft, vandalism, water or land-related accidents, natural events or any other occurrences or mishaps.

We are here of our free will, and entirely at our own risk. I acknowledge that camping has many hazards and that there are risks that cannot be eliminated, particularly in a wilderness environment. We understand that these injuries or outcomes may arise by our own or others' negligence or conditions on the premises or the conditions or our use of amenities offered at the premises or related to travel to and from the premises. Nonetheless, we assume all related risks, both known and unknown. Cady Hollow Campground is not responsible for errors, omissions, acts or failures to act of any party or entity conducting a specific event or activity. I fully understand that this is a release of liability and I agree to voluntarily give up or waive any right that I otherwise have to bring legal action against Cady Hollow Campground or its owners, for any personal injury or property damage whatsoever for negligence on the part of Cady Hollow Campground or its owners, agents and employees. This waiver and release of liability shall remain in effect for the duration of my presence at the premises.

We further agree to indemnify, defend, and hold harmless Rian and Charissa Chiaravalloti and Cady Hollow Campground, against any and all claims, suits or actions of any kind whatsoever for liability, damages, compensation or otherwise brought by me or anyone on my behalf, including attorney's fees and any related costs.

I acknowledge that children must be supervised at all times. No child may swim in the pool without an adult parent or guardian present. There is no lifeguard on duty and the pool goes up to 9 feet in depth. Pool is open from Memorial Day to Labor Day and 11-7 daily.`

function BookingForm() {
  const searchParams = useSearchParams()
  const cardRef = useRef<any>(null)
  const squareRef = useRef<any>(null)
  const signatureCanvasRef = useRef<HTMLCanvasElement>(null)
  const isDrawing = useRef(false)

  const [addons, setAddons] = useState<Addon[]>([])
  const [selectedAddons, setSelectedAddons] = useState<{ [id: string]: number }>({})
  const [discountCode, setDiscountCode] = useState('')
  const [discountResult, setDiscountResult] = useState<any>(null)
  const [discountError, setDiscountError] = useState('')
  const [checkingDiscount, setCheckingDiscount] = useState(false)
  const [form, setForm] = useState({ guest_name: '', guest_email: '', guest_phone: '' })
  const [step, setStep] = useState(1)
  const [paymentLoading, setPaymentLoading] = useState(false)
  const [paymentError, setPaymentError] = useState('')
  const [squareLoaded, setSquareLoaded] = useState(false)
  const [selectedPaymentType, setSelectedPaymentType] = useState<'deposit' | 'full' | null>(null)
  const [cancellationPolicy, setCancellationPolicy] = useState<any>(null)
  const [waiverSigned, setWaiverSigned] = useState(false)
  const [waiverChecked, setWaiverChecked] = useState(false)
  const [hasSignature, setHasSignature] = useState(false)

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

  useEffect(() => { fetchAddons() }, [])
  useEffect(() => { if (step >= 3 && !squareLoaded) loadSquare() }, [step])
  useEffect(() => { if (arrival) fetchCancellationPolicy() }, [arrival])

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

  // Signature canvas handlers
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
  const subtotal = site.total_price + extraGuestFee + addonTotal
  const discountAmount = discountResult
    ? discountResult.discount_type === 'percent'
      ? Math.round(subtotal * discountResult.discount_value / 100)
      : discountResult.discount_value
    : 0
  const total = Math.max(0, subtotal - discountAmount)
  const deposit = site.nightly_rate

  const siteTypeLabel = (type: string) => ({ rv_site: 'RV Site', cabin: 'Cabin', tent: 'Tent Site' }[type] || type)

  function validateAndContinue() {
    if (!form.guest_name.trim()) { alert('Please enter your name.'); return }
    if (!form.guest_email.trim() || !form.guest_email.includes('@')) { alert('Please enter a valid email.'); return }
    if (!form.guest_phone.trim()) { alert('Please enter your phone number.'); return }
    setStep(2)
  }

  async function handlePayment(paymentType: 'deposit' | 'full') {
    if (!waiverSigned) { alert('Please sign the liability waiver before paying.'); return }
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

      const signatureData = signatureCanvasRef.current?.toDataURL() || ''

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
          nightlyRate: site.nightly_rate,
          totalPrice: total,
          amountToPay, paymentType, addonItems,
          discountCode: discountResult?.code || null,
          discountAmount, extraGuestFee, addonTotal,
          nights: site.nights,
          waiverSigned: true,
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

  return (
    <main className="min-h-screen" style={{ backgroundColor: '#1C1C1C' }}>
      {/* Header */}
      <div className="px-4 py-4 flex items-center gap-4" style={{ backgroundColor: '#2B2B2B' }}>
        <Image src="/images/Cadylogo.png" alt="Cady Hollow" width={48} height={48} className="rounded-full" style={{ filter: 'hue-rotate(20deg) saturate(1.2)' }} />
        <div>
          <h1 className="text-white font-bold">Cady Hollow Campground</h1>
          <p className="text-sm" style={{ color: '#3DBDD4' }}>Complete your reservation</p>
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
                <button onClick={validateAndContinue} className="w-full py-3 rounded-xl text-white font-semibold transition-colors mt-2" style={{ backgroundColor: '#3DBDD4' }} onMouseOver={e => (e.currentTarget.style.backgroundColor = '#2DADC4')} onMouseOut={e => (e.currentTarget.style.backgroundColor = '#3DBDD4')}>
                  Continue to Add-Ons →
                </button>
              </div>
            ) : (
              <div className="text-gray-300 text-sm space-y-1">
                <p className="text-white font-medium">{form.guest_name}</p>
                <p>{form.guest_email}</p>
                <p>{form.guest_phone}</p>
                <button onClick={() => { setStep(1); setWaiverSigned(false) }} className="text-xs mt-2" style={{ color: '#3DBDD4' }}>Edit</button>
              </div>
            )}
          </div>

          {/* Step 2 - Add-Ons & Waiver */}
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
                        <p className="text-sm mt-0.5" style={{ color: '#3DBDD4' }}>${(addon.price / 100).toFixed(2)}</p>
                      </div>
                      <div className="flex items-center gap-2">
                        <button onClick={() => setSelectedAddons(prev => ({ ...prev, [addon.id]: Math.max(0, (prev[addon.id] || 0) - 1) }))} className="w-8 h-8 rounded-full bg-gray-700 text-white font-bold hover:bg-gray-600">-</button>
                        <span className="text-white w-6 text-center">{selectedAddons[addon.id] || 0}</span>
                        <button onClick={() => setSelectedAddons(prev => ({ ...prev, [addon.id]: (prev[addon.id] || 0) + 1 }))} className="w-8 h-8 rounded-full text-white font-bold" style={{ backgroundColor: '#3DBDD4' }}>+</button>
                      </div>
                    </div>
                  ))}
                </div>
              )}

              {/* Discount Code */}
              <div className="pt-4 border-t border-gray-700 mb-6">
                <h3 className="text-white font-medium mb-3">Discount Code</h3>
                <div className="flex gap-2">
                  <input className="flex-1 bg-gray-800 border border-gray-600 rounded-lg px-3 py-2 text-white text-sm uppercase" placeholder="Enter code..." value={discountCode} onChange={e => { setDiscountCode(e.target.value.toUpperCase()); setDiscountResult(null); setDiscountError('') }} />
                  <button onClick={checkDiscount} disabled={checkingDiscount} className="px-4 py-2 rounded-lg text-white text-sm font-medium" style={{ backgroundColor: '#3DBDD4' }}>{checkingDiscount ? '...' : 'Apply'}</button>
                </div>
                {discountError && <p className="text-red-400 text-sm mt-2">{discountError}</p>}
                {discountResult && <p className="text-green-400 text-sm mt-2">✓ {discountResult.discount_type === 'percent' ? `${discountResult.discount_value}% discount applied!` : `$${(discountResult.discount_value / 100).toFixed(2)} discount applied!`}</p>}
              </div>

              {/* Liability Waiver */}
              {!waiverSigned ? (
                <div className="pt-4 border-t border-gray-700">
                  <h3 className="text-white font-bold text-lg mb-3">3. Liability Waiver</h3>
                  <p className="text-gray-400 text-sm mb-3">Please read and sign the following waiver before proceeding to payment.</p>
                  
                  {/* Waiver Text */}
                  <div className="bg-gray-800 rounded-lg p-4 mb-4 h-48 overflow-y-auto">
                    <p className="text-gray-300 text-xs leading-relaxed whitespace-pre-line">{WAIVER_TEXT}</p>
                  </div>

                  {/* Signature Canvas */}
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

                  {/* Agreement Checkbox */}
                  <div className="flex items-start gap-3 mb-4">
                    <input
                      type="checkbox"
                      id="waiver_agree"
                      checked={waiverChecked}
                      onChange={e => setWaiverChecked(e.target.checked)}
                      className="w-4 h-4 mt-0.5 accent-teal-500"
                    />
                    <label htmlFor="waiver_agree" className="text-gray-300 text-sm">
                      I have read, understand, and agree to the Cady Hollow Campground Liability Waiver above. I acknowledge that my electronic signature is legally binding.
                    </label>
                  </div>

                  <button
                    onClick={acceptWaiver}
                    className="w-full py-3 rounded-xl text-white font-semibold transition-colors"
                    style={{ backgroundColor: '#3DBDD4' }}
                    onMouseOver={e => (e.currentTarget.style.backgroundColor = '#2DADC4')}
                    onMouseOut={e => (e.currentTarget.style.backgroundColor = '#3DBDD4')}
                  >
                    Accept Waiver & Continue to Payment →
                  </button>
                </div>
              ) : (
                <div className="pt-4 border-t border-gray-700">
                  <p className="text-green-400 font-medium">✓ Liability waiver signed</p>
                  <button onClick={() => { setWaiverSigned(false); setStep(2) }} className="text-xs mt-1" style={{ color: '#3DBDD4' }}>Re-sign</button>
                </div>
              )}
            </div>
          )}

          {/* Step 3 - Payment */}
          {step >= 3 && waiverSigned && (
            <div className="rounded-2xl p-6" style={{ backgroundColor: '#2B2B2B' }}>
              <h2 className="text-white font-bold text-lg mb-4">4. Payment</h2>

              {/* Price Summary */}
              <div className="mb-6 space-y-2 text-sm">
                <div className="flex justify-between text-gray-300">
                  <span>{siteTypeLabel(site.site_type)} {site.site_number} × {site.nights} nights</span>
                  <span>${(site.total_price / 100).toFixed(2)}</span>
                </div>
                {extraGuestFee > 0 && <div className="flex justify-between text-gray-300"><span>Extra guest fees</span><span>${(extraGuestFee / 100).toFixed(2)}</span></div>}
                {addonTotal > 0 && <div className="flex justify-between text-gray-300"><span>Add-ons</span><span>${(addonTotal / 100).toFixed(2)}</span></div>}
                {discountAmount > 0 && <div className="flex justify-between text-green-400"><span>Discount ({discountResult.code})</span><span>-${(discountAmount / 100).toFixed(2)}</span></div>}
                <div className="border-t border-gray-700 pt-2 flex justify-between text-white font-bold">
                  <span>Total</span><span>${(total / 100).toFixed(2)}</span>
                </div>
              </div>

              {/* Cancellation Policy */}
              <div className="rounded-lg p-4 bg-gray-800 mb-6">
                <p className="text-gray-300 text-xs leading-relaxed">
                  <span className="text-white font-medium">Cancellation Policy: </span>
                  {cancellationPolicy ? cancellationPolicy.policy_text : 'Cancellations must be made at least 7 days before arrival. A 10% booking fee is retained on all cancellations.'}
                </p>
                {cancellationPolicy && !cancellationPolicy.deposit_refundable && (
                  <p className="text-yellow-400 text-xs mt-2 font-medium">⚠ Deposit is non-refundable for these dates.</p>
                )}
              </div>
              {/* Important Notes */}
<div className="rounded-lg p-4 bg-gray-800 mb-6 space-y-2">
  <p className="text-gray-300 text-xs leading-relaxed">
    <span className="text-white font-medium">ℹ️ Site Selection: </span>
    Site choice is not guaranteed — we will do our best to honor your selection.
  </p>
  <p className="text-gray-300 text-xs leading-relaxed">
    <span className="text-white font-medium">ℹ️ Pricing: </span>
    All prices include taxes and fees — no surprises at checkout.
  </p>
</div>

              {/* Square Card Form */}
              <div className="mb-6">
                <h3 className="text-white font-medium mb-3">Card Details</h3>
                <div id="square-card-container" className="rounded-lg overflow-hidden" style={{ minHeight: '89px' }} />
                {!squareLoaded && <p className="text-gray-400 text-sm mt-2">Loading payment form...</p>}
              </div>

              {paymentError && <div className="rounded-lg p-4 bg-red-900 mb-4"><p className="text-red-300 text-sm">{paymentError}</p></div>}

              {/* Payment Buttons */}
              <div className="space-y-3">
                <h3 className="text-white font-medium">Choose Payment Option</h3>
                <button
                  disabled={paymentLoading || !squareLoaded}
                  className="w-full py-3 rounded-xl font-semibold border-2 transition-colors disabled:opacity-50"
                  style={{ borderColor: '#3DBDD4', color: '#3DBDD4', backgroundColor: 'transparent' }}
                  onClick={() => handlePayment('deposit')}
                >
                  {paymentLoading && selectedPaymentType === 'deposit' ? 'Processing...' : `Pay Deposit — $${(deposit / 100).toFixed(2)}`}
                  <span className="block text-xs font-normal mt-0.5 text-gray-400">First night only · Balance due at check-in</span>
                </button>
                <button
                  disabled={paymentLoading || !squareLoaded}
                  className="w-full py-3 rounded-xl text-white font-semibold transition-colors disabled:opacity-50"
                  style={{ backgroundColor: '#3DBDD4' }}
                  onMouseOver={e => (e.currentTarget.style.backgroundColor = '#2DADC4')}
                  onMouseOut={e => (e.currentTarget.style.backgroundColor = '#3DBDD4')}
                  onClick={() => handlePayment('full')}
                >
                  {paymentLoading && selectedPaymentType === 'full' ? 'Processing...' : `Pay in Full — $${(total / 100).toFixed(2)}`}
                </button>
              </div>
            </div>
          )}
        </div>

        {/* Booking Summary Sidebar */}
        <div className="lg:col-span-1">
          <div className="rounded-2xl p-6 sticky top-6" style={{ backgroundColor: '#2B2B2B' }}>
            <h3 className="text-white font-bold mb-4">Booking Summary</h3>
            <div className="space-y-3 text-sm">
              <div><p className="text-gray-400">Site</p><p className="text-white font-medium">{siteTypeLabel(site.site_type)} {site.site_number}</p></div>
              <div><p className="text-gray-400">Arrival</p><p className="text-white font-medium">{arrival}</p><p className="text-gray-500 text-xs">Check-in: 2:00 PM</p></div>
              <div><p className="text-gray-400">Departure</p><p className="text-white font-medium">{departure}</p><p className="text-gray-500 text-xs">Check-out: 12:00 PM</p></div>
              <div><p className="text-gray-400">Guests</p><p className="text-white font-medium">{adults} adult{adults !== 1 ? 's' : ''}{children > 0 ? `, ${children} child${children !== 1 ? 'ren' : ''}` : ''}</p></div>
              <div><p className="text-gray-400">Duration</p><p className="text-white font-medium">{site.nights} night{site.nights !== 1 ? 's' : ''}</p></div>
              <div className="border-t border-gray-700 pt-3"><p className="text-gray-400">Rate</p><p className="text-white font-medium">${(site.nightly_rate / 100).toFixed(2)}/night</p></div>
              <div className="border-t border-gray-700 pt-3">
                <div className="flex justify-between">
                  <p className="text-white font-bold">Total</p>
                  <p className="font-bold text-lg" style={{ color: '#3DBDD4' }}>${(total / 100).toFixed(2)}</p>
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