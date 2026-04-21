'use client'

import { useEffect, useState } from 'react'
import { supabase } from '@/lib/supabase'
import toast, { Toaster } from 'react-hot-toast'

const defaultSettings = {
  park_name: '',
  park_tagline: '',
  park_email: '',
  park_phone: '',
  park_address: '',
  park_website: '',
  check_in_time: '2:00 PM',
  check_out_time: '12:00 PM',
  same_day_cutoff_time: '11:00 am',
  extra_adult_fee: '',
  extra_child_fee: '',
  base_occupancy_adults: 2,
  base_occupancy_children: 2,
  cancellation_policy: '',
  accent_color: '#2D6A4F',
  show_site_map: false,
  admin_password: '',
  season_start: 'May 1',
  season_end: 'October 11',
  closed_season_message: 'We are closed for the season. We look forward to welcoming you back next year!',
}

export default function SettingsPage() {
  const [form, setForm] = useState(defaultSettings)
  const [settingsId, setSettingsId] = useState(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)

  useEffect(() => { fetchSettings() }, [])

  async function fetchSettings() {
    const { data } = await supabase.from('settings').select('*').limit(1).single()
    if (data) {
      setSettingsId(data.id)
      setForm({
        park_name: data.park_name || '',
        park_tagline: data.park_tagline || '',
        park_email: data.park_email || '',
        park_phone: data.park_phone || '',
        park_address: data.park_address || '',
        park_website: data.park_website || '',
        check_in_time: data.check_in_time || '2:00 PM',
        check_out_time: data.check_out_time || '12:00 PM',
        same_day_cutoff_time: data.same_day_cutoff_time || '11:00 AM',
        extra_adult_fee: (data.extra_adult_fee / 100).toString(),
        extra_child_fee: (data.extra_child_fee / 100).toString(),
        base_occupancy_adults: data.base_occupancy_adults || 2,
        base_occupancy_children: data.base_occupancy_children || 2,
        cancellation_policy: data.cancellation_policy || '',
        accent_color: data.accent_color || '#2D6A4F',
        show_site_map: data.show_site_map || false,
        admin_password: '',
        season_start: data.season_start || 'May 1',
        season_end: data.season_end || 'October 11',
        closed_season_message: data.closed_season_message || 'We are closed for the season. We look forward to welcoming you back next year!',
      })
    }
    setLoading(false)
  }

  async function handleSave() {
    setSaving(true)
    const payload = {
      park_name: form.park_name,
      park_tagline: form.park_tagline,
      park_email: form.park_email,
      park_phone: form.park_phone,
      park_address: form.park_address,
      park_website: form.park_website,
      check_in_time: form.check_in_time,
      check_out_time: form.check_out_time,
      same_day_cutoff_time: form.same_day_cutoff_time,
      extra_adult_fee: Math.round(parseFloat(form.extra_adult_fee) * 100),
      extra_child_fee: Math.round(parseFloat(form.extra_child_fee) * 100),
      base_occupancy_adults: form.base_occupancy_adults,
      base_occupancy_children: form.base_occupancy_children,
      cancellation_policy: form.cancellation_policy,
      accent_color: form.accent_color,
      show_site_map: form.show_site_map,
      ...(form.admin_password ? { admin_password: form.admin_password } : {}),
      season_start: form.season_start,
      season_end: form.season_end,
      closed_season_message: form.closed_season_message,
    }
    if (settingsId) {
      const { error } = await supabase.from('settings').update(payload).eq('id', settingsId)
      if (error) { toast.error('Error saving settings.'); setSaving(false); return }
    } else {
      const { error } = await supabase.from('settings').insert(payload)
      if (error) { toast.error('Error saving settings.'); setSaving(false); return }
    }
    toast.success('Settings saved!')
    setSaving(false)
    fetchSettings()
  }

  if (loading) return <div className="flex items-center justify-center h-64"><div className="text-gray-500">Loading settings...</div></div>

  return (
    <div className="p-6 max-w-4xl mx-auto">
      <Toaster />
      <div className="flex items-center justify-between mb-6">
        <div>
          <h2 className="text-2xl font-bold text-gray-900">Settings</h2>
          <p className="text-sm text-gray-500 mt-1">Manage your park information and booking rules.</p>
        </div>
        <button onClick={handleSave} disabled={saving} className="bg-green-700 text-white px-6 py-2 rounded-lg text-sm font-medium hover:bg-green-800 disabled:opacity-50">
          {saving ? 'Saving...' : 'Save Settings'}
        </button>
      </div>

      <div className="space-y-6">
        <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-6">
          <h3 className="text-lg font-semibold text-gray-900 mb-4">Park Information</h3>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div><label className="block text-sm font-medium text-gray-700 mb-1">Park Name</label><input className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm" value={form.park_name} onChange={e => setForm({ ...form, park_name: e.target.value })} /></div>
            <div><label className="block text-sm font-medium text-gray-700 mb-1">Tagline</label><input className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm" value={form.park_tagline} onChange={e => setForm({ ...form, park_tagline: e.target.value })} /></div>
            <div><label className="block text-sm font-medium text-gray-700 mb-1">Email</label><input className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm" type="email" value={form.park_email} onChange={e => setForm({ ...form, park_email: e.target.value })} /></div>
            <div><label className="block text-sm font-medium text-gray-700 mb-1">Phone</label><input className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm" value={form.park_phone} onChange={e => setForm({ ...form, park_phone: e.target.value })} /></div>
            <div><label className="block text-sm font-medium text-gray-700 mb-1">Address</label><input className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm" value={form.park_address} onChange={e => setForm({ ...form, park_address: e.target.value })} /></div>
            <div><label className="block text-sm font-medium text-gray-700 mb-1">Website</label><input className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm" value={form.park_website} onChange={e => setForm({ ...form, park_website: e.target.value })} /></div>
            <div><label className="block text-sm font-medium text-gray-700 mb-1">Show Site Map</label><div className="flex items-center gap-3"><input type="checkbox" checked={form.show_site_map} onChange={e => setForm({ ...form, show_site_map: e.target.checked })} className="w-5 h-5 rounded" /><span className="text-sm text-gray-600">{form.show_site_map ? 'Map is visible to guests' : 'List view shown to guests'}</span></div></div><div><label className="block text-sm font-medium text-gray-700 mb-1">Brand Color</label><div className="flex items-center gap-3"><input type="color" className="w-12 h-10 rounded border border-gray-200 cursor-pointer" value={form.accent_color} onChange={e => setForm({ ...form, accent_color: e.target.value })} /><input className="flex-1 border border-gray-200 rounded-lg px-3 py-2 text-sm font-mono" value={form.accent_color} onChange={e => setForm({ ...form, accent_color: e.target.value })} /></div></div>
          </div>
        </div>

        <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-6">
          <h3 className="text-lg font-semibold text-gray-900 mb-4">Booking Rules</h3>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div><label className="block text-sm font-medium text-gray-700 mb-1">Check-In Time</label><input className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm" value={form.check_in_time} onChange={e => setForm({ ...form, check_in_time: e.target.value })} /></div>
            <div><label className="block text-sm font-medium text-gray-700 mb-1">Check-Out Time</label><input className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm" value={form.check_out_time} onChange={e => setForm({ ...form, check_out_time: e.target.value })} /></div>
            <div><label className="block text-sm font-medium text-gray-700 mb-1">Same-Day Booking Cutoff</label><input className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm" placeholder="e.g. 11:00 AM" value={form.same_day_cutoff_time} onChange={e => setForm({ ...form, same_day_cutoff_time: e.target.value })} /></div>
            <div><label className="block text-sm font-medium text-gray-700 mb-1">Base Occupancy — Adults</label><input type="number" className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm" value={form.base_occupancy_adults} onChange={e => setForm({ ...form, base_occupancy_adults: parseInt(e.target.value) })} /></div>
            <div><label className="block text-sm font-medium text-gray-700 mb-1">Base Occupancy — Children</label><input type="number" className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm" value={form.base_occupancy_children} onChange={e => setForm({ ...form, base_occupancy_children: parseInt(e.target.value) })} /></div>
            <div><label className="block text-sm font-medium text-gray-700 mb-1">Extra Adult Fee ($/night)</label><input type="number" className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm" value={form.extra_adult_fee} onChange={e => setForm({ ...form, extra_adult_fee: e.target.value })} /></div>
            <div><label className="block text-sm font-medium text-gray-700 mb-1">Extra Child Fee ($/night)</label><input type="number" className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm" value={form.extra_child_fee} onChange={e => setForm({ ...form, extra_child_fee: e.target.value })} /></div>
          </div>
        </div>

        <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-6">
          <h3 className="text-lg font-semibold text-gray-900 mb-2">Season Dates</h3>
          <p className="text-sm text-gray-500 mb-4">Customers will see a closed message if they search dates outside your season.</p>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div><label className="block text-sm font-medium text-gray-700 mb-1">Season Opens</label><input className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm" placeholder="e.g. May 1" value={form.season_start} onChange={e => setForm({ ...form, season_start: e.target.value })} /></div>
            <div><label className="block text-sm font-medium text-gray-700 mb-1">Season Closes</label><input className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm" placeholder="e.g. October 11" value={form.season_end} onChange={e => setForm({ ...form, season_end: e.target.value })} /></div>
            <div className="md:col-span-2"><label className="block text-sm font-medium text-gray-700 mb-1">Closed Season Message</label><textarea className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm" rows={2} value={form.closed_season_message} onChange={e => setForm({ ...form, closed_season_message: e.target.value })} /></div>
          </div>
        </div>

        <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-6">
          <h3 className="text-lg font-semibold text-gray-900 mb-4">Cancellation Policy</h3>
          <textarea className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm" rows={4} value={form.cancellation_policy} onChange={e => setForm({ ...form, cancellation_policy: e.target.value })} />
        </div>
      </div>

      <div className="mt-6 flex justify-end">
        <button onClick={handleSave} disabled={saving} className="bg-green-700 text-white px-8 py-3 rounded-lg font-medium hover:bg-green-800 disabled:opacity-50">
          {saving ? 'Saving...' : 'Save Settings'}
        </button>
      </div>
    </div>
  )
}