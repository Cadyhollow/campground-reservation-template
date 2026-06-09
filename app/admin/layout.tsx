'use client'

import { useState, useEffect } from 'react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { supabase } from '@/lib/supabase'
import Image from 'next/image'

type NavItem = {
  name: string
  href: string
  icon: string
  minPlan?: 'ridgeline' | 'summit'
}

type NavGroup = {
  label: string
  icon: string
  posOnly?: boolean
  minPlan?: 'ridgeline' | 'summit'
  items: NavItem[]
}

// Plan hierarchy for comparison
const PLAN_LEVELS: { [key: string]: number } = {
  trailhead: 1,
  ridgeline: 2,
  summit: 3,
}

function planAtLeast(current: string, required: 'ridgeline' | 'summit'): boolean {
  return (PLAN_LEVELS[current] || 1) >= (PLAN_LEVELS[required] || 99)
}

const navGroups: NavGroup[] = [
  {
    label: 'Reservations',
    icon: '🏕️',
    items: [
      { name: 'Reservations', href: '/admin/reservations', icon: '📋' },
      { name: 'Calendar', href: '/admin/calendar', icon: '📅' },
      { name: 'Park Map', href: '/admin/map', icon: '🗺️', minPlan: 'ridgeline' as const },
      { name: 'Manual Booking', href: '/admin/manual-booking', icon: '✍️' },
      { name: 'Walk-In Booking', href: '/admin/walkin-booking', icon: '🚶' },
    ],
  },
  {
    label: 'Sites & Rules',
    icon: '⚙️',
    items: [
      { name: 'Sites', href: '/admin/sites', icon: '🪵' },
      { name: 'Pricing Rules', href: '/admin/pricing', icon: '💲' },
      { name: 'Min. Stay Rules', href: '/admin/min-stay', icon: '🌙' },
      { name: 'Cancellation Rules', href: '/admin/cancellation-rules', icon: '↩️' },
      { name: 'Add-Ons', href: '/admin/addons', icon: '➕' },
      { name: 'Blocked Dates', href: '/admin/blocked-dates', icon: '🚫' },
    ],
  },
  {
    label: 'Guests',
    icon: '👥',
    items: [
      { name: 'Guest Folios', href: '/admin/folios', icon: '🗂️', minPlan: 'summit' as const },
      { name: 'Guest Directory', href: '/admin/guests', icon: '📇' },
      { name: 'Send Email', href: '/admin/send-email', icon: '📣', minPlan: 'ridgeline' as const },
    ],
  },
  {
    label: 'Finance',
    icon: '💰',
    items: [
      { name: 'Taxes & Fees', href: '/admin/fees', icon: '🧾' },
      { name: 'Electric Billing', href: '/admin/electric-billing', icon: '⚡', minPlan: 'summit' as const },
      { name: 'Discounts', href: '/admin/discounts', icon: '🏷️' },
      { name: 'Transactions', href: '/admin/transactions', icon: '💳' },
    ],
  },
  {
    label: 'Point of Sale',
    icon: '🛒',
    posOnly: true,
    items: [
      { name: 'Products & Services', href: '/admin/products', icon: '📦' },
      { name: 'Square Terminal', href: '/admin/settings/terminal', icon: '💳' },
    ],
  },
  {
    label: 'Settings',
    icon: '🔧',
    items: [
      { name: 'Settings', href: '/admin/settings', icon: '⚙️' },
    ],
  },
]

