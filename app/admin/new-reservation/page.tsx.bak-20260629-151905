'use client'
import { useEffect, useMemo, useRef, useState } from 'react'
import { supabase } from '@/lib/supabase'
import { computePricing, siteFitsCamper } from '@/lib/pricing'
import type { PricingSite, PricingSettings, PricingFee, PricingRule } from '@/lib/pricing'

type Step = 1 | 2 | 3 | 4

const STEPS: { n: Step; label: string }[] = [
  { n: 1, label: 'Dates & site' },
  { n: 2, label: 'Guest' },
  { n: 3, label: 'Add-ons' },
  { n: 4, label: 'Review & pay' },
]

const money = (cents: number) => `$${(cents / 100).toFixed(2)}`
const posLineTax = (unit: number, taxClass?: string) => taxClass === 'standard' ? Math.round(unit * 0.06) : 0
const posLineTotal = (e: any) => (e.unit_price + posLineTax(e.unit_price, e.tax_class)) * e.quantity
const fmtTime = (t?: string | null) => {
  if (!t) return ''
  const [hStr, mStr] = t.split(':')
  const h = parseInt(hStr, 10)
  if (isNaN(h)) return t
  const ampm = h >= 12 ? 'PM' : 'AM'
  const h12 = h % 12 === 0 ? 12 : h % 12
  return `${h12}:${(mStr || '00').padStart(2, '0')} ${ampm}`
}
const siteTypeLabel = (t: string) =>
  (({ rv_site: 'RV sites', cabin: 'Cabins', tent: 'Tent sites', yurt: 'Yurts', tiny_home: 'Tiny homes', lodge: 'Lodge rooms', glamping: 'Glamping', treehouse: 'Treehouses' } as Record<string, string>)[t] || t)
