'use client'

import { useState, useEffect } from 'react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { createBrowserSupabase } from '@/lib/supabase-browser'

// Security PR 7-1: the admin browser talks to Supabase as the LOGGED-IN USER, not as `anon`.
// Same publishable key, but it travels with the session cookie, so PostgREST runs these queries
// as `authenticated` and the role-gated RLS policies apply. Safe at module scope:
// createBrowserClient returns a singleton in the browser and a no-op cookie store during
// prerender.
const supabase = createBrowserSupabase()
import Image from 'next/image'
import { planAtLeast, normalizePlan } from '@/lib/plan'
import { atLeast, type Role } from '@/lib/roles'
import { roleForPath } from '@/lib/admin-pages'

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

// Plan gating comes from lib/plan (shared with the dashboard) — it fails closed, so an
// unset or unrecognized plan can never satisfy a gate.

const navGroups: NavGroup[] = [
  {
    label: 'Reservations',
    icon: '🏕️',
    items: [
      { name: 'Reservations', href: '/admin/reservations', icon: '📋' },
      { name: 'Calendar', href: '/admin/calendar', icon: '📅' },
      { name: 'Park Map', href: '/admin/map', icon: '🗺️', minPlan: 'ridgeline' as const },
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
      // Owner-only, and hidden below Owner by the roleForPath() filter further down rather than
      // by anything special here — lib/admin-pages.ts maps /admin/users to 'owner'.
      { name: 'Staff Accounts', href: '/admin/users', icon: '👤' },
    ],
  },
]

export default function AdminLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname()
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const [settings, setSettings] = useState<any>(null)
  const [posEnabled, setPosEnabled] = useState(false)
  const [settingsLoaded, setSettingsLoaded] = useState(false) // gate plan-dependent nav until first fetch resolves
  const [role, setRole] = useState<Role | null>(null)
  const [roleLoaded, setRoleLoaded] = useState(false)
  const [deniedPath, setDeniedPath] = useState<string | null>(null)

  // The login page runs before anyone is authenticated, so the /api/me fetch below must not run
  // there — it would 401 on every visit to the one page that is supposed to be reachable.
  const isLoginPage = pathname.startsWith('/admin/login')

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

  const [plan, setPlan] = useState<string>('trailhead') // fail closed — lowest tier until settings load
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
      .select('park_name, logo_url, logo_shape, plan, pos_enabled')
      .limit(1)
      .single()
      .then(({ data }) => {
        if (data) {
          setSettings(data)
          setPosEnabled(!!data.pos_enabled)
          setPlan(normalizePlan(data.plan))
        }
        setSettingsLoaded(true) // resolve even on null/failed fetch so the nav never sticks on skeleton
      })
  }, [])

  // The signed-in user's role, for hiding nav items they cannot use. Asked of the server rather
  // than worked out here: the role lives in `profiles`, whose RLS policy scopes SELECT to the
  // caller's own row, and reading it needs the session the server sees at guard time.
  //
  // Fails closed to Staff: a failed fetch hides the privileged items rather than showing links
  // that would only redirect. `roleLoaded` gates the nav the same way `settingsLoaded` does, so
  // Owner-only groups never flash into view during the first paint and then vanish.
  useEffect(() => {
    if (isLoginPage) return
    fetch('/api/me')
      .then(res => (res.ok ? res.json() : null))
      .then(data => {
        if (data?.role) setRole(data.role as Role)
      })
      .catch(() => {})
      .finally(() => setRoleLoaded(true))
  }, [isLoginPage])

  // proxy.ts appends ?denied=<path> when it turns a user away from a page above their role.
  // Without this they are simply bounced to /admin with no explanation, which reads as a bug.
  useEffect(() => {
    const denied = new URLSearchParams(window.location.search).get('denied')
    setDeniedPath(denied)
    if (denied) {
      // Drop the marker so a refresh, or a later back-navigation, does not re-announce it.
      const url = new URL(window.location.href)
      url.searchParams.delete('denied')
      window.history.replaceState({}, '', url.toString())
    }
  }, [pathname])

  useEffect(() => {
    setOpenGroup(getActiveGroup())
  }, [pathname])

  async function handleLogout() {
    // Ends the Supabase session and clears its cookies, which is what every server guard reads.
    // There is no logout ENDPOINT any more because there is no server-minted cookie to clear.
    await createBrowserSupabase().auth.signOut()
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
        // Role gate. roleForPath() is the SAME table proxy.ts enforces with, so a link can never
        // appear for a page that would then redirect. This is UX only — hiding a link authorises
        // nothing, and proxy.ts refuses the URL whether or not it was ever shown.
        if (!atLeast(role, roleForPath(item.href))) return false
        // minPlan is always enforced; POS (an add-on) governs only posOnly groups, never plan gates
        return !item.minPlan || planAtLeast(plan, item.minPlan)
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

        {/* Plan- and role-dependent nav is held behind a skeleton until BOTH resolve, so gated
            items can never flash before the plan and the role are known. Role fails closed to
            Staff, so rendering early would show an Owner the Staff menu and then correct it. */}
        {!settingsLoaded || !roleLoaded ? (
          <div className="space-y-1.5 px-1 pt-1" aria-hidden>
            {[0, 1, 2, 3, 4].map(i => (
              <div key={i} style={{ height: 44, borderRadius: 12, background: 'rgba(255,255,255,0.06)' }} />
            ))}
          </div>
        ) : (<>
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
                  {group.items.map((item) => {
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
        </>)}
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
        {/* PR 5c-1. In the footer beside Log Out rather than in a nav group, because it belongs to
            whoever is signed in rather than to a part of the park. No role gate: /admin/account is
            the self-service password page and every logged-in user needs it.

            This link was dropped in the 7-1 template port. The page itself shipped and works, but
            nothing pointed at it, so the only way to reach a self-service password change was to
            type the URL. That matters more than a missing link usually would: without it people
            reach for Staff Accounts → Reset Password on their own row, which is the admin path and
            revokes their session out from under them. */}
        <Link href="/admin/account"
          className="flex items-center px-4 rounded-xl text-sm transition-all duration-150"
          style={{minHeight:'44px',display:'flex',alignItems:'center',color:'rgba(255,255,255,0.6)'}}
          onMouseEnter={e=>(e.currentTarget as HTMLElement).style.color='#fff'}
          onMouseLeave={e=>(e.currentTarget as HTMLElement).style.color='rgba(255,255,255,0.6)'}>
          My Account
        </Link>
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

      {/* proxy.ts turned this user away from a page above their role and said so in the URL.
          Without this they land on /admin with no explanation, which reads as a broken link
          rather than a permission boundary. */}
      {deniedPath && (
        <div role="alert" className="px-4 py-3 text-sm"
          style={{ background: '#fef3c7', color: '#92400e', borderBottom: '1px solid #fde68a' }}>
          <strong>Not available to your account.</strong>{' '}
          <span style={{ opacity: 0.9 }}>
            {deniedPath} needs a higher permission level. Ask an owner if you need access.
          </span>
          <button onClick={() => setDeniedPath(null)} aria-label="Dismiss"
            className="ml-3 underline" style={{ opacity: 0.75 }}>Dismiss</button>
        </div>
      )}

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
