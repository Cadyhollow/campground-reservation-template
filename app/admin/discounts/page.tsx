'use client'

import { useEffect, useState } from 'react'
import { supabase } from '@/lib/supabase'
import toast, { Toaster } from 'react-hot-toast'

type Discount = {
  id: string
  code: string
  description: string
  discount_type: string
  discount_value: number
  valid_from: string | null
  valid_until: string | null
  max_uses: number | null
  times_used: number
  is_active: boolean
}

const emptyDiscount = {
  code: '',
  description: '',
  discount_type: 'percent',
  discount_value: '',
  valid_from: '',
  valid_until: '',
  max_uses: '',
  is_active: true,
}

export default function DiscountsPage() {
  const [discounts, setDiscounts] = useState<Discount[]>([])
  const [loading, setLoading] = useState(true)
  const [showForm, setShowForm] = useState(false)
  const [editingDiscount, setEditingDiscount] = useState<Discount | null>(null)
  const [form, setForm] = useState(emptyDiscount)
  const [saving, setSaving] = useState(false)

  useEffect(() => { fetchDiscounts() }, [])

  async function fetchDiscounts() {
    const { data } = await supabase.from('discounts').select('*').order('created_at', { ascending: false })
    setDiscounts(data || [])
    setLoading(false)
  }

  function openAddForm() { setEditingDiscount(null); setForm(emptyDiscount); setShowForm(true) }

  function openEditForm(discount: Discount) {
    setEditingDiscount(discount)
    setForm({
      code: discount.code,
      description: discount.description || '',
      discount_type: discount.discount_type,
      discount_value: discount.discount_type === 'flat' ? (discount.discount_value / 100).toString() : discount.discount_value.toString(),
      valid_from: discount.valid_from || '',
      valid_until: discount.valid_until || '',
      max_uses: discount.max_uses?.toString() || '',
      is_active: discount.is_active,
    })
    setShowForm(true)
  }

  async function handleSave() {
    if (!form.code || !form.discount_value) { toast.error('Code and discount value are required.'); return }
    setSaving(true)
    const payload = {
      code: form.code.toUpperCase(),
      description: form.description,
      discount_type: form.discount_type,
      discount_value: form.discount_type === 'flat' ? Math.round(parseFloat(form.discount_value as string) * 100) : parseInt(form.discount_value as string),
      valid_from: form.valid_from || null,
      valid_until: form.valid_until || null,
      max_uses: form.max_uses ? parseInt(form.max_uses as string) : null,
      is_active: form.is_active,
    }
    if (editingDiscount) {
      const { error } = await supabase.from('discounts').update(payload).eq('id', editingDiscount.id)
      if (error) { toast.error('Error updating discount.'); setSaving(false); return }
      toast.success('Discount updated!')
    } else {
      const { error } = await supabase.from('discounts').insert(payload)
      if (error) { toast.error('Error creating discount.'); setSaving(false); return }
      toast.success('Discount created!')
    }
    setSaving(false); setShowForm(false); fetchDiscounts()
  }

  async function handleDelete(discount: Discount) {
    if (!confirm(`Delete discount code "${discount.code}"?`)) return
    await supabase.from('discounts').delete().eq('id', discount.id)
    toast.success('Discount deleted.'); fetchDiscounts()
  }

  async function toggleActive(discount: Discount) {
    await supabase.from('discounts').update({ is_active: !discount.is_active }).eq('id', discount.id)
    toast.success(`${discount.code} ${!discount.is_active ? 'activated' : 'deactivated'}`); fetchDiscounts()
  }

  const formatValue = (discount: Discount) =>
    discount.discount_type === 'percent' ? `${discount.discount_value}% off` : `$${(discount.discount_value / 100).toFixed(2)} off`

  return (
    <div className="p-4 md:p-6 max-w-7xl mx-auto">
      <Toaster />
      <div className="flex items-center justify-between mb-6">
        <div>
          <h2 className="text-2xl font-bold text-gray-900">Discount Codes</h2>
          <p className="text-sm text-gray-500 mt-1">Create promo codes for customers to use at checkout.</p>
        </div>
        <button onClick={openAddForm} className="bg-green-700 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-green-800">+ Add Code</button>
      </div>

      {showForm && (
        <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-6 mb-6">
          <h3 className="text-lg font-semibold text-gray-900 mb-4">{editingDiscount ? 'Edit Discount Code' : 'New Discount Code'}</h3>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Code *</label>
              <input className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm uppercase" placeholder="e.g. SUMMER10" value={form.code} onChange={e => setForm({ ...form, code: e.target.value.toUpperCase() })} />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Discount Type *</label>
              <select className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm" value={form.discount_type} onChange={e => setForm({ ...form, discount_type: e.target.value })}>
                <option value="percent">Percentage (e.g. 10% off)</option>
                <option value="flat">Flat Amount (e.g. $20 off)</option>
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">{form.discount_type === 'percent' ? 'Percentage (%)' : 'Amount ($)'} *</label>
              <input className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm" placeholder={form.discount_type === 'percent' ? 'e.g. 10' : 'e.g. 20.00'} type="number" value={form.discount_value} onChange={e => setForm({ ...form, discount_value: e.target.value })} />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Valid From</label>
              <input className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm" type="date" value={form.valid_from} onChange={e => setForm({ ...form, valid_from: e.target.value })} />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Valid Until</label>
              <input className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm" type="date" value={form.valid_until} onChange={e => setForm({ ...form, valid_until: e.target.value })} />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Max Uses (blank = unlimited)</label>
              <input className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm" placeholder="e.g. 50" type="number" value={form.max_uses} onChange={e => setForm({ ...form, max_uses: e.target.value })} />
            </div>
            <div className="md:col-span-2">
              <label className="block text-sm font-medium text-gray-700 mb-1">Description (internal note)</label>
              <input className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm" placeholder="e.g. Summer 2026 promotion" value={form.description} onChange={e => setForm({ ...form, description: e.target.value })} />
            </div>
            <div className="flex items-center gap-3 pt-6">
              <input type="checkbox" id="is_active_discount" checked={form.is_active} onChange={e => setForm({ ...form, is_active: e.target.checked })} className="w-4 h-4 accent-green-700" />
              <label htmlFor="is_active_discount" className="text-sm font-medium text-gray-700">Active</label>
            </div>
          </div>
          <div className="flex gap-3 mt-4">
            <button onClick={handleSave} disabled={saving} className="bg-green-700 text-white px-6 py-2 rounded-lg text-sm font-medium hover:bg-green-800 disabled:opacity-50">{saving ? 'Saving...' : editingDiscount ? 'Save Changes' : 'Create Code'}</button>
            <button onClick={() => setShowForm(false)} className="bg-gray-100 text-gray-700 px-6 py-2 rounded-lg text-sm font-medium hover:bg-gray-200">Cancel</button>
          </div>
        </div>
      )}

      {loading ? (
        <div className="text-center py-12 text-gray-400">Loading discounts...</div>
      ) : discounts.length === 0 ? (
        <div className="bg-white rounded-xl shadow-sm border border-gray-100 px-6 py-12 text-center text-gray-400">
          No discount codes yet. Click "+ Add Code" to create your first promotion!
        </div>
      ) : (
        <div className="bg-white rounded-xl shadow-sm border border-gray-100 divide-y divide-gray-50">
          {discounts.map((discount) => (
            <div key={discount.id} className="px-4 md:px-6 py-4 flex flex-col sm:flex-row sm:items-center gap-3">
              <div className="flex items-start gap-3 flex-1 min-w-0">
                <div className={`w-3 h-3 rounded-full mt-1 shrink-0 ${discount.is_active ? 'bg-green-500' : 'bg-gray-300'}`} />
                <div className="min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <p className="font-mono font-bold text-gray-900">{discount.code}</p>
                    <span className="text-xs bg-green-100 text-green-700 px-2 py-0.5 rounded-full">{formatValue(discount)}</span>
                  </div>
                  <p className="text-sm text-gray-500">
                    {discount.description && `${discount.description} · `}
                    Used {discount.times_used}{discount.max_uses ? ` of ${discount.max_uses}` : ''} times
                    {discount.valid_until && ` · Expires ${discount.valid_until}`}
                  </p>
                </div>
              </div>
              <div className="flex items-center gap-2 flex-wrap">
                <button onClick={() => toggleActive(discount)} className={`text-xs px-3 py-1 rounded-full font-medium ${discount.is_active ? 'bg-yellow-100 text-yellow-700 hover:bg-yellow-200' : 'bg-green-100 text-green-700 hover:bg-green-200'}`}>
                  {discount.is_active ? 'Deactivate' : 'Activate'}
                </button>
                <button onClick={() => openEditForm(discount)} className="text-xs px-3 py-1 rounded-full bg-gray-100 text-gray-600 hover:bg-gray-200 font-medium">Edit</button>
                <button onClick={() => handleDelete(discount)} className="text-xs px-3 py-1 rounded-full bg-red-50 text-red-600 hover:bg-red-100 font-medium">Delete</button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
