'use client'

import { useEffect, useState } from 'react'
import { supabase } from '@/lib/supabase'
import toast, { Toaster } from 'react-hot-toast'

type PricingRule = {
  id: string
  name: string
  site_id: string | null
  site_type: string | null
  start_date: string
  end_date: string
  nightly_rate: number
  priority: number
  is_active: boolean
}

type Site = {
  id: string
  site_number: string
  site_type: string
}

const emptyRule = {
  name: '',
  target: 'site_type',
  site_id: '',
  site_type: 'rv_site',
  start_date: '',
  end_date: '',
  nightly_rate: '',
  priority: 0,
  is_active: true,
}

export default function PricingPage() {
  const [rules, setRules] = useState<PricingRule[]>([])
  const [sites, setSites] = useState<Site[]>([])
  const [loading, setLoading] = useState(true)
  const [showForm, setShowForm] = useState(false)
  const [editingRule, setEditingRule] = useState<PricingRule | null>(null)
  const [form, setForm] = useState(emptyRule)
  const [saving, setSaving] = useState(false)

  useEffect(() => { fetchData() }, [])

  async function fetchData() {
    const [{ data: rulesData }, { data: sitesData }] = await Promise.all([
      supabase.from('pricing_rules').select('*').order('priority', { ascending: false }),
      supabase.from('sites').select('id, site_number, site_type').order('display_order'),
    ])
    setRules(rulesData || [])
    setSites(sitesData || [])
    setLoading(false)
  }

  function openAddForm() { setEditingRule(null); setForm(emptyRule); setShowForm(true) }

  function openEditForm(rule: PricingRule) {
    setEditingRule(rule)
    setForm({
      name: rule.name,
      target: rule.site_id ? 'site' : 'site_type',
      site_id: rule.site_id || '',
      site_type: rule.site_type || 'rv_site',
      start_date: rule.start_date,
      end_date: rule.end_date,
      nightly_rate: (rule.nightly_rate / 100).toString(),
      priority: rule.priority,
      is_active: rule.is_active,
    })
    setShowForm(true)
  }

  async function handleSave() {
    if (!form.name || !form.start_date || !form.end_date || !form.nightly_rate) {
      toast.error('Please fill in all required fields.'); return
    }
    setSaving(true)
    const payload = {
      name: form.name,
      site_id: form.target === 'site' ? form.site_id : null,
      site_type: form.target === 'site_type' ? form.site_type : null,
      start_date: form.start_date,
      end_date: form.end_date,
      nightly_rate: Math.round(parseFloat(form.nightly_rate as string) * 100),
      priority: form.priority,
      is_active: form.is_active,
    }
    if (editingRule) {
      const { error } = await supabase.from('pricing_rules').update(payload).eq('id', editingRule.id)
      if (error) { toast.error('Error updating rule.'); setSaving(false); return }
      toast.success('Pricing rule updated!')
    } else {
      const { error } = await supabase.from('pricing_rules').insert(payload)
      if (error) { toast.error('Error adding rule.'); setSaving(false); return }
      toast.success('Pricing rule added!')
    }
    setSaving(false); setShowForm(false); fetchData()
  }

  async function handleDelete(rule: PricingRule) {
    if (!confirm(`Delete pricing rule "${rule.name}"?`)) return
    await supabase.from('pricing_rules').delete().eq('id', rule.id)
    toast.success('Rule deleted.'); fetchData()
  }

  async function toggleActive(rule: PricingRule) {
    await supabase.from('pricing_rules').update({ is_active: !rule.is_active }).eq('id', rule.id)
    toast.success(`Rule ${!rule.is_active ? 'activated' : 'deactivated'}`); fetchData()
  }

  const siteTypeLabel = (type: string) => ({ rv_site: 'All RV Sites', cabin: 'All Cabins', tent: 'All Tent Sites' }[type] || type)
  const targetLabel = (rule: PricingRule) => {
    if (rule.site_id) {
      const site = sites.find(s => s.id === rule.site_id)
      return site ? `Site ${site.site_number}` : 'Specific Site'
    }
    return siteTypeLabel(rule.site_type || '')
  }

  return (
    <div className="p-4 md:p-6 max-w-7xl mx-auto">
      <Toaster />
      <div className="flex items-center justify-between mb-6">
        <div>
          <h2 className="text-2xl font-bold text-gray-900">Pricing Rules</h2>
          <p className="text-sm text-gray-500 mt-1">Override base rates for specific dates. Higher priority rules win when rules overlap.</p>
        </div>
        <button onClick={openAddForm} className="bg-green-700 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-green-800">
          + Add Rule
        </button>
      </div>

      {showForm && (
        <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-6 mb-6">
          <h3 className="text-lg font-semibold text-gray-900 mb-4">{editingRule ? 'Edit Pricing Rule' : 'Add Pricing Rule'}</h3>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            <div className="md:col-span-2 lg:col-span-3">
              <label className="block text-sm font-medium text-gray-700 mb-1">Rule Name *</label>
              <input className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm" placeholder="e.g. Fourth of July Weekend, Summer Peak" value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Apply To *</label>
              <select className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm" value={form.target} onChange={e => setForm({ ...form, target: e.target.value })}>
                <option value="site_type">All sites of a type</option>
                <option value="site">One specific site</option>
              </select>
            </div>
            {form.target === 'site_type' ? (
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Site Type *</label>
                <select className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm" value={form.site_type} onChange={e => setForm({ ...form, site_type: e.target.value })}>
                  <option value="rv_site">All RV Sites</option>
                  <option value="cabin">All Cabins</option>
                  <option value="tent">All Tent Sites</option>
                </select>
              </div>
            ) : (
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Specific Site *</label>
                <select className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm" value={form.site_id} onChange={e => setForm({ ...form, site_id: e.target.value })}>
                  <option value="">Select a site...</option>
                  {sites.map(site => (
                    <option key={site.id} value={site.id}>{site.site_type === 'rv_site' ? 'RV Site' : site.site_type === 'cabin' ? 'Cabin' : 'Tent'} {site.site_number}</option>
                  ))}
                </select>
              </div>
            )}
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Nightly Rate ($) *</label>
              <input className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm" placeholder="e.g. 75.00" type="number" value={form.nightly_rate} onChange={e => setForm({ ...form, nightly_rate: e.target.value })} />
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
              <label className="block text-sm font-medium text-gray-700 mb-1">Priority</label>
              <input className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm" type="number" placeholder="0 = lowest, 10 = highest" value={form.priority} onChange={e => setForm({ ...form, priority: parseInt(e.target.value) })} />
            </div>
            <div className="flex items-center gap-3 pt-6">
              <input type="checkbox" id="is_active_pricing" checked={form.is_active} onChange={e => setForm({ ...form, is_active: e.target.checked })} className="w-4 h-4 accent-green-700" />
              <label htmlFor="is_active_pricing" className="text-sm font-medium text-gray-700">Active</label>
            </div>
          </div>
          <div className="flex gap-3 mt-4">
            <button onClick={handleSave} disabled={saving} className="bg-green-700 text-white px-6 py-2 rounded-lg text-sm font-medium hover:bg-green-800 disabled:opacity-50">{saving ? 'Saving...' : editingRule ? 'Save Changes' : 'Add Rule'}</button>
            <button onClick={() => setShowForm(false)} className="bg-gray-100 text-gray-700 px-6 py-2 rounded-lg text-sm font-medium hover:bg-gray-200">Cancel</button>
          </div>
        </div>
      )}

      {loading ? (
        <div className="text-center py-12 text-gray-400">Loading pricing rules...</div>
      ) : rules.length === 0 ? (
        <div className="bg-white rounded-xl shadow-sm border border-gray-100 px-6 py-12 text-center text-gray-400">
          No pricing rules yet. Base rates from each site will apply. Click "Add Rule" to create holiday or seasonal pricing!
        </div>
      ) : (
        <div className="bg-white rounded-xl shadow-sm border border-gray-100 divide-y divide-gray-50">
          {rules.map((rule) => (
            <div key={rule.id} className="px-4 md:px-6 py-4 flex flex-col sm:flex-row sm:items-center gap-3">
              <div className="flex items-start gap-3 flex-1 min-w-0">
                <div className={`w-3 h-3 rounded-full mt-1 shrink-0 ${rule.is_active ? 'bg-green-500' : 'bg-gray-300'}`} />
                <div className="min-w-0">
                  <p className="font-semibold text-gray-900 truncate">{rule.name}</p>
                  <p className="text-sm text-gray-500">{targetLabel(rule)} · {rule.start_date} → {rule.end_date} · Priority {rule.priority}</p>
                  <p className="text-sm font-semibold text-green-700 mt-0.5">${(rule.nightly_rate / 100).toFixed(2)}/night</p>
                </div>
              </div>
              <div className="flex items-center gap-2 flex-wrap">
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