const fmtDate = (s: string) =>
  s ? new Date(s + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '—'

export default function NewReservationWizard() {
  const [step, setStep] = useState<Step>(1)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [confirmation, setConfirmation] = useState<string | null>(null)
  const [newReservationId, setNewReservationId] = useState<string | null>(null)
  const [sendWaiver, setSendWaiver] = useState(true)
  const [waiverMsg, setWaiverMsg] = useState<string | null>(null)
  const [newFolioId, setNewFolioId] = useState<string | null>(null)
  const [terminalStatus, setTerminalStatus] = useState<'' | 'waiting' | 'timeout'>('')
  const [squareCardRef, setSquareCardRef] = useState<any>(null)
  const [squareInstance, setSquareInstance] = useState<any>(null)
  const cardLoadingRef = useRef(false)

  const [sites, setSites] = useState<any[]>([])
  const [settings, setSettings] = useState<any>(null)
  const [fees, setFees] = useState<any[]>([])
  const [addons, setAddons] = useState<any[]>([])
  const [pricingRules, setPricingRules] = useState<any[]>([])
  const [guests, setGuests] = useState<any[]>([])
  const [products, setProducts] = useState<any[]>([])
  const [productCategories, setProductCategories] = useState<string[]>([])
  const [showPOS, setShowPOS] = useState(false)
  const [posCart, setPosCart] = useState<any[]>([])
  const [unavailableIds, setUnavailableIds] = useState<Set<string>>(new Set())

  const [form, setForm] = useState({
    arrival_date: '',
    departure_date: '',
    site_id: '',
    camper_type: '',
    camper_length: '',
    camper_amperage: '' as '' | '30amp' | '50amp',
    num_adults: 2,
    num_children: 0,
    guest_first: '',
    guest_last: '',
    guest_email: '',
    guest_phone: '',
    selectedAddons: {} as Record<string, number>,
    earlyCheckin: false,
    lateCheckout: false,
    amount_paid: '',
    payment_method: 'cash',
    email_waiver: true,
    total_override: '',
  })
  const set = (patch: Partial<typeof form>) => setForm(prev => ({ ...prev, ...patch }))

  useEffect(() => {
    (async () => {
      const [s, st, f, a, pr, g, pd, pc] = await Promise.all([
        supabase.from('sites').select('*').eq('is_available', true).order('display_order'),
        supabase.from('settings').select('*').limit(1).single(),
        supabase.from('fees').select('*').eq('is_active', true),
        supabase.from('addons').select('*').eq('is_active', true).order('display_order'),
        supabase.from('pricing_rules').select('*').eq('is_active', true),
        supabase.from('guests').select('id, name, email, phone, last_visit').order('name'),
        supabase.from('products').select('*').eq('active', true).order('display_order'),
        supabase.from('product_categories').select('name').order('display_order'),
      ])
      setSites(s.data || [])
      setSettings(st.data || null)
      setFees(f.data || [])
      setAddons(a.data || [])
      setPricingRules(pr.data || [])
      setGuests(g.data || [])
      setProducts(pd.data || [])
      setProductCategories((pc.data || []).map((c: any) => c.name))
      setLoading(false)
    })()
  }, [])

  useEffect(() => {
    if (!form.arrival_date || !form.departure_date) { setUnavailableIds(new Set()); return }
    (async () => {
      const { data } = await supabase
        .from('reservations')
        .select('site_id')
        .neq('status', 'cancelled')
        .lt('arrival_date', form.departure_date)
        .gt('departure_date', form.arrival_date)
      setUnavailableIds(new Set((data || []).map((r: any) => r.site_id)))
    })()
  }, [form.arrival_date, form.departure_date])

  useEffect(() => {
    if (step === 4 && form.payment_method === 'card') {
      const t = setTimeout(loadSquareCard, 300)
      return () => clearTimeout(t)
    }
  }, [step, form.payment_method])

  async function loadSquareCard() {
    if (cardLoadingRef.current) return
    const container = document.getElementById('wizard-card')
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
      await card.attach('#wizard-card')
      setSquareCardRef(card)
    } catch (e) {
      console.error('Square card load error:', e)
      cardLoadingRef.current = false
    }
  }

  const selectedSite = sites.find(s => s.id === form.site_id) || null

  const pricing = useMemo(() => {
    if (!settings) return null
    const addonItems = Object.entries(form.selectedAddons)
      .filter(([, q]) => q > 0)
      .map(([id, q]) => {
        const ad = addons.find(x => x.id === id)
        return { name: ad?.name, price: ad?.price || 0, quantity: q }
      })
    return computePricing({
      site: selectedSite as PricingSite | null,
      arrival_date: form.arrival_date,
      departure_date: form.departure_date,
      num_adults: form.num_adults,
      num_children: form.num_children,
      settings: settings as PricingSettings,
      fees: fees as PricingFee[],
      addons: addonItems,
      pricingRules: pricingRules as PricingRule[],
      earlyCheckin: form.earlyCheckin,
      lateCheckout: form.lateCheckout,
    })
  }, [settings, fees, addons, pricingRules, selectedSite, form])

  const available = useMemo(
    () => sites.filter(s => !unavailableIds.has(s.id)),
    [sites, unavailableIds],
  )

  const camper = {
    length: form.camper_length ? parseInt(form.camper_length) : null,
    amperage: (form.camper_amperage || null) as '30amp' | '50amp' | null,
  }

  const overrideActive = form.total_override.trim() !== '' && !isNaN(parseFloat(form.total_override)) && parseFloat(form.total_override) >= 0
  const effectiveTotal = overrideActive ? Math.round(parseFloat(form.total_override) * 100) : (pricing?.cashTotal || 0)
  const posTotal = posCart.reduce((sum: number, e: any) => sum + posLineTotal(e), 0)
  const grandTotal = effectiveTotal + posTotal

  function selectSite(s: any, needsOverride: boolean, reason?: string) {
    if (needsOverride) {
      const ok = window.confirm(`${s.site_number} is rated for ${reason}. Book this rig here anyway?`)
      if (!ok) return
    }
    set({ site_id: s.id })
  }

  async function handleComplete() {
    if (saving) return
    setError('')
    const guest_name = `${form.guest_first} ${form.guest_last}`.trim()
    if (!form.site_id || !form.arrival_date || !form.departure_date || !guest_name) {
      setError('Missing a site, dates, or guest name.')
      return
    }
    const p = pricing
    if (!p) return
    const paidCents = form.amount_paid ? Math.round(parseFloat(form.amount_paid) * 100) : 0

    // Total override — replaces the calculated total, recorded in notes.
    const overrideActive = form.total_override.trim() !== '' && !isNaN(parseFloat(form.total_override)) && parseFloat(form.total_override) >= 0
    const effectiveTotal = overrideActive ? Math.round(parseFloat(form.total_override) * 100) : p.cashTotal
    const overrideNote = overrideActive
      ? `[Total overridden ${new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}] Calculated: $${(p.cashTotal / 100).toFixed(2)} → Override: $${(effectiveTotal / 100).toFixed(2)}`
      : ''

    // Card: tokenize BEFORE creating any records, so an invalid card aborts cleanly.
    let cardToken: string | null = null
    if (form.payment_method === 'card' && paidCents > 0) {
      if (!squareCardRef) {
        setError('Card form is still loading — give it a second and try again.')
        return
      }
      const result = await squareCardRef.tokenize()
      if (result.status !== 'OK') {
        setError('Card details look invalid — please check them and try again.')
        return
      }
      cardToken = result.token
    }

    const isRv = selectedSite?.site_type === 'rv_site'
    const addonItems = Object.entries(form.selectedAddons)
      .filter(([, q]) => (q as number) > 0)
      .map(([id, quantity]) => {
        const a = addons.find(x => x.id === id)
        return { id, quantity, price: a?.price || 0 }
      })
    setSaving(true)
    try {
      // 1) Create the reservation. Money lives in the folio, so amount_paid stays 0.
      const res = await fetch('/api/manual-booking', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          site_id: form.site_id,
          arrival_date: form.arrival_date,
          departure_date: form.departure_date,
          num_adults: form.num_adults,
          num_children: form.num_children,
          guest_name,
          guest_email: form.guest_email,
          guest_phone: form.guest_phone,
          camper_type: isRv ? form.camper_type : '',
          camper_length: isRv && form.camper_length ? parseInt(form.camper_length) : 0,
          camper_amperage: isRv ? form.camper_amperage : '',
          base_nightly_rate: p.nightlyRate,
          extra_guest_fee_total: p.extraGuestFee,
          addons_total: p.addonTotal,
          early_checkin: form.earlyCheckin,
          early_checkin_fee: p.earlyFee,
          late_checkout: form.lateCheckout,
          late_checkout_fee: p.lateFee,
          total_price: effectiveTotal,
          fees_total: p.feesTotalCash,
          amount_paid: 0,
          payment_type: 'unpaid',
          payment_method: form.payment_method,
          notes: overrideNote,
          addonItems,
        }),
      })
      const data = await res.json()
      if (!res.ok || !data.success) {
        setError(data.error || 'Error creating reservation.')
        setSaving(false)
        return
      }

      // 2) Create the folio for this reservation — the single home for all payment.
      const { data: folio, error: folioErr } = await supabase.from('folios').insert({
        reservation_id: data.reservationId,
        guest_name,
        guest_email: form.guest_email || '',
        folio_type: 'reservation',
        status: 'open',
      }).select().single()
      if (folioErr || !folio) {
        setError(`Reservation created, but folio setup failed: ${folioErr?.message || 'unknown error'}`)
        setSaving(false)
        return
      }

      // 2b) Write any staged store items into the folio as line items (same shape as the folio POS).
      if (posCart.length > 0) {
        const rows = posCart.map((e: any) => ({
          folio_id: folio.id,
          product_id: e.product_id,
          description: e.description,
          quantity: e.quantity,
          unit_price: e.unit_price,
          tax_amount: posLineTax(e.unit_price, e.tax_class),
          line_total: posLineTotal(e),
          category: e.category,
        }))
        const { error: liErr } = await supabase.from('folio_line_items').insert(rows)
        if (liErr) {
          setNewReservationId(data.reservationId)
          setNewFolioId(folio.id)
          setError(`Reservation and folio created, but adding store items failed: ${liErr.message}. Open the folio to add them there.`)
          setSaving(false)
          return
        }
      }

      // Confirmation-email sender — best-effort; used by the immediate paths and
      // by the Terminal poll once the tap completes.
      const sendConfirmation = async () => {
        if (!form.guest_email) return
        try {
          const addonDetails = addonItems.map(item => ({
            name: addons.find(a => a.id === item.id)?.name || 'Add-on',
            quantity: item.quantity,
            price: item.price,
          }))
          if (p.earlyFee > 0) addonDetails.push({ name: 'Early Check-In', quantity: 1, price: p.earlyFee })
          if (p.lateFee > 0) addonDetails.push({ name: 'Late Check-Out', quantity: 1, price: p.lateFee })
          await fetch('/api/email', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              guestName: guest_name,
              guestEmail: form.guest_email,
              siteNumber: selectedSite?.site_number || '',
              siteType: selectedSite?.site_type || '',
              arrival: form.arrival_date,
              departure: form.departure_date,
              nights: p.nights,
              adults: form.num_adults,
              children: form.num_children,
              camperType: isRv ? form.camper_type : '',
              camperLength: isRv && form.camper_length ? parseInt(form.camper_length) : 0,
              camperAmperage: isRv ? form.camper_amperage : '',
              totalPrice: effectiveTotal,
              amountPaid: Math.min(paidCents, effectiveTotal),
              paymentType: paidCents <= 0 ? 'unpaid' : (paidCents >= effectiveTotal ? 'full' : 'deposit'),
              confirmationNumber: data.confirmationNumber,
              addonDetails,
              extraGuestFee: p.extraGuestFee,
              feesTotal: p.feesTotalCash,
            }),
          })
        } catch (e) {
          console.error('Confirmation email failed:', e)
        }
      }

      const finishSuccess = async () => {
        await sendConfirmation()
        setNewReservationId(data.reservationId)
        setNewFolioId(folio.id)
        setConfirmation(data.confirmationNumber)
        // Email the liability waiver if the toggle is on, the waiver is enabled, and we have an email.
        if (sendWaiver && settings?.waiver_enabled && form.guest_email) {
          try {
            const wRes = await fetch('/api/send-waiver', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ reservationId: data.reservationId, sendEmail: true }),
            })
            const wData = await wRes.json()
            if (wData?.emailed) setWaiverMsg(`Liability waiver emailed to ${wData.guestEmail}`)
            else if (wData?.success) setWaiverMsg('Waiver link created — email could not be sent here, but the link is ready.')
          } catch { /* non-blocking: booking already succeeded */ }
        }
        setSaving(false)
      }

      // 3) Record the payment into the folio, by method.

      // Terminal — send the charge to the Square Terminal, then poll for the tap.
      if (paidCents > 0 && form.payment_method === 'terminal') {
        const surcharge = p.cardSurcharge(paidCents)
        const tRes = await fetch('/api/terminal/charge', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            folioId: folio.id,
            amount: paidCents + surcharge,
            surchargeAmount: surcharge,
            note: `Booking payment · ${guest_name}`,
          }),
        })
        const tData = await tRes.json()
        if (!tRes.ok || !tData.success) {
          setNewReservationId(data.reservationId)
          setNewFolioId(folio.id)
          setError(`Reservation created and held, but the Terminal couldn't be reached: ${tData.error || 'failed'}. Open the folio to retry or collect another way.`)
          setSaving(false)
          return
        }
        setTerminalStatus('waiting')
        setSaving(false)
        let attempts = 0
        const interval = setInterval(async () => {
          attempts++
          const { data: pmts } = await supabase
            .from('folio_payments')
            .select('id')
            .eq('folio_id', folio.id)
            .eq('status', 'completed')
          if (pmts && pmts.length > 0) {
            clearInterval(interval)
            setTerminalStatus('')
            await finishSuccess()
          } else if (attempts >= 60) {
            clearInterval(interval)
            setNewReservationId(data.reservationId)
            setNewFolioId(folio.id)
            setTerminalStatus('timeout')
          }
        }, 3000)
        return
      }

      // Card (keyed) — charge-first: the API charges Square, then inserts the folio_payment.
      if (paidCents > 0 && form.payment_method === 'card') {
        const surcharge = p.cardSurcharge(paidCents)
        const cardRes = await fetch('/api/admin-card-payment', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            sourceId: cardToken,
            folioId: folio.id,
            amount: paidCents + surcharge,
            surchargeAmount: surcharge,
            note: `Booking payment · ${guest_name}`,
            guestName: guest_name,
          }),
        })
        const cardData = await cardRes.json()
        if (!cardRes.ok || !cardData.success) {
          setNewReservationId(data.reservationId)
          setNewFolioId(folio.id)
          setError(`Reservation created and held, but the card didn't go through: ${cardData.error || 'declined'}. Open the folio to try another payment, or cancel the reservation.`)
          setSaving(false)
          return
        }
      } else if (paidCents > 0) {
        // Cash or check — record directly, no surcharge.
        const { error: payErr } = await supabase.from('folio_payments').insert({
          folio_id: folio.id,
          method: form.payment_method,
          amount: paidCents,
          surcharge_amount: 0,
          status: 'completed',
          note: `Booking payment · ${guest_name}`,
        })
        if (payErr) {
          setError(`Reservation and folio created, but recording the payment failed: ${payErr.message}`)
          setSaving(false)
          return
        }
      }

      // 4) Cash / check / card / no-payment finalize here (Terminal finalizes via its poll).
      await finishSuccess()
    } catch (e: any) {
      setError(e.message || 'Error saving reservation.')
      setSaving(false)
    }
  }

  function resetWizard() {
    setConfirmation(null)
    setNewReservationId(null)
    setNewFolioId(null)
    setError('')
    setTerminalStatus('')
    setShowPOS(false)
    setPosCart([])
    setSendWaiver(true)
    setWaiverMsg(null)
    setStep(1)
    setForm({
      arrival_date: '', departure_date: '', site_id: '',
      camper_type: '', camper_length: '', camper_amperage: '',
      num_adults: 2, num_children: 0,
      guest_first: '', guest_last: '', guest_email: '', guest_phone: '',
      selectedAddons: {}, earlyCheckin: false, lateCheckout: false,
      amount_paid: '', payment_method: 'cash', email_waiver: true, total_override: '',
    })
  }

  if (loading) {
    return <div className="p-8 text-sm text-gray-500">Loading…</div>
  }

  if (terminalStatus === 'waiting') {
    return (
      <div className="max-w-4xl mx-auto p-6">
        <div className="bg-white border border-gray-100 rounded-2xl shadow-sm p-10 text-center">
          <div className="text-2xl font-semibold mb-2">Waiting for the customer…</div>
          <div className="text-sm text-gray-500 mb-6">The charge has been sent to your Square Terminal. Have the customer tap or insert their card.</div>
          <div className="inline-block w-6 h-6 border-2 border-green-600 border-t-transparent rounded-full animate-spin mb-6"></div>
          <div className="text-xs text-gray-400">This screen updates automatically once the payment completes.</div>
        </div>
      </div>
    )
  }

  if (terminalStatus === 'timeout') {
    return (
      <div className="max-w-4xl mx-auto p-6">
        <div className="bg-white border border-gray-100 rounded-2xl shadow-sm p-10 text-center">
          <div className="text-2xl font-semibold text-amber-700 mb-2">No tap detected</div>
          <div className="text-sm text-gray-500 mb-7">The reservation is created and held, but the Terminal payment didn't complete. Open the folio to retry the Terminal or collect another way.</div>
          <div className="flex gap-3 justify-center">
            <a href={`/admin/folio/${newReservationId}`} className="px-5 py-2 text-sm rounded-lg bg-green-700 text-white hover:bg-green-800">Open folio</a>
            <button onClick={resetWizard} className="px-5 py-2 text-sm rounded-lg border border-gray-200">Start another</button>
          </div>
        </div>
      </div>
    )
  }

  if (confirmation) {
    return (
      <div className="max-w-4xl mx-auto p-6">
        <div className="bg-white border border-gray-100 rounded-2xl shadow-sm p-10 text-center">
          <div className="text-2xl font-semibold text-green-700 mb-1">Reservation created</div>
          <div className="text-sm text-gray-500 mb-7">Confirmation #{confirmation}</div>
          {waiverMsg && (
            <div className="text-sm text-green-700 bg-green-50 border border-green-200 rounded-lg px-4 py-2 mb-6 inline-block">✓ {waiverMsg}</div>
          )}
          <div className="flex gap-3 justify-center">
            <a href={`/admin/folio/${newReservationId}`} className="px-5 py-2 text-sm rounded-lg bg-green-700 text-white hover:bg-green-800">Open folio</a>
            <a href={`/admin/reservations?id=${newReservationId}`} className="px-5 py-2 text-sm rounded-lg border border-gray-200">View reservation</a>
            <button onClick={resetWizard} className="px-5 py-2 text-sm rounded-lg border border-gray-200">Start another</button>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="max-w-4xl mx-auto p-6">
      <div className="bg-white border border-gray-100 rounded-2xl shadow-sm p-6">
        <div className="flex items-center justify-between mb-5">
          <div className="text-lg font-semibold">New reservation</div>
          <div className="text-sm text-gray-400">{settings?.park_name || ''}</div>
        </div>

        <Stepper step={step} />

        <div className="grid grid-cols-1 md:grid-cols-[minmax(0,1fr)_280px] gap-5 mt-6">
          <div>
            {step === 1 && (
              <StepDatesSite
                form={form}
                set={set}
                available={available}
                camper={camper}
                onSelectSite={selectSite}
              />
            )}
            {step === 2 && (
              <StepGuest form={form} set={set} guests={guests} />
            )}
            {step === 3 && (
              <StepAddons form={form} set={set} addons={addons} settings={settings} />
            )}
            {step === 4 && (
              <StepReview form={form} set={set} pricing={pricing} settings={settings} effectiveTotal={effectiveTotal} grandTotal={grandTotal} products={products} productCategories={productCategories} posCart={posCart} setPosCart={setPosCart} showPOS={showPOS} setShowPOS={setShowPOS} />
            )}
          </div>

          <SummaryPanel pricing={pricing} form={form} set={set} selectedSite={selectedSite} step={step} setStep={setStep} onComplete={handleComplete} saving={saving} error={error} settings={settings} effectiveTotal={effectiveTotal} overrideActive={overrideActive} grandTotal={grandTotal} posCart={posCart} showPOS={showPOS} setShowPOS={setShowPOS} sendWaiver={sendWaiver} setSendWaiver={setSendWaiver} />
        </div>
      </div>
    </div>
  )
}

