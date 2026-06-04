'use client'

import { useEffect, useState, Suspense } from 'react'
import { useSearchParams } from 'next/navigation'
import { supabase } from '@/lib/supabase'
import toast, { Toaster } from 'react-hot-toast'

type Addon = {
  name: string
  quantity: number
  price_at_booking: number
}

type AvailableAddon = {
  id: string
  name: string
  description: string
  price: number
  is_active: boolean
}

type Site = {
  id: string
  site_number: string
  site_type: string
  base_rate: number
}

type Reservation = {
  id: string
  guest_name: string
  guest_email: string
  guest_phone: string
  arrival_date: string
  departure_date: string
  num_adults: number
  num_children: number
  total_price: number
  amount_paid: number
  payment_type: string
  status: string
  waiver_signed: boolean
  notes: string
  created_at: string
  site_id: string
  camper_type: string
  camper_length: number
  camper_amperage: string
  square_payment_id: string | null
  sites: { site_number: string; site_type: string } | null
}

const camperTypeLabel = (val: string) => ({
  travel_trailer: 'Travel Trailer',
  fifth_wheel: 'Fifth Wheel',
  class_a: 'Class A',
  class_c: 'Class C',
  van: 'Van',
  other: 'Other',
}[val] || val || '—')

const amperageLabel = (val: string) => val ? val.replace('amp', ' Amp') : '—'

