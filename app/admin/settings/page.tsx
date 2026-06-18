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
  same_day_cutoff_time: '11:00 AM',
  same_day_cutoff_message: 'Same-day reservations are not available online. Please call us to book.',
  extra_adult_fee: '',
  extra_child_fee: '',
  base_occupancy_adults: 2,
  base_occupancy_children: 2,
  total_sites: 84,
  total_cabins: 3,
  seasonal_enabled: false,
  auto_sync_guests: false,
  max_credit_amount: 0,
  cancellation_policy: '',
  early_checkin_enabled: false,
  early_checkin_price: 0,
  early_checkin_time: '12:00',
  early_checkin_show_customers: false,
  late_checkout_enabled: false,
  late_checkout_price: 0,
  late_checkout_time: '12:00',
  late_checkout_show_customers: false,
  confirmation_message: '',
  accent_color: '#2D6A4F',
  show_site_map: false,
  admin_password: '',
  sender_name: '',
  sender_email: '',
  reply_to_email: '',
  use_custom_sender: false,
  season_start: 'May 1',
  season_end: 'October 11',
  closed_season_message: 'We are closed for the season. We look forward to welcoming you back next year!',
  waiver_enabled: true,
  waiver_text: '',
  maintenance_mode: false,
  maintenance_message: 'We are temporarily unavailable for online reservations. Please call us to book your stay!',
  deposit_type: 'first_night',
  deposit_value: 0,
}