function Stepper({ step }: { step: Step }) {
  return (
    <div className="flex items-center gap-2">
      {STEPS.map((s, i) => {
        const done = step > s.n
        const active = step === s.n
        return (
          <div key={s.n} className="flex items-center gap-2 flex-1 last:flex-none">
            <div
              className={`w-7 h-7 rounded-full flex items-center justify-center text-[13px] font-medium shrink-0 ${
                active ? 'bg-green-700 text-white' : done ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-400'
              }`}
            >
              {done ? '✓' : s.n}
            </div>
            <span className={`text-[13px] ${active ? 'font-medium text-green-700' : 'text-gray-500'}`}>{s.label}</span>
            {i < STEPS.length - 1 && <div className="flex-1 h-px bg-gray-200" />}
          </div>
        )
      })}
    </div>
  )
}

function StepDatesSite({ form, set, available, camper, onSelectSite }: any) {
  const rv = available.filter((s: any) => s.site_type === 'rv_site')
  const fittingRv = rv.filter((s: any) => siteFitsCamper(s, camper).fits)
  const otherRv = rv.filter((s: any) => !siteFitsCamper(s, camper).fits)
  const otherTypes = available.filter((s: any) => s.site_type !== 'rv_site')
  const grouped: Record<string, any[]> = {}
  for (const s of otherTypes) (grouped[s.site_type] ||= []).push(s)

  const Row = ({ s, dim, reason }: { s: any; dim?: boolean; reason?: string }) => {
    const selected = form.site_id === s.id
    return (
      <button
        onClick={() => onSelectSite(s, !!dim, reason)}
        className={`w-full flex items-center gap-3 px-3.5 py-2.5 rounded-lg border text-left mb-2 transition-colors ${
          selected ? 'border-2 border-green-600 bg-green-50' : 'border-gray-200 hover:bg-gray-50'
        } ${dim ? 'bg-amber-50/40' : ''}`}
      >
        <span className={`w-4 h-4 rounded-full border shrink-0 ${selected ? 'border-green-600 bg-green-600' : 'border-gray-300'}`} />
        <span className="flex-1">
          <span className="block text-sm">{siteTypeLabel(s.site_type).replace(/s$/, '')} {s.site_number}</span>
          <span className={`block text-xs ${dim ? 'text-amber-700' : 'text-gray-400'}`}>
            {dim ? `outside rig specs — ${reason}` : (s.description || s.hookups || '')}
          </span>
        </span>
        <span className="text-sm font-medium">{money(s.base_rate)}<span className="text-xs text-gray-400 font-normal">/night</span></span>
      </button>
    )
  }

  return (
    <div>
      <div className="grid grid-cols-2 gap-3 mb-4">
        <label className="block">
          <span className="text-[13px] text-gray-600 block mb-1">Arrival</span>
          <input type="date" value={form.arrival_date} onChange={e => set({ arrival_date: e.target.value, site_id: '' })} className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm" />
        </label>
        <label className="block">
          <span className="text-[13px] text-gray-600 block mb-1">Departure</span>
          <input type="date" value={form.departure_date} onChange={e => set({ departure_date: e.target.value, site_id: '' })} className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm" />
        </label>
      </div>

      <div className="border border-gray-200 rounded-lg p-3.5 mb-4">
        <div className="text-[13px] font-medium mb-0.5">Camper details</div>
        <div className="text-xs text-gray-400 mb-2.5">Matches the rig to compatible RV sites</div>
        <div className="grid grid-cols-[1.3fr_0.8fr_0.9fr] gap-2.5">
          <label className="block">
            <span className="text-xs text-gray-600 block mb-1">Type</span>
            <select value={form.camper_type} onChange={e => set({ camper_type: e.target.value })} className="w-full border border-gray-200 rounded-lg px-2 py-2 text-sm">
              <option value="">—</option>
              <option>Travel trailer</option><option>Fifth wheel</option><option>Motorhome</option><option>Pop-up</option><option>Van</option>
            </select>
          </label>
          <label className="block">
            <span className="text-xs text-gray-600 block mb-1">Length (ft)</span>
            <input type="number" value={form.camper_length} onChange={e => set({ camper_length: e.target.value, site_id: '' })} className="w-full border border-gray-200 rounded-lg px-2 py-2 text-sm" />
          </label>
          <label className="block">
            <span className="text-xs text-gray-600 block mb-1">Amperage</span>
            <select value={form.camper_amperage} onChange={e => set({ camper_amperage: e.target.value as any, site_id: '' })} className="w-full border border-gray-200 rounded-lg px-2 py-2 text-sm">
              <option value="">—</option><option value="50amp">50 amp</option><option value="30amp">30 amp</option>
            </select>
          </label>
        </div>
      </div>

      {!form.arrival_date || !form.departure_date ? (
        <div className="text-sm text-gray-400 text-center py-8">Pick dates to see available sites.</div>
      ) : (
        <>
          {rv.length > 0 && (
            <>
              <div className="text-[13px] font-medium text-gray-600 mt-3 mb-2">RV sites <span className="text-gray-400 font-normal">· {fittingRv.length} fit the rig</span></div>
              {fittingRv.map((s: any) => <Row key={s.id} s={s} />)}
              {otherRv.length > 0 && (
                <>
                  <div className="text-xs text-gray-400 mt-3 mb-2">Other RV sites — outside rig specs (tap to override)</div>
                  {otherRv.map((s: any) => <Row key={s.id} s={s} dim reason={siteFitsCamper(s, camper).reason} />)}
                </>
              )}
            </>
          )}
          {Object.entries(grouped).map(([type, list]) => (
            <div key={type}>
              <div className="text-[13px] font-medium text-gray-600 mt-3 mb-2">{siteTypeLabel(type)} <span className="text-gray-400 font-normal">· {list.length} open</span></div>
              {list.map((s: any) => <Row key={s.id} s={s} />)}
            </div>
          ))}
        </>
      )}
    </div>
  )
}

