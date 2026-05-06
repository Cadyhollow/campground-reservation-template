'use client'
import { useState, useEffect, useRef } from 'react'
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
  photo_url: string | null
  photo_url_2: string | null
}

type Category = {
  id: number
  name: string
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
  const [sameDayBlock, setSameDayBlock] = useState<string | null>(null)
  const [categories, setCategories] = useState<Category[]>([])
  const [siteCategories, setSiteCategories] = useState<Record<string, number[]>>({})
  const [openCategories, setOpenCategories] = useState<Set<number | 'uncategorized'>>(new Set())
  const [expandedPhotoSiteId, setExpandedPhotoSiteId] = useState<string | null>(null)
  const selectedSiteRef = useRef<HTMLDivElement>(null)

  const today = new Date().toISOString().split('T')[0]

  useEffect(() => {
    supabase.from('settings').select('*').limit(1).single().then(({ data }) => { if (data) setSettings(data) })
    supabase.from('sites').select('site_type').then(({ data }) => {
      if (data) {
        const types = [...new Set(data.map((s: any) => s.site_type))]
        setSiteTypes(types)
      }
    })
    supabase.from('categories').select('*').order('name').then(({ data }) => {
      setCategories(data || [])
    })
  }, [])

  useEffect(() => {
    if (selectedSite && selectedSiteRef.current) {
      selectedSiteRef.current.scrollIntoView({ behavior: 'smooth', block: 'center' })
    }
  }, [selectedSite])

  async function handleSearch() {
    if (!arrival || !departure) { alert('Please select both arrival and departure dates.'); return }
    if (departure <= arrival) { alert('Departure date must be after arrival date.'); return }

    if (settings?.same_day_cutoff_time && arrival === today) {
      const clean = settings.same_day_cutoff_time.trim().toUpperCase()
      const match = clean.match(/^(\d{1,2}):(\d{2})(?::\d{2})?\s*(AM|PM)?$/)
      if (match) {
        let hours = parseInt(match[1])
        const minutes = parseInt(match[2])
        const period = match[3]
        if (period === 'PM' && hours !== 12) hours += 12
        if (period === 'AM' && hours === 12) hours = 0
        const now = new Date()
        const currentMinutes = now.getHours() * 60 + now.getMinutes()
        const cutoffMinutes = hours * 60 + minutes
        if (currentMinutes >= cutoffMinutes) {
          setSameDayBlock(settings.same_day_cutoff_message || 'Same-day reservations are not available online. Please call us.')
          setStep(2)
          return
        }
      }
    }
    setSameDayBlock(null)
    setLoading(true)
    setStep(2)
    setSelectedSite(null)
    setOpenCategories(new Set())

    const res = await fetch(`/api/availability?arrival=${arrival}&departure=${departure}&siteType=${siteType}`)
    const data = await res.json()
    const fetchedSites: Site[] = data.sites || []
    setSites(fetchedSites)
    setIsClosed(data.closed || false)
    setClosedMessage(data.closedMessage || '')
    setSeasonStart(data.seasonStart || '')
    setSeasonEnd(data.seasonEnd || '')

    // Fetch site_categories for these sites
    if (fetchedSites.length > 0) {
      const siteIds = fetchedSites.map(s => s.id)
      const { data: sc } = await supabase
        .from('site_categories')
        .select('*')
        .in('site_id', siteIds)
      if (sc) {
        const map: Record<string, number[]> = {}
        sc.forEach((row: any) => {
          if (!map[row.site_id]) map[row.site_id] = []
          map[row.site_id].push(row.category_id)
        })
        setSiteCategories(map)
      }
    }

    setLoading(false)
  }

  function toggleCategory(id: number | 'uncategorized') {
    setOpenCategories(prev => {
      const next = new Set(prev)
      if (next.has(id)) { next.delete(id) } else { next.add(id) }
      return next
    })
  }

  const siteTypeLabel = (type: string) => ({ rv_site: 'RV Site', cabin: 'Cabin', tent: 'Tent Site' }[type] || type)

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
      arrival, departure,
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

  const logoShapeClass =
    settings?.logo_shape === 'circle' ? 'w-32 h-32 rounded-full' :
    settings?.logo_shape === 'rounded' ? 'w-32 h-32 rounded-xl' :
    settings?.logo_shape === 'square' ? 'w-32 h-32 rounded-none' :
    'w-40 h-24'

  // Group sites by category
  function groupSitesByCategory() {
    const groups: { id: number | 'uncategorized'; name: string; sites: Site[] }[] = []

    if (categories.length === 0) return [{ id: 'uncategorized' as const, name: '', sites }]

    categories.forEach(cat => {
      const catSites = sites.filter(s => siteCategories[s.id]?.includes(cat.id))
      if (catSites.length > 0) {
        groups.push({ id: cat.id, name: cat.name, sites: catSites })
      }
    })

    const uncategorized = sites.filter(s => !siteCategories[s.id] || siteCategories[s.id].length === 0)
    if (uncategorized.length > 0) {
      groups.push({ id: 'uncategorized', name: 'Other Sites', sites: uncategorized })
    }

    return groups
  }

  function renderSiteCard(site: Site) {
    const isSelected = selectedSite?.id === site.id
    const isExpanded = expandedPhotoSiteId === site.id
    return (
      <div key={site.id}
        ref={isSelected ? selectedSiteRef : null}
        className={`rounded-2xl overflow-hidden transition-all ${site.meets_min_stay ? 'cursor-pointer' : 'opacity-60 cursor-not-allowed'}`}
        style={{ backgroundColor: '#2B2B2B', outline: isSelected ? '2px solid var(--accent-color)' : 'none' }}
        onClick={() => site.meets_min_stay && setSelectedSite(site)}
      >
        {/* Main photo */}
        {site.photo_url && (
          <div className="relative w-full h-40 overflow-hidden">
            <Image
              src={site.photo_url}
              alt={`Site ${site.site_number}`}
              fill
              className="object-cover"
            />
            {site.photo_url_2 && (
              <button
                onClick={e => { e.stopPropagation(); setExpandedPhotoSiteId(isExpanded ? null : site.id) }}
                className="absolute bottom-2 right-2 bg-black bg-opacity-60 text-white text-xs px-2 py-1 rounded-full font-medium"
              >
                {isExpanded ? 'Hide interior ▲' : 'See interior ▼'}
              </button>
            )}
          </div>
        )}
        {/* Second photo */}
        {site.photo_url_2 && isExpanded && (
          <div className="relative w-full h-40 overflow-hidden border-t border-gray-700">
            <Image
              src={site.photo_url_2}
              alt={`Site ${site.site_number} interior`}
              fill
              className="object-cover"
            />
          </div>
        )}
        <div className="p-6">
          <div className="flex items-start justify-between mb-3">
            <div>
              <h3 className="text-white font-bold text-lg">
                {siteTypeLabel(site.site_type)} {site.site_number}
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
          {site.meets_min_stay && isSelected && (
            <div className="mt-3 pt-3 border-t border-gray-600">
              <p className="text-sm font-medium" style={{ color: 'var(--accent-color)' }}>Selected — scroll down to continue</p>
            </div>
          )}
        </div>
      </div>
    )
  }

  return (
    <main className="min-h-screen" style={{ backgroundColor: '#1C1C1C' }}>

      {/* Hero */}
      <div className="flex flex-col items-center justify-center px-4 py-12 text-center" style={{ backgroundColor: '#2B2B2B' }}>
        {settings?.logo_url && (
          <div className={`mb-6 overflow-hidden flex items-center justify-center ${logoShapeClass}`}>
            <Image src={settings.logo_url} alt={settings?.park_name || 'Campground'} width={160} height={160} className="object-contain w-full h-full" priority />
          </div>
        )}
        <h1 className="text-3xl font-bold text-white mb-2">Welcome to {settings?.park_name || 'Our Campground'}</h1>
        <p className="text-lg mb-1" style={{ color: 'var(--accent-color)' }}>{settings?.park_location || ''}</p>
        <p className="text-gray-400 mb-8 max-w-md">{settings?.park_tagline || 'Book your perfect campsite, cabin, or tent site today.'}</p>

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
                  <input type="number" min={1} max={20} className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm" value={adults} onChange={e => setAdults(parseInt(e.target.value))} />
                  <p className="text-xs text-gray-400 mt-0.5 text-center">Adults</p>
                </div>
                <div className="flex-1">
                  <input type="number" min={0} max={20} className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm" value={children} onChange={e => setChildren(parseInt(e.target.value))} />
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

          {sameDayBlock ? (
            <div className="rounded-2xl p-12 text-center" style={{ backgroundColor: '#2B2B2B' }}>
              <div className="text-6xl mb-4">📞</div>
              <p className="text-white text-xl font-bold mb-3">Same-Day Reservations</p>
              <p className="text-gray-300 text-base">{sameDayBlock}</p>
            </div>
          ) : loading ? (
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
                    onSelectSite={(site) => {
  const s = site as any
  setSelectedSite(s)
  const catIds = siteCategories[s.id]
  if (catIds && catIds.length > 0) {
    setOpenCategories(prev => {
      const next = new Set(prev)
      catIds.forEach((id: number) => next.add(id))
      return next
    })
  } else {
    setOpenCategories(prev => new Set(prev).add('uncategorized'))
  }
}}
                    sites={sites}
                    availableSiteIds={sites.filter(s => s.meets_min_stay !== false).map(s => s.id)}
                    selectedSiteId={selectedSite?.id}
                    nights={selectedSite?.nights || 0}
                  />
                </div>
              )}

              {/* Category Accordion */}
              {categories.length > 0 ? (
                <div className="space-y-3">
                  {groupSitesByCategory().map(group => (
                    <div key={group.id} className="rounded-2xl overflow-hidden" style={{ backgroundColor: '#2B2B2B' }}>
                      {/* Accordion Header */}
                      <button
                        onClick={() => toggleCategory(group.id)}
                        className="w-full flex items-center justify-between px-6 py-4 text-left hover:opacity-80 transition-opacity"
                      >
                        <div className="flex items-center gap-3">
                          <span className="text-white font-bold text-lg">
                            {group.id === 'uncategorized' ? '🏕️' : '🏷️'} {group.name || 'All Sites'}
                          </span>
                          <span className="text-sm px-2 py-0.5 rounded-full font-medium" style={{ backgroundColor: 'rgba(var(--accent-rgb, 56,189,196), 0.15)', color: 'var(--accent-color)' }}>
                            {group.sites.length} site{group.sites.length !== 1 ? 's' : ''} available
                          </span>
                        </div>
                        <span className="text-gray-400 text-xl">{openCategories.has(group.id) ? '▲' : '▼'}</span>
                      </button>

                      {/* Accordion Content */}
                      {openCategories.has(group.id) && (
                        <div className="px-4 pb-4 grid grid-cols-1 md:grid-cols-2 gap-4 border-t border-gray-700">
                          {group.sites.map(site => renderSiteCard(site))}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              ) : (
                // No categories — show flat grid as before
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  {sites.map(site => renderSiteCard(site))}
                </div>
              )}
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
        © 2026 {settings?.park_name || 'Campground'} · {settings?.park_location || ''}
      </div>
    </main>
  )
}
