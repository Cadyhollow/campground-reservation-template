'use client'

import { useState, useEffect } from 'react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { supabase } from '@/lib/supabase'
import Image from 'next/image'

const navigation = [
  { name: 'Dashboard', href: '/admin' },
  { name: 'Reservations', href: '/admin/reservations' },
  { name: 'Calendar', href: '/admin/calendar' },
  { name: 'Manual Booking', href: '/admin/manual-booking' },
  { name: 'Sites', href: '/admin/sites' },
  { name: 'Pricing Rules', href: '/admin/pricing' },
  { name: 'Min. Stay Rules', href: '/admin/min-stay' },
  { name: 'Cancellation Rules', href: '/admin/cancellation-rules' },
  { name: 'Add-Ons', href: '/admin/addons' },
  { name: 'Taxes & Fees', href: '/admin/fees' },
  { name: 'Reports', href: '/admin/reports' },
  { name: 'Discounts', href: '/admin/discounts' },
  { name: 'Blocked Dates', href: '/admin/blocked-dates' },
  { name: 'Settings', href: '/admin/settings' },
]

export default function AdminLayout({
  children,
}: {
  children: React.ReactNode
}) {
  const pathname = usePathname()
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [settings, setSettings] = useState<any>(null)

  useEffect(() => {
    supabase
      .from('settings')
      .select('park_name, logo_url, logo_shape')
      .limit(1)
      .single()
      .then(({ data }) => {
        if (data) setSettings(data)
      })
  }, [])

  async function handleLogout() {
    await fetch('/api/admin-auth', { method: 'DELETE' })
    window.location.href = '/admin/login'
  }

  const logoShapeClass =
    settings?.logo_shape === 'circle' ? 'rounded-full' :
    settings?.logo_shape === 'rounded' ? 'rounded-xl' :
    settings?.logo_shape === 'square' ? 'rounded-none' :
    'rounded-none'

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Top bar for mobile */}
      <div className="lg:hidden bg-green-800 text-white px-4 py-3 flex items-center justify-between">
        {settings?.logo_url ? (
          <div className={`w-10 h-10 overflow-hidden flex items-center justify-center ${logoShapeClass}`}>
            <Image
              src={settings.logo_url}
              alt={settings?.park_name || 'Campground'}
              width={40}
              height={40}
              className="object-contain w-full h-full"
            />
          </div>
        ) : (
          <span className="font-semibold text-lg">{settings?.park_name || 'Admin'}</span>
        )}
        <button onClick={() => setSidebarOpen(!sidebarOpen)} className="text-white">
          <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" />
          </svg>
        </button>
      </div>

      <div className="flex">
        {/* Sidebar */}
        <div className={`
          fixed inset-y-0 left-0 z-50 w-64 bg-green-800 text-white transform transition-transform duration-200
          lg:relative lg:translate-x-0 lg:flex lg:flex-col
          ${sidebarOpen ? 'translate-x-0' : '-translate-x-full'}
        `}>
          {/* Sidebar header with logo */}
          <div className="hidden lg:flex flex-col items-center px-6 py-6 border-b border-green-700">
            {settings?.logo_url && (
              <div className={`w-20 h-20 overflow-hidden flex items-center justify-center mb-3 ${logoShapeClass}`}>
                <Image
                  src={settings.logo_url}
                  alt={settings?.park_name || 'Campground'}
                  width={80}
                  height={80}
                  className="object-contain w-full h-full"
                />
              </div>
            )}
            <h1 className="text-lg font-bold text-center">{settings?.park_name || 'Campground'}</h1>
            <p className="text-green-300 text-sm mt-1">Admin Dashboard</p>
          </div>

          <nav className="flex-1 px-4 py-6 space-y-1 overflow-y-auto">
            {navigation.map((item) => (
              <Link
                key={item.name}
                href={item.href}
                onClick={() => setSidebarOpen(false)}
                className={`
                  block px-4 py-3 rounded-lg text-sm font-medium transition-colors
                  ${pathname === item.href
                    ? 'bg-green-700 text-white'
                    : 'text-green-100 hover:bg-green-700 hover:text-white'
                  }
                `}
              >
                {item.name}
              </Link>
            ))}
          </nav>

          <div className="px-4 py-4 border-t border-green-700 space-y-1">
            <Link
              href="/"
              className="block px-4 py-3 rounded-lg text-sm font-medium text-green-100 hover:bg-green-700"
            >
              ← View Booking Site
            </Link>
            <button
              onClick={handleLogout}
              className="w-full text-left block px-4 py-3 rounded-lg text-sm font-medium text-green-100 hover:bg-green-700"
            >
              Log Out
            </button>
          </div>
        </div>

        {/* Main content */}
        <div className="flex-1 min-w-0">
          {children}
        </div>
      </div>
    </div>
  )
}