function SummaryPanel({ pricing, form, set, selectedSite, step, setStep, onComplete, saving, error, settings, effectiveTotal, overrideActive, grandTotal, posCart, showPOS, setShowPOS, sendWaiver, setSendWaiver }: any) {
  const cash = pricing?.cashTotal || 0
  const fee = pricing ? pricing.cardSurcharge(cash) : 0
  const [editingTotal, setEditingTotal] = useState(false)
  const [draftTotal, setDraftTotal] = useState('')
  const [confirmZero, setConfirmZero] = useState(false)
  const guests = `${form.num_adults} adult${form.num_adults !== 1 ? 's' : ''}${form.num_children ? `, ${form.num_children} child${form.num_children !== 1 ? 'ren' : ''}` : ''}`
  const name = `${form.guest_first} ${form.guest_last}`.trim()
  const continueDisabled =
    (step === 1 && !form.site_id) ||
    (step === 2 && !form.guest_first.trim() && !form.guest_last.trim())
  const isReview = step === 4
  const paidCents = form.amount_paid ? Math.round(parseFloat(form.amount_paid) * 100) : 0
  const due = Math.max(0, grandTotal - paidCents)
  const cardGated = form.payment_method === 'card' || form.payment_method === 'terminal'

  return (
    <div className="md:sticky md:top-3 self-start bg-gray-50 rounded-xl p-4">
      <div className="text-[13px] font-medium text-gray-600 mb-3.5">Summary</div>
      {name && <Line k="Guest" v={name} />}
      <Line k="Site" v={selectedSite ? `${selectedSite.site_number}` : '—'} />
      {form.camper_length && <Line k="Rig" v={`${form.camper_length} ft${form.camper_amperage ? ` · ${form.camper_amperage.replace('amp', ' amp')}` : ''}`} />}
      <Line k="Dates" v={form.arrival_date ? `${fmtDate(form.arrival_date)} – ${fmtDate(form.departure_date)}` : '—'} />
      <Line k="Guests" v={guests} />
      <div className="h-px bg-gray-200 my-3.5" />
      <div className="flex flex-col gap-1.5 text-[13px]">
        {pricing?.lines?.length ? pricing.lines.map((l: any, i: number) => (
          <div key={i} className="flex justify-between"><span className="text-gray-500">{l.label}</span><span>{money(l.amount)}</span></div>
        )) : <div className="text-gray-400">No site selected</div>}
        {posCart && posCart.length > 0 && (
          <>
            <div className="text-xs text-gray-400 mt-2">Store items</div>
            {posCart.map((e: any, i: number) => (
              <div key={`pos-${i}`} className="flex justify-between"><span className="text-gray-500">{e.description}{e.quantity > 1 ? ` ×${e.quantity}` : ''}</span><span>{money(posLineTotal(e))}</span></div>
            ))}
          </>
        )}
      </div>
      <div className="h-px bg-gray-200 my-3.5" />

      {isReview ? (
        <>
          <div className="flex justify-between text-sm mb-1">
            <span className="text-gray-500">Total{overrideActive || (posCart && posCart.length > 0) ? '' : ' (cash)'}</span>
            <span className="font-medium">{money(grandTotal)}</span>
          </div>
          {overrideActive ? (
            <div className="flex justify-between items-center text-xs mb-1.5">
              <span className="text-amber-700">edited · was {money(cash)}</span>
              <button onClick={() => { set({ total_override: '' }); setEditingTotal(false) }} className="text-gray-400 underline">revert</button>
            </div>
          ) : editingTotal ? (
            <div className="flex items-center gap-1.5 mb-1.5">
              <span className="text-xs text-gray-400">$</span>
              <input type="number" value={draftTotal} onChange={e => setDraftTotal(e.target.value)} className="w-24 border border-gray-200 rounded px-2 py-1 text-sm" autoFocus />
              <button onClick={() => { if (draftTotal.trim() !== '' && !isNaN(parseFloat(draftTotal))) set({ total_override: draftTotal }); setEditingTotal(false) }} className="text-xs text-green-700 font-medium px-1">apply</button>
              <button onClick={() => setEditingTotal(false)} className="text-xs text-gray-400 px-1">cancel</button>
            </div>
          ) : (
            <button onClick={() => { setDraftTotal((cash / 100).toFixed(2)); setEditingTotal(true) }} className="text-xs text-gray-400 hover:text-gray-600 underline mb-1.5">edit total</button>
          )}
          <div className="flex justify-between text-sm"><span className="text-gray-500">Paid today</span><span>{money(paidCents)}</span></div>
          <div className="h-px bg-gray-200 my-3.5" />
          <div className="flex justify-between items-baseline">
            <span className="text-[13px] text-gray-600">Amount due</span>
            <span className="text-2xl font-semibold">{money(due)}</span>
          </div>
          <div className={`text-xs mt-1 text-right ${due <= 0 ? 'text-green-700' : 'text-gray-500'}`}>
            {due <= 0 ? '✓ paid in full' : 'balance carries to folio'}
          </div>
          {cardGated && paidCents > 0 && (
            <div className="text-xs text-gray-400 mt-1 text-right">card charge {money(paidCents + pricing.cardSurcharge(paidCents))} (incl. {pricing.cardSurchargePercent}%)</div>
          )}
          {error && <div className="text-xs text-red-600 mt-3">{error}</div>}
          {settings?.waiver_enabled && (
            <div
              onClick={() => { if (form.guest_email) setSendWaiver((v: boolean) => !v) }}
              className={`flex items-center gap-2.5 mt-4 text-[13px] rounded-lg border px-3 py-2.5 select-none ${form.guest_email ? 'cursor-pointer border-gray-200 hover:bg-gray-50' : 'border-gray-100 cursor-default'}`}
            >
              <span
                className="w-5 h-5 rounded flex items-center justify-center shrink-0 text-white text-xs font-bold"
                style={{
                  border: `2px solid ${sendWaiver && form.guest_email ? '#15803d' : '#9ca3af'}`,
                  background: sendWaiver && form.guest_email ? '#15803d' : '#fff',
                }}
              >
                {sendWaiver && form.guest_email ? '✓' : ''}
              </span>
              <span className={form.guest_email ? 'text-gray-700' : 'text-gray-400'}>
                {form.guest_email ? 'Email liability waiver to guest' : 'No guest email — sign in person after booking'}
              </span>
            </div>
          )}
          <button
            onClick={() => { if (paidCents === 0) { setConfirmZero(true) } else { onComplete() } }}
            disabled={saving}
            className="w-full mt-4 px-5 py-2.5 text-sm rounded-lg bg-green-700 text-white hover:bg-green-800 disabled:opacity-50"
          >
            {saving ? 'Saving…' : 'Complete booking'}
          </button>
          {settings?.pos_enabled && (
            <button
              onClick={() => setShowPOS((v: boolean) => !v)}
              className="w-full mt-2 px-5 py-2.5 text-sm rounded-lg border bg-[#EAF3DE] text-[#27500A] border-[#97C459] hover:bg-[#e0eecf]"
            >
              {showPOS ? 'Done adding items' : '+ Add store items'}
            </button>
          )}
          <button onClick={() => setStep((s: Step) => (Math.max(1, s - 1) as Step))} className="w-full mt-2 px-5 py-2 text-sm rounded-lg text-gray-500">Back</button>
          {confirmZero && (
            <div
              className="fixed inset-0 z-50 flex items-center justify-center px-4"
              style={{ background: 'rgba(0,0,0,0.45)' }}
              onClick={() => setConfirmZero(false)}
            >
              <div
                className="rounded-2xl p-6 shadow-xl"
                style={{ background: '#FBF7EE', border: '1px solid #ECE3D2', width: '100%', maxWidth: 360 }}
                onClick={e => e.stopPropagation()}
              >
                <div className="text-lg font-semibold text-gray-800 mb-1.5">No payment today?</div>
                <p className="text-sm text-gray-600 mb-1">
                  You're recording <span className="font-semibold">$0.00</span> paid today.
                </p>
                <p className="text-sm text-gray-600 mb-5">
                  The full <span className="font-semibold">{money(grandTotal)}</span> will carry to the folio as balance due. Is that right?
                </p>
                <button
                  onClick={() => { setConfirmZero(false); onComplete() }}
                  disabled={saving}
                  className="w-full px-5 py-2.5 text-sm rounded-lg bg-green-700 text-white hover:bg-green-800 disabled:opacity-50 mb-2"
                >
                  {saving ? 'Saving…' : 'Yes — nothing paid today'}
                </button>
                <button
                  onClick={() => setConfirmZero(false)}
                  className="w-full px-5 py-2.5 text-sm rounded-lg border bg-white text-gray-700 hover:bg-gray-50"
                  style={{ borderColor: '#ECE3D2' }}
                >
                  Go back — enter an amount
                </button>
              </div>
            </div>
          )}
        </>
      ) : (
        <>
          <div className="flex justify-between items-baseline">
            <span className="text-[13px] text-gray-600">Cash total</span>
            <span className="text-2xl font-semibold">{money(cash)}</span>
          </div>
          {cash > 0 && pricing.cardSurchargePercent > 0 && (
            <div className="text-xs text-gray-400 mt-1 text-right">+{pricing.cardSurchargePercent}% ({money(fee)}) on card = {money(cash + fee)}</div>
          )}
          <div className="flex gap-2 mt-4">
            <button
              onClick={() => setStep((s: Step) => (Math.max(1, s - 1) as Step))}
              disabled={step === 1}
              className="px-4 py-2 text-sm rounded-lg border border-gray-200 disabled:opacity-40"
            >
              Back
            </button>
            <button
              onClick={() => setStep((s: Step) => (Math.min(4, s + 1) as Step))}
              disabled={continueDisabled}
              className="flex-1 px-5 py-2 text-sm rounded-lg bg-green-700 text-white hover:bg-green-800 disabled:opacity-40"
            >
              Continue
            </button>
          </div>
        </>
      )}
    </div>
  )
}

