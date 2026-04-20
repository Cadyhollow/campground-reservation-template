'use client'

import { useEffect, useState } from 'react'
import { supabase } from '@/lib/supabase'
import toast, { Toaster } from 'react-hot-toast'

type Fee = {
  id: string
  name: string
  type: 'percentage' | 'flat'
  amount: number
  applies_to: string
  is_active: boolean
}

export default function FeesPage() {
  const [fees, setFees] = useState<Fee[]>([])
  const [loading, setLoading] = useState(true)
  const [showForm, setShowForm] = useState(false)
  const [editingFee, setEditingFee] = useState<Fee | null>(null)
  const [form, setForm] = useState({
    name: '',
    type: 'percentage' as 'percentage' | 'flat',
    amount: '',
    applies_to: 'all',
    is_active: true,
  })

  useEffect(() => { fetchFees() }, [])

  async function fetchFees() {
    setLoading(true)
    const { data } = await supabase.from('fees').select('*').order('created_at')
    if (data) setFees(data)
    setLoading(false)
  }

  function openAddForm() {
    setEditingFee(null)
    setForm({ name: '', type: 'percentage', amount: '', applies_to: 'all', is_active: true })
    setShowForm(true)
  }

  function openEditForm(fee: Fee) {
    setEditingFee(fee)
    setForm({ name: fee.name, type: fee.type, amount: String(fee.amount), applies_to: fee.applies_to, is_active: fee.is_active })
    setShowForm(true)
  }

  async function saveFee() {
    if (!form.name || !form.amount) { toast.error('Please fill in all fields.'); return }
    const payload = {
      name: form.name,
      type: form.type,
      amount: parseFloat(form.amount),
      applies_to: form.applies_to,
      is_active: form.is_active,
    }
    if (editingFee) {
      const { error } = await supabase.from('fees').update(payload).eq('id', editingFee.id)
      if (error) { toast.error('Error saving fee.'); return }
    } else {
      const { error } = await supabase.from('fees').insert(payload)
      if (error) { toast.error('Error adding fee.'); return }
    }
    toast.success('Fee saved!')
    setShowForm(false)
    fetchFees()
  }

  async function toggleFee(fee: Fee) {
    await supabase.from('fees').update({ is_active: !fee.is_active }).eq('id', fee.id)
    fetchFees()
  }

  async function deleteFee(id: string) {
    if (!confirm('Delete this fee?')) return
    await supabase.from('fees').delete().eq('id', id)
    toast.success('Fee deleted.')
    fetchFees()
  }

  function formatFee(fee: Fee) {
    return fee.type === 'percentage' ? `${fee.amount}%` : `$${fee.amount.toFixed(2)}`
  }

  return (
    <div className="p-6 max-w-3xl mx-auto">
      <Toaster />
      <div className="flex justify-between items-center mb-6">
        <h1 className="text-2xl font-bold text-gray-900">Taxes & Fees</h1>
        <button onClick={openAddForm} className="px-4 py-2 rounded-lg text-white text-sm font-medium" style={{ backgroundColor: 'var(--accent-color)' }}>
          + Add Fee
        </button>
      </div>

      {showForm && (
        <div className="bg-white rounded-2xl border border-gray-200 p-6 mb-6">
          <h2 className="text-lg font-semibold mb-4">{editingFee ? 'Edit Fee' : 'Add New Fee'}</h2>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Fee Name</label>
              <input className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm" placeholder="e.g. PA State Tax" value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Type</label>
              <select className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm" value={form.type} onChange={e => setForm({ ...form, type: e.target.value as 'percentage' | 'flat' })}>
                <option value="percentage">Percentage (%)</option>
                <option value="flat">Flat Amount ($)</option>
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Amount {form.type === 'percentage' ? '(%)' : '($)'}</label>
              <input className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm" placeholder={form.type === 'percentage' ? 'e.g. 6' : 'e.g. 10.00'} type="number" step="0.01" value={form.amount} onChange={e => setForm({ ...form, amount: e.target.value })} />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Applies To</label>
              <select className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm" value={form.applies_to} onChange={e => setForm({ ...form, applies_to: e.target.value })}>
                <option value="all">All Sites</option>
                <option value="rv_site">RV Sites Only</option>
                <option value="cabin">Cabins Only</option>
                <option value="tent">Tent Sites Only</option>
              </select>
            </div>
            <div className="flex items-center gap-2">
              <input type="checkbox" checked={form.is_active} onChange={e => setForm({ ...form, is_active: e.target.checked })} className="w-4 h-4 rounded" />
              <label className="text-sm text-gray-700">Active (applied to bookings)</label>
            </div>
          </div>
          <div className="flex gap-3 mt-4">
            <button onClick={saveFee} className="px-4 py-2 rounded-lg text-white text-sm font-medium" style={{ backgroundColor: 'var(--accent-color)' }}>Save Fee</button>
            <button onClick={() => setShowForm(false)} className="px-4 py-2 rounded-lg text-sm font-medium bg-gray-100 text-gray-700">Cancel</button>
          </div>
        </div>
      )}

      {loading ? (
        <p className="text-gray-500">Loading fees...</p>
      ) : fees.length === 0 ? (
        <div className="text-center py-12 text-gray-500">
          <p className="text-lg mb-2">No fees configured yet</p>
          <p className="text-sm">Click Add Fee to add taxes or fees to bookings.</p>
        </div>
      ) : (
        <div className="space-y-3">
          {fees.map(fee => (
            <div key={fee.id} className="bg-white rounded-2xl border border-gray-200 p-4 flex items-center justify-between">
              <div className="flex items-center gap-4">
                <div className={`w-2 h-2 rounded-full ${fee.is_active ? 'bg-green-500' : 'bg-gray-300'}`} />
                <div>
                  <p className="font-semibold text-gray-900">{fee.name}</p>
                  <p className="text-sm text-gray-500">{formatFee(fee)} · {fee.applies_to === 'all' ? 'All sites' : fee.applies_to}{!fee.is_active && ' · Inactive'}</p>
                </div>
              </div>
              <div className="flex items-center gap-2">
                <button onClick={() => toggleFee(fee)} className="px-3 py-1 rounded-lg text-xs font-medium bg-gray-100 text-gray-700">{fee.is_active ? 'Disable' : 'Enable'}</button>
                <button onClick={() => openEditForm(fee)} className="px-3 py-1 rounded-lg text-xs font-medium bg-blue-50 text-blue-700">Edit</button>
                <button onClick={() => deleteFee(fee.id)} className="px-3 py-1 rounded-lg text-xs font-medium bg-red-50 text-red-700">Delete</button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
