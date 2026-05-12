'use client'

import { useEffect, useState } from 'react'
import { supabase } from '@/lib/supabase'
import toast, { Toaster } from 'react-hot-toast'

type CancellationRule = {
  id: string
  name: string
  days_before_arrival: number
  refund_percentage: number
  is_active: boolean
}

const emptyRule = {
  name: '',
  days_before_arrival: 14,
  refund_percentage: 90,
  is_active: true,
}

export default function CancellationRulesPage() {
  const [rules, setRules] = useState<CancellationRule[]>([])
  const [loading, setLoading] = useState(true)
  const [showForm, setShowForm] = useState(false)
  const [editingRule, setEditingRule] = useState<CancellationRule | null>(null)
  const [form, setForm] = useState(emptyRule)
  const [saving, setSaving] = useState(false)

  useEffect(() => { fetchRules() }, [])

  async function fetchRules() {
    const { data } = await supabase.from('cancellation_rules').select('*').order('days_before_arrival', { ascending: false })
    setRules(data || [])
    setLoading(false)
  }

  function openAddForm() { setEditingRule(null); setForm(emptyRule); setShowForm(true) }

  function openEditForm(rule: CancellationRule) {
    setEditingRule(rule)
    setForm({
      name: rule.name,
      days_before_arrival: rule.days_before_arrival,
      refund_percentage: rule.refund_percentage,
      is_active: rule.is_active,
    })
    setShowForm(true)
  }

  async function handleSave() {
    if (!form.name) { toast.error('Please enter a rule name.'); return }
    setSaving(true)
    const payload = {
      name: form.name,
      days_before_arrival: form.days_before_arrival,
      refund_percentage: form.refund_percentage,
      is_active: form.is_active,
    }
    if (editingRule) {
      const { error } = await supabase.from('cancellation_rules').update(payload).eq('id', editingRule.id)
      if (error) { toast.error('Error updating rule.'); setSaving(false); return }
      toast.success('Cancellation rule updated!')
    } else {
      const { error } = await supabase.from('cancellation_rules').insert(payload)
      if (error) { toast.error('Error adding rule.'); setSaving(false); return }
      toast.success('Cancellation rule added!')
    }
    setSaving(false); setShowForm(false); fetchRules()
  }

  async function handleDelete(rule: CancellationRule) {
    if (!confirm(`Delete "${rule.name}"?`)) return
    await supabase.from('cancellation_rules').delete().eq('id', rule.id)
    toast.success('Rule deleted.'); fetchRules()
  }

  async function toggleActive(rule: CancellationRule) {
    await supabase.from('cancellation_rules').update({ is_active: !rule.is_active }).eq('id', rule.id)
    toast.success(`Rule ${!rule.is_active ? 'activated' : 'deactivated'}`); fetchRules()
  }

  return (
    <div className="p-4 md:p-6 max-w-7xl mx-auto">
      <Toaster />
      <div className="flex items-center justify-between mb-6">
        <div>
          <h2 className="text-2xl font-bold text-gray-900">Cancellation Rules</h2>
          <p className="text-sm text-gray-500 mt-1">Define cancellation policies. Rules with more days take priority.</p>
        </div>
        <button onClick={openAddForm} className="bg-green-700 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-green-800 shrink-0">
          + Add Rule
        </button>
      </div>

      {showForm && (
        <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-6 mb-6">
          <h3 className="text-lg font-semibold text-gray-900 mb-4">{editingRule ? 'Edit Cancellation Rule' : 'Add Cancellation Rule'}</h3>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div className="md:col-span-3">
              <label className="block text-sm font-medium text-gray-700 mb-1">Rule Name *</label>
              <input className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm" placeholder="e.g. Standard Cancellation, Holiday Non-Refundable" value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Days Before Arrival</label>
              <input className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm" type="number" min="0" value={form.days_before_arrival} onChange={e => setForm({ ...form, days_before_arrival: parseInt(e.target.value) })} />
              <p className="text-xs text-gray-400 mt-1">Minimum days before arrival to cancel.</p>
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Refund Percentage (%)</label>
              <input className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm" type="number" min="0" max="100" value={form.refund_percentage} onChange={e => setForm({ ...form, refund_percentage: parseInt(e.target.value) })} />
            </div>
            <div className="flex items-center gap-3 pt-6">
              <button
                type="button"
                onClick={() => setForm({ ...form, is_active: !form.is_active })}
                className="relative inline-flex h-7 w-14 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200"
                style={{ backgroundColor: form.is_active ? '#15803d' : '#d1d5db' }}
              >
                <span className="pointer-events-none inline-block h-6 w-6 transform rounded-full bg-white shadow-md transition duration-200"
                  style={{ transform: form.is_active ? 'translateX(28px)' : 'translateX(0px)' }} />
              </button>
              <label className="text-sm font-medium text-gray-700">Active</label>
            </div>
          </div>
          <div className="flex gap-3 mt-4">
            <button onClick={handleSave} disabled={saving} className="bg-green-700 text-white px-6 py-2 rounded-lg text-sm font-medium hover:bg-green-800 disabled:opacity-50">
              {saving ? 'Saving...' : editingRule ? 'Save Changes' : 'Add Rule'}
            </button>
            <button onClick={() => setShowForm(false)} className="bg-gray-100 text-gray-700 px-6 py-2 rounded-lg text-sm font-medium hover:bg-gray-200">Cancel</button>
          </div>
        </div>
      )}

      {loading ? (
        <div className="text-center py-12 text-gray-400">Loading cancellation rules...</div>
      ) : rules.length === 0 ? (
        <div className="bg-white rounded-xl shadow-sm border border-gray-100 px-6 py-12 text-center text-gray-400">
          No cancellation rules yet. Click "+ Add Rule" to create one!
        </div>
      ) : (
        <div className="bg-white rounded-xl shadow-sm border border-gray-100 divide-y divide-gray-50">
          {rules.map((rule) => (
            <div key={rule.id} className="px-4 md:px-6 py-4 flex flex-col sm:flex-row sm:items-center gap-3">
              <div className="flex items-start gap-3 flex-1 min-w-0">
                <div className={`w-3 h-3 rounded-full mt-1 shrink-0 ${rule.is_active ? 'bg-green-500' : 'bg-gray-300'}`} />
                <div className="min-w-0">
                  <p className="font-semibold text-gray-900">{rule.name}</p>
                  <p className="text-sm text-gray-500 mt-0.5">
                    Cancel {rule.days_before_arrival}+ days before arrival · {rule.refund_percentage}% refund
                  </p>
                </div>
              </div>
              <div className="flex items-center gap-2 flex-wrap shrink-0">
                <button onClick={() => toggleActive(rule)} className={`text-xs px-3 py-1 rounded-full font-medium ${rule.is_active ? 'bg-yellow-100 text-yellow-700 hover:bg-yellow-200' : 'bg-green-100 text-green-700 hover:bg-green-200'}`}>
                  {rule.is_active ? 'Deactivate' : 'Activate'}
                </button>
                <button onClick={() => openEditForm(rule)} className="text-xs px-3 py-1 rounded-full bg-gray-100 text-gray-600 hover:bg-gray-200 font-medium">Edit</button>
                <button onClick={() => handleDelete(rule)} className="text-xs px-3 py-1 rounded-full bg-red-50 text-red-600 hover:bg-red-100 font-medium">Delete</button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}