function Line({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex justify-between text-[13px] mb-1.5">
      <span className="text-gray-400">{k}</span>
      <span className="font-medium">{v}</span>
    </div>
  )
}

function StepGuest({ form, set, guests }: any) {
  const [q, setQ] = useState('')
  const matches = q.trim().length >= 2
    ? guests.filter((g: any) =>
        `${g.name || ''} ${g.email || ''} ${g.phone || ''}`.toLowerCase().includes(q.trim().toLowerCase()),
      ).slice(0, 6)
    : []

  function pick(g: any) {
    const parts = (g.name || '').trim().split(/\s+/)
    set({
      guest_first: parts[0] || '',
      guest_last: parts.slice(1).join(' '),
      guest_email: g.email || '',
      guest_phone: g.phone || '',
    })
    setQ('')
  }

  const adj = (field: 'num_adults' | 'num_children', d: number) => {
    const min = field === 'num_adults' ? 1 : 0
    set({ [field]: Math.max(min, (form[field] as number) + d) } as any)
  }

  return (
    <div>
      <label className="block mb-1 text-[13px] text-gray-600">Returning guest?</label>
      <div className="relative mb-2">
        <input
          value={q}
          onChange={e => setQ(e.target.value)}
          placeholder="Search by name, phone, or email"
          className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm"
        />
        {matches.length > 0 && (
          <div className="absolute z-10 left-0 right-0 mt-1 bg-white border border-gray-200 rounded-lg shadow-sm overflow-hidden">
            {matches.map((g: any) => (
              <button
                key={g.id}
                onClick={() => pick(g)}
                className="w-full text-left px-3 py-2 hover:bg-gray-50 border-b border-gray-50 last:border-0"
              >
                <div className="text-sm">{g.name}</div>
                <div className="text-xs text-gray-400">
                  {[g.email, g.phone].filter(Boolean).join(' · ')}
                  {g.last_visit ? ` · last stay ${new Date(g.last_visit + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', year: 'numeric' })}` : ''}
                </div>
              </button>
            ))}
          </div>
        )}
      </div>
      <div className="text-xs text-gray-400 mb-5">Pulls from your guest directory — including hand-entered seasonals.</div>

      <div className="grid grid-cols-2 gap-3 mb-3.5">
        <label className="block">
          <span className="text-[13px] text-gray-600 block mb-1">First name</span>
          <input value={form.guest_first} onChange={e => set({ guest_first: e.target.value })} className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm" />
        </label>
        <label className="block">
          <span className="text-[13px] text-gray-600 block mb-1">Last name</span>
          <input value={form.guest_last} onChange={e => set({ guest_last: e.target.value })} className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm" />
        </label>
      </div>
      <div className="grid grid-cols-2 gap-3 mb-5">
        <label className="block">
          <span className="text-[13px] text-gray-600 block mb-1">Email</span>
          <input type="email" value={form.guest_email} onChange={e => set({ guest_email: e.target.value })} className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm" />
        </label>
        <label className="block">
          <span className="text-[13px] text-gray-600 block mb-1">Phone</span>
          <input type="tel" value={form.guest_phone} onChange={e => set({ guest_phone: e.target.value })} className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm" />
        </label>
      </div>

      <div className="flex gap-6 items-end">
        <div>
          <span className="text-[13px] text-gray-600 block mb-1.5">Adults</span>
          <Qty value={form.num_adults} onMinus={() => adj('num_adults', -1)} onPlus={() => adj('num_adults', 1)} />
        </div>
        <div>
          <span className="text-[13px] text-gray-600 block mb-1.5">Children</span>
          <Qty value={form.num_children} onMinus={() => adj('num_children', -1)} onPlus={() => adj('num_children', 1)} />
        </div>
      </div>
    </div>
  )
}

