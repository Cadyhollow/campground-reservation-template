'use client'

import { useEffect, useState } from 'react'
import { supabase } from '@/lib/supabase'
import toast, { Toaster } from 'react-hot-toast'

type CancellationRule = {
  id: string
  name: string
  start_date: string
  end_date: string
  deposit_refundable: boolean
  refund_percent: number
  cancellation_deadline_days: number
  policy_text: string
  is_active: boolean
}

const emptyRule = {
  name: '',
  start_date: '',
  end_date: '',
  deposit_refundable: true,
  refund_percent: 90,
  cancellation_deadline_days: 7,
  policy_text: '',
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
    const { data } = await supabase.from('cancellation_rules').select('*').order('start_date')
    setRules(data || [])
    setLoading(false)
  }

  function openAddForm() { setEditingRule(null); setForm(emptyRule); setShowForm(true) }

  function openEditForm(rule: CancellationRule) {
    setEditingRule(rule)
    setForm({
      name: rule.name,
      start_date: rule.start_date,
      end_date: rule.end_date,
      deposit_refundable: rule.deposit_refundable,
      refund_percent: rule.refund_percent,
      cancellation_deadline_days: rule.cancellation_deadline_days,
      policy_text: rule.policy_text,
      is_active: rule.is_active,
    })
    setShowForm(true)
  }

  async function handleSave() {
    if (!form.name || !form.start_date || !form.end_date || !form.policy_text) {
      toast.error('Please fill in all required fields.'); return
    }
    setSaving(true)
    const payload = {
      name: form.name,
      start_date: form.start_date,
      end_date: form.end_date,
      deposit_refundable: form.deposit_refundable,
      refund_percent: form.refund_percent,
      cancellation_deadline_days: form.cancellation_deadline_days,
      policy_text: form.policy_text,
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
          <p className="text-sm text-gray-500 mt-1">Define cancellation policies for different date ranges. Higher specificity rules override the default.</p>
        </div>
        <button onClick={openAddForm} className="bg-green-700 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-green-800 shrink-0">
          + Add Rule
        </button>
      </div>

      {showForm && (
        <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-6 mb-6">
          <h3 className="text-lg font-semibold text-gray-900 mb-4">{editingRule ? 'Edit Cancellation Rule' : 'Add Cancellation Rule'}</h3>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            <div className="md:col-span-2 lg:col-span-3">
              <label className="block text-sm font-medium text-gray-700 mb-1">Rule Name *</label>
              <input className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm" placeholder="e.g. Holiday Non-Refundable, Standard Policy" value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Start Date *</label>
              <input className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm" type="date" value={form.start_date} onChange={e => setForm({ ...form, start_date: e.target.value })} />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">End Date *</label>
              <input className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm" type="date" value={form.end_date} onChange={e => setForm({ ...form, end_date: e.target.value })} />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Cancellation Deadline (days before arrival)</label>
              <input className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm" type="number" min="0" value={form.cancellation_deadline_days} onChange={e => setForm({ ...form, cancellation_deadline_days: parseInt(e.target.value) })} />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Refund Percentage (%)</label>
              <input className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm" type="number" min="0" max="100" value={form.refund_percent} onChange={e => setForm({ ...form, refund_percent: parseInt(e.target.value) })} />
            </div>
            <div className="flex flex-col gap-3 pt-2">
              <div className="flex items-center gap-3">
                <input type="checkbox" id="deposit_refundable" checked={form.deposit_refundable} onChange={e => setForm({ ...form, deposit_refundable: e.target.checked })} className="w-4 h-4 accent-green-700" />
                <label htmlFor="deposit_refundable" className="text-sm font-medium text-gray-700">Deposit is refundable</label>
              </div>
              <div className="flex items-center gap-3">
                <input type="checkbox" id="is_active_cancel" checked={form.is_active} onChange={e => setForm({ ...form, is_active: e.target.checked })} className="w-4 h-4 accent-green-700" />
                <label htmlFor="is_active_cancel" className="text-sm font-medium text-gray-700">Active</label>
              </div>
            </div>
            <div className="md:col-span-2 lg:col-span-3">
              <label className="block text-sm font-medium text-gray-700 mb-1">Policy Text (shown to customers at checkout) *</label>
              <textarea className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm" rows={3} placeholder="Describe the cancellation policy as customers will see it..." value={form.policy_text} onChange={e => setForm({ ...form, policy_text: e.target.value })} />
            </div>
          </div>
          <div className="flex gap-3 mt-4">
            <button onClick={handleSave} disabled={saving} className="bg-green-700 text-white px-6 py-2 rounded-lg text-sm font-medium hover:bg-green-800 disabled:opacity-50">{saving ? 'Saving...' : editingRule ? 'Save Changes' : 'Add Rule'}</button>
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
            <div key={rule.id} className="px-4 md:px-6 py-4 flex flex-col sm:flex-row sm:items-start gap-3">
              <div className="flex items-start gap-3 flex-1 min-w-0">
                <div className={`w-3 h-3 rounded-full mt-1 shrink-0 ${rule.is_active ? 'bg-green-500' : 'bg-gray-300'}`} />
                <div className="min-w-0">
                  <p className="font-semibold text-gray-900">{rule.name}</p>
                  <p className="text-sm text-gray-500 mt-0.5">
                    {rule.start_date} → {rule.end_date} · Cancel {rule.cancellation_deadline_days}+ days out for {rule.refund_percent}% refund · Deposit {rule.deposit_refundable ? 'refundable' : 'non-refundable'}
                  </p>
                  <p className="text-sm text-gray-400 mt-1 italic">"{rule.policy_text}"</p>
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
