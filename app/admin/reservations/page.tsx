'use client'

import { useEffect, useState } from 'react'
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
  sites: { site_number: string; site_type: string } | null
}

export default function ReservationsPage() {
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

  // Edit mode state
  const [editing, setEditing] = useState(false)
  const [editForm, setEditForm] = useState({
    site_id: '',
    arrival_date: '',
    departure_date: '',
    num_adults: 2,
    num_children: 0,
    amount_paid: '',
  })
  const [editAddons, setEditAddons] = useState<{ [id: string]: number }>({})
  const [saving, setSaving] = useState(false)

  useEffect(() => { fetchReservations(); fetchAllSites(); fetchAvailableAddons() }, [])

  async function fetchReservations() {
    const { data } = await supabase
      .from('reservations')
      .select('*, sites(site_number, site_type)')
      .order('arrival_date', { ascending: false })
    setReservations(data || [])
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
    const { data } = await supabase
      .from('reservation_addons')
      .select('quantity, price_at_booking, addons(name)')
      .eq('reservation_id', reservationId)
    if (data) {
      setSelectedAddons(data.map((row: any) => ({
        name: row.addons?.name || 'Add-on',
        quantity: row.quantity,
        price_at_booking: row.price_at_booking,
      })))
    } else {
      setSelectedAddons([])
    }
  }

  async function fetchAddonsForEdit(reservationId: string) {
    const { data } = await supabase
      .from('reservation_addons')
      .select('quantity, addon_id, addons(name)')
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
    })
    fetchAddonsForEdit(res.id)
    if (res.arrival_date && res.departure_date) {
      fetchBookedSites(res.arrival_date, res.departure_date, res.id)
    }
    setEditing(true)
  }

  async function handleSaveEdit() {
    if (!selected) return
    setSaving(true)

    const site = allSites.find(s => s.id === editForm.site_id)
    const nights = Math.round(
      (new Date(editForm.departure_date).getTime() - new Date(editForm.arrival_date).getTime()) / (1000 * 60 * 60 * 24)
    )
    const basePrice = site ? site.base_rate * nights : selected.total_price
    const addonTotal = Object.entries(editAddons).reduce((sum, [id, qty]) => {
      const addon = availableAddons.find(a => a.id === id)
      return sum + (addon ? addon.price * qty : 0)
    }, 0)
    const newTotal = basePrice + addonTotal

    // Build audit note
    const oldSite = selected.sites
    const auditNote = `[Edited ${new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}] Was: ${oldSite ? `Site ${oldSite.site_number}` : 'unknown site'}, ${selected.arrival_date} → ${selected.departure_date}, ${selected.num_adults} adults, ${selected.num_children} children`
    const existingNotes = selected.notes || ''
    const updatedNotes = existingNotes ? `${existingNotes}\n${auditNote}` : auditNote

    // Update reservation
    const { error } = await supabase.from('reservations').update({
      site_id: editForm.site_id,
      arrival_date: editForm.arrival_date,
      departure_date: editForm.departure_date,
      num_adults: editForm.num_adults,
      num_children: editForm.num_children,
      total_price: newTotal,
      amount_paid: Math.round(parseFloat(editForm.amount_paid) * 100),
      notes: updatedNotes,
    }).eq('id', selected.id)

    if (error) { toast.error('Error saving changes.'); setSaving(false); return }

    // Update add-ons: delete existing, insert new
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
    // Refresh selected
    const { data } = await supabase.from('reservations').select('*, sites(site_number, site_type)').eq('id', selected.id).single()
    if (data) { setSelected(data); fetchAddons(data.id) }
  }

  async function handleCancel(res: Reservation) {
    if (!confirm(`Cancel reservation for ${res.guest_name}? This cannot be undone.`)) return
    await supabase.from('reservations').update({ status: 'cancelled' }).eq('id', res.id)
    toast.success('Reservation cancelled.')
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

  // Recalculate price when edit dates/site change
  const editNights = editForm.arrival_date && editForm.departure_date
    ? Math.round((new Date(editForm.departure_date).getTime() - new Date(editForm.arrival_date).getTime()) / (1000 * 60 * 60 * 24))
    : 0
  const editSite = allSites.find(s => s.id === editForm.site_id)
  const editBasePrice = editSite ? editSite.base_rate * editNights : 0
  const editAddonTotal = Object.entries(editAddons).reduce((sum, [id, qty]) => {
    const addon = availableAddons.find(a => a.id === id)
    return sum + (addon ? addon.price * qty : 0)
  }, 0)
  const editTotal = editBasePrice + editAddonTotal

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
          className="flex-1 border border-gray-200 rounded-lg px-3 py-2 text-sm"
          placeholder="Search by name, email, or site..."
          value={search}
          onChange={e => setSearch(e.target.value)}
        />
        <select
          className="border border-gray-200 rounded-lg px-3 py-2 text-sm"
          value={statusFilter}
          onChange={e => setStatusFilter(e.target.value)}
        >
          <option value="all">All Statuses</option>
          <option value="confirmed">Confirmed</option>
          <option value="pending">Pending</option>
          <option value="manual">Manual</option>
          <option value="cancelled">Cancelled</option>
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
            filtered.map(res => (
              <div
                key={res.id}
                onClick={() => selectReservation(res)}
                className={`px-6 py-4 cursor-pointer hover:bg-gray-50 transition-colors ${selected?.id === res.id ? 'bg-green-50 border-l-4 border-green-600' : ''}`}
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
            ))
          )}
        </div>

        {/* Detail / Edit Panel */}
        {selected && (
          <div className="w-96 bg-white rounded-xl shadow-sm border border-gray-100 p-6 h-fit sticky top-6">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-lg font-semibold text-gray-900">
                {editing ? 'Edit Reservation' : 'Reservation Details'}
              </h3>
              <button onClick={() => { setSelected(null); setEditing(false) }} className="text-gray-400 hover:text-gray-600">✕</button>
            </div>

            {!editing ? (
              // — VIEW MODE —
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
                  <p className="text-gray-500">Guests</p>
                  <p className="font-medium text-gray-900">{selected.num_adults} adults · {selected.num_children} children</p>
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
                  <div className="flex gap-2 pt-3">
                    <button
                      onClick={() => startEditing(selected)}
                      className="flex-1 bg-green-700 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-green-800"
                    >
                      Edit Reservation
                    </button>
                    <button
                      onClick={() => handleCancel(selected)}
                      className="flex-1 bg-red-50 text-red-600 px-4 py-2 rounded-lg text-sm font-medium hover:bg-red-100"
                    >
                      Cancel
                    </button>
                  </div>
                )}
              </div>
            ) : (
              // — EDIT MODE —
              <div className="space-y-4 text-sm">

                {/* Site */}
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
                          {siteTypeLabel(site.site_type)} {site.site_number} — ${(site.base_rate / 100).toFixed(2)}/night
                          {isCurrent ? ' (current)' : isBooked ? ' ⚠ booked' : ' ✓ available'}
                        </option>
                      )
                    })}
                  </select>
                </div>

                {/* Dates */}
                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">Arrival</label>
                    <input
                      type="date"
                      className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm"
                      value={editForm.arrival_date}
                      onChange={e => {
                        setEditForm({ ...editForm, arrival_date: e.target.value })
                        if (e.target.value && editForm.departure_date) {
                          fetchBookedSites(e.target.value, editForm.departure_date, selected.id)
                        }
                      }}
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">Departure</label>
                    <input
                      type="date"
                      className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm"
                      value={editForm.departure_date}
                      onChange={e => {
                        setEditForm({ ...editForm, departure_date: e.target.value })
                        if (editForm.arrival_date && e.target.value) {
                          fetchBookedSites(editForm.arrival_date, e.target.value, selected.id)
                        }
                      }}
                    />
                  </div>
                </div>

                {/* Guests */}
                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">Adults</label>
                    <input
                      type="number" min="1"
                      className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm"
                      value={editForm.num_adults}
                      onChange={e => setEditForm({ ...editForm, num_adults: parseInt(e.target.value) })}
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">Children</label>
                    <input
                      type="number" min="0"
                      className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm"
                      value={editForm.num_children}
                      onChange={e => setEditForm({ ...editForm, num_children: parseInt(e.target.value) })}
                    />
                  </div>
                </div>

                {/* Add-ons */}
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
                            <button
                              onClick={() => setEditAddons(prev => ({ ...prev, [addon.id]: Math.max(0, (prev[addon.id] || 0) - 1) }))}
                              className="w-6 h-6 rounded-full bg-gray-200 text-gray-700 font-bold hover:bg-gray-300 text-xs"
                            >-</button>
                            <span className="w-5 text-center font-medium text-gray-900 text-xs">{editAddons[addon.id] || 0}</span>
                            <button
                              onClick={() => setEditAddons(prev => ({ ...prev, [addon.id]: (prev[addon.id] || 0) + 1 }))}
                              className="w-6 h-6 rounded-full bg-green-700 text-white font-bold hover:bg-green-800 text-xs"
                            >+</button>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* Amount Paid */}
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Amount Paid ($)</label>
                  <input
                    type="number"
                    className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm"
                    value={editForm.amount_paid}
                    onChange={e => setEditForm({ ...editForm, amount_paid: e.target.value })}
                  />
                </div>

                {/* New Total */}
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
                    <div className="flex justify-between font-bold text-gray-900 border-t border-green-200 pt-2 mt-2">
                      <span>New Total</span>
                      <span>${(editTotal / 100).toFixed(2)}</span>
                    </div>
                  </div>
                )}

                <div className="flex gap-2 pt-2">
                  <button
                    onClick={handleSaveEdit}
                    disabled={saving}
                    className="flex-1 bg-green-700 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-green-800 disabled:opacity-50"
                  >
                    {saving ? 'Saving...' : 'Save Changes'}
                  </button>
                  <button
                    onClick={() => setEditing(false)}
                    className="flex-1 bg-gray-100 text-gray-700 px-4 py-2 rounded-lg text-sm font-medium hover:bg-gray-200"
                  >
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