function Qty({ value, onMinus, onPlus }: { value: number; onMinus: () => void; onPlus: () => void }) {
  return (
    <div className="inline-flex items-center border border-gray-200 rounded-lg overflow-hidden">
      <button onClick={onMinus} className="w-9 h-9 text-lg hover:bg-gray-50">−</button>
      <span className="w-10 text-center text-sm font-medium">{value}</span>
      <button onClick={onPlus} className="w-9 h-9 text-lg hover:bg-gray-50">+</button>
    </div>
  )
}

function StepAddons({ form, set, addons, settings }: any) {
  const setQty = (id: string, qty: number) =>
    set({ selectedAddons: { ...form.selectedAddons, [id]: Math.max(0, qty) } })

  return (
    <div>
      <div className="text-[13px] font-medium text-gray-600 mb-2.5">Add-ons</div>
      {addons.length === 0 ? (
        <div className="text-sm text-gray-400 mb-4">No add-ons configured.</div>
      ) : (
        <div className="flex flex-col gap-2">
          {addons.map((a: any) => {
            const qty = form.selectedAddons[a.id] || 0
            return (
              <div key={a.id} className="flex items-center gap-3 px-3.5 py-2.5 border border-gray-200 rounded-lg">
                <div className="flex-1">
                  <div className="text-sm">{a.name}</div>
                  <div className="text-xs text-gray-400">{a.description ? `${a.description} · ` : ''}{money(a.price)}</div>
                </div>
                <Qty value={qty} onMinus={() => setQty(a.id, qty - 1)} onPlus={() => setQty(a.id, qty + 1)} />
              </div>
            )
          })}
        </div>
      )}

      {(settings?.early_checkin_enabled || settings?.late_checkout_enabled) && (
        <>
          <div className="text-[13px] font-medium text-gray-600 mt-5 mb-2.5">Check-in options</div>
          {settings?.early_checkin_enabled && (
            <div className="flex items-center gap-3 px-3.5 py-2.5 border border-gray-200 rounded-lg mb-2">
              <div className="flex-1">
                <div className="text-sm">Early check-in</div>
                <div className="text-xs text-gray-400">{settings.early_checkin_time ? `from ${fmtTime(settings.early_checkin_time)} · ` : ''}{money(settings.early_checkin_price || 0)}</div>
              </div>
              <Toggle on={form.earlyCheckin} onClick={() => set({ earlyCheckin: !form.earlyCheckin })} />
            </div>
          )}
          {settings?.late_checkout_enabled && (
            <div className="flex items-center gap-3 px-3.5 py-2.5 border border-gray-200 rounded-lg">
              <div className="flex-1">
                <div className="text-sm">Late check-out</div>
                <div className="text-xs text-gray-400">{settings.late_checkout_time ? `until ${fmtTime(settings.late_checkout_time)} · ` : ''}{money(settings.late_checkout_price || 0)}</div>
              </div>
              <Toggle on={form.lateCheckout} onClick={() => set({ lateCheckout: !form.lateCheckout })} />
            </div>
          )}
        </>
      )}
    </div>
  )
}