export default function SettingsPage() {
  const [form, setForm] = useState(defaultSettings)
  const [settingsId, setSettingsId] = useState(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [squareConnected, setSquareConnected] = useState<boolean | null>(null)
  const [plan, setPlan] = useState('trailhead')
  const [earlyPriceInput, setEarlyPriceInput] = useState('0.00')
  const [latePriceInput, setLatePriceInput] = useState('0.00')
  const [uploadingLogo, setUploadingLogo] = useState(false)
  useEffect(() => { setEarlyPriceInput((form.early_checkin_price / 100).toFixed(2)) }, [form.early_checkin_price])
  useEffect(() => { setLatePriceInput((form.late_checkout_price / 100).toFixed(2)) }, [form.late_checkout_price])
  const fileInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => { fetchSettings() }, [])

  async function fetchSettings() {
    const { data } = await supabase.from('settings').select('*').limit(1).single()
    if (data) {
      setSettingsId(data.id)
      setPlan(data.plan || 'trailhead')
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
        same_day_cutoff_message: data.same_day_cutoff_message || 'Same-day reservations are not available online. Please call us to book.',
        extra_adult_fee: (data.extra_adult_fee / 100).toString(),
        extra_child_fee: (data.extra_child_fee / 100).toString(),
        base_occupancy_adults: data.base_occupancy_adults || 2,
        base_occupancy_children: data.base_occupancy_children || 2,
        total_sites: data.total_sites || 84,
        total_cabins: data.total_cabins || 3,
        seasonal_enabled: data.seasonal_enabled || false,
        auto_sync_guests: data.auto_sync_guests || false,
        max_credit_amount: data.max_credit_amount || 0,
        cancellation_policy: data.cancellation_policy || '',
        early_checkin_enabled: data.early_checkin_enabled || false,
        early_checkin_price: data.early_checkin_price || 0,
        early_checkin_time: data.early_checkin_time || '12:00',
        early_checkin_show_customers: data.early_checkin_show_customers || false,
        late_checkout_enabled: data.late_checkout_enabled || false,
        late_checkout_price: data.late_checkout_price || 0,
        late_checkout_time: data.late_checkout_time || '12:00',
        late_checkout_show_customers: data.late_checkout_show_customers || false,
        confirmation_message: data.confirmation_message || '',
        accent_color: data.accent_color || '#2D6A4F',
        show_site_map: data.show_site_map || false,
        admin_password: '',
        sender_name: data.sender_name || '',
        sender_email: data.sender_email || '',
        reply_to_email: data.reply_to_email || '',
        use_custom_sender: data.use_custom_sender || false,
        season_start: data.season_start || 'May 1',
        season_end: data.season_end || 'October 11',
        closed_season_message: data.closed_season_message || 'We are closed for the season. We look forward to welcoming you back next year!',
        waiver_enabled: data.waiver_enabled !== false,
        waiver_text: data.waiver_text || '',
        maintenance_mode: data.maintenance_mode || false,
        maintenance_message: data.maintenance_message || 'We are temporarily unavailable for online reservations. Please call us to book your stay!',
        deposit_type: data.deposit_type || 'first_night',
        deposit_value: data.deposit_value || 0,
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
      same_day_cutoff_message: form.same_day_cutoff_message,
      extra_adult_fee: Math.round(parseFloat(form.extra_adult_fee) * 100),
      extra_child_fee: Math.round(parseFloat(form.extra_child_fee) * 100),
      base_occupancy_adults: form.base_occupancy_adults,
      base_occupancy_children: form.base_occupancy_children,
      total_sites: form.total_sites,
      total_cabins: form.total_cabins,
      seasonal_enabled: form.seasonal_enabled,
      auto_sync_guests: form.auto_sync_guests,
      max_credit_amount: form.max_credit_amount,
      cancellation_policy: form.cancellation_policy,
      early_checkin_enabled: form.early_checkin_enabled,
      early_checkin_price: form.early_checkin_price,
      early_checkin_time: form.early_checkin_time,
      early_checkin_show_customers: form.early_checkin_show_customers,
      late_checkout_enabled: form.late_checkout_enabled,
      late_checkout_price: form.late_checkout_price,
      late_checkout_time: form.late_checkout_time,
      late_checkout_show_customers: form.late_checkout_show_customers,
      confirmation_message: form.confirmation_message,
      accent_color: form.accent_color,
      show_site_map: form.show_site_map,
      ...(form.admin_password ? { admin_password: form.admin_password } : {}),
      sender_name: form.sender_name,
      sender_email: form.sender_email,
      reply_to_email: form.reply_to_email,
      use_custom_sender: form.use_custom_sender,
      season_start: form.season_start,
      season_end: form.season_end,
      closed_season_message: form.closed_season_message,
      waiver_enabled: form.waiver_enabled,
      waiver_text: form.waiver_text,
      maintenance_mode: form.maintenance_mode,
      maintenance_message: form.maintenance_message,
      deposit_type: form.deposit_type,
      deposit_value: form.deposit_value || 0,
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

  useEffect(() => {
    fetch('/api/square/status')
      .then(res => res.json())
      .then(data => setSquareConnected(!!data.connected))
      .catch(() => setSquareConnected(false))
  }, [])

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

        {/* Square Payments */}
        <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-6">
          <div className="flex items-start justify-between gap-4 flex-wrap">
            <div className="flex-1 min-w-0">
              <h3 className="text-lg font-semibold text-gray-900 mb-1">Square Payments</h3>
              <p className="text-sm text-gray-500 mb-3">Connect your Square account so guests can pay for reservations online.</p>
              {squareConnected === true && (
                <div className="inline-flex items-center gap-2 text-sm text-green-700">
                  <div className="w-2 h-2 rounded-full bg-green-500"></div>
                  Connected
                </div>
              )}
              {squareConnected === false && (
                <div className="inline-flex items-center gap-2 text-sm text-gray-500">
                  <div className="w-2 h-2 rounded-full bg-gray-300"></div>
                  Not connected
                </div>
              )}
            </div>
            <a href="/admin/settings/square" className="bg-green-700 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-green-800 whitespace-nowrap">
              {squareConnected ? 'Manage' : 'Connect Square'}
            </a>
          </div>
        </div>
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
            <div><label className="block text-sm font-medium text-gray-700 mb-1">Sender Name</label><p className="text-xs text-gray-400 mb-1">Name guests see in their inbox</p><input className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm" placeholder="e.g. Cady Hollow Campground" value={form.sender_name} onChange={e => setForm({ ...form, sender_name: e.target.value })} /></div>

            {/* Sender Email — Summit only */}
            {plan === 'summit' && (
              <div><label className="block text-sm font-medium text-gray-700 mb-1">Sender Email</label><p className="text-xs text-gray-400 mb-1">Must be verified in Resend</p><input type="email" className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm" placeholder="e.g. bookings@cadyhollow.com" value={form.sender_email} onChange={e => setForm({ ...form, sender_email: e.target.value })} /></div>
            )}

            <div><label className="block text-sm font-medium text-gray-700 mb-1">Reply-To Email</label><p className="text-xs text-gray-400 mb-1">Where guest replies go</p><input type="email" className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm" placeholder="e.g. hello@cadyhollow.com" value={form.reply_to_email} onChange={e => setForm({ ...form, reply_to_email: e.target.value })} /></div>

            {/* Use Custom Sender — Summit only */}
            {plan === 'summit' && (
              <div className="md:col-span-2 flex items-center justify-between p-4 bg-gray-50 rounded-lg border border-gray-200">
                <div>
                  <p className="text-sm font-medium text-gray-900">Use Custom Sender</p>
                  <p className="text-xs text-gray-500 mt-0.5">{form.use_custom_sender ? 'Emails send from your custom sender email above.' : 'Emails send from the default bookings address.'}</p>
                </div>
                <button type="button" onClick={() => setForm({ ...form, use_custom_sender: !form.use_custom_sender })}
                  className="relative inline-flex h-7 w-14 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ml-4"
                  style={{ backgroundColor: form.use_custom_sender ? '#15803d' : '#d1d5db' }}>
                  <span className="pointer-events-none inline-block h-6 w-6 transform rounded-full bg-white shadow-md transition duration-200"
                    style={{ transform: form.use_custom_sender ? 'translateX(28px)' : 'translateX(0px)' }} />
                </button>
              </div>
            )}

            <div><label className="block text-sm font-medium text-gray-700 mb-1">Brand Color</label><div className="flex items-center gap-3"><input type="color" className="w-12 h-10 rounded border border-gray-200 cursor-pointer" value={form.accent_color} onChange={e => setForm({ ...form, accent_color: e.target.value })} /><input className="flex-1 border border-gray-200 rounded-lg px-3 py-2 text-sm font-mono" value={form.accent_color} onChange={e => setForm({ ...form, accent_color: e.target.value })} /></div></div>
          </div>

          {/* Show Site Map — Ridgeline and Summit only */}
          {['ridgeline', 'summit'].includes(plan) && (
            <div className="mt-4 pt-4 border-t border-gray-100 flex items-center justify-between">
              <div>
                <p className="text-sm font-medium text-gray-700">Show Site Map</p>
                <p className="text-xs text-gray-500 mt-0.5">{form.show_site_map ? 'Guests see the interactive map when browsing sites.' : 'Guests see a list view when browsing sites.'}</p>
              </div>
              <button type="button" onClick={() => setForm({ ...form, show_site_map: !form.show_site_map })}
                className="relative inline-flex h-7 w-14 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ml-6"
                style={{ backgroundColor: form.show_site_map ? '#15803d' : '#d1d5db' }}>
                <span className="pointer-events-none inline-block h-6 w-6 transform rounded-full bg-white shadow-md transition duration-200"
                  style={{ transform: form.show_site_map ? 'translateX(28px)' : 'translateX(0px)' }} />
              </button>
            </div>
          )}
        </div>

        {/* Booking Rules */}
        <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-6">
          <h3 className="text-lg font-semibold text-gray-900 mb-4">Booking Rules</h3>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div><label className="block text-sm font-medium text-gray-700 mb-1">Check-In Time</label><input className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm" value={form.check_in_time} onChange={e => setForm({ ...form, check_in_time: e.target.value })} /></div>
            <div><label className="block text-sm font-medium text-gray-700 mb-1">Check-Out Time</label><input className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm" value={form.check_out_time} onChange={e => setForm({ ...form, check_out_time: e.target.value })} /></div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Same-Day Booking Cutoff</label>
              <input className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm" placeholder="e.g. 11:00 AM (leave blank to allow all day)" value={form.same_day_cutoff_time} onChange={e => setForm({ ...form, same_day_cutoff_time: e.target.value })} />
              <p className="text-xs text-gray-400 mt-1">Leave blank to allow same-day bookings at any time.</p>
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Same-Day Cutoff Message</label>
              <input className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm" placeholder="e.g. Please call for same-day reservations." value={form.same_day_cutoff_message} onChange={e => setForm({ ...form, same_day_cutoff_message: e.target.value })} />
              <p className="text-xs text-gray-400 mt-1">Shown to guests when same-day booking is blocked.</p>
            </div>
            <div><label className="block text-sm font-medium text-gray-700 mb-1">Base Occupancy — Adults</label><input type="number" className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm" value={form.base_occupancy_adults} onChange={e => setForm({ ...form, base_occupancy_adults: parseInt(e.target.value) })} /></div>
            <div><label className="block text-sm font-medium text-gray-700 mb-1">Base Occupancy — Children</label><input type="number" className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm" value={form.base_occupancy_children} onChange={e => setForm({ ...form, base_occupancy_children: parseInt(e.target.value) })} /></div>
            <div><label className="block text-sm font-medium text-gray-700 mb-1">Extra Adult Fee ($/night)</label><input type="number" className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm" value={form.extra_adult_fee} onChange={e => setForm({ ...form, extra_adult_fee: e.target.value })} /></div>
            <div><label className="block text-sm font-medium text-gray-700 mb-1">Total Campsites</label><p className="text-xs text-gray-400 mb-1">Non-cabin sites at your campground (used for occupancy reporting)</p><input type="number" className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm" value={form.total_sites} onChange={e => setForm({ ...form, total_sites: parseInt(e.target.value) || 0 })} /></div>
            <div><label className="block text-sm font-medium text-gray-700 mb-1">Total Cabins</label><p className="text-xs text-gray-400 mb-1">Cabin units tracked separately in occupancy reporting</p><input type="number" className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm" value={form.total_cabins} onChange={e => setForm({ ...form, total_cabins: parseInt(e.target.value) || 0 })} /></div>
            <div><label className="block text-sm font-medium text-gray-700 mb-1">Extra Child Fee ($/night)</label><input type="number" className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm" value={form.extra_child_fee} onChange={e => setForm({ ...form, extra_child_fee: e.target.value })} /></div>
            <div className="col-span-full"><label className="block text-sm font-medium text-gray-700 mb-1">Seasonal Camper Management</label><p className="text-xs text-gray-400 mb-2">Enable seasonal camper features — guest accounts, electric billing, seasonal reports (Summit plan only)</p><div className="flex items-center gap-3"><button type="button" onClick={() => setForm({...form, seasonal_enabled: !form.seasonal_enabled})} style={{width:44,height:24,borderRadius:12,border:'none',cursor:'pointer',backgroundColor:form.seasonal_enabled?'#15803d':'#d1d5db',position:'relative',flexShrink:0,transition:'background 0.2s'}}><span style={{position:'absolute',top:3,left:form.seasonal_enabled?23:3,width:18,height:18,borderRadius:'50%',backgroundColor:'white',transition:'left 0.2s'}}/></button><span className="text-sm text-gray-700">{form.seasonal_enabled ? 'Enabled' : 'Disabled'}</span></div></div><div className="col-span-full"><label className="block text-sm font-medium text-gray-700 mb-1">Automatic Guest Sync</label><p className="text-xs text-gray-400 mb-2">Automatically add guests to your Guest Directory as reservations come in. Leave this off while testing so test bookings don't get added — you can always use the manual Sync button.</p><div className="flex items-center gap-3"><button type="button" onClick={() => setForm({...form, auto_sync_guests: !form.auto_sync_guests})} style={{width:44,height:24,borderRadius:12,border:'none',cursor:'pointer',backgroundColor:form.auto_sync_guests?'#15803d':'#d1d5db',position:'relative',flexShrink:0,transition:'background 0.2s'}}><span style={{position:'absolute',top:3,left:form.auto_sync_guests?23:3,width:18,height:18,borderRadius:'50%',backgroundColor:'white',transition:'left 0.2s'}}/></button><span className="text-sm text-gray-700">{form.auto_sync_guests ? 'Enabled' : 'Disabled'}</span></div></div>
            <div><label className="block text-sm font-medium text-gray-700 mb-1">Maximum Credit Balance (seasonal campers)</label><p className="text-xs text-gray-400 mb-1">Allow seasonal campers to carry a credit balance up to this amount. Set to $0 to disallow credits — any overpayment will trigger a warning.</p><div className="flex items-center gap-2"><span className="text-sm text-gray-500">$</span><input type="number" min="0" step="1" className="w-32 border border-gray-200 rounded-lg px-3 py-2 text-sm" value={form.max_credit_amount / 100} onChange={e => setForm({ ...form, max_credit_amount: Math.round(parseFloat(e.target.value || '0') * 100) })} /></div><p className="text-xs text-gray-400 mt-1">{form.max_credit_amount === 0 ? 'Credits disabled — staff will be warned before recording an overpayment' : `Staff can record payments that leave up to $${(form.max_credit_amount/100).toFixed(2)} credit on account`}</p></div>
          </div>
        </div>

        {/* Deposit */}
        <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-6">
          <h3 className="text-lg font-semibold text-gray-900 mb-1">Deposit</h3>
          <p className="text-sm text-gray-500 mb-4">Choose how much guests pay up front when booking. The remaining balance is collected at or before arrival.</p>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Deposit Type</label>
              <select
                className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm"
                value={form.deposit_type}
                onChange={e => setForm({ ...form, deposit_type: e.target.value, deposit_value: 0 })}
              >
                <option value="first_night">First night — first night&apos;s rate plus a share of fees</option>
                <option value="percentage">Percentage of total — a set percent of the full reservation</option>
                <option value="flat">Flat amount — a fixed dollar deposit</option>
                <option value="full">Paid in full — guests pay the entire balance at booking</option>
              </select>
            </div>

            {form.deposit_type === 'percentage' && (
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Deposit Percentage</label>
                <div className="flex items-center gap-2">
                  <input type="number" min="0" max="100" step="1" className="w-28 border border-gray-200 rounded-lg px-3 py-2 text-sm"
                    value={form.deposit_value}
                    onChange={e => setForm({ ...form, deposit_value: Math.min(parseInt(e.target.value) || 0, 100) })} />
                  <span className="text-sm text-gray-500">% of the reservation total</span>
                </div>
                <p className="text-xs text-gray-400 mt-1">Example: 50 means guests pay half up front.</p>
              </div>
            )}

            {form.deposit_type === 'flat' && (
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Deposit Amount</label>
                <div className="flex items-center gap-2">
                  <span className="text-sm text-gray-500">$</span>
                  <input type="number" min="0" step="1" className="w-32 border border-gray-200 rounded-lg px-3 py-2 text-sm"
                    value={form.deposit_value / 100}
                    onChange={e => setForm({ ...form, deposit_value: Math.round(parseFloat(e.target.value || '0') * 100) })} />
                </div>
                <p className="text-xs text-gray-400 mt-1">Capped at the reservation total so it never exceeds the balance.</p>
              </div>
            )}
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
              <p className="text-xs text-gray-500 mt-0.5">{form.waiver_enabled ? 'Guests must read and sign the waiver before they can pay.' : 'No waiver will be shown to guests during checkout.'}</p>
            </div>
            <button type="button" onClick={() => setForm({ ...form, waiver_enabled: !form.waiver_enabled })}
              className="relative inline-flex h-7 w-14 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ml-4"
              style={{ backgroundColor: form.waiver_enabled ? '#15803d' : '#d1d5db' }}>
              <span className="pointer-events-none inline-block h-6 w-6 transform rounded-full bg-white shadow-md transition duration-200"
                style={{ transform: form.waiver_enabled ? 'translateX(28px)' : 'translateX(0px)' }} />
            </button>
          </div>
          {form.waiver_enabled && (
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Waiver Text</label>
              <p className="text-xs text-gray-400 mb-2">Write your full liability waiver here. Use <strong>[CAMPGROUND NAME]</strong> as a placeholder — it will be automatically replaced with your park name when guests see it.</p>
              <textarea className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm font-sans leading-relaxed" rows={16}
                placeholder="Enter your liability waiver text here. Use [CAMPGROUND NAME] where your park name should appear..."
                value={form.waiver_text} onChange={e => setForm({ ...form, waiver_text: e.target.value })} />
              <p className="text-xs text-gray-400 mt-2">💡 Tip: Consult with a legal professional to ensure your waiver is appropriate for your property and jurisdiction.</p>
            </div>
          )}
        </div>

        {/* Maintenance Mode */}
        <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-6">
          <h3 className="text-lg font-semibold text-gray-900 mb-1">Early Check-In & Late Check-Out</h3>
          <p className="text-sm text-gray-500 mb-4">Offer guests the option to check in early or check out late for an additional fee. When shown to customers, early check-in will be automatically hidden if another guest is checking out of the same site that day.</p>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-6 mb-6">
            <div className="p-4 bg-gray-50 rounded-lg border border-gray-200">
              <div className="flex items-center justify-between mb-3">
                <p className="text-sm font-semibold text-gray-900">Early Check-In</p>
                <button type="button" onClick={() => setForm({ ...form, early_checkin_enabled: !form.early_checkin_enabled })}
                  className="relative inline-flex h-7 w-14 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200"
                  style={{ backgroundColor: form.early_checkin_enabled ? '#15803d' : '#d1d5db' }}>
                  <span className="pointer-events-none inline-block h-6 w-6 transform rounded-full bg-white shadow-md transition duration-200"
                    style={{ transform: form.early_checkin_enabled ? 'translateX(28px)' : 'translateX(0px)' }} />
                </button>
              </div>
              {form.early_checkin_enabled && (
                <div className="space-y-3">
                  <div>
                    <label className="block text-xs font-medium text-gray-700 mb-1">Fee</label>
                    <div className="relative">
                      <span className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 text-sm">$</span>
                      <input type="number" min="0" step="0.01"
                        className="w-full border border-gray-200 rounded-lg pl-7 pr-3 py-2 text-sm"
                        value={earlyPriceInput}
                        onChange={e => setEarlyPriceInput(e.target.value)}
                        onBlur={() => setForm({ ...form, early_checkin_price: Math.round((parseFloat(earlyPriceInput) || 0) * 100) })}
                      />
                    </div>
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-gray-700 mb-1">Earliest available check-in time</label>
                    <input type="time"
                      className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm"
                      value={form.early_checkin_time}
                      onChange={e => setForm({ ...form, early_checkin_time: e.target.value })}
                    />
                  </div>
                  <div className="flex items-center justify-between pt-1">
                    <div>
                      <p className="text-xs font-medium text-gray-700">Show to customers at booking</p>
                      <p className="text-xs text-gray-400">Auto-hidden if same-day checkout on that site</p>
                    </div>
                    <button type="button" onClick={() => setForm({ ...form, early_checkin_show_customers: !form.early_checkin_show_customers })}
                      className="relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ml-3"
                      style={{ backgroundColor: form.early_checkin_show_customers ? '#15803d' : '#d1d5db' }}>
                      <span className="pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow-md transition duration-200"
                        style={{ transform: form.early_checkin_show_customers ? 'translateX(20px)' : 'translateX(0px)' }} />
                    </button>
                  </div>
                </div>
              )}
            </div>

            <div className="p-4 bg-gray-50 rounded-lg border border-gray-200">
              <div className="flex items-center justify-between mb-3">
                <p className="text-sm font-semibold text-gray-900">Late Check-Out</p>
                <button type="button" onClick={() => setForm({ ...form, late_checkout_enabled: !form.late_checkout_enabled })}
                  className="relative inline-flex h-7 w-14 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200"
                  style={{ backgroundColor: form.late_checkout_enabled ? '#15803d' : '#d1d5db' }}>
                  <span className="pointer-events-none inline-block h-6 w-6 transform rounded-full bg-white shadow-md transition duration-200"
                    style={{ transform: form.late_checkout_enabled ? 'translateX(28px)' : 'translateX(0px)' }} />
                </button>
              </div>
              {form.late_checkout_enabled && (
                <div className="space-y-3">
                  <div>
                    <label className="block text-xs font-medium text-gray-700 mb-1">Fee</label>
                    <div className="relative">
                      <span className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 text-sm">$</span>
                      <input type="number" min="0" step="0.01"
                        className="w-full border border-gray-200 rounded-lg pl-7 pr-3 py-2 text-sm"
                        value={latePriceInput}
                        onChange={e => setLatePriceInput(e.target.value)}
                        onBlur={() => setForm({ ...form, late_checkout_price: Math.round((parseFloat(latePriceInput) || 0) * 100) })}
                      />
                    </div>
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-gray-700 mb-1">Latest available check-out time</label>
                    <input type="time"
                      className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm"
                      value={form.late_checkout_time}
                      onChange={e => setForm({ ...form, late_checkout_time: e.target.value })}
                    />
                  </div>
                  <div className="flex items-center justify-between pt-1">
                    <div>
                      <p className="text-xs font-medium text-gray-700">Show to customers at booking</p>
                      <p className="text-xs text-gray-400">Auto-hidden if same-day arrival on that site</p>
                    </div>
                    <button type="button" onClick={() => setForm({ ...form, late_checkout_show_customers: !form.late_checkout_show_customers })}
                      className="relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ml-3"
                      style={{ backgroundColor: form.late_checkout_show_customers ? '#15803d' : '#d1d5db' }}>
                      <span className="pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow-md transition duration-200"
                        style={{ transform: form.late_checkout_show_customers ? 'translateX(20px)' : 'translateX(0px)' }} />
                    </button>
                  </div>
                </div>
              )}
            </div>
          </div>

          <h3 className="text-lg font-semibold text-gray-900 mb-1">Maintenance Mode</h3>
          <p className="text-sm text-gray-500 mb-4">When enabled, guests will see your message instead of the booking form. The admin panel remains accessible.</p>
          <div className="flex items-center justify-between mb-4 p-4 bg-gray-50 rounded-lg border border-gray-200">
            <div>
              <p className="text-sm font-medium text-gray-900">Maintenance Mode</p>
              <p className="text-xs text-gray-500 mt-0.5">{form.maintenance_mode ? '⚠️ Booking is currently disabled for guests.' : 'Booking is live and available to guests.'}</p>
            </div>
            <button type="button" onClick={() => setForm({ ...form, maintenance_mode: !form.maintenance_mode })}
              className="relative inline-flex h-7 w-14 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ml-4"
              style={{ backgroundColor: form.maintenance_mode ? '#dc2626' : '#d1d5db' }}>
              <span className="pointer-events-none inline-block h-6 w-6 transform rounded-full bg-white shadow-md transition duration-200"
                style={{ transform: form.maintenance_mode ? 'translateX(28px)' : 'translateX(0px)' }} />
            </button>
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Message shown to guests</label>
            <textarea className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm" rows={3}
              value={form.maintenance_message} onChange={e => setForm({ ...form, maintenance_message: e.target.value })} />
          </div>
        </div>

      </div>

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