export default function AdminLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname()
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const [settings, setSettings] = useState<any>(null)
  const [posEnabled, setPosEnabled] = useState(false)
  const [seasonalEnabled, setSeasonalEnabled] = useState(false)

  // Find which group contains the active page and open only that one
  const getActiveGroup = () => {
    for (const group of navGroups) {
      if (group.items.some(item =>
        item.href === pathname || (item.href !== '/admin' && pathname.startsWith(item.href))
      )) {
        return group.label
      }
    }
    return null
  }

  const [openGroup, setOpenGroup] = useState<string | null>(null)

  const [plan, setPlan] = useState<string>('summit') // default to summit for Cady Hollow
  const [dashboardView, setDashboardView] = useState<'owner'|'staff'>('staff')

  useEffect(() => {
    const stored = localStorage.getItem('resonation_dashboard_view')
    if (stored === 'owner' || stored === 'staff') setDashboardView(stored as 'owner'|'staff')
    const collapsed = localStorage.getItem('resonation_sidebar_collapsed')
    if (collapsed === 'true') setSidebarCollapsed(true)
  }, [])

  function toggleSidebarCollapsed() {
    setSidebarCollapsed(prev => {
      const next = !prev
      localStorage.setItem('resonation_sidebar_collapsed', String(next))
      return next
    })
  }

  function toggleDashboardView(view: 'owner'|'staff') {
    setDashboardView(view)
    localStorage.setItem('resonation_dashboard_view', view)
    window.dispatchEvent(new Event('dashboardViewChanged'))
  }

  useEffect(() => {
    supabase
      .from('settings')
      .select('park_name, logo_url, logo_shape, plan, pos_enabled, seasonal_enabled')
      .limit(1)
      .single()
      .then(({ data }) => {
        if (data) {
          setSettings(data)
          setPosEnabled(!!data.pos_enabled)
          setSeasonalEnabled(!!data.seasonal_enabled)
          if (data.plan) setPlan(data.plan)
        }
      })
  }, [])

  useEffect(() => {
    setOpenGroup(getActiveGroup())
  }, [pathname])

  async function handleLogout() {
    await fetch('/api/admin-auth', { method: 'DELETE' })
    window.location.href = '/admin/login'
  }

  const logoShapeClass =
    settings?.logo_shape === 'circle' ? 'rounded-full' :
    settings?.logo_shape === 'rounded' ? 'rounded-xl' :
    'rounded-none'

  const visibleGroups = navGroups
    .filter(g => (!g.posOnly || posEnabled) && (!g.minPlan || planAtLeast(plan, g.minPlan)))
    .map(g => ({
      ...g,
      items: g.items.filter(item => {
        if (item.href === '/admin/electric-billing') return seasonalEnabled && planAtLeast(plan, 'summit')
        return true
      })
    }))
    .filter(g => g.items.length > 0)

  function toggleGroup(label: string) {
    setOpenGroup(prev => prev === label ? null : label)
  }

  function isGroupActive(group: NavGroup) {
    return group.items.some(item =>
      item.href === pathname || (item.href !== '/admin' && pathname.startsWith(item.href))
    )
  }

  const SidebarContent = () => (
    <div className="flex flex-col h-full" style={{ background: 'linear-gradient(180deg, #1a3a2a 0%, #0f2419 100%)' }}>

      {/* Header */}
      <div className="flex flex-col items-center px-6 py-6" style={{ borderBottom: '1px solid rgba(255,255,255,0.08)' }}>
        {settings?.logo_url && (
          <div className={`w-16 h-16 overflow-hidden flex items-center justify-center mb-3 ${logoShapeClass}`}
            style={{ boxShadow: '0 4px 12px rgba(0,0,0,0.3)' }}>
            <Image src={settings.logo_url} alt={settings?.park_name || 'Campground'} width={64} height={64} className="object-contain w-full h-full" />
          </div>
        )}
        <h1 className="text-base font-bold text-center text-white leading-tight">{settings?.park_name || 'Campground'}</h1>
        <p className="text-xs mt-1 font-medium tracking-widest uppercase" style={{ color: 'rgba(255,255,255,0.4)' }}>Admin</p>
      </div>

      {/* Nav groups */}
      <nav className="flex-1 px-3 py-4 overflow-y-auto space-y-0.5">
        {/* Dashboard */}
        <Link href="/admin" onClick={() => setSidebarOpen(false)}
          className="flex items-center px-4 rounded-xl text-sm font-semibold transition-all duration-150 mb-3"
          style={{
            minHeight: '48px', display: 'flex', alignItems: 'center',
            background: pathname === '/admin' ? 'var(--accent-color, #12c9e5)' : 'rgba(255,255,255,0.07)',
            color: '#fff',
            boxShadow: pathname === '/admin' ? '0 2px 8px rgba(18,201,229,0.3)' : 'none',
          }}>
          Dashboard
        </Link>

        {visibleGroups.map((group) => {
          const active = isGroupActive(group)
          const open = openGroup === group.label
          return (
            <div key={group.label} className="mb-0.5">
              <button onClick={() => toggleGroup(group.label)}
                className="w-full flex items-center justify-between px-4 rounded-xl text-left transition-all duration-150"
                style={{
                  minHeight: '48px',
                  background: active && !open ? 'rgba(255,255,255,0.1)' : open ? 'rgba(255,255,255,0.12)' : 'transparent',
                  color: 'rgba(255,255,255,0.85)',
                }}>
                <span className="text-sm font-semibold">{group.label}</span>
                <svg className="w-4 h-4 transition-transform duration-200 flex-shrink-0"
                  style={{ transform: open ? 'rotate(180deg)' : 'rotate(0deg)', opacity: 0.6 }}
                  fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M19 9l-7 7-7-7" />
                </svg>
              </button>
              {open && (
                <div className="mt-0.5 space-y-0.5 pb-1">
                  {group.items.filter(item => !item.minPlan || planAtLeast(plan, item.minPlan) || posEnabled).map((item) => {
                    const itemActive = item.href === pathname || (item.href !== '/admin' && pathname.startsWith(item.href))
                    return (
                      <Link key={item.name} href={item.href} onClick={() => setSidebarOpen(false)}
                        className="flex items-center px-4 ml-2 rounded-xl text-sm transition-all duration-150"
                        style={{
                          minHeight: '44px', display: 'flex', alignItems: 'center',
                          background: itemActive ? 'var(--accent-color, #12c9e5)' : 'rgba(255,255,255,0.05)',
                          color: itemActive ? '#fff' : 'rgba(255,255,255,0.8)',
                          fontWeight: itemActive ? 600 : 400,
                          boxShadow: itemActive ? '0 2px 8px rgba(18,201,229,0.25)' : 'none',
                        }}>
                        {item.name}
                      </Link>
                    )
                  })}
                </div>
              )}
            </div>
          )
        })}

        {/* Reports — standalone top-level item (ridgeline+) */}
        {planAtLeast(plan, 'ridgeline') && (
          <Link href="/admin/reports" onClick={() => setSidebarOpen(false)}
            className="flex items-center px-4 rounded-xl text-sm font-semibold transition-all duration-150 mt-3"
            style={{
              minHeight: '48px', display: 'flex', alignItems: 'center',
              background: pathname.startsWith('/admin/reports') ? 'var(--accent-color, #12c9e5)' : 'rgba(255,255,255,0.07)',
              color: '#fff',
              boxShadow: pathname.startsWith('/admin/reports') ? '0 2px 8px rgba(18,201,229,0.3)' : 'none',
            }}>
            Reports
          </Link>
        )}
      </nav>

      {/* Footer */}
      <div className="px-3 py-4 space-y-2" style={{ borderTop: '1px solid rgba(255,255,255,0.08)' }}>
        {/* Dashboard view toggle */}
        <div className="mb-2">
          <p className="text-xs font-semibold uppercase tracking-widest mb-2 px-1" style={{color:'rgba(255,255,255,0.35)'}}>Dashboard View</p>
          <div className="flex rounded-xl overflow-hidden" style={{border:'1px solid rgba(255,255,255,0.12)'}}>
            <button onClick={()=>toggleDashboardView('staff')}
              className="flex-1 text-xs font-semibold transition-all"
              style={{minHeight:'40px',background:dashboardView==='staff'?'rgba(255,255,255,0.18)':'transparent',color:dashboardView==='staff'?'#fff':'rgba(255,255,255,0.45)'}}>
              Staff
            </button>
            <button onClick={()=>toggleDashboardView('owner')}
              className="flex-1 text-xs font-semibold transition-all"
              style={{minHeight:'40px',background:dashboardView==='owner'?'rgba(255,255,255,0.18)':'transparent',color:dashboardView==='owner'?'#fff':'rgba(255,255,255,0.45)'}}>
              Owner
            </button>
          </div>
        </div>
        <Link href="/"
          className="flex items-center px-4 rounded-xl text-sm transition-all duration-150"
          style={{minHeight:'44px',display:'flex',alignItems:'center',color:'rgba(255,255,255,0.6)'}}
          onMouseEnter={e=>(e.currentTarget as HTMLElement).style.color='#fff'}
          onMouseLeave={e=>(e.currentTarget as HTMLElement).style.color='rgba(255,255,255,0.6)'}>
          View Booking Site
        </Link>
        <button onClick={handleLogout}
          className="w-full flex items-center px-4 rounded-xl text-sm transition-all duration-150"
          style={{minHeight:'44px',color:'rgba(255,255,255,0.6)'}}
          onMouseEnter={e=>(e.currentTarget as HTMLElement).style.color='#fff'}
          onMouseLeave={e=>(e.currentTarget as HTMLElement).style.color='rgba(255,255,255,0.6)'}>
          Log Out
        </button>
      </div>
    </div>
  )

  return (
    <div className="min-h-screen bg-gray-50">

      {/* Mobile top bar */}
      <div className="lg:hidden text-white px-4 py-3 flex items-center justify-between"
        style={{ background: '#1a3a2a' }}>
        <div className="flex items-center gap-3">
          {settings?.logo_url ? (
            <div className={`w-8 h-8 overflow-hidden flex items-center justify-center ${logoShapeClass}`}>
              <Image src={settings.logo_url} alt={settings?.park_name || 'Campground'} width={32} height={32} className="object-contain w-full h-full" />
            </div>
          ) : null}
          <span className="font-semibold text-sm">{settings?.park_name || 'Admin'}</span>
        </div>
        <button onClick={() => setSidebarOpen(!sidebarOpen)} className="p-2 rounded-lg transition-colors"
          style={{ background: 'rgba(255,255,255,0.1)' }}>
          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            {sidebarOpen
              ? <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              : <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" />
            }
          </svg>
        </button>
      </div>

      <div className="flex relative">
        {/* Desktop sidebar — collapsible */}
        {!sidebarCollapsed && (
          <div className="hidden lg:flex lg:flex-col w-60 min-h-screen flex-shrink-0 relative">
            <SidebarContent />
            {/* Collapse button */}
            <button
              onClick={toggleSidebarCollapsed}
              className="absolute -right-3 top-1/2 -translate-y-1/2 w-6 h-12 rounded-r-lg flex items-center justify-center transition-all hover:w-8 z-10"
              style={{ background: '#1a3a2a', color: 'rgba(255,255,255,0.7)' }}
              title="Collapse sidebar">
              ‹
            </button>
          </div>
        )}

        {/* Expand tab — shown when sidebar is collapsed */}
        {sidebarCollapsed && (
          <button
            onClick={toggleSidebarCollapsed}
            className="hidden lg:flex fixed left-0 top-1/2 -translate-y-1/2 w-6 h-16 rounded-r-xl flex-col items-center justify-center z-30 transition-all hover:w-8"
            style={{ background: '#1a3a2a', color: 'rgba(255,255,255,0.8)' }}
            title="Expand sidebar">
            ›
          </button>
        )}

        {/* Mobile sidebar overlay */}
        {sidebarOpen && (
          <div className="lg:hidden fixed inset-0 z-50 flex">
            <div className="w-60 flex flex-col">
              <SidebarContent />
            </div>
            <div className="flex-1 bg-black bg-opacity-50" onClick={() => setSidebarOpen(false)} />
          </div>
        )}

        {/* Main content */}
        <div className="flex-1 min-w-0">
          {children}
        </div>
      </div>
    </div>
  )
}
