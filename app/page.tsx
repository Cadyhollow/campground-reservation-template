'use client'
import { useState, useEffect } from 'react'
import Image from 'next/image'
import CampgroundMap from './components/CampgroundMap'
import { supabase } from '@/lib/supabase'

type Site = {
  id: string
  site_number: string
  site_type: string
  amp_service: string
  max_rv_length: number | null
  hookups: string
  base_rate: number
  nightly_rate: number
  total_price: number
  nights: number
  min_stay: number
  meets_min_stay: boolean
  description: string
}

export default function HomePage() {
  const [step, setStep] = useState(1)
  const [arrival, setArrival] = useState('')
  const [departure, setDeparture] = useState('')
  const [adults, setAdults] = useState(2)
  const [children, setChildren] = useState(0)
  const [siteType, setSiteType] = useState('all')
  const [sites, setSites] = useState<Site[]>([])
  const [loading, setLoading] = useState(false)
  const [selectedSite, setSelectedSite] = useState<Site | null>(null)
  const [isClosed, setIsClosed] = useState(false)
  const [closedMessage, setClosedMessage] = useState('')
  const [seasonStart, setSeasonStart] = useState('')
  const [seasonEnd, setSeasonEnd] = useState('')
  const [settings, setSettings] = useState<any>(null)
  const [siteTypes, setSiteTypes] = useState<string[]>([])

  const today = new Date().toISOString().split('T')[0]

  useEffect(() => {
    supabase.from('settings').select('*').limit(1).single().then(({ data }) => { if (data) setSettings(data) })
    supabase.from('sites').select('site_type').then(({ data }) => {
      if (data) {
        const types = [...new Set(data.map((s: any) => s.site_type))]
        setSiteTypes(types)
      }
    })
  }, [])

  async function handleSearch() {
    if (!arrival || !departure) { alert('Please select both arrival and departure dates.'); return }
    if (departure <= arrival) { alert('Departure date must be after arrival date.'); return }
    setLoading(true)
    setStep(2)
    setSelectedSite(null)
    const res = await fetch(`/api/availability?arrival=${arrival}&departure=${departure}&siteType=${siteType}`)
    const data = await res.json()
    setSites(data.sites || [])
    setIsClosed(data.closed || false)
    setClosedMessage(data.closedMessage || '')
    setSeasonStart(data.seasonStart || '')
    setSeasonEnd(data.seasonEnd || '')
    setLoading(false)
  }

  const siteTypeLabel = (type: string) => ({ rv_site: 'RV Site', cabin: 'Cabin', tent: 'Tent Site' }[type] || type)
  const hookupLabel = (h: string) => ({ full: 'Full Hookup', water_electric: 'Water & Electric', none: 'None' }[h] || h)
  const ampLabel = (a: string) => ({ '30amp': '30 Amp', '30_50amp': '30/50 Amp', none: '' }[a] || '')

  function handleContinue() {
    if (!selectedSite) return
    const params = new URLSearchParams({
      siteId: selectedSite.id,
      siteNumber: selectedSite.site_number,
      siteType: selectedSite.site_type,
      ampService: selectedSite.amp_service,
      hookups: selectedSite.hookups,
      maxLength: selectedSite.max_rv_length?.toString() || '',
      nightlyRate: selectedSite.nightly_rate.toString(),
      totalPrice: selectedSite.total_price.toString(),
      nights: selectedSite.nights.toString(),
      arrival,
      departure,
      adults: adults.toString(),
      children: children.toString(),
    })
    window.location.href = `/book?${params.toString()}`
  }

  const siteTypeInfo: Record<string, { icon: string; label: string; desc: string }> = {
    rv_site: { icon: '🏕️', label: 'RV Sites', desc: 'Full hookup and water & electric sites available with 30 and 30/50 amp service.' },
    cabin: { icon: '🛖', label: 'Cabins', desc: 'Cozy cabins for a comfortable glamping experience in the great outdoors.' },
    tent: { icon: '⛺', label: 'Tent Sites', desc: 'Back to nature tent camping with easy access to all park amenities.' },
    yurt: { icon: '🏠', label: 'Yurts', desc: 'Unique circular yurt accommodations blending comfort with nature.' },
    tiny_home: { icon: '🏡', label: 'Tiny Homes', desc: 'Fully equipped tiny homes for a cozy and modern camping experience.' },
    lodge: { icon: '🏰', label: 'Lodge Rooms', desc: 'Comfortable lodge rooms with all the amenities you need.' },
    glamping: { icon: '✨', label: 'Glamping', desc: 'Glamorous camping with luxury amenities in a beautiful natural setting.' },
    treehouse: { icon: '🌲', label: 'Treehouses', desc: 'Unique treehouse accommodations nestled among the treetops.' },
  }

  return (
    <main className="min-h-screen" style={{ backgroundColor: '#1C1C1C' }}>

      {/* Hero Section */}
      <div className="flex flex-col items-center justify-center px-4 py-16 text-center"
        style={{ backgroundColor: '#2B2B2B' }}>

        <div className={`mb-6 overflow-hidden flex items-center justify-center ${
          settings?.logo_shape === 'circle' ? 'w-40 h-40 rounded-full' :
          settings?.logo_shape === 'rounded' ? 'w-40 h-40 rounded-xl' :
          settings?.logo_shape === 'square' ? 'w-40 h-40 rounded-none' :
          'w-40 h-24'
        }`}>
          <Image
            src={settings?.logo_url || '/images/logo.png'}
            alt={settings?.park_name || 'Campground'}
            width={160}
            height={160}
            className="object-contain w-full h-full"
            priority
          />
        </div>

        <h1 className="text-3xl font-bold text-white mb-2">Welcome to {settings?.park_name || 'Our Campground'}</h1>
        <p className="text-lg mb-1" style={{ color: 'var(--accent-color)' }}>{settings?.park_location || 'Location'}</p>
        <p className="text-gray-400 mb-8 max-w-md">
          {settings?.park_tagline || "Book your perfect campsite, cabin, or tent site today."}
        </p>

        {/* Search Box */}
        <div className="w-full max-w-3xl bg-white rounded-2xl shadow-2xl p-6">
          <h2 className="text-xl font-bold text-gray-900 mb-5">Check Availability</h2>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4 mb-5">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Arrival Date</label>
              <input type="date" className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm" min={today} value={arrival}
                onChange={e => { setArrival(e.target.value); if (departure && departure <= e.target.value) setDeparture('') }} />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Departure Date</label>
              <input type="date" className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm" min={arrival || today} value={departure}
                onChange={e => setDeparture(e.target.value)} />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Guests</label>
              <div className="flex gap-2">
                <div className="flex-1">
                  <input type="number" min={1} max={20} className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm" value={adults}
                    onChange={e => setAdults(parseInt(e.target.value))} />
                  <p className="text-xs text-gray-400 mt-0.5 text-center">Adults</p>
                </div>
                <div className="flex-1">
                  <input type="number" min={0} max={20} className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm" value={children}
                    onChange={e => setChildren(parseInt(e.target.value))} />
                  <p className="text-xs text-gray-400 mt-0.5 text-center">Children</p>
                </div>
              </div>
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Site Type</label>
              <select className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm" value={siteType} onChange={e => setSiteType(e.target.value)}>
                <option value="all">All Types</option>
                <option value="rv_site">RV Sites</option>
                <option value="cabin">Cabins</option>
                <option value="tent">Tent Sites</option>
              </select>
            </div>
          </div>
          <button onClick={handleSearch}
            className="w-full py-3 rounded-xl text-white font-semibold text-lg transition-colors"
            style={{ backgroundColor: 'var(--accent-color)' }}
            onMouseOver={e => (e.currentTarget.style.backgroundColor = '#2DADC4')}
            onMouseOut={e => (e.currentTarget.style.backgroundColor = 'var(--accent-color)')}>
            Search Available Sites
          </button>
        </div>
      </div>

      {/* Feature Cards */}
      {step === 1 && siteTypes.length > 0 && (
        <div className="max-w-5xl mx-auto px-4 py-16 grid grid-cols-1 md:grid-cols-3 gap-8 text-center">
          {siteTypes.map(type => {
            const info = siteTypeInfo[type] || { icon: '🏕️', label: type, desc: 'Come enjoy your stay with us.' }
            return (
              <div key={type} className="rounded-2xl p-6" style={{ backgroundColor: '#2B2B2B' }}>
                <div className="text-4xl mb-3">{info.icon}</div>
                <h3 className="text-white font-bold text-lg mb-2">{info.label}</h3>
                <p className="text-gray-400 text-sm">{info.desc}</p>
              </div>
            )
          })}
        </div>
      )}

      {/* Results */}
      {step === 2 && (
        <div className="max-w-5xl mx-auto px-4 py-12">
          <div className="flex items-center justify-between mb-6">
            <div>
              <h2 className="text-2xl font-bold text-white">Available Sites</h2>
              <p className="text-gray-400 text-sm mt-1">
                {arrival} → {departure} · {adults} adult{adults !== 1 ? 's' : ''}
                {children > 0 ? `, ${children} child${children !== 1 ? 'ren' : ''}` : ''}
              </p>
            </div>
            <button onClick={() => { setStep(1); setSelectedSite(null) }}
              className="text-sm px-4 py-2 rounded-lg"
              style={{ backgroundColor: '#2B2B2B', color: 'var(--accent-color)' }}>
              ← Change Dates
            </button>
          </div>

          {loading ? (
            <div className="rounded-2xl p-12 text-center" style={{ backgroundColor: '#2B2B2B' }}>
              <p className="text-gray-400 text-lg">Searching for available sites...</p>
            </div>
          ) : isClosed ? (
            <div className="rounded-2xl p-12 text-center" style={{ backgroundColor: '#2B2B2B' }}>
              <div className="text-6xl mb-4">❄️</div>
              <p className="text-white text-xl font-bold mb-3">We're Closed for the Season</p>
              <p className="text-gray-400 mb-4">{closedMessage}</p>
              <p className="text-sm" style={{ color: 'var(--accent-color)' }}>We are open from {seasonStart} through {seasonEnd}</p>
            </div>
          ) : sites.length === 0 ? (
            <div className="rounded-2xl p-12 text-center" style={{ backgroundColor: '#2B2B2B' }}>
              <p className="text-white text-lg font-semibold mb-2">No sites available</p>
              <p className="text-gray-400">Try different dates or a different site type.</p>
            </div>
          ) : (
            <>
              {settings?.show_site_map && (
                <div className="rounded-2xl p-4 mb-6" style={{ backgroundColor: '#2B2B2B' }}>
                  <h3 className="text-white font-semibold mb-3 text-sm">
                    Click a site on the map to select it — <span className="text-gray-400">grey = not available for selected dates</span>
                  </h3>
                  <CampgroundMap
                    onSiteSelect={(site) => setSelectedSite(site as any)}
                    arrival={arrival}
                    departure={departure}
                    bookedSiteIds={sites.filter(s => s.meets_min_stay === false).map(s => s.id)}
                  />
                </div>
              )}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {sites.map(site => (
                  <div key={site.id}
                    onClick={() => site.meets_min_stay && setSelectedSite(site)}
                    className={`rounded-2xl p-6 transition-all ${site.meets_min_stay ? 'cursor-pointer' : 'opacity-60 cursor-not-allowed'}`}
                    style={{ backgroundColor: '#2B2B2B', outline: selectedSite?.id === site.id ? '2px solid var(--accent-color)' : 'none' }}>
                    <div className="flex items-start justify-between mb-3">
                      <div>
                        <h3 className="text-white font-bold text-lg">
                          {site.site_type === 'rv_site' ? 'RV Site' : site.site_type === 'cabin' ? 'Cabin' : 'Tent Site'} {site.site_number}
                        </h3>
                        <p className="text-sm" style={{ color: 'var(--accent-color)' }}>
                          {site.site_type === 'rv_site' && `${site.amp_service === '30amp' ? '30 Amp' : '30/50 Amp'} · ${site.hookups === 'full' ? 'Full Hookup' : 'Water & Electric'}`}
                          {site.site_type === 'cabin' && 'Private Cabin'}
                          {site.site_type === 'tent' && 'Tent Site'}
                        </p>
                      </div>
                      <div className="text-right">
                        <p className="text-white font-bold text-xl">${(site.nightly_rate / 100).toFixed(0)}<span className="text-sm font-normal text-gray-400">/night</span></p>
                        <p className="text-sm text-gray-400">${(site.total_price / 100).toFixed(0)} total</p>
                      </div>
                    </div>
                    {site.max_rv_length && <p className="text-gray-400 text-sm mb-2">Max RV length: {site.max_rv_length}ft</p>}
                    {site.description && <p className="text-gray-400 text-sm mb-2">{site.description}</p>}
                    {!site.meets_min_stay && <p className="text-yellow-400 text-sm mt-2">Minimum {site.min_stay} nights required for this site</p>}
                    {site.meets_min_stay && selectedSite?.id === site.id && (
                      <div className="mt-3 pt-3 border-t border-gray-600">
                        <p className="text-sm font-medium" style={{ color: 'var(--accent-color)' }}>Selected — scroll down to continue</p>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </>
          )}

          {selectedSite && (
            <div className="mt-8 rounded-2xl p-6" style={{ backgroundColor: '#2B2B2B' }}>
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-white font-semibold">{siteTypeLabel(selectedSite.site_type)} {selectedSite.site_number} selected</p>
                  <p className="text-gray-400 text-sm">{selectedSite.nights} nights · ${(selectedSite.total_price / 100).toFixed(2)} total</p>
                </div>
                <button className="px-8 py-3 rounded-xl text-white font-semibold transition-colors"
                  style={{ backgroundColor: 'var(--accent-color)' }}
                  onMouseOver={e => (e.currentTarget.style.backgroundColor = '#2DADC4')}
                  onMouseOut={e => (e.currentTarget.style.backgroundColor = 'var(--accent-color)')}
                  onClick={handleContinue}>
                  Continue →
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Footer */}
      <div className="text-center py-8 text-gray-600 text-sm">
        © 2026 {settings?.park_name || 'Campground'} · {settings?.park_location || 'Location'}
      </div>
    </main>
  )
}
