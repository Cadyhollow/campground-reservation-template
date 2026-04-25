'use client'

import { useEffect, useState } from 'react'
import { supabase } from '@/lib/supabase'
import toast, { Toaster } from 'react-hot-toast'

type BlockedDate = {
  id: string
  site_id: string | null
  date: string
  reason: string
  created_at: string
  sites: { site_number: string; site_type: string } | null
}

type Site = {
  id: string
  site_number: string
  site_type: string
}

const emptyBlock = {
  target: 'all',
  site_id: '',
  start_date: '',
  end_date: '',
  reason: '',
}

export default function BlockedDatesPage() {
  const [blocked, setBlocked] = useState<BlockedDate[]>([])
  const [sites, setSites] = useState<Site[]>([])
  const [loading, setLoading] = useState(true)
  const [showForm, setShowForm] = useState(false)
  const [form, setForm] = useState(emptyBlock)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    fetchData()
  }, [])

  async function fetchData() {
    const [{ data: blockedData }, { data: sitesData }] = await Promise.all([
      supabase
        .from('blocked_dates')
        .select('*, sites(site_number, site_type)')
        .order('date', { ascending: true }),
      supabase.from('sites').select('id, site_number, site_type').order('display_order'),
    ])
    setBlocked(blockedData || [])
    setSites(sitesData || [])
    setLoading(false)
  }

  async function handleSave() {
    if (!form.start_date) {
      toast.error('Please select at least a start date.')
      return
    }
    setSaving(true)

    const start = new Date(form.start_date)
    const end = form.end_date ? new Date(form.end_date) : start
    const dates: string[] = []
    const current = new Date(start)
    while (current <= end) {
      dates.push(current.toISOString().split('T')[0])
      current.setDate(current.getDate() + 1)
    }

    const rows = dates.map(date => ({
      site_id: form.target === 'site' ? form.site_id : null,
      date,
      reason: form.reason,
    }))

    const { error } = await supabase.from('blocked_dates').insert(rows)
    if (error) {
      toast.error('Error blocking dates.')
      setSaving(false)
      return
    }

    toast.success(`${dates.length} date${dates.length > 1 ? 's' : ''} blocked!`)
    setSaving(false)
    setShowForm(false)
    setForm(emptyBlock)
    fetchData()
  }

  async function handleDelete(id: string) {
    if (!confirm('Unblock this date?')) return
    await supabase.from('blocked_dates').delete().eq('id', id)
    toast.success('Date unblocked.')
    fetchData()
  }

  const siteLabel = (b: BlockedDate) => {
    if (!b.site_id) return 'All Sites'
    return b.sites
      ? `${({ rv_site: 'RV', cabin: 'Cabin', tent: 'Tent', yurt: 'Yurt', tiny_home: 'Tiny Home', lodge: 'Lodge', glamping: 'Glamping', treehouse: 'Treehouse' }[b.sites.site_type] || b.sites.site_type)} ${b.sites.site_number}`
      : 'Specific Site'
  }

  const upcoming = blocked.filter(b => b.date >= new Date().toISOString().split('T')[0])
  const past = blocked.filter(b => b.date < new Date().toISOString().split('T')[0])

  return (
    <div className="p-6 max-w-7xl mx-auto">
      <Toaster />
      <div className="flex items-center justify-between mb-6">
        <div>
          <h2 className="text-2xl font-bold text-gray-900">Blocked Dates</h2>
          <p className="text-sm text-gray-500 mt-1">Block dates to prevent bookings on specific days.</p>
        </div>
        <button
          onClick={() => setShowForm(true)}
          className="bg-green-700 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-green-800"
        >
          + Block Dates
        </button>
      </div>

      {/* Form */}
      {showForm && (
        <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-6 mb-6">
          <h3 className="text-lg font-semibold text-gray-900 mb-4">Block Dates</h3>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Apply To *</label>
              <select
                className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm"
                value={form.target}
                onChange={e => setForm({ ...form, target: e.target.value })}
              >
                <option value="all">All Sites</option>
                <option value="site">One Specific Site</option>
              </select>
            </div>
            {form.target === 'site' && (
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Site *</label>
                <select
                  className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm"
                  value={form.site_id}
                  onChange={e => setForm({ ...form, site_id: e.target.value })}
                >
                  <option value="">Select a site...</option>
                  {sites.map(site => (
                    <option key={site.id} value={site.id}>
                      {({ rv_site: 'RV', cabin: 'Cabin', tent: 'Tent', yurt: 'Yurt', tiny_home: 'Tiny Home', lodge: 'Lodge', glamping: 'Glamping', treehouse: 'Treehouse' }[site.site_type] || site.site_type)} {site.site_number}
                    </option>
                  ))}
                </select>
              </div>
            )}
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Start Date *</label>
              <input
                className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm"
                type="date"
                value={form.start_date}
                onChange={e => setForm({ ...form, start_date: e.target.value })}
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">End Date (optional, for ranges)</label>
              <input
                className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm"
                type="date"
                value={form.end_date}
                onChange={e => setForm({ ...form, end_date: e.target.value })}
              />
            </div>
            <div className="md:col-span-2">
              <label className="block text-sm font-medium text-gray-700 mb-1">Reason (internal note)</label>
              <input
                className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm"
                placeholder="e.g. Park maintenance, Private event"
                value={form.reason}
                onChange={e => setForm({ ...form, reason: e.target.value })}
              />
            </div>
          </div>
          <div className="flex gap-3 mt-4">
            <button
              onClick={handleSave}
              disabled={saving}
              className="bg-green-700 text-white px-6 py-2 rounded-lg text-sm font-medium hover:bg-green-800 disabled:opacity-50"
            >
              {saving ? 'Blocking...' : 'Block Dates'}
            </button>
            <button
              onClick={() => { setShowForm(false); setForm(emptyBlock) }}
              className="bg-gray-100 text-gray-700 px-6 py-2 rounded-lg text-sm font-medium hover:bg-gray-200"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Upcoming Blocked Dates */}
      {loading ? (
        <div className="text-center py-12 text-gray-400">Loading blocked dates...</div>
      ) : (
        <>
          <div className="bg-white rounded-xl shadow-sm border border-gray-100 mb-6">
            <div className="px-6 py-4 border-b border-gray-100">
              <h3 className="font-semibold text-gray-900">Upcoming Blocked Dates ({upcoming.length})</h3>
            </div>
            {upcoming.length === 0 ? (
              <div className="px-6 py-8 text-center text-gray-400">No upcoming blocked dates.</div>
            ) : (
              <div className="divide-y divide-gray-50">
                {upcoming.map(b => (
                  <div key={b.id} className="px-6 py-3 flex items-center justify-between">
                    <div>
                      <span className="font-medium text-gray-900">{b.date}</span>
                      <span className="mx-2 text-gray-300">·</span>
                      <span className="text-sm text-gray-500">{siteLabel(b)}</span>
                      {b.reason && (
                        <>
                          <span className="mx-2 text-gray-300">·</span>
                          <span className="text-sm text-gray-400">{b.reason}</span>
                        </>
                      )}
                    </div>
                    <button
                      onClick={() => handleDelete(b.id)}
                      className="text-xs px-3 py-1 rounded-full bg-red-50 text-red-600 hover:bg-red-100 font-medium"
                    >
                      Unblock
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>

          {past.length > 0 && (
            <div className="bg-white rounded-xl shadow-sm border border-gray-100 opacity-60">
              <div className="px-6 py-4 border-b border-gray-100">
                <h3 className="font-semibold text-gray-900">Past Blocked Dates ({past.length})</h3>
              </div>
              <div className="divide-y divide-gray-50">
                {past.slice(-10).reverse().map(b => (
                  <div key={b.id} className="px-6 py-3 flex items-center justify-between">
                    <div>
                      <span className="font-medium text-gray-500">{b.date}</span>
                      <span className="mx-2 text-gray-300">·</span>
                      <span className="text-sm text-gray-400">{siteLabel(b)}</span>
                      {b.reason && (
                        <>
                          <span className="mx-2 text-gray-300">·</span>
                          <span className="text-sm text-gray-400">{b.reason}</span>
                        </>
                      )}
                    </div>
                    <button
                      onClick={() => handleDelete(b.id)}
                      className="text-xs px-3 py-1 rounded-full bg-gray-100 text-gray-500 hover:bg-gray-200 font-medium"
                    >
                      Remove
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  )
}