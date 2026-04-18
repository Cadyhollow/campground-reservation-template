'use client'

import { useState } from 'react'
import Image from 'next/image'

export default function HomePage() {
  const [step, setStep] = useState(1)
  const [arrival, setArrival] = useState('')
  const [departure, setDeparture] = useState('')
  const [adults, setAdults] = useState(2)
  const [children, setChildren] = useState(0)
  const [siteType, setSiteType] = useState('all')

  const today = new Date().toISOString().split('T')[0]

  function handleSearch() {
    if (!arrival || !departure) {
      alert('Please select both arrival and departure dates.')
      return
    }
    if (departure <= arrival) {
      alert('Departure date must be after arrival date.')
      return
    }
    setStep(2)
  }

  return (
    <main className="min-h-screen" style={{ backgroundColor: '#1C1C1C' }}>

      {/* Hero Section */}
      <div className="flex flex-col items-center justify-center px-4 py-16 text-center"
        style={{ backgroundColor: '#2B2B2B' }}>
        <div className="mb-6">
          <Image
            src="/images/logo.png"
            alt="Campground Logo"
            width={160}
            height={160}
            className="rounded-full mx-auto"
            style={{ filter: 'hue-rotate(20deg) saturate(1.2)' }}
            priority
          />
        </div>
        <h1 className="text-3xl font-bold text-white mb-2">Welcome to {process.env.NEXT_PUBLIC_CAMPGROUND_NAME || "Campground"}</h1>
        <p className="text-lg mb-1" style={{ color: 'process.env.NEXT_PUBLIC_COLOR_ACCENT || '#3DBDD4'' }}>{process.env.NEXT_PUBLIC_CAMPGROUND_LOCATION || "Location"}</p>
        <p className="text-gray-400 mb-8 max-w-md">
          Your home away from home. Book your perfect campsite, cabin, or tent site today.
        </p>

        {/* Search Box */}
        <div className="w-full max-w-3xl bg-white rounded-2xl shadow-2xl p-6">
          <h2 className="text-xl font-bold text-gray-900 mb-5">Check Availability</h2>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4 mb-5">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Arrival Date</label>
              <input
                type="date"
                className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm"
                min={today}
                value={arrival}
                onChange={e => {
                  setArrival(e.target.value)
                  if (departure && departure <= e.target.value) setDeparture('')
                }}
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Departure Date</label>
              <input
                type="date"
                className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm"
                min={arrival || today}
                value={departure}
                onChange={e => setDeparture(e.target.value)}
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Guests</label>
              <div className="flex gap-2">
                <div className="flex-1">
                  <input
                    type="number"
                    min={1}
                    max={20}
                    className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm"
                    placeholder="Adults"
                    value={adults}
                    onChange={e => setAdults(parseInt(e.target.value))}
                  />
                  <p className="text-xs text-gray-400 mt-0.5 text-center">Adults</p>
                </div>
                <div className="flex-1">
                  <input
                    type="number"
                    min={0}
                    max={20}
                    className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm"
                    placeholder="Children"
                    value={children}
                    onChange={e => setChildren(parseInt(e.target.value))}
                  />
                  <p className="text-xs text-gray-400 mt-0.5 text-center">Children</p>
                </div>
              </div>
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Site Type</label>
              <select
                className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm"
                value={siteType}
                onChange={e => setSiteType(e.target.value)}
              >
                <option value="all">All Types</option>
                <option value="rv_site">RV Sites</option>
                <option value="cabin">Cabins</option>
                <option value="tent">Tent Sites</option>
              </select>
            </div>
          </div>
          <button
            onClick={handleSearch}
            className="w-full py-3 rounded-xl text-white font-semibold text-lg transition-colors"
            style={{ backgroundColor: 'process.env.NEXT_PUBLIC_COLOR_ACCENT || '#3DBDD4'' }}
            onMouseOver={e => (e.currentTarget.style.backgroundColor = '#2DADC4')}
            onMouseOut={e => (e.currentTarget.style.backgroundColor = 'process.env.NEXT_PUBLIC_COLOR_ACCENT || '#3DBDD4'')}
          >
            Search Available Sites
          </button>
        </div>
      </div>

      {/* Why Book With Us */}
      {step === 1 && (
        <div className="max-w-5xl mx-auto px-4 py-16 grid grid-cols-1 md:grid-cols-3 gap-8 text-center">
          {[
            { icon: '🏕️', title: 'RV Sites', desc: 'Full hookup and water & electric sites available with 30 and 30/50 amp service.' },
            { icon: '🛖', title: 'Cozy Cabins', desc: 'Three unique cabins for a comfortable glamping experience in the woods.' },
            { icon: '⛺', title: 'Tent Sites', desc: 'Back to nature tent camping with easy access to all park amenities.' },
          ].map(item => (
            <div key={item.title} className="rounded-2xl p-6" style={{ backgroundColor: '#2B2B2B' }}>
              <div className="text-4xl mb-3">{item.icon}</div>
              <h3 className="text-white font-bold text-lg mb-2">{item.title}</h3>
              <p className="text-gray-400 text-sm">{item.desc}</p>
            </div>
          ))}
        </div>
      )}

      {/* Results placeholder */}
      {step === 2 && (
        <div className="max-w-5xl mx-auto px-4 py-12">
          <div className="flex items-center justify-between mb-6">
            <div>
              <h2 className="text-2xl font-bold text-white">Available Sites</h2>
              <p className="text-gray-400 text-sm mt-1">
                {arrival} → {departure} · {adults} adult{adults !== 1 ? 's' : ''}{children > 0 ? `, ${children} child${children !== 1 ? 'ren' : ''}` : ''}
              </p>
            </div>
            <button
              onClick={() => setStep(1)}
              className="text-sm px-4 py-2 rounded-lg"
              style={{ backgroundColor: '#2B2B2B', color: 'process.env.NEXT_PUBLIC_COLOR_ACCENT || '#3DBDD4'' }}
            >
              ← Change Dates
            </button>
          </div>
          <div className="rounded-2xl p-8 text-center" style={{ backgroundColor: '#2B2B2B' }}>
            <p className="text-gray-400">Loading available sites...</p>
            <p className="text-gray-500 text-sm mt-2">We'll connect this to your real availability next!</p>
          </div>
        </div>
      )}

      {/* Footer */}
      <div className="text-center py-8 text-gray-600 text-sm">
        © 2026 {process.env.NEXT_PUBLIC_CAMPGROUND_NAME || "Campground"} · {process.env.NEXT_PUBLIC_CAMPGROUND_LOCATION || "Location"}
      </div>
    </main>
  )
}