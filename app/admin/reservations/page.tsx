'use client'

import { useEffect, useState } from 'react'
import { supabase } from '@/lib/supabase'
import toast, { Toaster } from 'react-hot-toast'

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
  sites: { site_number: string; site_type: string } | null
}

export default function ReservationsPage() {
  const [reservations, setReservations] = useState<Reservation[]>([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [statusFilter, setStatusFilter] = useState('all')
  const [selected, setSelected] = useState<Reservation | null>(null)
  const [notes, setNotes] = useState('')
  const [savingNotes, setSavingNotes] = useState(false)

  useEffect(() => {
    fetchReservations()
  }, [])

  async function fetchReservations() {
    const { data } = await supabase
      .from('reservations')
      .select('*, sites(site_number, site_type)')
      .order('arrival_date', { ascending: false })
    setReservations(data || [])
    setLoading(false)
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
                onClick={() => { setSelected(res); setNotes(res.notes || '') }}
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

        {/* Detail Panel */}
        {selected && (
          <div className="w-96 bg-white rounded-xl shadow-sm border border-gray-100 p-6 h-fit sticky top-6">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-lg font-semibold text-gray-900">Reservation Details</h3>
              <button onClick={() => setSelected(null)} className="text-gray-400 hover:text-gray-600">✕</button>
            </div>

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
            </div>

            {selected.status !== 'cancelled' && (
              <button
                onClick={() => handleCancel(selected)}
                className="mt-6 w-full bg-red-50 text-red-600 px-4 py-2 rounded-lg text-sm font-medium hover:bg-red-100"
              >
                Cancel Reservation
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  )
}