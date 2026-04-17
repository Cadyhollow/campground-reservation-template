'use client'

import { useEffect, useState } from 'react'
import { supabase } from '@/lib/supabase'
import toast, { Toaster } from 'react-hot-toast'

type Addon = {
  id: string
  name: string
  description: string
  price: number
  is_active: boolean
  is_early_checkin: boolean
  display_order: number
}

const emptyAddon = {
  name: '',
  description: '',
  price: '',
  is_active: true,
  is_early_checkin: false,
  display_order: 0,
}

export default function AddonsPage() {
  const [addons, setAddons] = useState<Addon[]>([])
  const [loading, setLoading] = useState(true)
  const [showForm, setShowForm] = useState(false)
  const [editingAddon, setEditingAddon] = useState<Addon | null>(null)
  const [form, setForm] = useState(emptyAddon)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    fetchAddons()
  }, [])

  async function fetchAddons() {
    const { data } = await supabase
      .from('addons')
      .select('*')
      .order('display_order')
    setAddons(data || [])
    setLoading(false)
  }

  function openAddForm() {
    setEditingAddon(null)
    setForm(emptyAddon)
    setShowForm(true)
  }

  function openEditForm(addon: Addon) {
    setEditingAddon(addon)
    setForm({
      name: addon.name,
      description: addon.description || '',
      price: (addon.price / 100).toString(),
      is_active: addon.is_active,
      is_early_checkin: addon.is_early_checkin,
      display_order: addon.display_order,
    })
    setShowForm(true)
  }

  async function handleSave() {
    if (!form.name || !form.price) {
      toast.error('Name and price are required.')
      return
    }
    setSaving(true)
    const payload = {
      name: form.name,
      description: form.description,
      price: Math.round(parseFloat(form.price as string) * 100),
      is_active: form.is_active,
      is_early_checkin: form.is_early_checkin,
      display_order: form.display_order,
    }

    if (editingAddon) {
      const { error } = await supabase.from('addons').update(payload).eq('id', editingAddon.id)
      if (error) { toast.error('Error updating add-on.'); setSaving(false); return }
      toast.success('Add-on updated!')
    } else {
      const { error } = await supabase.from('addons').insert(payload)
      if (error) { toast.error('Error adding add-on.'); setSaving(false); return }
      toast.success('Add-on created!')
    }

    setSaving(false)
    setShowForm(false)
    fetchAddons()
  }

  async function handleDelete(addon: Addon) {
    if (!confirm(`Delete "${addon.name}"?`)) return
    await supabase.from('addons').delete().eq('id', addon.id)
    toast.success('Add-on deleted.')
    fetchAddons()
  }

  async function toggleActive(addon: Addon) {
    await supabase.from('addons').update({ is_active: !addon.is_active }).eq('id', addon.id)
    toast.success(`${addon.name} ${!addon.is_active ? 'activated' : 'deactivated'}`)
    fetchAddons()
  }

  return (
    <div className="p-6 max-w-7xl mx-auto">
      <Toaster />
      <div className="flex items-center justify-between mb-6">
        <div>
          <h2 className="text-2xl font-bold text-gray-900">Add-Ons</h2>
          <p className="text-sm text-gray-500 mt-1">Upsell items customers can pre-order at checkout.</p>
        </div>
        <button
          onClick={openAddForm}
          className="bg-green-700 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-green-800"
        >
          + Add Item
        </button>
      </div>

      {/* Form */}
      {showForm && (
        <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-6 mb-6">
          <h3 className="text-lg font-semibold text-gray-900 mb-4">
            {editingAddon ? 'Edit Add-On' : 'New Add-On'}
          </h3>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Name *</label>
              <input
                className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm"
                placeholder="e.g. Firewood Bundle, Bag of Ice"
                value={form.name}
                onChange={e => setForm({ ...form, name: e.target.value })}
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Price ($) *</label>
              <input
                className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm"
                placeholder="e.g. 8.00"
                type="number"
                value={form.price}
                onChange={e => setForm({ ...form, price: e.target.value })}
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Display Order</label>
              <input
                className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm"
                type="number"
                value={form.display_order}
                onChange={e => setForm({ ...form, display_order: parseInt(e.target.value) })}
              />
            </div>
            <div className="md:col-span-2">
              <label className="block text-sm font-medium text-gray-700 mb-1">Description</label>
              <input
                className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm"
                placeholder="Short description shown to customers"
                value={form.description}
                onChange={e => setForm({ ...form, description: e.target.value })}
              />
            </div>
            <div className="flex flex-col gap-3 pt-2">
              <div className="flex items-center gap-3">
                <input
                  type="checkbox"
                  id="is_active_addon"
                  checked={form.is_active}
                  onChange={e => setForm({ ...form, is_active: e.target.checked })}
                  className="w-4 h-4 accent-green-700"
                />
                <label htmlFor="is_active_addon" className="text-sm font-medium text-gray-700">Active</label>
              </div>
              <div className="flex items-center gap-3">
                <input
                  type="checkbox"
                  id="is_early_checkin"
                  checked={form.is_early_checkin}
                  onChange={e => setForm({ ...form, is_early_checkin: e.target.checked })}
                  className="w-4 h-4 accent-green-700"
                />
                <label htmlFor="is_early_checkin" className="text-sm font-medium text-gray-700">This is an early check-in option</label>
              </div>
            </div>
          </div>
          <div className="flex gap-3 mt-4">
            <button
              onClick={handleSave}
              disabled={saving}
              className="bg-green-700 text-white px-6 py-2 rounded-lg text-sm font-medium hover:bg-green-800 disabled:opacity-50"
            >
              {saving ? 'Saving...' : editingAddon ? 'Save Changes' : 'Add Item'}
            </button>
            <button
              onClick={() => setShowForm(false)}
              className="bg-gray-100 text-gray-700 px-6 py-2 rounded-lg text-sm font-medium hover:bg-gray-200"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Addons List */}
      {loading ? (
        <div className="text-center py-12 text-gray-400">Loading add-ons...</div>
      ) : addons.length === 0 ? (
        <div className="bg-white rounded-xl shadow-sm border border-gray-100 px-6 py-12 text-center text-gray-400">
          No add-ons yet. Click "+ Add Item" to create your first upsell item!
        </div>
      ) : (
        <div className="bg-white rounded-xl shadow-sm border border-gray-100 divide-y divide-gray-50">
          {addons.map((addon) => (
            <div key={addon.id} className="px-6 py-4 flex items-center justify-between gap-4">
              <div className="flex items-center gap-4">
                <div className={`w-3 h-3 rounded-full ${addon.is_active ? 'bg-green-500' : 'bg-gray-300'}`} />
                <div>
                  <div className="flex items-center gap-2">
                    <p className="font-semibold text-gray-900">{addon.name}</p>
                    {addon.is_early_checkin && (
                      <span className="text-xs bg-blue-100 text-blue-700 px-2 py-0.5 rounded-full">Early Check-In</span>
                    )}
                  </div>
                  {addon.description && (
                    <p className="text-sm text-gray-500">{addon.description}</p>
                  )}
                </div>
              </div>
              <div className="flex items-center gap-3">
                <span className="text-green-700 font-semibold">${(addon.price / 100).toFixed(2)}</span>
                <button
                  onClick={() => toggleActive(addon)}
                  className={`text-xs px-3 py-1 rounded-full font-medium ${
                    addon.is_active
                      ? 'bg-yellow-100 text-yellow-700 hover:bg-yellow-200'
                      : 'bg-green-100 text-green-700 hover:bg-green-200'
                  }`}
                >
                  {addon.is_active ? 'Deactivate' : 'Activate'}
                </button>
                <button
                  onClick={() => openEditForm(addon)}
                  className="text-xs px-3 py-1 rounded-full bg-gray-100 text-gray-600 hover:bg-gray-200 font-medium"
                >
                  Edit
                </button>
                <button
                  onClick={() => handleDelete(addon)}
                  className="text-xs px-3 py-1 rounded-full bg-red-50 text-red-600 hover:bg-red-100 font-medium"
                >
                  Delete
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}