function ReservationsPageInner() {
  const searchParams = useSearchParams()
  const [reservations, setReservations] = useState<Reservation[]>([])
  const [allSites, setAllSites] = useState<Site[]>([])
  const [bookedSiteIds, setBookedSiteIds] = useState<Set<string>>(new Set())
  const [availableAddons, setAvailableAddons] = useState<AvailableAddon[]>([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [statusFilter, setStatusFilter] = useState('all')
  const [selected, setSelected] = useState<Reservation | null>(null)
  const [selectedAddons, setSelectedAddons] = useState<Addon[]>([])
  const [notes, setNotes] = useState('')
  const [savingNotes, setSavingNotes] = useState(false)
  const [sortBy, setSortBy] = useState<'arrival_date' | 'created_at' | 'guest_name'>('arrival_date')

  // Edit mode state
  const [editing, setEditing] = useState(false)
  const [editForm, setEditForm] = useState({
    site_id: '',
    arrival_date: '',
    departure_date: '',
    num_adults: 2,
    num_children: 0,
    amount_paid: '',
    guest_email: '',
    guest_phone: '',
  })
  const [resendingEmail, setResendingEmail] = useState(false)
  const [editAddons, setEditAddons] = useState<{ [id: string]: number }>({})
  const [saving, setSaving] = useState(false)
  const [fees, setFees] = useState<{name:string,type:string,amount:number,applies_to:string}[]>([])
  const [pricingRules, setPricingRules] = useState<any[]>([])
  const [overrideTotal, setOverrideTotal] = useState(false)
  const [overrideTotalValue, setOverrideTotalValue] = useState('')
  const [showResRefund, setShowResRefund] = useState(false)
  const [resRefundAmount, setResRefundAmount] = useState('')
  const [resRefundReason, setResRefundReason] = useState('')
  const [processingResRefund, setProcessingResRefund] = useState(false)
  const [resRefundError, setResRefundError] = useState('')

  useEffect(() => {
    fetchReservations()
    fetchAllSites()
    fetchAvailableAddons()
    fetchFees()
  }, [])

  // Auto-select reservation from URL param (e.g. from calendar)
  useEffect(() => {
    const idFromUrl = searchParams.get('id')
    if (idFromUrl && reservations.length > 0) {
      const res = reservations.find(r => r.id === idFromUrl)
      if (res) selectReservation(res)
    }
  }, [searchParams, reservations])

  async function fetchReservations() {
    const today = new Date().toISOString().split('T')[0]
    const { data } = await supabase
      .from('reservations')
      .select('*, sites(site_number, site_type), square_payment_id')
      .order('arrival_date', { ascending: true })
    if (data) {
      const upcoming = data.filter(r => r.arrival_date >= today)
      const past = data.filter(r => r.arrival_date < today).reverse()
      setReservations([...upcoming, ...past])
    }
    setLoading(false)
  }

  async function fetchAllSites() {
    const { data } = await supabase.from('sites').select('*').order('display_order')
    setAllSites(data || [])
  }

  async function fetchAvailableAddons() {
    const { data } = await supabase.from('addons').select('*').eq('is_active', true).order('display_order')
    setAvailableAddons(data || [])
  }

  async function fetchFees() {
    const { data } = await supabase.from('fees').select('*').eq('is_active', true)
    setFees(data || [])
    const { data: rulesData } = await supabase.from('pricing_rules').select('*').eq('is_active', true)
    setPricingRules(rulesData || [])
  }

  async function fetchBookedSites(arrival: string, departure: string, excludeReservationId: string) {
    const { data } = await supabase
      .from('reservations')
      .select('site_id')
      .neq('status', 'cancelled')
      .neq('id', excludeReservationId)
      .lt('arrival_date', departure)
      .gt('departure_date', arrival)
    setBookedSiteIds(new Set(data?.map(r => r.site_id) || []))
  }

  async function fetchAddons(reservationId: string) {
    const { data: addonRows } = await supabase
      .from('reservation_addons')
      .select('quantity, price_at_booking, addon_id')
      .eq('reservation_id', reservationId)

    if (!addonRows || addonRows.length === 0) { setSelectedAddons([]); return }

    const addonIds = addonRows.map(r => r.addon_id)
    const { data: addonNames } = await supabase.from('addons').select('id, name').in('id', addonIds)
    const nameMap: Record<string, string> = {}
    addonNames?.forEach((a: any) => { nameMap[a.id] = a.name })

    setSelectedAddons(addonRows.map((row: any) => ({
      name: nameMap[row.addon_id] || 'Add-on',
      quantity: row.quantity,
      price_at_booking: row.price_at_booking,
    })))
  }

  async function fetchAddonsForEdit(reservationId: string) {
    const { data } = await supabase
      .from('reservation_addons')
      .select('quantity, addon_id')
      .eq('reservation_id', reservationId)
    if (data) {
      const map: { [id: string]: number } = {}
      data.forEach((row: any) => { if (row.addon_id) map[row.addon_id] = row.quantity })
      setEditAddons(map)
    } else {
      setEditAddons({})
    }
  }

  function selectReservation(res: Reservation) {
    setSelected(res)
    setNotes(res.notes || '')
    setEditing(false)
    fetchAddons(res.id)
  }

  function startEditing(res: Reservation) {
    setEditForm({
      site_id: res.site_id || '',
      arrival_date: res.arrival_date,
      departure_date: res.departure_date,
      num_adults: res.num_adults,
      num_children: res.num_children,
      amount_paid: (res.amount_paid / 100).toFixed(2),
      guest_email: res.guest_email || '',
      guest_phone: res.guest_phone || '',
    })
    fetchAddonsForEdit(res.id)
    if (res.arrival_date && res.departure_date) {
      fetchBookedSites(res.arrival_date, res.departure_date, res.id)
    }
    setOverrideTotal(false)
    setOverrideTotalValue('')
    setEditing(true)
  }

  async function handleSaveEdit() {
    if (!selected) return
    setSaving(true)

    const site = allSites.find(s => s.id === editForm.site_id)
    const nights = Math.round(
      (new Date(editForm.departure_date).getTime() - new Date(editForm.arrival_date).getTime()) / (1000 * 60 * 60 * 24)
    )
    const applicable = site ? pricingRules.filter(rule => {
      const withinDates = rule.start_date <= editForm.departure_date && rule.end_date >= editForm.arrival_date
      if (!withinDates) return false
      if (rule.site_ids) return rule.site_ids.split(',').includes(site.id)
      if (rule.site_id) return rule.site_id === site.id
      if (rule.site_type) return rule.site_type === site.site_type
      return false
    }) : []
    const bestRule = applicable.sort((a: any, b: any) => b.priority - a.priority)[0]
    const nightlyRate = site ? (bestRule ? bestRule.nightly_rate : site.base_rate) : 0
    const basePrice = site ? nightlyRate * nights : selected.total_price
    const addonTotal = Object.entries(editAddons).reduce((sum, [id, qty]) => {
      const addon = availableAddons.find(a => a.id === id)
      return sum + (addon ? addon.price * qty : 0)
    }, 0)
    const applicableFees = site ? fees.filter(f => {
      if (f.applies_to === 'all') return true
      const targets = f.applies_to.split(',').map(s => s.trim())
      return targets.includes(site.site_type)
    }) : []
    const feesTotal = applicableFees.reduce((sum, f) =>
      sum + (f.type === 'percentage' ? (basePrice / 100) * f.amount / 100 : f.amount) * 100, 0)
    const newTotal = basePrice + addonTotal + feesTotal

    const oldSite = selected.sites
    const auditNote = `[Edited ${new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}] Was: ${oldSite ? `Site ${oldSite.site_number}` : 'unknown site'}, ${selected.arrival_date} → ${selected.departure_date}, ${selected.num_adults} adults, ${selected.num_children} children`
    const existingNotes = selected.notes || ''
    const updatedNotes = existingNotes ? `${existingNotes}\n${auditNote}` : auditNote

    const finalTotal = overrideTotal && overrideTotalValue
      ? Math.round(parseFloat(overrideTotalValue) * 100)
      : newTotal

    const prevTotal = newTotal > 0 ? newTotal : selected.total_price
    const overrideNote = overrideTotal && overrideTotalValue
      ? `\n[Total overridden ${new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}] Previous total: $${(prevTotal/100).toFixed(2)} → New total: $${parseFloat(overrideTotalValue).toFixed(2)}`
      : ''

    const { error } = await supabase.from('reservations').update({
      site_id: editForm.site_id,
      arrival_date: editForm.arrival_date,
      departure_date: editForm.departure_date,
      num_adults: editForm.num_adults,
      num_children: editForm.num_children,
      total_price: finalTotal,
      amount_paid: Math.round(parseFloat(editForm.amount_paid) * 100),
      notes: updatedNotes + overrideNote,
      guest_email: editForm.guest_email,
      guest_phone: editForm.guest_phone,
    }).eq('id', selected.id)

    if (error) { toast.error('Error saving changes.'); setSaving(false); return }

    await supabase.from('reservation_addons').delete().eq('reservation_id', selected.id)
    const addonItems = Object.entries(editAddons).filter(([_, qty]) => qty > 0)
    if (addonItems.length > 0) {
      await supabase.from('reservation_addons').insert(
        addonItems.map(([addon_id, quantity]) => {
          const addon = availableAddons.find(a => a.id === addon_id)
          return { reservation_id: selected.id, addon_id, quantity, price_at_booking: addon?.price || 0 }
        })
      )
    }

    toast.success('Reservation updated!')
    setSaving(false)
    setEditing(false)
    setNotes(updatedNotes)
    await fetchReservations()
    const { data } = await supabase.from('reservations').select('*, sites(site_number, site_type)').eq('id', selected.id).single()
    if (data) { setSelected(data); fetchAddons(data.id) }
  }

  async function handleResRefund() {
    if (!selected || !resRefundAmount) return
    setProcessingResRefund(true)
    setResRefundError('')

    const res = await fetch('/api/reservation-refund', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        reservationId: selected.id,
        squarePaymentId: selected.square_payment_id,
        refundAmount: parseFloat(resRefundAmount),
        reason: resRefundReason || 'Refund',
        currentAmountPaid: selected.amount_paid,
        currentNotes: selected.notes || '',
      }),
    })
    const data = await res.json()

    if (!data.success) {
      setResRefundError(data.error || 'Refund failed. Please try again.')
      setProcessingResRefund(false)
      return
    }

    toast.success('Refund recorded successfully!')
    setProcessingResRefund(false)
    setShowResRefund(false)
    setResRefundAmount('')
    setResRefundReason('')
    await fetchReservations()
    const { data: updated } = await supabase.from('reservations').select('*, sites(site_number, site_type), square_payment_id').eq('id', selected.id).single()
    if (updated) { setSelected(updated); fetchAddons(updated.id) }
  }

  async function handleCancel(res: Reservation) {
    if (!confirm(`Cancel reservation for ${res.guest_name}?\n\nThis marks it as cancelled but keeps the record in your history.`)) return
    await supabase.from('reservations').update({ status: 'cancelled' }).eq('id', res.id)
    toast.success('Reservation cancelled.')
    fetchReservations()
    setSelected(null)
  }

  async function handleDelete(res: Reservation) {
    if (!confirm(`PERMANENTLY DELETE this reservation for ${res.guest_name}?\n\nThis cannot be undone and will remove all records. Only use this for test data or duplicates.`)) return
    const secondConfirm = prompt(`Type DELETE to confirm permanently removing this reservation:`)
    if (secondConfirm !== 'DELETE') { toast.error('Deletion cancelled.'); return }
    await supabase.from('reservation_addons').delete().eq('reservation_id', res.id)
    await supabase.from('folios').delete().eq('reservation_id', res.id)
    await supabase.from('reservations').delete().eq('id', res.id)
    toast.success('Reservation permanently deleted.')
    fetchReservations()
    setSelected(null)
  }

  async function handleSaveNotes() {
    if (!selected) return
    setSavingNotes(true)
    await supabase.from('reservations').update({ notes }).eq('id', selected.id)
    toast.success('Notes saved.')
    setSavingNotes(false)
    fetchReservations()
  }

  const filtered = reservations.filter(res => {
    const matchesSearch =
      res.guest_name.toLowerCase().includes(search.toLowerCase()) ||
      res.guest_email.toLowerCase().includes(search.toLowerCase()) ||
      res.sites?.site_number.includes(search)
    const matchesStatus = statusFilter === 'all' || res.status === statusFilter
    return matchesSearch && matchesStatus
  }).sort((a, b) => {
    if (sortBy === 'arrival_date') {
      const today = new Date().toISOString().split('T')[0]
      const aUpcoming = a.arrival_date >= today
      const bUpcoming = b.arrival_date >= today
      if (aUpcoming && !bUpcoming) return -1
      if (!aUpcoming && bUpcoming) return 1
      if (aUpcoming && bUpcoming) return a.arrival_date.localeCompare(b.arrival_date)
      return b.arrival_date.localeCompare(a.arrival_date)
    }
    if (sortBy === 'created_at') return new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
    if (sortBy === 'guest_name') return a.guest_name.localeCompare(b.guest_name)
    return 0
  })

  const statusColor = (status: string) => ({
    confirmed: 'bg-green-100 text-green-700',
    cancelled: 'bg-red-100 text-red-700',
    pending: 'bg-yellow-100 text-yellow-700',
    manual: 'bg-blue-100 text-blue-700',
  }[status] || 'bg-gray-100 text-gray-700')

  const siteTypeLabel = (type: string) => ({ rv_site: 'RV', cabin: 'Cabin', tent: 'Tent', yurt: 'Yurt', tiny_home: 'Tiny Home', lodge: 'Lodge', glamping: 'Glamping', treehouse: 'Treehouse' }[type] || type)

  const nights = (res: Reservation) => {
    const a = new Date(res.arrival_date)
    const d = new Date(res.departure_date)
    return Math.round((d.getTime() - a.getTime()) / (1000 * 60 * 60 * 24))
  }

  const editNights = editForm.arrival_date && editForm.departure_date
    ? Math.round((new Date(editForm.departure_date).getTime() - new Date(editForm.arrival_date).getTime()) / (1000 * 60 * 60 * 24))
    : 0
  const editSite = allSites.find(s => s.id === editForm.site_id)
  const editNightlyRate = (() => {
    if (!editSite || !editForm.arrival_date || !editForm.departure_date) return editSite?.base_rate || 0
    const applicable = pricingRules.filter(rule => {
      const withinDates = rule.start_date <= editForm.departure_date && rule.end_date >= editForm.arrival_date
      if (!withinDates) return false
      if (rule.site_ids) return rule.site_ids.split(',').includes(editSite.id)
      if (rule.site_id) return rule.site_id === editSite.id
      if (rule.site_type) return rule.site_type === editSite.site_type
      return false
    })
    const best = applicable.sort((a: any, b: any) => b.priority - a.priority)[0]
    return best ? best.nightly_rate : editSite.base_rate
  })()
  const editBasePrice = editNightlyRate * editNights
  const editAddonTotal = Object.entries(editAddons).reduce((sum, [id, qty]) => {
    const addon = availableAddons.find(a => a.id === id)
    return sum + (addon ? addon.price * qty : 0)
  }, 0)
  const editApplicableFees = editSite ? fees.filter(f => {
    if (f.applies_to === 'all') return true
    const targets = f.applies_to.split(',').map(s => s.trim())
    return targets.includes(editSite.site_type)
  }) : []
  const editFeesTotal = editApplicableFees.reduce((sum, f) =>
    sum + (f.type === 'percentage' ? (editBasePrice / 100) * f.amount / 100 : f.amount) * 100, 0)
  const editTotal = editBasePrice + editAddonTotal + editFeesTotal

  const today = new Date().toISOString().split('T')[0]

  return (
    <div className="p-6 max-w-7xl mx-auto">
      <Toaster />
      <div className="flex items-center justify-between mb-6">
        <h2 className="text-2xl font-bold text-gray-900">Reservations</h2>
        <span className="text-sm text-gray-500">{filtered.length} reservation{filtered.length !== 1 ? 's' : ''}</span>
      </div>

      {/* Filters */}
      <div className="flex gap-3 mb-6">
        <input
          className="w-full border border-gray-200 rounded-lg px-4 py-2.5 text-sm"
          style={{ minWidth: 0, flex: '1 1 auto' }}
          placeholder="🔍  Search by name, email, or site number..."
          value={search}
          onChange={e => setSearch(e.target.value)}
        />
        <select
          className="border border-gray-200 rounded-lg px-4 py-2.5 text-sm shrink-0"
          style={{ width: '180px' }}
          value={statusFilter}
          onChange={e => setStatusFilter(e.target.value)}
        >
          <option value="all">All Statuses</option>
          <option value="confirmed">Confirmed</option>
          <option value="pending">Pending</option>
          <option value="manual">Manual</option>
          <option value="cancelled">Cancelled</option>
        </select>
        <select
          className="border border-gray-200 rounded-lg px-4 py-2.5 text-sm shrink-0"
          style={{ width: '180px' }}
          value={sortBy}
          onChange={e => setSortBy(e.target.value as any)}
        >
          <option value="arrival_date">Sort: Arrival Date</option>
          <option value="created_at">Sort: Date Booked</option>
          <option value="guest_name">Sort: Guest Name</option>
        </select>
      </div>

      <div className="flex gap-6">
        {/* Reservations List */}
        <div className="flex-1 bg-white rounded-xl shadow-sm border border-gray-100 divide-y divide-gray-50 overflow-hidden">
          {loading ? (
            <div className="text-center py-12 text-gray-400">Loading reservations...</div>
          ) : filtered.length === 0 ? (
            <div className="text-center py-12 text-gray-400">No reservations found.</div>
          ) : (
            filtered.map(res => {
              const isPast = res.arrival_date < today
              return (
                <div
                  key={res.id}
                  onClick={() => selectReservation(res)}
                  className={`px-6 py-4 cursor-pointer hover:bg-gray-50 transition-colors ${selected?.id === res.id ? 'bg-green-50 border-l-4 border-green-600' : ''} ${isPast ? 'opacity-60' : ''}`}
                >
                  <div className="flex items-center justify-between">
                    <div>
                      <p className="font-semibold text-gray-900">{res.guest_name}</p>
                      <p className="text-sm text-gray-500">
                        {siteTypeLabel(res.sites?.site_type || '')} Site {res.sites?.site_number} · {res.arrival_date} → {res.departure_date} · {nights(res)} nights
                      </p>
                    </div>
                    <div className="text-right">
                      <p className="font-semibold text-gray-900">${(res.total_price / 100).toFixed(2)}</p>
                      <span className={`text-xs px-2 py-1 rounded-full ${statusColor(res.status)}`}>
                        {res.status}
                      </span>
                    </div>
                  </div>
                </div>
              )
            })
          )}
        </div>

        {/* Detail / Edit Panel */}
        {selected && (
          <div className="w-96 bg-white rounded-xl shadow-sm border border-gray-100 p-6 sticky top-6 max-h-[calc(100vh-6rem)] overflow-y-auto">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-lg font-semibold text-gray-900">
                {editing ? 'Edit Reservation' : 'Reservation Details'}
              </h3>
              <button onClick={() => { setSelected(null); setEditing(false) }} className="text-gray-400 hover:text-gray-600">✕</button>
            </div>

            {!editing ? (
              <div className="space-y-3 text-sm">
                <div>
                  <p className="text-gray-500">Guest</p>
                  <p className="font-medium text-gray-900">{selected.guest_name}</p>
                </div>
                <div>
                  <p className="text-gray-500">Contact</p>
                  <p className="font-medium text-gray-900">{selected.guest_email}</p>
                  <p className="font-medium text-gray-900">{selected.guest_phone}</p>
                </div>
                <div>
                  <p className="text-gray-500">Site</p>
                  <p className="font-medium text-gray-900">
                    {siteTypeLabel(selected.sites?.site_type || '')} {selected.sites?.site_number}
                  </p>
                </div>
                <div>
                  <p className="text-gray-500">Dates</p>
                  <p className="font-medium text-gray-900">{selected.arrival_date} → {selected.departure_date} ({nights(selected)} nights)</p>
                </div>
                <div>
                  <p className="text-gray-500">Nightly Rate</p>
                  <p className="font-medium text-gray-900">
                    {(() => {
                      const site = allSites.find(s => s.id === selected.site_id)
                      if (!site) return '—'
                      const applicable = pricingRules.filter(rule => {
                        const withinDates = rule.start_date <= selected.departure_date && rule.end_date >= selected.arrival_date
                        if (!withinDates) return false
                        if (rule.site_ids) return rule.site_ids.split(',').includes(site.id)
                        if (rule.site_id) return rule.site_id === site.id
                        if (rule.site_type) return rule.site_type === site.site_type
                        return false
                      })
                      const best = applicable.sort((a: any, b: any) => b.priority - a.priority)[0]
                      const rate = best ? best.nightly_rate : site.base_rate
                      const isRule = !!best
                      return <>
                        ${(rate / 100).toFixed(2)}/night
                        {isRule && <span className="ml-2 text-xs text-amber-600 font-normal">(pricing rule applied)</span>}
                      </>
                    })()}
                  </p>
                </div>
                <div>
                  <p className="text-gray-500">Reservation Made</p>
                  <p className="font-medium text-gray-900">{new Date(selected.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}</p>
                </div>
                <div>
                  <p className="text-gray-500">Guests</p>
                  <p className="font-medium text-gray-900">{selected.num_adults} adults · {selected.num_children} children</p>
                </div>

                {/* Camper Info */}
                <div className="bg-blue-50 border border-blue-100 rounded-lg px-3 py-2.5">
                  <p className="text-gray-500 text-xs uppercase tracking-wide font-semibold mb-1.5">Camper Info</p>
                  <div className="space-y-1">
                    <div className="flex justify-between">
                      <span className="text-gray-500">Type</span>
                      <span className="font-medium text-gray-900">{camperTypeLabel(selected.camper_type)}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-gray-500">Length</span>
                      <span className="font-medium text-gray-900">{selected.camper_length ? `${selected.camper_length} ft` : '—'}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-gray-500">Amperage</span>
                      <span className="font-medium text-gray-900">{amperageLabel(selected.camper_amperage)}</span>
                    </div>
                  </div>
                </div>

                {selectedAddons.length > 0 && (
                  <div>
                    <p className="text-gray-500 mb-1">Add-ons</p>
                    <div className="bg-amber-50 border border-amber-100 rounded-lg px-3 py-2 space-y-1">
                      {selectedAddons.map((addon, i) => (
                        <div key={i} className="flex justify-between text-gray-800">
                          <span className="font-medium">{addon.name}{addon.quantity > 1 ? ` ×${addon.quantity}` : ''}</span>
                          <span className="text-gray-600">${((addon.price_at_booking * addon.quantity) / 100).toFixed(2)}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                <div>
                  <p className="text-gray-500">Payment</p>
                  <p className="font-medium text-gray-900">
                    ${(selected.amount_paid / 100).toFixed(2)} paid of ${(selected.total_price / 100).toFixed(2)} total
                    {selected.amount_paid < selected.total_price && (
                      <span className="ml-2 text-yellow-600 text-xs">(balance due: ${((selected.total_price - selected.amount_paid) / 100).toFixed(2)})</span>
                    )}
                  </p>
                  <p className="text-gray-500 text-xs mt-1">{selected.payment_type === 'deposit' ? 'Deposit paid' : 'Paid in full'}</p>
                </div>
                <div>
                  <p className="text-gray-500">Waiver</p>
                  <p className={`font-medium ${selected.waiver_signed ? 'text-green-600' : 'text-red-500'}`}>
                    {selected.waiver_signed ? 'Signed' : 'Not signed'}
                  </p>
                </div>
                <div>
                  <p className="text-gray-500 mb-1">Internal Notes</p>
                  <textarea
                    className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm"
                    rows={3}
                    value={notes}
                    onChange={e => setNotes(e.target.value)}
                    placeholder="Add notes visible only to staff..."
                  />
                  <button
                    onClick={handleSaveNotes}
                    disabled={savingNotes}
                    className="mt-1 text-xs bg-gray-100 text-gray-700 px-3 py-1 rounded-lg hover:bg-gray-200 disabled:opacity-50"
                  >
                    {savingNotes ? 'Saving...' : 'Save Notes'}
                  </button>
                </div>

                {selected.status !== 'cancelled' && (
                  <>
                  <div className="flex gap-2 pt-3 flex-wrap">
                    <button
                      onClick={() => startEditing(selected)}
                      className="flex-1 bg-green-700 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-green-800"
                    >
                      Edit Reservation
                    </button>
                    <button
                      onClick={() => window.location.href = '/admin/folio/' + selected.id}
                      className="flex-1 px-4 py-2 rounded-lg text-sm font-medium text-white"
                      style={{ background: '#2E6B8A', border: 'none', cursor: 'pointer' }}
                    >
                      Open Folio
                    </button>
                    <button
                      onClick={() => handleCancel(selected)}
                      className="flex-1 bg-red-50 text-red-600 px-4 py-2 rounded-lg text-sm font-medium hover:bg-red-100"
                    >
                      Cancel
                    </button>
                  </div>
                  <div className="pt-2">
                    <button
                      onClick={async () => {
                        if (!selected.guest_email) { toast.error('No email address on file.'); return }
                        setResendingEmail(true)
                        try {
                          const nights = Math.round((new Date(selected.departure_date).getTime() - new Date(selected.arrival_date).getTime()) / (1000 * 60 * 60 * 24))
                          await fetch('/api/email', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({
                              guestName: selected.guest_name,
                              guestEmail: selected.guest_email,
                              siteNumber: selected.sites?.site_number || '',
                              siteType: selected.sites?.site_type || 'rv_site',
                              arrival: selected.arrival_date,
                              departure: selected.departure_date,
                              nights,
                              adults: selected.num_adults,
                              children: selected.num_children,
                              camperType: '',
                              camperLength: 0,
                              camperAmperage: '',
                              totalPrice: selected.total_price,
                              amountPaid: selected.amount_paid,
                              paymentType: selected.payment_type,
                              confirmationNumber: selected.id.slice(0,8).toUpperCase(),
                              addonDetails: [],
                              extraGuestFee: 0,
                            }),
                          })
                          toast.success('Confirmation email resent!')
                        } catch (e) {
                          toast.error('Failed to resend email.')
                        }
                        setResendingEmail(false)
                      }}
                      disabled={resendingEmail}
                      className="w-full bg-blue-50 text-blue-700 border border-blue-200 px-4 py-2 rounded-lg text-sm font-medium hover:bg-blue-100 disabled:opacity-50"
                    >
                      {resendingEmail ? 'Sending...' : '✉️ Resend Confirmation Email'}
                    </button>
                  </div>
                  </>
                )}
                {selected.amount_paid > 0 && selected.status !== 'cancelled' && (
                  <div className="pt-2">
                    {!showResRefund ? (
                      <button
                        onClick={() => { setResRefundAmount(((selected.amount_paid * 0.9) / 100).toFixed(2)); setShowResRefund(true); setResRefundError('') }}
                        className="w-full bg-orange-50 text-orange-700 border border-orange-200 px-4 py-2 rounded-lg text-sm font-medium hover:bg-orange-100"
                      >
                        Issue Refund
                      </button>
                    ) : (
                      <div className="bg-orange-50 border border-orange-200 rounded-lg p-3 space-y-2">
                        <div className="flex items-center justify-between">
                          <span className="text-sm font-semibold text-orange-800">Issue Refund</span>
                          <span className="text-xs text-gray-500">Paid: ${(selected.amount_paid / 100).toFixed(2)}</span>
                        </div>
                        <div className="flex gap-2">
                          {[100, 90, 50].map(pct => (
                            <button key={pct} onClick={() => setResRefundAmount((selected.amount_paid * pct / 10000).toFixed(2))}
                              className="flex-1 bg-white border border-gray-200 rounded text-xs font-semibold py-1 hover:bg-gray-50">
                              {pct}%
                            </button>
                          ))}
                        </div>
                        <div className="relative">
                          <span className="absolute left-2 top-1/2 -translate-y-1/2 text-gray-400">$</span>
                          <input type="number" step="0.01" className="w-full border border-gray-200 rounded pl-6 pr-2 py-1.5 text-sm"
                            value={resRefundAmount} onChange={e => setResRefundAmount(e.target.value)} />
                        </div>
                        <input type="text" placeholder="Reason (e.g. Cancellation — outside 7 days)"
                          className="w-full border border-gray-200 rounded px-2 py-1.5 text-sm"
                          value={resRefundReason} onChange={e => setResRefundReason(e.target.value)} />
                        {selected.square_payment_id
                          ? <p className="text-xs text-green-700">✓ Will refund to card via Square</p>
                          : <p className="text-xs text-gray-500">Cash/check — return funds manually</p>}
                        {resRefundError && <p className="text-xs text-red-600">{resRefundError}</p>}
                        <div className="flex gap-2">
                          <button onClick={() => setShowResRefund(false)}
                            className="flex-1 bg-white border border-gray-200 rounded py-1.5 text-sm">Cancel</button>
                          <button onClick={handleResRefund} disabled={processingResRefund || !resRefundAmount}
                            className="flex-1 bg-red-600 text-white rounded py-1.5 text-sm font-semibold disabled:opacity-50">
                            {processingResRefund ? 'Processing...' : `Refund $${resRefundAmount}`}
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                )}
                {selected.status === 'cancelled' && (
                  <div className="pt-3">
                    <div className="text-xs text-gray-400 mb-2 text-center">This reservation is cancelled and kept for records.</div>
                    <button
                      onClick={() => handleDelete(selected)}
                      className="w-full bg-red-600 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-red-700"
                    >
                      🗑 Permanently Delete
                    </button>
                  </div>
                )}
              </div>
            ) : (
              <div className="space-y-4 text-sm">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Site</label>
                  <select
                    className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm"
                    value={editForm.site_id}
                    onChange={e => {
                      setEditForm({ ...editForm, site_id: e.target.value })
                      if (editForm.arrival_date && editForm.departure_date) {
                        fetchBookedSites(editForm.arrival_date, editForm.departure_date, selected.id)
                      }
                    }}
                  >
                    <option value="">Select a site...</option>
                    {allSites.map(site => {
                      const isBooked = bookedSiteIds.has(site.id)
                      const isCurrent = site.id === selected.site_id
                      return (
                        <option key={site.id} value={site.id}>
                          {siteTypeLabel(site.site_type)} {site.site_number} — ${((editForm.site_id === site.id ? editNightlyRate : site.base_rate) / 100).toFixed(2)}/night
                          {isCurrent ? ' (current)' : isBooked ? ' ⚠ booked' : ' ✓ available'}
                        </option>
                      )
                    })}
                  </select>
                </div>

                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">Arrival</label>
                    <input type="date" className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm"
                      value={editForm.arrival_date}
                      onChange={e => {
                        setEditForm({ ...editForm, arrival_date: e.target.value })
                        if (e.target.value && editForm.departure_date) fetchBookedSites(e.target.value, editForm.departure_date, selected.id)
                      }}
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">Departure</label>
                    <input type="date" className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm"
                      value={editForm.departure_date}
                      onChange={e => {
                        setEditForm({ ...editForm, departure_date: e.target.value })
                        if (editForm.arrival_date && e.target.value) fetchBookedSites(editForm.arrival_date, e.target.value, selected.id)
                      }}
                    />
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">Adults</label>
                    <input type="number" min="1" className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm"
                      value={editForm.num_adults} onChange={e => setEditForm({ ...editForm, num_adults: parseInt(e.target.value) })} />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">Children</label>
                    <input type="number" min="0" className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm"
                      value={editForm.num_children} onChange={e => setEditForm({ ...editForm, num_children: parseInt(e.target.value) })} />
                  </div>
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Email</label>
                  <input type="email" className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm"
                    value={editForm.guest_email} onChange={e => setEditForm({ ...editForm, guest_email: e.target.value })} />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Phone</label>
                  <input type="tel" className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm"
                    value={editForm.guest_phone} onChange={e => setEditForm({ ...editForm, guest_phone: e.target.value })} />
                </div>

                {availableAddons.length > 0 && (
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-2">Add-Ons</label>
                    <div className="space-y-2">
                      {availableAddons.map(addon => (
                        <div key={addon.id} className="flex items-center justify-between p-2 rounded-lg bg-gray-50 border border-gray-100">
                          <div>
                            <p className="font-medium text-gray-900 text-xs">{addon.name}</p>
                            <p className="text-green-700 text-xs">${(addon.price / 100).toFixed(2)}</p>
                          </div>
                          <div className="flex items-center gap-1">
                            <button onClick={() => setEditAddons(prev => ({ ...prev, [addon.id]: Math.max(0, (prev[addon.id] || 0) - 1) }))}
                              className="w-6 h-6 rounded-full bg-gray-200 text-gray-700 font-bold hover:bg-gray-300 text-xs">-</button>
                            <span className="w-5 text-center font-medium text-gray-900 text-xs">{editAddons[addon.id] || 0}</span>
                            <button onClick={() => setEditAddons(prev => ({ ...prev, [addon.id]: (prev[addon.id] || 0) + 1 }))}
                              className="w-6 h-6 rounded-full bg-green-700 text-white font-bold hover:bg-green-800 text-xs">+</button>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Amount Paid ($)</label>
                  <input type="number" className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm"
                    value={editForm.amount_paid} onChange={e => setEditForm({ ...editForm, amount_paid: e.target.value })} />
                </div>

                {editNights > 0 && editSite && (
                  <div className="bg-green-50 border border-green-100 rounded-lg p-3">
                    <div className="flex justify-between text-sm text-gray-600">
                      <span>Site ({editNights} nights)</span>
                      <span>${(editBasePrice / 100).toFixed(2)}</span>
                    </div>
                    {editAddonTotal > 0 && (
                      <div className="flex justify-between text-sm text-gray-600 mt-1">
                        <span>Add-ons</span>
                        <span>${(editAddonTotal / 100).toFixed(2)}</span>
                      </div>
                    )}
                    {editApplicableFees.map((fee, i) => (
                      <div key={i} className="flex justify-between text-sm text-gray-600 mt-1">
                        <span>{fee.name}</span>
                        <span>${(fee.type === 'percentage' ? (editBasePrice / 100) * fee.amount / 100 : fee.amount / 100).toFixed(2)}</span>
                      </div>
                    ))}
                    <div className="flex justify-between font-bold text-gray-900 border-t border-green-200 pt-2 mt-2">
                      <span>New Total</span>
                      <span>${(editTotal / 100).toFixed(2)}</span>
                    </div>
                  </div>
                )}

                {/* Override total */}
                <div className="border border-gray-200 rounded-lg p-3 bg-gray-50">
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={overrideTotal}
                      onChange={e => {
                        setOverrideTotal(e.target.checked)
                        if (e.target.checked && editNights > 0 && editSite) {
                          setOverrideTotalValue((editTotal / 100).toFixed(2))
                        } else {
                          setOverrideTotalValue('')
                        }
                      }}
                      className="w-4 h-4 accent-green-700"
                    />
                    <span className="text-sm font-medium text-gray-700">Override total price</span>
                  </label>
                  {overrideTotal && (
                    <div className="mt-2">
                      <p className="text-xs text-gray-500 mb-1">Enter the actual total (e.g. what was agreed at booking)</p>
                      <div className="relative">
                        <span className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400">$</span>
                        <input
                          type="number"
                          step="0.01"
                          min="0"
                          className="w-full border border-green-300 rounded-lg pl-7 pr-3 py-2 text-sm font-semibold"
                          value={overrideTotalValue}
                          onChange={e => setOverrideTotalValue(e.target.value)}
                        />
                      </div>
                      {overrideTotalValue && (
                        <div className="mt-2 text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded px-2 py-1.5">
                          Balance due will be: <strong>${Math.max(0, parseFloat(overrideTotalValue || '0') - parseFloat(editForm.amount_paid || '0')).toFixed(2)}</strong>
                          {' · '}An audit note will be added automatically.
                        </div>
                      )}
                    </div>
                  )}
                </div>

                <div className="flex gap-2 pt-2">
                  <button onClick={handleSaveEdit} disabled={saving}
                    className="flex-1 bg-green-700 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-green-800 disabled:opacity-50">
                    {saving ? 'Saving...' : 'Save Changes'}
                  </button>
                  <button onClick={() => setEditing(false)}
                    className="flex-1 bg-gray-100 text-gray-700 px-4 py-2 rounded-lg text-sm font-medium hover:bg-gray-200">
                    Cancel
                  </button>
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

export default function ReservationsPage() {
  return (
    <Suspense fallback={<div className="p-6 text-gray-500">Loading...</div>}>
      <ReservationsPageInner />
    </Suspense>
  )
}
