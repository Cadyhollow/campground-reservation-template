'use client'

import { useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import Image from 'next/image'
import { supabase } from '@/lib/supabase'

export default function AdminLoginPage() {
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [settings, setSettings] = useState<any>(null)
  const router = useRouter()

  useEffect(() => {
    supabase.from('settings').select('park_name, logo_url').limit(1).single().then(({ data }) => {
      if (data) setSettings(data)
    })
  }, [])

  async function handleLogin() {
    if (!password) { setError('Please enter the password.'); return }
    setLoading(true)
    setError('')

    const res = await fetch('/api/admin-auth', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password }),
    })

    const data = await res.json()

    if (data.success) {
      window.location.href = '/admin'
    } else {
      setError('Incorrect password. Please try again.')
      setLoading(false)
    }
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Enter') handleLogin()
  }

  return (
    <main className="min-h-screen flex items-center justify-center" style={{ backgroundColor: '#1C1C1C' }}>
      <div className="w-full max-w-sm px-4">
        {/* Logo */}
        <div className="text-center mb-8">
          <Image
            src={settings?.logo_url || '/images/logo.png'}
            alt={settings?.park_name || 'Campground Logo'}
            width={100}
            height={100}
            className="rounded-full mx-auto mb-4"
            style={{ filter: 'hue-rotate(20deg) saturate(1.2)' }}
          />
          <h1 className="text-white font-bold text-xl">{settings?.park_name || 'Campground'}</h1>
          <p className="text-sm mt-1" style={{ color: 'var(--accent-color)' }}>Admin Dashboard</p>
        </div>

        {/* Login Card */}
        <div className="rounded-2xl p-6" style={{ backgroundColor: '#2B2B2B' }}>
          <h2 className="text-white font-bold text-lg mb-6 text-center">Staff Login</h2>

          <div className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-gray-300 mb-1">Password</label>
              <input
                type="password"
                className="w-full bg-gray-800 border border-gray-600 rounded-lg px-3 py-2 text-white text-sm"
                placeholder="Enter staff password"
                value={password}
                onChange={e => setPassword(e.target.value)}
                onKeyDown={handleKeyDown}
                autoFocus
              />
            </div>

            {error && (
              <p className="text-red-400 text-sm">{error}</p>
            )}

            <button
              onClick={handleLogin}
              disabled={loading}
              className="w-full py-3 rounded-xl text-white font-semibold transition-colors disabled:opacity-50"
              style={{ backgroundColor: 'var(--accent-color)' }}
              onMouseOver={e => (e.currentTarget.style.backgroundColor = '#2DADC4')}
              onMouseOut={e => (e.currentTarget.style.backgroundColor = 'var(--accent-color)')}
            >
              {loading ? 'Logging in...' : 'Log In'}
            </button>
          </div>
        </div>

        <p className="text-center text-gray-600 text-xs mt-6">
          © 2026 {settings?.park_name || 'Campground'}
        </p>
      </div>
    </main>
  )
}