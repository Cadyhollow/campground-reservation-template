'use client'
import { useState, useEffect, useRef } from 'react'
import Image from 'next/image'
import CampgroundMap from './components/CampgroundMap'
import type { HomeData } from '@/lib/home-server'
// Safe to import into the browser bundle: lib/bookability.ts has no imports of its own and no
// Supabase client — the reason it was written that way. The picker's bound is derived by the SAME
// arithmetic the server enforces with, so the two cannot drift and offer a date create refuses.
import { resolveMaxAdvanceDays, horizonLastArrival, isNightInSeason, checkSeasonSpan, seasonLastNight, monthDayLabel } from '@/lib/bookability'

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
  /** The party-above-occupancy charge already included in total_price. Same on every card. */
  extra_guest_fee: number
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

// The booking page's interactive half. Split out of app/page.tsx, which is now a server
// component that reads the park settings and hands them in below — see the comment on
// `initialSettings` for why.
export default function HomeClient({
  initialSettings,
  initialHome,
}: {
  initialSettings: any
  initialHome: HomeData
}) {
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
  // Seeded from the server read, NOT null. This is the whole fix: `settings` drives the hero
  // image, the logo, the park name and — critically — whether the hero section is a 520px
  // photo or a 100px flat band. Starting at null meant the first paint always rendered the
  // no-hero variant and then jumped, because the settings arrived in a useEffect after mount.
  // The theme has been resolved server-side for exactly this reason; the hero now is too.
  const [settings, setSettings] = useState<any>(initialSettings ?? null)
  const [siteTypes] = useState<string[]>(initialHome.siteTypes)
  const [sameDayBlock, setSameDayBlock] = useState<string | null>(null)
  const [outOfWindow, setOutOfWindow] = useState<string | null>(null)
  const [outOfSeason, setOutOfSeason] = useState<string | null>(null)
  const [categories] = useState<Category[]>(initialHome.categories)
  const [siteCategories, setSiteCategories] = useState<Record<string, number[]>>({})
  const [openCategories, setOpenCategories] = useState<Set<number | 'uncategorized'>>(new Set())
  const [expandedPhotoSiteId, setExpandedPhotoSiteId] = useState<string | null>(null)
  const selectedSiteRef = useRef<HTMLDivElement>(null)

  const today = new Date().toISOString().split('T')[0]

  // The booking horizon, as the calendar sees it.
  //
  // NO SLACK here, on purpose. The server allows one day past this (it has no park timezone —
  // see HORIZON_SERVER_SLACK_DAYS), so the picker being the stricter of the two guarantees that
  // every date it offers is a date /api/payment will honour. The asymmetry must never run the
  // other way: a calendar that offers a day the charge route refuses is a guest filling in their
  // card details to be told no.
  //
  // null when the park has set no window, in which case the input gets no `max` at all and
  // behaves exactly as it did before this feature.
  const maxAdvanceDays = resolveMaxAdvanceDays(settings?.max_advance_days)
  const horizonMaxDate = maxAdvanceDays === null ? null : horizonLastArrival(maxAdvanceDays, today)

  // Closed-season dates, greyed out in the picker.
  //
  // <input type="date"> has no "disable these particular days" — only min/max — and a season can
  // sit anywhere inside the horizon, so the season cannot be expressed as a bound. Instead the
  // input is left unbounded by season and the SELECTED dates are checked below, which is also the
  // honest arrangement: the graying is UX, and /api/payment is the enforcement either way.
  //
  // What the picker CAN do cheaply is refuse to leave a closed date selected, and say why.
  const seasonConfigured = isNightInSeason(today, settings) !== null
  // The closing day is a CHECKOUT day, so an arrival on it is out of season like any other closed
  // date — isNightInSeason already says so, and this flag inherits that for free.
  const arrivalOutOfSeason = seasonConfigured && !!arrival && isNightInSeason(arrival, settings) === false
  // "Open May 1 through October 11" invites exactly the arrival the server refuses, so the hint
  // names the last night a guest can actually book instead of leaving them to infer it.
  const lastNightLabel = monthDayLabel(seasonLastNight(settings))
  const stayOutOfSeason =
    seasonConfigured && !!arrival && !!departure && departure > arrival &&
    !checkSeasonSpan(arrival, departure, settings).bookable

  // Security PR 7-1: the site types and categories that used to be fetched here on mount are
  // now props. They were two anon-key reads from the browser, they are settled before the
  // camper touches anything, and under the locked-down schema anon can no longer read either
  // table — so they are read on the server by lib/home-server.ts and handed in.

  useEffect(() => {
    if (selectedSite && selectedSiteRef.current) {
      selectedSiteRef.current.scrollIntoView({ behavior: 'smooth', block: 'center' })
    }
  }, [selectedSite])

  async function handleSearch() {
    if (!arrival || !departure) { alert('Please select both arrival and departure dates.'); return }
    if (departure <= arrival) { alert('Departure date must be after arrival date.'); return }

    // THE SEASON — a hard block for the public flow. No override exists here and none should:
    // waiving a closure is a staff act, and a guest cannot occupy a site the park has shut.
    //
    // Whole-stay, matching the server exactly: a stay that starts in season and runs past closing
    // is refused, which is the hole this closes. Advisory only — /api/payment refuses it too.
    if (stayOutOfSeason) {
      setOutOfSeason(settings?.closed_season_message || 'We are closed for the season.')
      setOutOfWindow(null)
      setSameDayBlock(null)
      setStep(2)
      return
    }
    setOutOfSeason(null)

    // The horizon, checked explicitly rather than relying on the input's `max`.
    //
    // `min`/`max` on <input type="date"> are ADVISORY: they grey out days in the native picker
    // and mark the field :invalid, but they do not stop a value that arrives by paste, by
    // autofill, or from a browser whose picker ignores them. Neither this nor the input attribute
    // is the enforcement — /api/payment is — but a guest should be told here rather than after
    // choosing a site.
    //
    // ARRIVAL only. A stay that starts inside the window and ends outside it is fine; see the
    // note on checkHorizon.
    if (horizonMaxDate && arrival > horizonMaxDate) {
      setOutOfWindow(
        `We accept reservations up to ${maxAdvanceDays} day${maxAdvanceDays === 1 ? '' : 's'} in advance. Please choose an arrival date on or before ${horizonMaxDate}.`
      )
      setSameDayBlock(null)
      setStep(2)
      return
    }
    setOutOfWindow(null)

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

    // adults/children go with the search so the card can include the extra-guest fee. The form
    // has always collected them; it just never sent them, so every booking above the park's base
    // occupancy was quoted low and then grew at checkout.
    const res = await fetch(`/api/availability?arrival=${arrival}&departure=${departure}&siteType=${siteType}&adults=${adults}&children=${children}`)
    const data = await res.json()
    const fetchedSites: Site[] = data.sites || []
    setSites(fetchedSites)
    setIsClosed(data.closed || false)
    // The route's own horizon verdict. The guard above should have caught this already, so
    // reaching here means the two disagreed — a stale settings prop in the browser, or a search
    // fired before the page had settings. The server's answer wins, and the guest sees the same
    // wording either way.
    if (data.outOfWindow) setOutOfWindow(data.horizonMessage || null)
    // The route's own season verdict. `closed` now reflects the WHOLE STAY, so it fires for a
    // stay that begins in season and runs past closing, not just an out-of-season arrival.
    if (data.closed) setOutOfSeason(data.closedMessage || null)
    setClosedMessage(data.closedMessage || '')
    setSeasonStart(data.seasonStart || '')
    setSeasonEnd(data.seasonEnd || '')

    // site_categories used to be a second round trip from the browser — an anon-key read of
    // every category assignment for the sites just returned. It depends on the search, so it
    // could not become a page prop; instead /api/availability, which already produced these
    // sites server-side, now returns the mapping with them.
    if (fetchedSites.length > 0 && data.siteCategories) {
      setSiteCategories(data.siteCategories)
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
      // NO `totalPrice`. It used to carry this card's FEES-INCLUSIVE total, which /book then
      // treated as the stay base and applied every fee to a second time. /book now derives the
      // stay itself from nightlyRate × nights — the same expression /api/payment uses — so
      // there is nothing left for this parameter to say that is not already here, and a link
      // that still carries one from an older session is simply ignored rather than mispriced.
      nights: selectedSite.nights.toString(),
      arrival, departure,
      adults: adults.toString(),
      children: children.toString(),
    })
    window.location.href = `/book?${params.toString()}`
  }

  const siteTypeInfo: Record<string, { icon: string; label: string; desc: string }> = {
    rv_site: { icon: '🏕️', label: 'RV Sites', desc: 'Pull in and plug in — our RV sites offer the hookups and space you need for a comfortable stay.' },
    cabin: { icon: '🛖', label: 'Cabins', desc: 'Cozy and comfortable, our cabins let you enjoy the outdoors without giving up the comforts of home.' },
    tent: { icon: '⛺', label: 'Tent Sites', desc: 'Get back to nature with a classic camping experience surrounded by the great outdoors.' },
    yurt: { icon: '🏠', label: 'Yurts', desc: 'A unique and comfortable stay in a traditional circular dwelling nestled in nature.' },
    tiny_home: { icon: '🏡', label: 'Tiny Homes', desc: 'Fully equipped and thoughtfully designed tiny homes for a cozy modern getaway.' },
    lodge: { icon: '🏰', label: 'Lodge Rooms', desc: 'Comfortable lodge accommodations with everything you need for a relaxing stay.' },
    glamping: { icon: '✨', label: 'Glamping', desc: 'Experience the beauty of the outdoors with upscale amenities and stylish accommodations.' },
    treehouse: { icon: '🌲', label: 'Treehouses', desc: 'Spend the night among the treetops in a one-of-a-kind elevated retreat.' },
  }

  // Read defensively: `hero_image_url` isn't in every tenant's settings table yet. The
  // settings read above is select('*'), so a missing column is simply absent from the row
  // and this lands on null — no hero, no throw. An empty/whitespace value counts as unset
  // too, so a cleared field falls back to the plain header band rather than an empty box.
  const heroImageUrl =
    typeof settings?.hero_image_url === 'string' && settings.hero_image_url.trim()
      ? settings.hero_image_url.trim()
      : null

  // Clicking a date field only puts the caret in a segment (mm/dd/yyyy) — on desktop it does
  // not open the calendar, so a camper who clicks the field sees nothing happen. Tapping on
  // iOS/iPadOS opens the native picker regardless, which is why this only looks broken on
  // desktop. showPicker() opens it explicitly.
  //
  // It must be called from a real user gesture or it throws NotAllowedError, so it hangs off
  // onClick rather than onFocus — that also keeps the picker from springing open when someone
  // merely tabs through the field. Optional-called and wrapped: any browser without it (or
  // that refuses the call) simply falls back to today's behavior instead of throwing.
  function openDatePicker(e: React.MouseEvent<HTMLInputElement>) {
    try { e.currentTarget.showPicker?.() } catch { /* unsupported or gesture refused — no-op */ }
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
        style={{ backgroundColor: 'var(--surface-card)', outline: isSelected ? '2px solid var(--accent-color)' : 'none' }}
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
          <div className="relative w-full h-40 overflow-hidden border-t border-[var(--border)]">
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
              <h3 className="text-[var(--text-primary)] font-bold text-lg">
                {siteTypeLabel(site.site_type)} {site.site_number}
              </h3>
              <p className="text-sm" style={{ color: 'var(--accent-color)' }}>
                {site.site_type === 'rv_site' && `${site.amp_service === '30amp' ? '30 Amp' : '30/50 Amp'} · ${site.hookups === 'full' ? 'Full Hookup' : 'Water & Electric'}`}
                {site.site_type === 'cabin' && 'Private Cabin'}
                {site.site_type === 'tent' && 'Tent Site'}
              </p>
            </div>
            <div className="text-right">
              <p className="text-[var(--text-primary)] font-bold text-xl">${(site.nightly_rate / 100).toFixed(0)}<span className="text-sm font-normal text-[var(--text-muted)]">/night</span></p>
              <p className="text-sm text-[var(--text-muted)]">${(site.total_price / 100).toFixed(0)} total</p>
              {site.extra_guest_fee > 0 && (
                <p className="text-xs text-[var(--text-muted)]">incl. ${(site.extra_guest_fee / 100).toFixed(2)} extra guests</p>
              )}
            </div>
          </div>
          {site.max_rv_length && <p className="text-[var(--text-muted)] text-sm mb-2">Max RV length: {site.max_rv_length}ft</p>}
          {site.description && <p className="text-[var(--text-muted)] text-sm mb-2">{site.description}</p>}
          {!site.meets_min_stay && <p className="text-yellow-400 text-sm mt-2">Minimum {site.min_stay} nights required for this site</p>}
          {site.meets_min_stay && isSelected && (
            <div className="mt-3 pt-3 border-t border-[var(--border)]">
              <p className="text-sm font-medium" style={{ color: 'var(--accent-color)' }}>Selected — scroll down to continue</p>
            </div>
          )}
        </div>
      </div>
    )
  }

  return (
    <main className="min-h-screen" style={{ backgroundColor: 'var(--surface-bg)' }}>

      {/* Maintenance Mode */}
      {settings?.maintenance_mode && (
        <div className="min-h-screen flex flex-col items-center justify-center px-4 text-center">
          <div className="text-6xl mb-6">🚧</div>
          <h1 className="text-3xl font-bold text-[var(--text-primary)] mb-6">
            {settings?.park_name || 'Our Campground'}
          </h1>
          <div className="bg-[var(--surface-card)] border border-[var(--border)] rounded-2xl shadow-xl p-8 max-w-md w-full">
            <p className="text-[var(--text-primary)] text-lg leading-relaxed">
              {settings?.maintenance_message || 'We are temporarily unavailable for online reservations. Please call us to book your stay!'}
            </p>
          </div>
          {settings?.logo_url && (
            <div className={`mt-8 overflow-hidden flex items-center justify-center ${logoShapeClass}`}>
              <Image src={settings.logo_url} alt={settings?.park_name || 'Campground'} width={160} height={160} className="object-contain w-full h-full" priority />
            </div>
          )}
        </div>
      )}

      {!settings?.maintenance_mode && <>

      {/* Hero — full-width photo behind the header + search card when the client has set
          one, otherwise the plain surface-card band this section has always been. */}
      <div
        className={`relative flex flex-col items-center justify-center px-4 text-center ${
          heroImageUrl ? 'py-16 md:py-24 min-h-[520px] md:min-h-[600px]' : 'py-12'
        }`}
        style={heroImageUrl ? undefined : { backgroundColor: 'var(--surface-card)' }}
      >
        {heroImageUrl && (
          <>
            {/* Decorative, so alt is empty. `fill` + object-cover keeps the photo covering
                and centred at every width instead of squashing on narrow screens. */}
            <Image
              src={heroImageUrl}
              alt=""
              fill
              sizes="100vw"
              priority
              className="object-cover object-center"
            />
            {/* Scrim. Text over the photo is white regardless of theme, so legibility rides
                on this gradient rather than on the theme tokens — which means it reads the
                same in light and dark instead of inverting into a light-on-light failure. */}
            <div
              className="absolute inset-0"
              style={{ background: 'linear-gradient(to bottom, rgba(0,0,0,0.60) 0%, rgba(0,0,0,0.42) 30%, rgba(0,0,0,0.12) 58%, rgba(0,0,0,0.30) 100%)' }}
            />
          </>
        )}

        {/* Content sits above the photo + scrim. Both of those are absolutely positioned
            and earlier in the DOM, so this only needs its own stacking position. */}
        <div className="relative z-10 w-full flex flex-col items-center">
        {settings?.logo_url && (
          <div className={`mb-6 overflow-hidden flex items-center justify-center ${logoShapeClass}`}>
            <Image src={settings.logo_url} alt={settings?.park_name || 'Campground'} width={160} height={160} className="object-contain w-full h-full" priority />
          </div>
        )}
        {/* Only the hero variant scales up, so with no hero this is exactly today's band. */}
        <h1
          className={`font-bold mb-2 ${heroImageUrl ? 'text-3xl md:text-4xl' : 'text-3xl'}`}
          style={heroImageUrl
            ? { color: '#FFFFFF', textShadow: '0 1px 4px rgba(0,0,0,0.55)' }
            : { color: 'var(--text-primary)' }}
        >Welcome to {settings?.park_name || 'Our Campground'}</h1>
        <p
          className="text-lg mb-1"
          style={heroImageUrl
            ? { color: 'rgba(255,255,255,0.95)', textShadow: '0 1px 4px rgba(0,0,0,0.55)' }
            : { color: 'var(--accent-color)' }}
        >{settings?.park_location || ''}</p>
        <p
          className="mb-8 max-w-md"
          style={heroImageUrl
            ? { color: 'rgba(255,255,255,0.88)', textShadow: '0 1px 4px rgba(0,0,0,0.55)' }
            : { color: 'var(--text-muted)' }}
        >{settings?.park_tagline || 'Book your perfect campsite, cabin, or tent site today.'}</p>

        {/* Search Box — stays fully opaque so it anchors the hero rather than blending into it. */}
        <div className="w-full max-w-3xl bg-[var(--surface-card)] border border-[var(--border)] rounded-2xl shadow-2xl p-6">
          <h2 className="text-xl font-bold text-[var(--text-primary)] mb-5">Check Availability</h2>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4 mb-5">
            <div>
              <label className="block text-sm font-medium text-[var(--text-muted)] mb-1">Arrival Date</label>
              {/* max grays out everything past the park's booking window. `undefined` when no
                  window is set, so the attribute is absent and the calendar is unbounded exactly
                  as it was before. Advisory only — handleSearch checks it too. */}
              <input type="date" className="themed-input w-full border rounded-lg px-3 py-2 text-sm" min={today} max={horizonMaxDate || undefined} value={arrival}
                onClick={openDatePicker}
                onChange={e => { setArrival(e.target.value); if (departure && departure <= e.target.value) setDeparture('') }} />
              {arrivalOutOfSeason && (
                <p className="text-xs mt-1 font-medium" style={{ color: '#b91c1c' }}>
                  {lastNightLabel
                    ? `We are closed on this date. The last night you can book is ${lastNightLabel}.`
                    : 'We are closed on this date.'}
                </p>
              )}
              {horizonMaxDate && (
                <p className="text-xs mt-1 text-[var(--text-muted)]">Booking open through {horizonMaxDate}</p>
              )}
              {seasonConfigured && !arrivalOutOfSeason && (
                <p className="text-xs mt-1 text-[var(--text-muted)]">
                  Open {settings.season_start} through {settings.season_end}
                  {lastNightLabel && <> · last night {lastNightLabel}</>}
                </p>
              )}
            </div>
            <div>
              <label className="block text-sm font-medium text-[var(--text-muted)] mb-1">Departure Date</label>
              {/* Deliberately NOT capped by the horizon. The window governs the arrival only, so a
                  stay that starts inside it may finish outside it — capping departure here would
                  silently shorten every park's window by the length of the stay. */}
              <input type="date" className="themed-input w-full border rounded-lg px-3 py-2 text-sm" min={arrival || today} value={departure}
                onClick={openDatePicker}
                onChange={e => setDeparture(e.target.value)} />
              {stayOutOfSeason && !arrivalOutOfSeason && (
                <p className="text-xs mt-1 font-medium" style={{ color: '#b91c1c' }}>
                  This stay runs past our closing date.
                </p>
              )}
            </div>
            <div>
              <label className="block text-sm font-medium text-[var(--text-muted)] mb-1">Guests</label>
              <div className="flex gap-2">
                <div className="flex-1">
                  <input type="number" min={1} max={20} className="themed-input w-full border rounded-lg px-3 py-2 text-sm" value={adults} onChange={e => setAdults(parseInt(e.target.value))} />
                  <p className="text-xs text-[var(--text-muted)] mt-0.5 text-center">Adults</p>
                </div>
                <div className="flex-1">
                  <input type="number" min={0} max={20} className="themed-input w-full border rounded-lg px-3 py-2 text-sm" value={children} onChange={e => setChildren(parseInt(e.target.value))} />
                  <p className="text-xs text-[var(--text-muted)] mt-0.5 text-center">Children</p>
                </div>
              </div>
            </div>
            <div>
              <label className="block text-sm font-medium text-[var(--text-muted)] mb-1">Site Type</label>
              <select className="themed-input w-full border rounded-lg px-3 py-2 text-sm" value={siteType} onChange={e => setSiteType(e.target.value)}>
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
      </div>

      {/* Feature Cards */}
      {step === 1 && siteTypes.length > 0 && (
        <div className="max-w-5xl mx-auto px-4 py-16 grid grid-cols-1 md:grid-cols-3 gap-8 text-center">
          {siteTypes.map(type => {
            const info = siteTypeInfo[type] || { icon: '🏕️', label: type, desc: 'Come enjoy your stay with us.' }
            return (
              <div key={type} className="rounded-2xl p-6" style={{ backgroundColor: 'var(--surface-card)' }}>
                <div className="text-4xl mb-3">{info.icon}</div>
                <h3 className="text-[var(--text-primary)] font-bold text-lg mb-2">{info.label}</h3>
                <p className="text-[var(--text-muted)] text-sm">{info.desc}</p>
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
              <h2 className="text-2xl font-bold text-[var(--text-primary)]">Available Sites</h2>
              <p className="text-[var(--text-muted)] text-sm mt-1">
                {arrival} → {departure} · {adults} adult{adults !== 1 ? 's' : ''}
                {children > 0 ? `, ${children} child${children !== 1 ? 'ren' : ''}` : ''}
              </p>
            </div>
            <button onClick={() => { setStep(1); setSelectedSite(null) }}
              className="text-sm px-4 py-2 rounded-lg"
              style={{ backgroundColor: 'var(--surface-card)', color: 'var(--accent-color)' }}>
              ← Change Dates
            </button>
          </div>

          {outOfSeason ? (
            <div className="rounded-2xl p-12 text-center" style={{ backgroundColor: 'var(--surface-card)' }}>
              <div className="text-6xl mb-4">❄️</div>
              <p className="text-[var(--text-primary)] text-xl font-bold mb-3">We&apos;re Closed for These Dates</p>
              <p className="text-[var(--text-muted)] mb-4">{outOfSeason}</p>
              {settings?.season_start && settings?.season_end && (
                <p className="text-sm" style={{ color: 'var(--accent-color)' }}>We are open from {settings.season_start} through {settings.season_end}</p>
              )}
            </div>
          ) : outOfWindow ? (
            // Its own panel rather than the ❄️ closed-for-season one. "Further ahead than we take
            // bookings" and "we are shut that week" are different facts; a guest shown the wrong
            // one either waits for a season that is already open or writes the park off entirely.
            <div className="rounded-2xl p-12 text-center" style={{ backgroundColor: 'var(--surface-card)' }}>
              <div className="text-6xl mb-4">🗓️</div>
              <p className="text-[var(--text-primary)] text-xl font-bold mb-3">That's Further Out Than We Book</p>
              <p className="text-[var(--text-muted)] text-base">{outOfWindow}</p>
            </div>
          ) : sameDayBlock ? (
            <div className="rounded-2xl p-12 text-center" style={{ backgroundColor: 'var(--surface-card)' }}>
              <div className="text-6xl mb-4">📞</div>
              <p className="text-[var(--text-primary)] text-xl font-bold mb-3">Same-Day Reservations</p>
              <p className="text-[var(--text-muted)] text-base">{sameDayBlock}</p>
            </div>
          ) : loading ? (
            <div className="rounded-2xl p-12 text-center" style={{ backgroundColor: 'var(--surface-card)' }}>
              <p className="text-[var(--text-muted)] text-lg">Searching for available sites...</p>
            </div>
          ) : isClosed ? (
            <div className="rounded-2xl p-12 text-center" style={{ backgroundColor: 'var(--surface-card)' }}>
              <div className="text-6xl mb-4">❄️</div>
              <p className="text-[var(--text-primary)] text-xl font-bold mb-3">We're Closed for the Season</p>
              <p className="text-[var(--text-muted)] mb-4">{closedMessage}</p>
              <p className="text-sm" style={{ color: 'var(--accent-color)' }}>We are open from {seasonStart} through {seasonEnd}</p>
            </div>
          ) : sites.length === 0 ? (
            <div className="rounded-2xl p-12 text-center" style={{ backgroundColor: 'var(--surface-card)' }}>
              <p className="text-[var(--text-primary)] text-lg font-semibold mb-2">No sites available</p>
              <p className="text-[var(--text-muted)]">Try different dates or a different site type.</p>
            </div>
          ) : (
            <>
              {settings?.show_site_map && (
                <div className="rounded-2xl p-4 mb-6" style={{ backgroundColor: 'var(--surface-card)' }}>
                  <h3 className="text-[var(--text-primary)] font-semibold mb-3 text-sm">
                    Click a site on the map to select it — <span className="text-[var(--text-muted)]">grey = not available for selected dates</span>
                  </h3>
                  <CampgroundMap
                    onSiteSelect={(site) => {
  const s = site as any
  setSelectedSite(s)
  const catIds = siteCategories[s.id]
  if (catIds && catIds.length > 0) {
    setOpenCategories(prev => {
      const next = new Set(prev)
      catIds.forEach((id) => next.add(id))
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
                    <div key={group.id} className="rounded-2xl overflow-hidden" style={{ backgroundColor: 'var(--surface-card)' }}>
                      {/* Accordion Header */}
                      <button
                        onClick={() => toggleCategory(group.id)}
                        className="w-full flex items-center justify-between px-6 py-4 text-left hover:opacity-80 transition-opacity"
                      >
                        <div className="flex items-center gap-3">
                          <span className="text-[var(--text-primary)] font-bold text-lg">
                            {group.id === 'uncategorized' ? '🏕️' : '🏷️'} {group.name || 'All Sites'}
                          </span>
                          <span className="text-sm px-2 py-0.5 rounded-full font-medium" style={{ backgroundColor: 'rgba(var(--accent-rgb, 56,189,196), 0.15)', color: 'var(--accent-color)' }}>
                            {group.sites.length} site{group.sites.length !== 1 ? 's' : ''} available
                          </span>
                        </div>
                        <span className="text-[var(--text-muted)] text-xl">{openCategories.has(group.id) ? '▲' : '▼'}</span>
                      </button>

                      {/* Accordion Content */}
                      {openCategories.has(group.id) && (
                        <div className="px-4 pb-4 grid grid-cols-1 md:grid-cols-2 gap-4 border-t border-[var(--border)]">
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
            <div className="mt-8 rounded-2xl p-6" style={{ backgroundColor: 'var(--surface-card)' }}>
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-[var(--text-primary)] font-semibold">{siteTypeLabel(selectedSite.site_type)} {selectedSite.site_number} selected</p>
                  <p className="text-[var(--text-muted)] text-sm">
                    {selectedSite.nights} nights · ${(selectedSite.total_price / 100).toFixed(2)} total
                    {selectedSite.extra_guest_fee > 0 && <> · incl. ${(selectedSite.extra_guest_fee / 100).toFixed(2)} extra guests</>}
                  </p>
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
      <div className="text-center py-8 text-[var(--text-muted)] text-sm">
        © 2026 {settings?.park_name || 'Campground'} · {settings?.park_location || ''}
      </div>
   </>}
    </main>
  )
}
