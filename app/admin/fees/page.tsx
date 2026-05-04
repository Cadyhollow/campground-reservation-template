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

const APPLIES_TO_OPTIONS = [
  { value: 'rv_site', label: 'RV Sites' },
  { value: 'cabin', label: 'Cabins' },
  { value: 'tent', label: 'Tent Sites' },
  { value: 'yurt', label: 'Yurts' },
  { value: 'tiny_home', label: 'Tiny Homes' },
  { value: 'lodge', label: 'Lodge Rooms' },
  { value: 'glamping', label: 'Glamping' },
  { value: 'treehouse', label: 'Treehouses' },
  { value: 'addons', label: 'Add-On Items' },
]

function formatAppliesTo(applies_to: string): string {
  if (applies_to === 'all') return 'All sites + add-ons'
  return applies_to.split(',').map(v => {
    const opt = APPLIES_TO_OPTIONS.find(o => o.value === v.trim())
    return opt ? opt.label : v.trim()
  }).join(', ')
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
    applies_to_all: true,
    applies_to_selections: [] as string[],
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
    setForm({ name: '', type: 'percentage', amount: '', applies_to_all: true, applies_to_selections: [], is_active: true })
    setShowForm(true)
  }

  function openEditForm(fee: Fee) {
    setEditingFee(fee)
    const isAll = fee.applies_to === 'all'
    setForm({
      name: fee.name,
      type: fee.type,
      amount: String(fee.amount),
      applies_to_all: isAll,
      applies_to_selections: isAll ? [] : fee.applies_to.split(',').map(s => s.trim()),
      is_active: fee.is_active,
    })
    setShowForm(true)
  }

  function toggleSelection(value: string) {
    setForm(prev => ({
      ...prev,
      applies_to_selections: prev.applies_to_selections.includes(value)
        ? prev.applies_to_selections.filter(v => v !== value)
        : [...prev.applies_to_selections, value]
    }))
  }

  async function saveFee() {
    if (!form.name || !form.amount) { toast.error('Please fill in all fields.'); return }
    if (!form.applies_to_all && form.applies_to_selections.length === 0) {
      toast.error('Please select at least one option for Applies To.'); return
    }
    const applies_to = form.applies_to_all ? 'all' : form.applies_to_selections.join(',')
    const payload = {
      name: form.name,
      type: form.type,
      amount: parseFloat(form.amount),
      applies_to,
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

          <div className="space-y-4">
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
              <label className="block text-sm font-medium text-gray-700 mb-2">Applies To</label>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '12px' }}>
                <input
                  type="checkbox"
                  id="applies_all"
                  checked={form.applies_to_all}
                  onChange={e => setForm({ ...form, applies_to_all: e.target.checked, applies_to_selections: [] })}
                  style={{ width: '16px', height: '16px', flexShrink: 0, appearance: 'auto' as any }}
                />
                <label htmlFor="applies_all" className="text-sm font-medium text-gray-700">All sites + add-ons</label>
              </div>
              {!form.applies_to_all && (
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '8px', padding: '12px', border: '1px solid #e5e7eb', borderRadius: '8px', backgroundColor: '#f9fafb' }}>
                  {APPLIES_TO_OPTIONS.map(opt => (
                    <div key={opt.value} style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                      <input
                        type="checkbox"
                        id={opt.value}
                        checked={form.applies_to_selections.includes(opt.value)}
                        onChange={() => toggleSelection(opt.value)}
                        style={{ width: '16px', height: '16px', flexShrink: 0, appearance: 'auto' as any }}
                      />
                      <label htmlFor={opt.value} className="text-sm text-gray-700" style={{ cursor: 'pointer' }}>{opt.label}</label>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <input
                type="checkbox"
                id="is_active"
                checked={form.is_active}
                onChange={e => setForm({ ...form, is_active: e.target.checked })}
                style={{ width: '16px', height: '16px', flexShrink: 0, appearance: 'auto' as any }}
              />
              <label htmlFor="is_active" className="text-sm text-gray-700">Active (applied to bookings)</label>
            </div>
          </div>

          <div className="flex gap-3 mt-6">
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
                  <p className="text-sm text-gray-500">{formatFee(fee)} · {formatAppliesTo(fee.applies_to)}{!fee.is_active && ' · Inactive'}</p>
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