'use client'

import { useEffect, useState } from 'react'
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

export default function ManualBookingPage() {
  const [sites, setSites] = useState<Site[]>([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [fees, setFees] = useState<{name:string,type:string,amount:number,applies_to:string}[]>([])
  const [form, setForm] = useState({
    site_id: '',
    arrival_date: '',
    departure_date: '',
    num_adults: 2,
    num_children: 0,
    guest_name: '',
    guest_email: '',
    guest_phone: '',
    payment_type: 'full',
    amount_paid: '',
    notes: '',
  })

  useEffect(() => { fetchSites() }, [])

  async function fetchSites() {
    const { data } = await supabase
      .from('sites')
      .select('*')
      .eq('is_available', true)
      .order('display_order')
    setSites(data || [])
    setLoading(false)
  }

  const selectedSite = sites.find(s => s.id === form.site_id)

  const nights = form.arrival_date && form.departure_date
    ? Math.round((new Date(form.departure_date).getTime() - new Date(form.arrival_date).getTime()) / (1000 * 60 * 60 * 24))
    : 0

  const baseTotal = selectedSite ? selectedSite.base_rate * nights : 0
  const extraAdults = Math.max(0, form.num_adults - 2)
  const extraChildren = Math.max(0, form.num_children - 2)
  const extraGuestFee = (extraAdults * 1000 + extraChildren * 500) * nights
  const applicableFees = selectedSite ? fees.filter(f => f.applies_to === 'all' || f.applies_to === selectedSite.site_type) : []
  const feesTotal = applicableFees.reduce((sum, f) => sum + (f.type === 'percentage' ? (baseTotal / 100) * f.amount / 100 : f.amount) * 100, 0)
  const total = baseTotal + extraGuestFee + feesTotal

  // Fetch fees on load
  if (fees.length === 0) { supabase.from('fees').select('*').eq('is_active', true).then(({data}) => { if (data) setFees(data) }) }

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
        base_nightly_rate: selectedSite?.base_rate || 0,
        extra_guest_fee_total: extraGuestFee,
        total_price: total,
        amount_paid: amountPaid,
        payment_type: form.payment_type,
        notes: form.notes,
      }),
    })

    const data = await response.json()

    if (!response.ok || !data.success) {
      toast.error(data.error || 'Error saving reservation.')
      setSaving(false)
      return
    }

    // Send confirmation email
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
          totalPrice: total,
          amountPaid: amountPaid,
          paymentType: form.payment_type,
          confirmationNumber: data.confirmationNumber,
        }),
      })
    } catch (e) {
      console.error('Email failed:', e)
    }

    toast.success(`Reservation created! Confirmation #${data.confirmationNumber}`)
    setSaving(false)
    setForm({
      site_id: '',
      arrival_date: '',
      departure_date: '',
      num_adults: 2,
      num_children: 0,
      guest_name: '',
      guest_email: '',
      guest_phone: '',
      payment_type: 'full',
      amount_paid: '',
      notes: '',
    })
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
              <div className="md:col-span-2">
                <label className="block text-sm font-medium text-gray-700 mb-1">Site *</label>
                <select
                  className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm"
                  value={form.site_id}
                  onChange={e => setForm({ ...form, site_id: e.target.value })}
                >
                  <option value="">Select a site...</option>
                  {sites.map(site => (
                    <option key={site.id} value={site.id}>
                      {siteTypeLabel(site.site_type)} {site.site_number} — ${(site.base_rate / 100).toFixed(2)}/night
                      {site.site_type === 'rv_site' ? ` · ${ampLabel(site.amp_service)} · ${hookupLabel(site.hookups)}` : ''}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Arrival Date *</label>
                <input
                  type="date"
                  className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm"
                  value={form.arrival_date}
                  onChange={e => setForm({ ...form, arrival_date: e.target.value })}
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Departure Date *</label>
                <input
                  type="date"
                  className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm"
                  value={form.departure_date}
                  onChange={e => { if (form.arrival_date && e.target.value && e.target.value <= form.arrival_date) { toast.error('Departure must be after arrival date.'); return; } setForm({ ...form, departure_date: e.target.value }) }}
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Adults</label>
                <input
                  type="number"
                  min="1"
                  className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm"
                  value={form.num_adults}
                  onChange={e => setForm({ ...form, num_adults: parseInt(e.target.value) })}
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Children</label>
                <input
                  type="number"
                  min="0"
                  className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm"
                  value={form.num_children}
                  onChange={e => setForm({ ...form, num_children: parseInt(e.target.value) })}
                />
              </div>
            </div>
          </div>

          {/* Guest Info */}
          <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-6">
            <h3 className="text-lg font-semibold text-gray-900 mb-4">Guest Information</h3>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="md:col-span-2">
                <label className="block text-sm font-medium text-gray-700 mb-1">Full Name *</label>
                <input
                  className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm"
                  placeholder="Jane Smith"
                  value={form.guest_name}
                  onChange={e => setForm({ ...form, guest_name: e.target.value })}
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Email *</label>
                <input
                  type="email"
                  className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm"
                  placeholder="jane@email.com"
                  value={form.guest_email}
                  onChange={e => setForm({ ...form, guest_email: e.target.value })}
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Phone</label>
                <input
                  type="tel"
                  className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm"
                  placeholder="(555) 555-5555"
                  value={form.guest_phone}
                  onChange={e => setForm({ ...form, guest_phone: e.target.value })}
                />
              </div>
            </div>
          </div>

          {/* Payment */}
          <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-6">
            <h3 className="text-lg font-semibold text-gray-900 mb-4">Payment</h3>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Payment Type</label>
                <select
                  className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm"
                  value={form.payment_type}
                  onChange={e => setForm({ ...form, payment_type: e.target.value })}
                >
                  <option value="full">Paid in Full</option>
                  <option value="deposit">Deposit Only</option>
                  <option value="unpaid">Pay on Arrival</option>
                </select>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Amount Paid ($)</label>
                <input
                  type="number"
                  className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm"
                  placeholder="0.00"
                  value={form.amount_paid}
                  onChange={e => setForm({ ...form, amount_paid: e.target.value })}
                />
              </div>
              <div className="md:col-span-2">
                <label className="block text-sm font-medium text-gray-700 mb-1">Internal Notes</label>
                <textarea
                  className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm"
                  rows={3}
                  placeholder="Any notes about this booking..."
                  value={form.notes}
                  onChange={e => setForm({ ...form, notes: e.target.value })}
                />
              </div>
            </div>
          </div>

          <button
            onClick={handleSave}
            disabled={saving}
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
                  <p className="font-medium text-gray-900">
                    {selectedSite ? `${siteTypeLabel(selectedSite.site_type)} ${selectedSite.site_number}` : '—'}
                  </p>
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
                  {applicableFees.map((fee, i) => (
                    <div key={i} className="flex justify-between text-gray-600">
                      <span>{fee.name}</span>
                      <span>${(fee.type === "percentage" ? (baseTotal / 100) * fee.amount / 100 : fee.amount).toFixed(2)}</span>
                    </div>
                  ))}
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