function Toggle({ on, onClick }: { on: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      aria-pressed={on}
      className={`relative w-10 h-6 rounded-full transition-colors shrink-0 ${on ? 'bg-green-600' : 'bg-gray-300'}`}
    >
      <span className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white transition-transform ${on ? 'translate-x-4' : ''}`} />
    </button>
  )
}

function StepReview({ form, set, pricing, settings, effectiveTotal, grandTotal, products, productCategories, posCart, setPosCart, showPOS, setShowPOS }: any) {
  const paidCents = form.amount_paid ? Math.round(parseFloat(form.amount_paid) * 100) : 0
  const setPaid = (cents: number) => set({ amount_paid: (cents / 100).toFixed(2) })
  const [activeCat, setActiveCat] = useState('')

  function addToCart(product: any, unitPrice: number) {
    setPosCart((cart: any[]) => {
      const i = cart.findIndex((e) => e.product_id === product.id && e.unit_price === unitPrice)
      if (i >= 0) {
        const next = [...cart]
        next[i] = { ...next[i], quantity: next[i].quantity + 1 }
        return next
      }
      return [...cart, { product_id: product.id, description: product.name, unit_price: unitPrice, quantity: 1, tax_class: product.tax_class, category: product.category }]
    })
  }
  const setQty = (idx: number, q: number) =>
    setPosCart((cart: any[]) => q <= 0 ? cart.filter((_, i) => i !== idx) : cart.map((e, i) => i === idx ? { ...e, quantity: q } : e))
  const methods = [
    { k: 'cash', label: 'Cash' },
    { k: 'card', label: 'Card' },
    { k: 'check', label: 'Check' },
    { k: 'terminal', label: 'Terminal' },
  ]
  return (
    <div>
      <div className="text-[13px] font-medium text-gray-600 mb-2.5">Charges</div>
      <div className="border border-gray-200 rounded-lg p-3.5 mb-5 text-sm">
        {pricing?.lines?.length ? pricing.lines.map((l: any, i: number) => (
          <div key={i} className="flex justify-between mb-1.5 last:mb-0">
            <span className="text-gray-600">{l.label}</span><span>{money(l.amount)}</span>
          </div>
        )) : <div className="text-gray-400">No charges yet.</div>}
        {posCart.map((e: any, i: number) => (
          <div key={`c-${i}`} className="flex justify-between items-center mt-1.5">
            <span className="text-gray-600 flex-1">{e.description}</span>
            <Qty value={e.quantity} onMinus={() => setQty(i, e.quantity - 1)} onPlus={() => setQty(i, e.quantity + 1)} />
            <span className="w-16 text-right">{money(posLineTotal(e))}</span>
          </div>
        ))}
      </div>

      {showPOS && (
        <div className="border border-gray-200 rounded-lg p-3.5 mb-5">
          <div className="flex items-center justify-between mb-2.5">
            <div className="text-[13px] font-medium text-gray-600">Store items</div>
            <button onClick={() => setShowPOS(false)} className="text-xs text-gray-400 underline">done</button>
          </div>
          <div className="flex gap-1.5 flex-wrap mb-3">
            {productCategories.map((cat: string) => (
              <button key={cat} onClick={() => setActiveCat(cat)}
                className={`px-2.5 py-1 text-xs rounded-full border ${activeCat === cat ? 'border-green-600 bg-green-50 text-green-800' : 'border-gray-200 text-gray-500 hover:bg-gray-50'}`}>
                {cat}
              </button>
            ))}
          </div>
          {activeCat ? (
            <div className="grid grid-cols-2 gap-2">
              {products.filter((p: any) => p.category === activeCat).map((prod: any) => {
                const idx = posCart.findIndex((e: any) => e.product_id === prod.id && e.unit_price === prod.price)
                return (
                  <ProductTile
                    key={prod.id}
                    product={prod}
                    onAdd={addToCart}
                    cartQty={idx >= 0 ? posCart[idx].quantity : 0}
                    onMinus={() => { if (idx >= 0) setQty(idx, posCart[idx].quantity - 1) }}
                  />
                )
              })}
              {products.filter((p: any) => p.category === activeCat).length === 0 && (
                <div className="text-xs text-gray-400 col-span-2">No products in this category.</div>
              )}
            </div>
          ) : (
            <div className="text-xs text-gray-400">Pick a category to see products.</div>
          )}
        </div>
      )}

      <div className="rounded-xl border-2 p-4 mb-2" style={{ borderColor: '#ECE3D2', background: '#FBF7EE' }}>
      <div className="text-[13px] font-semibold text-gray-700 mb-2.5">Payment</div>
      <label className="text-[13px] text-gray-600 block mb-1">Amount paid today</label>
      <div className="flex items-center gap-2 flex-wrap mb-2">
        <input type="number" value={form.amount_paid} onChange={e => set({ amount_paid: e.target.value })} placeholder="0.00" className="w-28 border border-gray-300 rounded-lg px-3 py-2 text-sm bg-white" />
        <button onClick={() => setPaid(pricing?.deposit || 0)} className="px-3 py-1.5 text-xs rounded-lg border border-gray-200 bg-white hover:bg-gray-50">{pricing?.depositLabel || 'Deposit'} · {money(pricing?.deposit || 0)}</button>
        <button onClick={() => setPaid(grandTotal)} className="px-3 py-1.5 text-xs rounded-lg border border-gray-200 bg-white hover:bg-gray-50">Full · {money(grandTotal)}</button>
        <button onClick={() => setPaid(0)} className="px-3 py-1.5 text-xs rounded-lg border border-gray-200 bg-white hover:bg-gray-50">None</button>
      </div>
      <div className="text-xs text-gray-400 mb-4">Deposit options come from your settings.</div>

      <label className="text-[13px] text-gray-600 block mb-1.5">Method</label>
      <div className="flex gap-2 mb-3">
        {methods.map(m => (
          <button key={m.k} onClick={() => set({ payment_method: m.k })}
            className={`flex-1 py-2 text-sm rounded-lg border ${form.payment_method === m.k ? 'border-2 border-green-600 bg-green-50 text-green-800' : 'border-gray-200 bg-white hover:bg-gray-50'}`}>
            {m.label}
          </button>
        ))}
      </div>
      {form.payment_method === 'card' && (
        <div className="mb-3">
          <div id="wizard-card" className="border border-gray-200 rounded-lg p-3 min-h-[44px]"></div>
          {paidCents > 0 && (
            <div className="text-xs text-gray-500 mt-2">
              Card charge: {money(paidCents)} + {pricing.cardSurchargePercent}% ({money(pricing.cardSurcharge(paidCents))}) = <span className="font-medium text-gray-900">{money(paidCents + pricing.cardSurcharge(paidCents))}</span>
            </div>
          )}
        </div>
      )}
      {form.payment_method === 'terminal' && (
        <div className="text-xs bg-gray-50 rounded-lg px-3 py-2.5 mb-3 text-gray-600">
          {paidCents > 0 ? (
            <>Terminal charge: {money(paidCents)} + {pricing.cardSurchargePercent}% ({money(pricing.cardSurcharge(paidCents))}) = <span className="font-medium text-gray-900">{money(paidCents + pricing.cardSurcharge(paidCents))}</span>. On complete, this is sent to your Square Terminal for the customer to tap.</>
          ) : (
            'Enter an amount to send to the Terminal.'
          )}
        </div>
      )}
      </div>
    </div>
  )
}

function ProductTile({ product, onAdd, cartQty, onMinus }: { product: any; onAdd: (p: any, unitPrice: number) => void; cartQty: number; onMinus: () => void }) {
  const [price, setPrice] = useState('')
  if (product.variable_price) {
    return (
      <div className="border border-gray-200 rounded-lg p-2.5">
        <div className="text-sm mb-1.5">{product.name}{cartQty > 0 ? ` · ${cartQty} added` : ''}</div>
        <div className="flex items-center gap-1.5">
          <span className="text-xs text-gray-400">$</span>
          <input type="number" value={price} onChange={e => setPrice(e.target.value)} placeholder="0.00" className="w-16 border border-gray-200 rounded px-2 py-1 text-sm" />
          <button
            onClick={() => { const c = Math.round(parseFloat(price) * 100); if (c > 0) { onAdd(product, c); setPrice('') } }}
            className="text-xs text-green-700 font-medium px-1.5 py-1"
          >
            add
          </button>
        </div>
      </div>
    )
  }
  if (cartQty > 0) {
    return (
      <div className="border-2 border-green-600 bg-green-50 rounded-lg p-2.5 flex items-center gap-2">
        <div className="flex-1 min-w-0">
          <div className="text-sm truncate">{product.name}</div>
          <div className="text-xs text-gray-400 mt-0.5">{money(product.price)}</div>
        </div>
        <div className="inline-flex items-center border border-gray-200 bg-white rounded-lg overflow-hidden shrink-0">
          <button onClick={onMinus} className="w-8 h-8 text-lg hover:bg-gray-50">−</button>
          <span className="w-7 text-center text-sm font-medium">{cartQty}</span>
          <button onClick={() => onAdd(product, product.price)} className="w-8 h-8 text-lg hover:bg-gray-50">+</button>
        </div>
      </div>
    )
  }
  return (
    <button onClick={() => onAdd(product, product.price)} className="border border-gray-200 rounded-lg p-2.5 text-left hover:bg-gray-50">
      <div className="text-sm">{product.name}</div>
      <div className="text-xs text-gray-400 mt-0.5">{money(product.price)}</div>
    </button>
  )
}
