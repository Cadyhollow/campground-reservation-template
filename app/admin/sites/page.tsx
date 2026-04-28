'use client'

import { useEffect, useState } from 'react'
import { supabase } from '@/lib/supabase'
import toast, { Toaster } from 'react-hot-toast'

type Site = {
  id: string
  site_number: string
  site_type: string
  amp_service: string
  max_rv_length: number | null
  hookups: string
  is_available: boolean
  base_rate: number
  description: string
  display_order: number
}

const emptySite = {
  site_number: '',
  site_type: 'rv_site',
  amp_service: '30amp',
  max_rv_length: '',
  hookups: 'full',
  is_available: true,
  base_rate: '',
  description: '',
  display_order: 0,
}

export default function SitesPage() {
  const [sites, setSites] = useState<Site[]>([])
  const [loading, setLoading] = useState(true)
  const [showForm, setShowForm] = useState(false)
  const [editingSite, setEditingSite] = useState<Site | null>(null)
  const [form, setForm] = useState(emptySite)
  const [saving, setSaving] = useState(false)

  useEffect(() => { fetchSites() }, [])

  async function fetchSites() {
    const { data } = await supabase.from('sites').select('*').order('display_order')
    setSites(data || [])
    setLoading(false)
  }

  function openAddForm() { setEditingSite(null); setForm(emptySite); setShowForm(true) }

  function openEditForm(site: Site) {
    setEditingSite(site)
    setForm({
      site_number: site.site_number,
      site_type: site.site_type,
      amp_service: site.amp_service,
      max_rv_length: site.max_rv_length?.toString() || '',
      hookups: site.hookups,
      is_available: site.is_available,
      base_rate: (site.base_rate / 100).toString(),
      description: site.description || '',
      display_order: site.display_order,
    })
    setShowForm(true)
  }

  async function handleSave() {
    if (!form.site_number || !form.base_rate) { toast.error('Site number and nightly rate are required.'); return }
    setSaving(true)
    const payload = {
      site_number: form.site_number,
      site_type: form.site_type,
      amp_service: form.site_type === 'rv_site' ? form.amp_service : 'none',
      max_rv_length: form.max_rv_length ? parseInt(form.max_rv_length as string) : null,
      hookups: form.site_type === 'rv_site' ? form.hookups : 'none',
      is_available: form.is_available,
      base_rate: Math.round(parseFloat(form.base_rate as string) * 100),
      description: form.description,
      display_order: form.display_order,
    }
    if (editingSite) {
      const { error } = await supabase.from('sites').update(payload).eq('id', editingSite.id)
      if (error) { toast.error('Error updating site.'); setSaving(false); return }
      toast.success('Site updated!')
    } else {
      const { error } = await supabase.from('sites').insert(payload)
      if (error) { toast.error('Error adding site.'); setSaving(false); return }
      toast.success('Site added!')
    }
    setSaving(false); setShowForm(false); fetchSites()
  }

  async function toggleAvailability(site: Site) {
    await supabase.from('sites').update({ is_available: !site.is_available }).eq('id', site.id)
    toast.success(`Site ${site.site_number} ${!site.is_available ? 'activated' : 'deactivated'}`); fetchSites()
  }

  async function handleDelete(site: Site) {
    if (!confirm(`Are you sure you want to delete Site ${site.site_number}? This cannot be undone.`)) return
    await supabase.from('sites').delete().eq('id', site.id)
    toast.success('Site deleted.'); fetchSites()
  }

  const siteTypeLabel = (type: string) => ({ rv_site: 'RV Site', cabin: 'Cabin', tent: 'Tent', yurt: 'Yurt', tiny_home: 'Tiny Home', lodge: 'Lodge Room', glamping: 'Glamping', treehouse: 'Treehouse' }[type] || type)
  const hookupLabel = (h: string) => ({ full: 'Full Hookup', water_electric: 'Water & Electric', none: 'None' }[h] || h)
  const ampLabel = (a: string) => ({ '30amp': '30 Amp', '30_50amp': '30/50 Amp', none: 'N/A' }[a] || a)

  return (
    <div className="p-4 md:p-6 max-w-7xl mx-auto">
      <Toaster />
      <div className="flex items-center justify-between mb-6">
        <h2 className="text-2xl font-bold text-gray-900">Sites</h2>
        <button onClick={openAddForm} className="bg-green-700 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-green-800 transition-colors">+ Add Site</button>
      </div>

      {showForm && (
        <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-6 mb-6">
          <h3 className="text-lg font-semibold text-gray-900 mb-4">{editingSite ? `Edit Site ${editingSite.site_number}` : 'Add New Site'}</h3>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Site Number / Name *</label>
              <input className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm" placeholder="e.g. 14, Cabin 1, Tent A" value={form.site_number} onChange={e => setForm({ ...form, site_number: e.target.value })} />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Site Type *</label>
              <select className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm" value={form.site_type} onChange={e => setForm({ ...form, site_type: e.target.value })}>
                <option value="rv_site">RV Site</option>
                <option value="cabin">Cabin</option>
                <option value="tent">Tent Site</option>
                <option value="yurt">Yurt</option>
                <option value="tiny_home">Tiny Home</option>
                <option value="lodge">Lodge Room</option>
                <option value="glamping">Glamping</option>
                <option value="treehouse">Treehouse</option>
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Nightly Rate ($) *</label>
              <input className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm" placeholder="e.g. 45.00" type="number" value={form.base_rate} onChange={e => setForm({ ...form, base_rate: e.target.value })} />
            </div>
            {form.site_type === 'rv_site' && (
              <>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Amp Service</label>
                  <select className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm" value={form.amp_service} onChange={e => setForm({ ...form, amp_service: e.target.value })}>
                    <option value="30amp">30 Amp</option>
                    <option value="30_50amp">30/50 Amp</option>
                  </select>
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Hookups</label>
                  <select className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm" value={form.hookups} onChange={e => setForm({ ...form, hookups: e.target.value })}>
                    <option value="full">Full Hookup</option>
                    <option value="water_electric">Water & Electric Only</option>
                  </select>
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Max RV Length (ft)</label>
                  <input className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm" placeholder="e.g. 40" type="number" value={form.max_rv_length} onChange={e => setForm({ ...form, max_rv_length: e.target.value })} />
                </div>
              </>
            )}
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Display Order</label>
              <input className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm" type="number" value={form.display_order} onChange={e => setForm({ ...form, display_order: parseInt(e.target.value) })} />
            </div>
            <div className="flex items-center gap-3 pt-6">
              <input type="checkbox" id="is_available" checked={form.is_available} onChange={e => setForm({ ...form, is_available: e.target.checked })} className="w-4 h-4 accent-green-700" />
              <label htmlFor="is_available" className="text-sm font-medium text-gray-700">Available for booking</label>
            </div>
            <div className="md:col-span-2 lg:col-span-3">
              <label className="block text-sm font-medium text-gray-700 mb-1">Description (optional)</label>
              <textarea className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm" rows={2} placeholder="Any extra details customers should know..." value={form.description} onChange={e => setForm({ ...form, description: e.target.value })} />
            </div>
          </div>
          <div className="flex gap-3 mt-4">
            <button onClick={handleSave} disabled={saving} className="bg-green-700 text-white px-6 py-2 rounded-lg text-sm font-medium hover:bg-green-800 disabled:opacity-50">{saving ? 'Saving...' : editingSite ? 'Save Changes' : 'Add Site'}</button>
            <button onClick={() => setShowForm(false)} className="bg-gray-100 text-gray-700 px-6 py-2 rounded-lg text-sm font-medium hover:bg-gray-200">Cancel</button>
          </div>
        </div>
      )}

      {loading ? (
        <div className="text-center py-12 text-gray-400">Loading sites...</div>
      ) : sites.length === 0 ? (
        <div className="bg-white rounded-xl shadow-sm border border-gray-100 px-6 py-12 text-center text-gray-400">
          No sites yet. Click "Add Site" to get started!
        </div>
      ) : (
        <div className="bg-white rounded-xl shadow-sm border border-gray-100 divide-y divide-gray-50">
          {sites.map((site) => (
            <div key={site.id} className="px-4 md:px-6 py-4 flex flex-col sm:flex-row sm:items-center gap-3">
              <div className="flex items-start gap-3 flex-1 min-w-0">
                <div className={`w-3 h-3 rounded-full mt-1 shrink-0 ${site.is_available ? 'bg-green-500' : 'bg-gray-300'}`} />
                <div className="min-w-0">
                  <p className="font-semibold text-gray-900">{siteTypeLabel(site.site_type)} {site.site_number}</p>
                  <p className="text-sm text-gray-500">
                    {ampLabel(site.amp_service)} · {hookupLabel(site.hookups)}{site.max_rv_length ? ` · Max ${site.max_rv_length}ft` : ''}
                  </p>
                  <p className="text-sm font-semibold text-green-700 mt-0.5">${(site.base_rate / 100).toFixed(2)}/night</p>
                </div>
              </div>
              <div className="flex items-center gap-2 flex-wrap">
                <button onClick={() => toggleAvailability(site)} className={`text-xs px-3 py-1 rounded-full font-medium ${site.is_available ? 'bg-yellow-100 text-yellow-700 hover:bg-yellow-200' : 'bg-green-100 text-green-700 hover:bg-green-200'}`}>
                  {site.is_available ? 'Mark Unavailable' : 'Mark Available'}
                </button>
                <button onClick={() => openEditForm(site)} className="text-xs px-3 py-1 rounded-full bg-gray-100 text-gray-600 hover:bg-gray-200 font-medium">Edit</button>
                <button onClick={() => handleDelete(site)} className="text-xs px-3 py-1 rounded-full bg-red-50 text-red-600 hover:bg-red-100 font-medium">Delete</button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
