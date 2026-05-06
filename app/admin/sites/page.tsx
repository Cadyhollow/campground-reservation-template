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
  photo_url: string | null
  photo_url_2: string | null
}

type Category = {
  id: number
  name: string
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
  photo_url: null as string | null,
  photo_url_2: null as string | null,
}

export default function SitesPage() {
  const [sites, setSites] = useState<Site[]>([])
  const [categories, setCategories] = useState<Category[]>([])
  const [loading, setLoading] = useState(true)
  const [showForm, setShowForm] = useState(false)
  const [showCategoryForm, setShowCategoryForm] = useState(false)
  const [editingSite, setEditingSite] = useState<Site | null>(null)
  const [form, setForm] = useState(emptySite)
  const [saving, setSaving] = useState(false)
  const [selectedCategories, setSelectedCategories] = useState<number[]>([])
  const [newCategoryName, setNewCategoryName] = useState('')
  const [photo1File, setPhoto1File] = useState<File | null>(null)
  const [photo2File, setPhoto2File] = useState<File | null>(null)
  const [uploadingPhoto, setUploadingPhoto] = useState(false)
  const [siteCategories, setSiteCategories] = useState<Record<string, number[]>>({})

  useEffect(() => { fetchSites(); fetchCategories() }, [])

  async function fetchSites() {
    const { data } = await supabase.from('sites').select('*').order('display_order')
    setSites(data || [])
    setLoading(false)
    // Fetch site_categories for all sites
    const { data: sc } = await supabase.from('site_categories').select('*')
    if (sc) {
      const map: Record<string, number[]> = {}
      sc.forEach((row: any) => {
        if (!map[row.site_id]) map[row.site_id] = []
        map[row.site_id].push(row.category_id)
      })
      setSiteCategories(map)
    }
  }

  async function fetchCategories() {
    const { data } = await supabase.from('categories').select('*').order('name')
    setCategories(data || [])
  }

  async function uploadPhoto(file: File, siteId: string, slot: 1 | 2): Promise<string | null> {
    const ext = file.name.split('.').pop()
    const path = `${siteId}-photo${slot}-${Date.now()}.${ext}`
    const { error } = await supabase.storage.from('site-photos').upload(path, file, { upsert: true })
    if (error) { toast.error(`Error uploading photo ${slot}`); return null }
    const { data } = supabase.storage.from('site-photos').getPublicUrl(path)
    return data.publicUrl
  }

  function openAddForm() {
    setEditingSite(null)
    setForm(emptySite)
    setSelectedCategories([])
    setPhoto1File(null)
    setPhoto2File(null)
    setShowForm(true)
  }

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
      photo_url: site.photo_url || null,
      photo_url_2: site.photo_url_2 || null,
    })
    setSelectedCategories(siteCategories[site.id] || [])
    setPhoto1File(null)
    setPhoto2File(null)
    setShowForm(true)
  }

  function toggleCategory(id: number) {
    setSelectedCategories(prev =>
      prev.includes(id) ? prev.filter(c => c !== id) : [...prev, id]
    )
  }

  async function handleSave() {
    if (!form.site_number || !form.base_rate) { toast.error('Site number and nightly rate are required.'); return }
    setSaving(true)
    setUploadingPhoto(true)

    let photo_url = form.photo_url
    let photo_url_2 = form.photo_url_2

    // We need the site id to name the photo — handle insert first, then upload
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
      photo_url,
      photo_url_2,
    }

    let siteId = editingSite?.id

    if (editingSite) {
      // Upload photos if new files selected
      if (photo1File) photo_url = await uploadPhoto(photo1File, editingSite.id, 1)
      if (photo2File) photo_url_2 = await uploadPhoto(photo2File, editingSite.id, 2)
      const { error } = await supabase.from('sites').update({ ...payload, photo_url, photo_url_2 }).eq('id', editingSite.id)
      if (error) { toast.error('Error updating site.'); setSaving(false); setUploadingPhoto(false); return }
      toast.success('Site updated!')
    } else {
      const { data, error } = await supabase.from('sites').insert(payload).select().single()
      if (error || !data) { toast.error('Error adding site.'); setSaving(false); setUploadingPhoto(false); return }
      siteId = data.id
      // Upload photos now that we have the id
      if (photo1File) {
        photo_url = await uploadPhoto(photo1File, siteId!, 1)
        if (photo_url) await supabase.from('sites').update({ photo_url }).eq('id', siteId!)
      }
      if (photo2File) {
        photo_url_2 = await uploadPhoto(photo2File, siteId!, 2)
        if (photo_url_2) await supabase.from('sites').update({ photo_url_2 }).eq('id', siteId!)
      }
      toast.success('Site added!')
    }

    setUploadingPhoto(false)

    // Save categories
    if (siteId) {
      await supabase.from('site_categories').delete().eq('site_id', siteId)
      if (selectedCategories.length > 0) {
        await supabase.from('site_categories').insert(
          selectedCategories.map(cat_id => ({ site_id: siteId, category_id: cat_id }))
        )
      }
    }

    setSaving(false); setShowForm(false); fetchSites()
  }

  async function handleAddCategory() {
    if (!newCategoryName.trim()) return
    const { error } = await supabase.from('categories').insert({ name: newCategoryName.trim() })
    if (error) { toast.error('Error adding category'); return }
    toast.success('Category added!')
    setNewCategoryName('')
    fetchCategories()
  }

  async function handleDeleteCategory(id: number) {
    if (!confirm('Delete this category? Sites will be unassigned from it.')) return
    await supabase.from('site_categories').delete().eq('category_id', id)
    await supabase.from('categories').delete().eq('id', id)
    toast.success('Category deleted')
    fetchCategories()
    fetchSites()
  }

  async function handleRemovePhoto(slot: 1 | 2) {
    if (!editingSite) return
    const field = slot === 1 ? 'photo_url' : 'photo_url_2'
    await supabase.from('sites').update({ [field]: null }).eq('id', editingSite.id)
    setForm(prev => ({ ...prev, [field]: null }))
    toast.success('Photo removed')
    fetchSites()
  }

  async function toggleAvailability(site: Site) {
    await supabase.from('sites').update({ is_available: !site.is_available }).eq('id', site.id)
    toast.success(`Site ${site.site_number} ${!site.is_available ? 'activated' : 'deactivated'}`); fetchSites()
  }

  async function handleDelete(site: Site) {
    if (!confirm(`Are you sure you want to delete Site ${site.site_number}? This cannot be undone.`)) return
    await supabase.from('site_categories').delete().eq('site_id', site.id)
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
        <div className="flex gap-2">
          <button onClick={() => setShowCategoryForm(!showCategoryForm)} className="bg-gray-100 text-gray-700 px-4 py-2 rounded-lg text-sm font-medium hover:bg-gray-200 transition-colors">🏷️ Manage Categories</button>
          <button onClick={openAddForm} className="bg-green-700 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-green-800 transition-colors">+ Add Site</button>
        </div>
      </div>

      {/* Category Manager */}
      {showCategoryForm && (
        <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-6 mb-6">
          <h3 className="text-lg font-semibold text-gray-900 mb-4">Manage Categories</h3>
          <div className="flex gap-2 mb-4">
            <input
              className="flex-1 border border-gray-200 rounded-lg px-3 py-2 text-sm"
              placeholder="New category name (e.g. Waterfront, Full Hookups)"
              value={newCategoryName}
              onChange={e => setNewCategoryName(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && handleAddCategory()}
            />
            <button onClick={handleAddCategory} className="bg-green-700 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-green-800">Add</button>
          </div>
          {categories.length === 0 ? (
            <p className="text-sm text-gray-400">No categories yet. Add one above!</p>
          ) : (
            <div className="flex flex-wrap gap-2">
              {categories.map(cat => (
                <div key={cat.id} className="flex items-center gap-1 bg-green-50 border border-green-200 rounded-full px-3 py-1">
                  <span className="text-sm text-green-800 font-medium">{cat.name}</span>
                  <button onClick={() => handleDeleteCategory(cat.id)} className="text-red-400 hover:text-red-600 ml-1 text-xs font-bold">✕</button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Site Form */}
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

            {/* Photo Upload */}
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Main Photo (optional)</label>
              {form.photo_url && (
                <div className="mb-2 relative inline-block">
                  <img src={form.photo_url} alt="Main photo" className="h-24 w-40 object-cover rounded-lg border border-gray-200" />
                  {editingSite && (
                    <button onClick={() => handleRemovePhoto(1)} className="absolute -top-1 -right-1 bg-red-500 text-white rounded-full w-5 h-5 text-xs flex items-center justify-center hover:bg-red-600">✕</button>
                  )}
                </div>
              )}
              <input type="file" accept="image/*" className="w-full text-sm text-gray-500 file:mr-3 file:py-1 file:px-3 file:rounded-full file:border-0 file:text-xs file:font-medium file:bg-green-50 file:text-green-700 hover:file:bg-green-100" onChange={e => setPhoto1File(e.target.files?.[0] || null)} />
              <p className="text-xs text-gray-400 mt-1">Shown as thumbnail in site list</p>
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Second Photo (optional)</label>
              {form.photo_url_2 && (
                <div className="mb-2 relative inline-block">
                  <img src={form.photo_url_2} alt="Second photo" className="h-24 w-40 object-cover rounded-lg border border-gray-200" />
                  {editingSite && (
                    <button onClick={() => handleRemovePhoto(2)} className="absolute -top-1 -right-1 bg-red-500 text-white rounded-full w-5 h-5 text-xs flex items-center justify-center hover:bg-red-600">✕</button>
                  )}
                </div>
              )}
              <input type="file" accept="image/*" className="w-full text-sm text-gray-500 file:mr-3 file:py-1 file:px-3 file:rounded-full file:border-0 file:text-xs file:font-medium file:bg-green-50 file:text-green-700 hover:file:bg-green-100" onChange={e => setPhoto2File(e.target.files?.[0] || null)} />
              <p className="text-xs text-gray-400 mt-1">Shown when site is selected (interior, detail, etc.)</p>
            </div>

            {/* Categories */}
            {categories.length > 0 && (
              <div className="md:col-span-2 lg:col-span-3">
                <label className="block text-sm font-medium text-gray-700 mb-2">Categories (optional — select all that apply)</label>
                <div className="flex flex-wrap gap-2">
                  {categories.map(cat => (
                    <button
                      key={cat.id}
                      type="button"
                      onClick={() => toggleCategory(cat.id)}
                      className={`px-3 py-1 rounded-full text-sm font-medium border transition-colors ${selectedCategories.includes(cat.id) ? 'bg-green-700 text-white border-green-700' : 'bg-white text-gray-600 border-gray-200 hover:border-green-400'}`}
                    >
                      {cat.name}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
          <div className="flex gap-3 mt-4">
            <button onClick={handleSave} disabled={saving} className="bg-green-700 text-white px-6 py-2 rounded-lg text-sm font-medium hover:bg-green-800 disabled:opacity-50">
              {saving ? (uploadingPhoto ? 'Uploading photo...' : 'Saving...') : editingSite ? 'Save Changes' : 'Add Site'}
            </button>
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
                {site.photo_url && (
                  <img src={site.photo_url} alt={`Site ${site.site_number}`} className="w-16 h-16 object-cover rounded-lg border border-gray-100 shrink-0" />
                )}
                <div className={`w-3 h-3 rounded-full mt-1 shrink-0 ${site.is_available ? 'bg-green-500' : 'bg-gray-300'}`} />
                <div className="min-w-0">
                  <p className="font-semibold text-gray-900">{siteTypeLabel(site.site_type)} {site.site_number}</p>
                  <p className="text-sm text-gray-500">
                    {ampLabel(site.amp_service)} · {hookupLabel(site.hookups)}{site.max_rv_length ? ` · Max ${site.max_rv_length}ft` : ''}
                  </p>
                  <p className="text-sm font-semibold text-green-700 mt-0.5">${(site.base_rate / 100).toFixed(2)}/night</p>
                  {siteCategories[site.id]?.length > 0 && (
                    <div className="flex flex-wrap gap-1 mt-1">
                      {siteCategories[site.id].map(catId => {
                        const cat = categories.find(c => c.id === catId)
                        return cat ? <span key={catId} className="text-xs bg-green-50 text-green-700 border border-green-200 rounded-full px-2 py-0.5">{cat.name}</span> : null
                      })}
                    </div>
                  )}
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
