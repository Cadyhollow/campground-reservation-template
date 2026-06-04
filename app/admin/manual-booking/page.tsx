'use client'

import { useEffect, useState, useRef, Suspense } from 'react'
import { useSearchParams } from 'next/navigation'
import { supabase } from '@/lib/supabase'
import toast, { Toaster } from 'react-hot-toast'

type Site = {
  id: string
  site_number: string
  site_type: string
  amp_service: string
  hookups: string
  base_rate: number
  is_available: boolean
}

type Addon = {
  id: string
  name: string
  description: string
  price: number
  is_active: boolean
}

type Fee = {
  name: string
  type: string
  amount: number
  applies_to: string
  card_only: boolean
}

function ManualBookingInner() {
  const [sites, setSites] = useState<Site[]>([])
  const [addons, setAddons] = useState<Addon[]>([])
  const [selectedAddons, setSelectedAddons] = useState<{ [id: string]: number }>({})
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [fees, setFees] = useState<Fee[]>([])
  const [pricingRules, setPricingRules] = useState<any[]>([])
  const [enabledFees, setEnabledFees] = useState<{ [name: string]: boolean }>({})
  const [balanceDue, setBalanceDue] = useState('')
  const [squareCardRef, setSquareCardRef] = useState<any>(null)
  const [squareCardLoaded, setSquareCardLoaded] = useState(false)
  const [squareInstance, setSquareInstance] = useState<any>(null)
  const cardLoadingRef = useRef(false)
  const [form, setForm] = useState({
    site_id: '',
    arrival_date: '',
    departure_date: '',
    num_adults: 2,
    num_children: 0,
    guest_name: '',
    guest_email: '',
    guest_phone: '',
    camper_type: '',
    camper_length: '',
    camper_amperage: '',
    payment_type: 'full',
    amount_paid: '',
    payment_method: 'cash',
    notes: '',
  })

  useEffect(() => { fetchSites(); fetchAddons(); fetchFees(); fetchPricingRules() }, [])
  const searchParams = useSearchParams()
  useEffect(() => {
    const siteIdFromUrl = searchParams.get('site_id')
    if (siteIdFromUrl && sites.length > 0) {
      setForm(prev => ({ ...prev, site_id: siteIdFromUrl }))
    }
  }, [searchParams, sites])

  useEffect(() => {
    if (form.payment_method === 'card') {
      const timer = setTimeout(loadSquareCard, 500)
      return () => clearTimeout(timer)
    }
  }, [form.payment_method])

  async function fetchPricingRules() {
    const { data } = await supabase.from('pricing_rules').select('*').eq('is_active', true)
    setPricingRules(data || [])
  }

  async function fetchSites(arrivalDate?: string, departureDate?: string) {
    const { data: allSites } = await supabase.from('sites').select('*').eq('is_available', true).order('display_order')
    if (!arrivalDate || !departureDate || !allSites) {
      setSites(allSites || [])
      setLoading(false)
      return
    }
    // Filter out sites with conflicting reservations
    const { data: conflicts } = await supabase
      .from('reservations')
      .select('site_id')
      .neq('status', 'cancelled')
      .lt('arrival_date', departureDate)
      .gt('departure_date', arrivalDate)
    const conflictIds = new Set((conflicts || []).map((r: any) => r.site_id))
    setSites(allSites.filter(s => !conflictIds.has(s.id)))
    setLoading(false)
  }

  async function fetchAddons() {
    const { data } = await supabase.from('addons').select('*').eq('is_active', true).order('display_order')
    setAddons(data || [])
  }

  async function loadSquareCard() {
    if (cardLoadingRef.current) return
    const container = document.getElementById('manual-booking-card')
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
      await card.attach('#manual-booking-card')
      setSquareCardRef(card)
      setSquareCardLoaded(true)
    } catch (e) { console.error('Square card load error:', e); cardLoadingRef.current = false }
  }

  async function fetchFees() {
    const { data } = await supabase.from('fees').select('*').eq('is_active', true)
    if (data) {
      setFees(data)
      const defaults: { [name: string]: boolean } = {}
      data.forEach(f => { defaults[f.name] = true })
      setEnabledFees(defaults)
    }
  }

  function toggleFee(name: string) {
    setEnabledFees(prev => ({ ...prev, [name]: !prev[name] }))
    setBalanceDue('')
  }

  const selectedSite = sites.find(s => s.id === form.site_id)
  const isRvSite = selectedSite?.site_type === 'rv_site'

  const nights = form.arrival_date && form.departure_date
    ? Math.round((new Date(form.departure_date).getTime() - new Date(form.arrival_date).getTime()) / (1000 * 60 * 60 * 24))
    : 0

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
  const baseTotal = selectedSite ? nightlyRate * nights : 0
  const extraAdults = Math.max(0, form.num_adults - 2)
  const extraChildren = Math.max(0, form.num_children - 2)
  const extraGuestFee = (extraAdults * 1000 + extraChildren * 500) * nights

  const applicableFees = selectedSite ? fees.filter(f => {
    if (f.applies_to === 'all') return true
    const targets = f.applies_to.split(',').map(s => s.trim())
    return targets.includes(selectedSite.site_type)
  }) : []

  const enabledApplicableFees = applicableFees.filter(f => enabledFees[f.name])

  const feesTotal = enabledApplicableFees.reduce((sum, f) =>
    sum + (f.type === 'percentage' ? (baseTotal / 100) * f.amount / 100 : f.amount) * 100, 0)



  const addonTotal = Object.entries(selectedAddons).reduce((sum, [id, qty]) => {
    const addon = addons.find(a => a.id === id)
    return sum + (addon ? addon.price * qty : 0)
  }, 0)

  const calculatedTotal = baseTotal + extraGuestFee + feesTotal + addonTotal
  const total = calculatedTotal

  // Card-only fees (excluded from cash total)
  const cardOnlyFees = enabledApplicableFees.filter(f => f.card_only)
  const cardOnlyFeesTotal = cardOnlyFees.reduce((sum, f) =>
    sum + (f.type === 'percentage' ? (baseTotal / 100) * f.amount / 100 : f.amount) * 100, 0)
  const cashTotal = total - cardOnlyFeesTotal
  const hasCashCardSplit = cardOnlyFeesTotal > 0

  const firstNightBase = selectedSite ? selectedSite.base_rate : 0
  const proportionalFees = nights > 0 ? Math.round(feesTotal / nights) : 0
  const depositAmount = firstNightBase + proportionalFees

  const siteTypeLabel = (type: string) => ({ rv_site: 'RV Site', cabin: 'Cabin', tent: 'Tent Site', yurt: 'Yurt', tiny_home: 'Tiny Home', lodge: 'Lodge Room', glamping: 'Glamping', treehouse: 'Treehouse' }[type] || type)
  const hookupLabel = (h: string) => ({ full: 'Full Hookup', water_electric: 'Water & Electric', none: 'None' }[h] || h)
  const ampLabel = (a: string) => ({ '30amp': '30 Amp', '30_50amp': '30/50 Amp', none: '' }[a] || '')

  async function handleSave() {
    if (!form.site_id || !form.arrival_date || !form.departure_date || !form.guest_name || !form.guest_email) {
      toast.error('Please fill in all required fields.')
      return
    }
    if (nights <= 0) {
      toast.error('Departure date must be after arrival date.')
      return
    }

    setSaving(true)
    const amountPaid = form.amount_paid ? Math.round(parseFloat(form.amount_paid) * 100) : 0

    // If card payment, tokenize first before creating reservation
    let cardToken: string | null = null
    if (form.payment_method === 'card' && amountPaid > 0) {
      if (!squareCardRef) {
        toast.error('Card form not ready. Please wait a moment.')
        setSaving(false)
        return
      }
      const result = await squareCardRef.tokenize()
      if (result.status !== 'OK') {
        toast.error('Card details invalid. Please check and try again.')
        setSaving(false)
        return
      }
      cardToken = result.token
    }

    const addonItems = Object.entries(selectedAddons)
      .filter(([_, qty]) => qty > 0)
      .map(([id, quantity]) => {
        const addon = addons.find(a => a.id === id)
        return { id, quantity, price: addon?.price || 0 }
      })

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
        extra_guest_fee_total: extraGuestFee,
        addons_total: addonTotal,
        total_price: balanceDue ? amountPaid + Math.round(parseFloat(balanceDue) * 100) : calculatedTotal,
        fees_total: 0,
        amount_paid: amountPaid,
        payment_type: amountPaid > 0 ? 'deposit' : 'unpaid',
        payment_method: form.payment_method,
        notes: form.notes,
        addonItems,
      }),
    })

    const data = await response.json()

    if (!response.ok || !data.success) {
      toast.error(data.error || 'Error saving reservation.')
      setSaving(false)
      return
    }

    const addonDetails = addonItems.map(item => ({
      name: addons.find(a => a.id === item.id)?.name || 'Add-on',
      quantity: item.quantity,
      price: item.price,
    }))

    try {
      await fetch('/api/email', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          guestName: form.guest_name,
          guestEmail: form.guest_email,
          siteNumber: selectedSite?.site_number || '',
          siteType: selectedSite?.site_type || 'rv_site',
          arrival: form.arrival_date,
          departure: form.departure_date,
          nights,
          adults: form.num_adults,
          children: form.num_children,
          camperType: isRvSite ? form.camper_type : '',
          camperLength: isRvSite && form.camper_length ? parseInt(form.camper_length) : 0,
          camperAmperage: isRvSite ? form.camper_amperage : '',
          totalPrice: total,
          amountPaid: amountPaid,
          paymentType: form.payment_type,
          confirmationNumber: data.confirmationNumber,
          addonDetails,
          extraGuestFee,
        }),
      })
    } catch (e) {
      console.error('Email failed:', e)
    }

    // Charge card if applicable — create folio first then charge
    if (cardToken && data.reservationId && amountPaid > 0) {
      // Create folio for this reservation
      const { data: newFolio } = await supabase.from('folios').insert({
        reservation_id: data.reservationId,
        guest_name: form.guest_name,
        guest_email: form.guest_email || '',
        folio_type: 'reservation',
        status: 'open',
      }).select().single()

      if (newFolio) {
        const cardRes = await fetch('/api/admin-card-payment', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            sourceId: cardToken,
            folioId: newFolio.id,
            amount: amountPaid,
            surchargeAmount: 0,
            guestName: form.guest_name,
          }),
        })
        const cardData = await cardRes.json()
        if (!cardData.success) {
          toast.error('Reservation created but card charge failed: ' + (cardData.error || 'Unknown error'))
          setSaving(false)
          return
        }
      }
    }

    if (cardToken && amountPaid > 0) {
      toast.success(`✓ Card approved! Reservation #${data.confirmationNumber} created.`)
    } else {
      toast.success(`Reservation created! Confirmation #${data.confirmationNumber}`)
    }
    setSaving(false)
    setSquareCardLoaded(false)
    setSquareCardRef(null)
    setForm({
      site_id: '',
      arrival_date: '',
      departure_date: '',
      num_adults: 2,
      num_children: 0,
      guest_name: '',
      guest_email: '',
      guest_phone: '',
      camper_type: '',
      camper_length: '',
      camper_amperage: '',
      payment_type: 'full',
      amount_paid: '',
      payment_method: 'cash',
      notes: '',
    })
    setSelectedAddons({})
    setBalanceDue('')
  }

  return (
    <div className="p-6 max-w-4xl mx-auto">
      <Toaster />
      <div className="mb-6">
        <h2 className="text-2xl font-bold text-gray-900">Manual Booking</h2>
        <p className="text-sm text-gray-500 mt-1">Enter reservations made by phone or in person.</p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="lg:col-span-2 space-y-6">

          {/* Site & Dates */}
          <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-6">
            <h3 className="text-lg font-semibold text-gray-900 mb-4">Site & Dates</h3>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Arrival Date *</label>
                <input type="date" className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm" value={form.arrival_date} onChange={e => {
                  const newArrival = e.target.value
                  setForm(prev => ({ ...prev, arrival_date: newArrival, site_id: '' }))
                  if (newArrival && form.departure_date) fetchSites(newArrival, form.departure_date)
                }} />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Departure Date *</label>
                <input type="date" className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm" value={form.departure_date}
                  onChange={e => {
                    if (form.arrival_date && e.target.value && e.target.value <= form.arrival_date) { toast.error('Departure must be after arrival date.'); return }
                    const newDep = e.target.value
                    setForm(prev => ({ ...prev, departure_date: newDep, site_id: '' }))
                    if (form.arrival_date && newDep) fetchSites(form.arrival_date, newDep)
                  }} />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Adults</label>
                <input type="number" min="1" className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm" value={form.num_adults} onChange={e => setForm({ ...form, num_adults: parseInt(e.target.value) })} />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Children</label>
                <input type="number" min="0" className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm" value={form.num_children} onChange={e => setForm({ ...form, num_children: parseInt(e.target.value) })} />
              </div>
              <div className="md:col-span-2">
                <label className="block text-sm font-medium text-gray-700 mb-1">Site *</label>
                {!form.arrival_date || !form.departure_date ? (
                  <div className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm text-gray-400 bg-gray-50">Enter dates above to see available sites</div>
                ) : sites.length === 0 ? (
                  <div className="w-full border border-red-200 rounded-lg px-3 py-2 text-sm text-red-500 bg-red-50">No sites available for these dates</div>
                ) : (
                  <select className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm" value={form.site_id} onChange={e => setForm({ ...form, site_id: e.target.value })}>
                    <option value="">Select a site...</option>
                    {sites.map(site => {
                      const applicable = pricingRules.filter(rule => {
                        const withinDates = rule.start_date <= form.departure_date && rule.end_date >= form.arrival_date
                        if (!withinDates) return false
                        if (rule.site_ids) return rule.site_ids.split(',').includes(site.id)
                        if (rule.site_id) return rule.site_id === site.id
                        if (rule.site_type) return rule.site_type === site.site_type
                        return false
                      })
                      const bestRule = applicable.sort((a: any, b: any) => b.priority - a.priority)[0]
                      const rate = bestRule ? bestRule.nightly_rate : site.base_rate
                      return (
                        <option key={site.id} value={site.id}>
                          {siteTypeLabel(site.site_type)} {site.site_number} — ${(rate / 100).toFixed(2)}/night
                          {bestRule ? ' ★' : ''}
                          {site.site_type === 'rv_site' ? ` · ${ampLabel(site.amp_service)} · ${hookupLabel(site.hookups)}` : ''}
                        </option>
                      )
                    })}
                  </select>
                )}
              </div>
            </div>
          </div>

          {/* Add-Ons */}
          {addons.length > 0 && (
            <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-6">
              <h3 className="text-lg font-semibold text-gray-900 mb-4">Add-Ons (Optional)</h3>
              <div className="space-y-3">
                {addons.map(addon => (
                  <div key={addon.id} className="flex items-center justify-between p-3 rounded-lg bg-gray-50 border border-gray-100">
                    <div>
                      <p className="font-medium text-gray-900 text-sm">{addon.name}</p>
                      {addon.description && <p className="text-gray-500 text-xs">{addon.description}</p>}
                      <p className="text-green-700 text-sm mt-0.5">${(addon.price / 100).toFixed(2)}</p>
                    </div>
                    <div className="flex items-center gap-2">
                      <button onClick={() => setSelectedAddons(prev => ({ ...prev, [addon.id]: Math.max(0, (prev[addon.id] || 0) - 1) }))}
                        className="w-8 h-8 rounded-full bg-gray-200 text-gray-700 font-bold hover:bg-gray-300">-</button>
                      <span className="w-6 text-center font-medium text-gray-900">{selectedAddons[addon.id] || 0}</span>
                      <button onClick={() => setSelectedAddons(prev => ({ ...prev, [addon.id]: (prev[addon.id] || 0) + 1 }))}
                        className="w-8 h-8 rounded-full bg-green-700 text-white font-bold hover:bg-green-800">+</button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Fees */}
          {applicableFees.length > 0 && selectedSite && nights > 0 && (
            <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-6">
              <h3 className="text-lg font-semibold text-gray-900 mb-1">Taxes & Fees</h3>
              <p className="text-xs text-gray-500 mb-4">Uncheck any fees that don't apply to this booking (e.g. cash payments).</p>
              <div className="space-y-3">
                {applicableFees.map((fee, i) => {
                  const feeAmount = fee.type === 'percentage'
                    ? (baseTotal / 100) * fee.amount / 100
                    : fee.amount / 100
                  return (
                    <div key={i} className="flex items-center justify-between p-3 rounded-lg bg-gray-50 border border-gray-100">
                      <div className="flex items-center gap-3">
                        <button
                          type="button"
                          onClick={() => toggleFee(fee.name)}
                          className={`w-5 h-5 rounded border-2 flex items-center justify-center shrink-0 transition-colors ${
                            (enabledFees[fee.name] ?? true)
                              ? 'bg-green-700 border-green-700 text-white'
                              : 'bg-white border-gray-300'
                          }`}
                        >
                          {(enabledFees[fee.name] ?? true) && <span className="text-xs font-bold">✓</span>}
                        </button>
                        <div>
                          <p className="font-medium text-gray-900 text-sm">{fee.name}</p>
                          <p className="text-gray-500 text-xs">
                            {fee.type === 'percentage' ? `${fee.amount}% of site total` : 'Flat fee'}
                          </p>
                        </div>
                      </div>
                      <p className={`text-sm font-medium ${enabledFees[fee.name] ? 'text-gray-900' : 'text-gray-300 line-through'}`}>
                        ${feeAmount.toFixed(2)}
                      </p>
                    </div>
                  )
                })}
              </div>
            </div>
          )}

          {/* Guest Info */}
          <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-6">
            <h3 className="text-lg font-semibold text-gray-900 mb-4">Guest Information</h3>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="md:col-span-2">
                <label className="block text-sm font-medium text-gray-700 mb-1">Full Name *</label>
                <input className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm" placeholder="Jane Smith" value={form.guest_name} onChange={e => setForm({ ...form, guest_name: e.target.value })} />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Email *</label>
                <input type="email" className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm" placeholder="jane@email.com" value={form.guest_email} onChange={e => setForm({ ...form, guest_email: e.target.value })} />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Phone</label>
                <input type="tel" className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm" placeholder="(555) 555-5555" value={form.guest_phone} onChange={e => setForm({ ...form, guest_phone: e.target.value })} />
              </div>

              {/* Camper Info — RV sites only, all optional */}
              {isRvSite && (
                <>
                  <div className="md:col-span-2 border-t border-gray-100 pt-4">
                    <p className="text-sm font-medium text-gray-700 mb-3">Camper Info <span className="text-gray-400 font-normal">(optional)</span></p>
                    <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                      <div>
                        <label className="block text-sm font-medium text-gray-700 mb-1">Camper Type</label>
                        <select className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm" value={form.camper_type} onChange={e => setForm({ ...form, camper_type: e.target.value })}>
                          <option value="">Unknown</option>
                          <option value="travel_trailer">Travel Trailer</option>
                          <option value="fifth_wheel">Fifth Wheel</option>
                          <option value="class_a">Class A</option>
                          <option value="class_c">Class C</option>
                          <option value="van">Van</option>
                          <option value="other">Other</option>
                        </select>
                      </div>
                      <div>
                        <label className="block text-sm font-medium text-gray-700 mb-1">Length (ft)</label>
                        <input
                          type="number"
                          min="1"
                          max="100"
                          className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm"
                          placeholder="e.g. 32"
                          value={form.camper_length}
                          onChange={e => setForm({ ...form, camper_length: e.target.value })}
                        />
                      </div>
                      <div>
                        <label className="block text-sm font-medium text-gray-700 mb-1">Amperage</label>
                        <select className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm" value={form.camper_amperage} onChange={e => setForm({ ...form, camper_amperage: e.target.value })}>
                          <option value="">Unknown</option>
                          <option value="50amp">50 Amp</option>
                          <option value="30amp">30 Amp</option>
                          <option value="20amp">20 Amp</option>
                        </select>
                      </div>
                    </div>
                  </div>
                </>
              )}
            </div>
          </div>

          {/* Payment */}
          <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-6">
            <h3 className="text-lg font-semibold text-gray-900 mb-4">Payment</h3>
            <p className="text-xs text-gray-500 mb-4">Enter what was collected today and what the guest will owe at arrival. Balance due is the cash price — card adds 3% at check-in.</p>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="md:col-span-2">
                <label className="block text-sm font-medium text-gray-700 mb-2">Payment Method</label>
                <div className="grid grid-cols-3 gap-2">
                  {(['cash', 'card', 'check'] as const).map(m => (
                    <button key={m} type="button" onClick={() => setForm({ ...form, payment_method: m })}
                      className="py-2 rounded-lg text-sm font-semibold border-2 capitalize transition-colors"
                      style={{ borderColor: form.payment_method === m ? '#15803d' : '#e5e7eb', background: form.payment_method === m ? '#f0fdf4' : '#fff', color: form.payment_method === m ? '#15803d' : '#374151' }}>
                      {m}
                    </button>
                  ))}
                </div>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Amount Paid Today ($)</label>
                <input type="number" min="0" step="0.01" className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm" placeholder="0.00" value={form.amount_paid} onChange={e => setForm({ ...form, amount_paid: e.target.value })} />
                <p className="text-xs text-gray-400 mt-1">Card total: ${(total / 100).toFixed(2)} · Cash total: ${(cashTotal / 100).toFixed(2)}</p>
              </div>
              {form.payment_method === 'card' && (
                <div className="md:col-span-2">
                  <label className="block text-sm font-medium text-gray-700 mb-1">Card Details</label>
                  <div id="manual-booking-card" className="border border-gray-200 rounded-lg p-2 min-h-[89px]"
                    ref={el => { if (el && !squareCardLoaded) setTimeout(loadSquareCard, 100) }}
                  />
                  {!squareCardLoaded && <p className="text-xs text-gray-400 mt-1">Loading card form...</p>}
                </div>
              )}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Balance Due at Arrival ($)</label>
                <input
                  type="number"
                  min="0"
                  step="0.01"
                  className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm"
                  placeholder={(cashTotal / 100).toFixed(2)}
                  value={balanceDue}
                  onChange={e => setBalanceDue(e.target.value)}
                />
                <p className="text-xs text-gray-400 mt-1">Suggested: ${(cashTotal / 100).toFixed(2)} cash. Card adds 3% at check-in.</p>
              </div>
              <div className="md:col-span-2">
                <label className="block text-sm font-medium text-gray-700 mb-1">Internal Notes</label>
                <textarea className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm" rows={3} placeholder="Any notes about this booking..." value={form.notes} onChange={e => setForm({ ...form, notes: e.target.value })} />
              </div>
            </div>
          </div>
          {form.payment_method === 'card' && !squareCardLoaded && (
            <p className="text-center text-sm text-amber-600 font-medium mb-2">⏳ Waiting for card form to load — please wait before submitting.</p>
          )}
          <button
            onClick={handleSave}
            disabled={saving || (form.payment_method === 'card' && parseFloat(form.amount_paid || '0') > 0 && !squareCardLoaded)}
            className="w-full py-3 rounded-xl text-white font-semibold bg-green-700 hover:bg-green-800 disabled:opacity-50 transition-colors"
          >
            {saving ? 'Saving...' : 'Create Reservation & Send Confirmation Email'}
          </button>
        </div>

        {/* Summary Sidebar */}
        <div className="lg:col-span-1">
          <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-6 sticky top-6">
            <h3 className="text-lg font-semibold text-gray-900 mb-4">Booking Summary</h3>
            {!form.site_id || !form.arrival_date || !form.departure_date ? (
              <p className="text-gray-400 text-sm">Select a site and dates to see pricing.</p>
            ) : (
              <div className="space-y-3 text-sm">
                <div>
                  <p className="text-gray-500">Site</p>
                  <p className="font-medium text-gray-900">{selectedSite ? `${siteTypeLabel(selectedSite.site_type)} ${selectedSite.site_number}` : '—'}</p>
                </div>
                <div>
                  <p className="text-gray-500">Dates</p>
                  <p className="font-medium text-gray-900">{form.arrival_date} → {form.departure_date}</p>
                </div>
                <div>
                  <p className="text-gray-500">Duration</p>
                  <p className="font-medium text-gray-900">{nights} night{nights !== 1 ? 's' : ''}</p>
                </div>
                <div>
                  <p className="text-gray-500">Guests</p>
                  <p className="font-medium text-gray-900">{form.num_adults} adults, {form.num_children} children</p>
                </div>
                {isRvSite && (form.camper_type || form.camper_length || form.camper_amperage) && (
                  <div>
                    <p className="text-gray-500">Camper</p>
                    <p className="font-medium text-gray-900">
                      {form.camper_type ? { travel_trailer: 'Travel Trailer', fifth_wheel: 'Fifth Wheel', class_a: 'Class A', class_c: 'Class C', van: 'Van', other: 'Other' }[form.camper_type] || form.camper_type : 'Unknown type'}
                      {form.camper_length ? ` · ${form.camper_length} ft` : ''}
                      {form.camper_amperage ? ` · ${form.camper_amperage.replace('amp', ' Amp')}` : ''}
                    </p>
                  </div>
                )}
                <div className="border-t border-gray-100 pt-3 space-y-1">
                  <div className="flex justify-between text-gray-600">
                    <span>Site ({nights} nights)</span>
                    <span>${(baseTotal / 100).toFixed(2)}</span>
                  </div>
                  {extraGuestFee > 0 && (
                    <div className="flex justify-between text-gray-600">
                      <span>Extra guests</span>
                      <span>${(extraGuestFee / 100).toFixed(2)}</span>
                    </div>
                  )}
                  {Object.entries(selectedAddons).filter(([_, qty]) => qty > 0).map(([id, qty]) => {
                    const addon = addons.find(a => a.id === id)
                    if (!addon) return null
                    return (
                      <div key={id} className="flex justify-between text-gray-600">
                        <span>{addon.name}{qty > 1 ? ` ×${qty}` : ''}</span>
                        <span>${((addon.price * qty) / 100).toFixed(2)}</span>
                      </div>
                    )
                  })}
                  {applicableFees.map((fee, i) => {
                    const feeAmount = fee.type === 'percentage'
                      ? (baseTotal / 100) * fee.amount / 100
                      : fee.amount / 100
                    const isEnabled = enabledFees[fee.name] ?? true
                    return (
                      <div key={i} className={`flex justify-between ${isEnabled ? 'text-gray-600' : 'text-gray-300 line-through'}`}>
                        <span>{fee.name}</span>
                        <span>${feeAmount.toFixed(2)}</span>
                      </div>
                    )
                  })}

                  <div className="flex justify-between font-bold text-gray-900 border-t border-gray-100 pt-2 mt-2">
                    <span>Total</span>
                    <span>${(total / 100).toFixed(2)}</span>
                  </div>

                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

export default function ManualBookingPage() {
  return (
    <Suspense fallback={<div className="p-6 text-gray-500">Loading...</div>}>
      <ManualBookingInner />
    </Suspense>
  )
}
