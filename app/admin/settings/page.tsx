'use client'

import { useEffect, useState, useRef } from 'react'
import { supabase } from '@/lib/supabase'
import toast, { Toaster } from 'react-hot-toast'
import Image from 'next/image'

const defaultSettings = {
  park_name: '',
  park_tagline: '',
  park_email: '',
  park_phone: '',
  park_address: '',
  park_website: '',
  park_location: '',
  logo_url: '',
  logo_shape: 'circle',
  check_in_time: '2:00 PM',
  check_out_time: '12:00 PM',
  same_day_cutoff_time: '11:00 am',
  extra_adult_fee: '',
  extra_child_fee: '',
  base_occupancy_adults: 2,
  base_occupancy_children: 2,
  cancellation_policy: '',
  confirmation_message: '',
  accent_color: '#2D6A4F',
  show_site_map: false,
  admin_password: '',
  season_start: 'May 1',
  season_end: 'October 11',
  closed_season_message: 'We are closed for the season. We look forward to welcoming you back next year!',
  waiver_enabled: true,
  waiver_text: '',
}

export default function SettingsPage() {
  const [form, setForm] = useState(defaultSettings)
  const [settingsId, setSettingsId] = useState(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [uploadingLogo, setUploadingLogo] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)

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
        park_location: data.park_location || '',
        logo_url: data.logo_url || '',
        logo_shape: data.logo_shape || 'circle',
        check_in_time: data.check_in_time || '2:00 PM',
        check_out_time: data.check_out_time || '12:00 PM',
        same_day_cutoff_time: data.same_day_cutoff_time || '11:00 AM',
        extra_adult_fee: (data.extra_adult_fee / 100).toString(),
        extra_child_fee: (data.extra_child_fee / 100).toString(),
        base_occupancy_adults: data.base_occupancy_adults || 2,
        base_occupancy_children: data.base_occupancy_children || 2,
        cancellation_policy: data.cancellation_policy || '',
        confirmation_message: data.confirmation_message || '',
        accent_color: data.accent_color || '#2D6A4F',
        show_site_map: data.show_site_map || false,
        admin_password: '',
        season_start: data.season_start || 'May 1',
        season_end: data.season_end || 'October 11',
        closed_season_message: data.closed_season_message || 'We are closed for the season. We look forward to welcoming you back next year!',
        waiver_enabled: data.waiver_enabled !== false,
        waiver_text: data.waiver_text || '',
      })
    }
    setLoading(false)
  }

  async function handleLogoUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    if (!file.type.startsWith('image/')) { toast.error('Please upload an image file.'); return }
    if (file.size > 2 * 1024 * 1024) { toast.error('Image must be smaller than 2MB.'); return }
    setUploadingLogo(true)
    const fileExt = file.name.split('.').pop()
    const fileName = `logo-${Date.now()}.${fileExt}`
    const { error: uploadError } = await supabase.storage.from('logos').upload(fileName, file, { upsert: true })
    if (uploadError) { toast.error('Error uploading logo.'); setUploadingLogo(false); return }
    const { data: urlData } = supabase.storage.from('logos').getPublicUrl(fileName)
    const publicUrl = urlData.publicUrl
    const { error: updateError } = await supabase.from('settings').update({ logo_url: publicUrl }).eq('id', settingsId)
    if (updateError) { toast.error('Error saving logo URL.'); setUploadingLogo(false); return }
    setForm({ ...form, logo_url: publicUrl })
    toast.success('Logo uploaded successfully!')
    setUploadingLogo(false)
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
      park_location: form.park_location,
      logo_shape: form.logo_shape,
      check_in_time: form.check_in_time,
      check_out_time: form.check_out_time,
      same_day_cutoff_time: form.same_day_cutoff_time,
      extra_adult_fee: Math.round(parseFloat(form.extra_adult_fee) * 100),
      extra_child_fee: Math.round(parseFloat(form.extra_child_fee) * 100),
      base_occupancy_adults: form.base_occupancy_adults,
      base_occupancy_children: form.base_occupancy_children,
      cancellation_policy: form.cancellation_policy,
      confirmation_message: form.confirmation_message,
      accent_color: form.accent_color,
      show_site_map: form.show_site_map,
      ...(form.admin_password ? { admin_password: form.admin_password } : {}),
      season_start: form.season_start,
      season_end: form.season_end,
      closed_season_message: form.closed_season_message,
      waiver_enabled: form.waiver_enabled,
      waiver_text: form.waiver_text,
    }
    if (settingsId) {
      const { error } = await supabase.from('settings').update(payload).eq('id', settingsId)
      if (error) { toast.error('Error saving settings.'); setSaving(false); return }
    } else {
      const { error } = await supabase.from('settings').insert(payload)
      if (error) { toast.error('Error saving settings.'); setSaving(false); return }
    }
    toast.success('Settings saved!')
    await new Promise(resolve => setTimeout(resolve, 500))
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

        {/* Logo */}
        <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-6">
          <h3 className="text-lg font-semibold text-gray-900 mb-4">Logo</h3>
          <div className="flex items-center gap-6 mb-4">
            <div className={`w-24 h-24 overflow-hidden border border-gray-200 flex items-center justify-center bg-gray-50 flex-shrink-0 ${
              form.logo_shape === 'circle' ? 'rounded-full' :
              form.logo_shape === 'rounded' ? 'rounded-xl' :
              form.logo_shape === 'square' ? 'rounded-none' : 'rounded-none bg-transparent border-dashed'
            }`}>
              {form.logo_url ? (
                <Image src={form.logo_url} alt="Campground logo" width={96} height={96} className="object-contain w-full h-full" />
              ) : (
                <span className="text-gray-400 text-xs text-center px-2">No logo uploaded</span>
              )}
            </div>
            <div className="flex-1">
              <input type="file" accept="image/*" ref={fileInputRef} onChange={handleLogoUpload} className="hidden" />
              <button onClick={() => fileInputRef.current?.click()} disabled={uploadingLogo} className="bg-green-700 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-green-800 disabled:opacity-50">
                {uploadingLogo ? 'Uploading...' : 'Upload New Logo'}
              </button>
              <p className="text-xs text-gray-400 mt-2">PNG, JPG or SVG. Max 2MB.</p>
              {form.logo_url && <p className="text-xs text-green-600 mt-1">✓ Logo uploaded</p>}
            </div>
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Logo Display Shape</label>
            <select className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm" value={form.logo_shape} onChange={e => setForm({ ...form, logo_shape: e.target.value })}>
              <option value="circle">Circle — round crop</option>
              <option value="rounded">Rounded Square — soft corners</option>
              <option value="square">Square — sharp corners</option>
              <option value="original">Original — no crop, transparent background</option>
            </select>
          </div>
        </div>

        {/* Park Information */}
        <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-6">
          <h3 className="text-lg font-semibold text-gray-900 mb-4">Park Information</h3>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div><label className="block text-sm font-medium text-gray-700 mb-1">Park Name</label><input className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm" value={form.park_name} onChange={e => setForm({ ...form, park_name: e.target.value })} /></div>
            <div><label className="block text-sm font-medium text-gray-700 mb-1">Tagline</label><input className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm" value={form.park_tagline} onChange={e => setForm({ ...form, park_tagline: e.target.value })} /></div>
            <div><label className="block text-sm font-medium text-gray-700 mb-1">Location</label><input className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm" placeholder="e.g. Port Allegany, PA" value={form.park_location} onChange={e => setForm({ ...form, park_location: e.target.value })} /></div>
            <div><label className="block text-sm font-medium text-gray-700 mb-1">Email</label><input className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm" type="email" value={form.park_email} onChange={e => setForm({ ...form, park_email: e.target.value })} /></div>
            <div><label className="block text-sm font-medium text-gray-700 mb-1">Phone</label><input className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm" value={form.park_phone} onChange={e => setForm({ ...form, park_phone: e.target.value })} /></div>
            <div><label className="block text-sm font-medium text-gray-700 mb-1">Address</label><input className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm" value={form.park_address} onChange={e => setForm({ ...form, park_address: e.target.value })} /></div>
            <div><label className="block text-sm font-medium text-gray-700 mb-1">Website</label><input className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm" value={form.park_website} onChange={e => setForm({ ...form, park_website: e.target.value })} /></div>
            <div><label className="block text-sm font-medium text-gray-700 mb-1">Show Site Map</label><div className="flex items-center gap-3"><input type="checkbox" checked={form.show_site_map} onChange={e => setForm({ ...form, show_site_map: e.target.checked })} className="w-5 h-5 rounded" /><span className="text-sm text-gray-600">{form.show_site_map ? 'Map is visible to guests' : 'List view shown to guests'}</span></div></div>
            <div><label className="block text-sm font-medium text-gray-700 mb-1">Brand Color</label><div className="flex items-center gap-3"><input type="color" className="w-12 h-10 rounded border border-gray-200 cursor-pointer" value={form.accent_color} onChange={e => setForm({ ...form, accent_color: e.target.value })} /><input className="flex-1 border border-gray-200 rounded-lg px-3 py-2 text-sm font-mono" value={form.accent_color} onChange={e => setForm({ ...form, accent_color: e.target.value })} /></div></div>
          </div>
        </div>

        {/* Booking Rules */}
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

        {/* Season Dates */}
        <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-6">
          <h3 className="text-lg font-semibold text-gray-900 mb-2">Season Dates</h3>
          <p className="text-sm text-gray-500 mb-4">Customers will see a closed message if they search dates outside your season.</p>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div><label className="block text-sm font-medium text-gray-700 mb-1">Season Opens</label><input className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm" placeholder="e.g. May 1" value={form.season_start} onChange={e => setForm({ ...form, season_start: e.target.value })} /></div>
            <div><label className="block text-sm font-medium text-gray-700 mb-1">Season Closes</label><input className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm" placeholder="e.g. October 11" value={form.season_end} onChange={e => setForm({ ...form, season_end: e.target.value })} /></div>
            <div className="md:col-span-2"><label className="block text-sm font-medium text-gray-700 mb-1">Closed Season Message</label><textarea className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm" rows={2} value={form.closed_season_message} onChange={e => setForm({ ...form, closed_season_message: e.target.value })} /></div>
          </div>
        </div>

        {/* Confirmation Email Message */}
        <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-6">
          <h3 className="text-lg font-semibold text-gray-900 mb-1">Confirmation Email Message</h3>
          <p className="text-sm text-gray-500 mb-4">This message appears in the <strong>Important Information</strong> section of every customer confirmation email. Separate paragraphs with a blank line.</p>
          <textarea className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm font-sans leading-relaxed" rows={12} placeholder="Enter directions, check-in instructions, rules, or anything guests need to know before they arrive..." value={form.confirmation_message} onChange={e => setForm({ ...form, confirmation_message: e.target.value })} />
          <p className="text-xs text-gray-400 mt-2">💡 Tip: Leave a blank line between paragraphs and each one will appear as its own paragraph in the email.</p>
        </div>

        {/* Cancellation Policy */}
        <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-6">
          <h3 className="text-lg font-semibold text-gray-900 mb-4">Cancellation Policy</h3>
          <textarea className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm" rows={4} value={form.cancellation_policy} onChange={e => setForm({ ...form, cancellation_policy: e.target.value })} />
        </div>

        {/* Liability Waiver */}
        <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-6">
          <h3 className="text-lg font-semibold text-gray-900 mb-1">Liability Waiver</h3>
          <p className="text-sm text-gray-500 mb-4">Control whether guests must sign a liability waiver during checkout. If enabled, guests will read and sign before paying.</p>

          <div className="flex items-center justify-between mb-6 p-4 bg-gray-50 rounded-lg border border-gray-200">
            <div>
              <p className="text-sm font-medium text-gray-900">Require liability waiver at checkout</p>
              <p className="text-xs text-gray-500 mt-0.5">
                {form.waiver_enabled ? 'Guests must read and sign the waiver before they can pay.' : 'No waiver will be shown to guests during checkout.'}
              </p>
            </div>
            <button
              type="button"
              onClick={() => setForm({ ...form, waiver_enabled: !form.waiver_enabled })}
              className="relative inline-flex h-7 w-14 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ml-4"
              style={{ backgroundColor: form.waiver_enabled ? '#15803d' : '#d1d5db' }}
            >
              <span
                className="pointer-events-none inline-block h-6 w-6 transform rounded-full bg-white shadow-md transition duration-200"
                style={{ transform: form.waiver_enabled ? 'translateX(28px)' : 'translateX(0px)' }}
              />
            </button>
          </div>

          {form.waiver_enabled && (
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Waiver Text</label>
              <p className="text-xs text-gray-400 mb-2">Write your full liability waiver here. Use <strong>[CAMPGROUND NAME]</strong> as a placeholder — it will be automatically replaced with your park name when guests see it.</p>
              <textarea
                className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm font-sans leading-relaxed"
                rows={16}
                placeholder="Enter your liability waiver text here. Use [CAMPGROUND NAME] where your park name should appear..."
                value={form.waiver_text}
                onChange={e => setForm({ ...form, waiver_text: e.target.value })}
              />
              <p className="text-xs text-gray-400 mt-2">💡 Tip: Consult with a legal professional to ensure your waiver is appropriate for your property and jurisdiction.</p>
            </div>
          )}
        </div>

      </div>

      {/* Admin Password */}
      <div className="border-t border-gray-200 pt-6 mt-6">
        <h2 className="text-lg font-semibold text-gray-900 mb-4">Change Admin Password</h2>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">New Password</label>
            <input type="password" className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm" placeholder="Enter new password" value={form.admin_password || ''} onChange={e => setForm({ ...form, admin_password: e.target.value })} />
          </div>
        </div>
        <p className="text-xs text-gray-400 mt-2">Leave blank to keep current password.</p>
      </div>

      <div className="mt-6 flex justify-end">
        <button onClick={handleSave} disabled={saving} className="bg-green-700 text-white px-8 py-3 rounded-lg font-medium hover:bg-green-800 disabled:opacity-50">
          {saving ? 'Saving...' : 'Save Settings'}
        </button>
      </div>
    </div>
  )
}
