'use client'

import { useEffect, useState, Suspense } from 'react'
import { useSearchParams } from 'next/navigation'

function SquareSettings() {
  const searchParams = useSearchParams()
  const [status, setStatus] = useState<'loading' | 'connected' | 'disconnected'>('loading')
  const [disconnecting, setDisconnecting] = useState(false)

  useEffect(() => {
    const success = searchParams.get('success')
    const error = searchParams.get('error')

    if (success === 'true') {
      setStatus('connected')
    } else if (error) {
      setStatus('disconnected')
    } else {
      fetch('/api/square/status')
        .then(res => res.json())
        .then(data => setStatus(data.connected ? 'connected' : 'disconnected'))
        .catch(() => setStatus('disconnected'))
    }
  }, [searchParams])

  async function handleDisconnect() {
    if (!confirm('Are you sure you want to disconnect your Square account? Payments will stop working until you reconnect.')) return
    setDisconnecting(true)
    await fetch('/api/square/disconnect', { method: 'POST' })
    setStatus('disconnected')
    setDisconnecting(false)
  }

  return (
    <div className="max-w-xl mx-auto py-12 px-4">
      <h1 className="text-2xl font-bold mb-2">Square Payments</h1>
      <p className="text-gray-600 mb-8">
        Connect your Square account so guests can pay for reservations directly into your account.
      </p>

      {status === 'loading' && (
        <div className="text-gray-500">Checking connection status...</div>
      )}

      {status === 'disconnected' && (
        <div>
          {searchParams.get('error') && (
            <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded text-red-700 text-sm">
              Something went wrong connecting your Square account. Please try again.
            </div>
          )}
          <a href="/api/square/connect" className="inline-flex items-center gap-3 bg-black text-white px-6 py-3 rounded-lg font-medium hover:bg-gray-800 transition-colors">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
              <path d="M5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2zm7 4a5 5 0 1 0 0 10A5 5 0 0 0 12 7zm0 2a3 3 0 1 1 0 6 3 3 0 0 1 0-6z"/>
            </svg>
            Connect with Square
          </a>
          <p className="mt-3 text-sm text-gray-500">
            You'll be redirected to Square to log in and approve access. You'll come right back here when done.
          </p>
        </div>
      )}

      {status === 'connected' && (
        <div>
          <div className="mb-6 p-4 bg-green-50 border border-green-200 rounded-lg flex items-center gap-3">
            <div className="w-3 h-3 rounded-full bg-green-500"></div>
            <span className="text-green-800 font-medium">Square account connected</span>
          </div>
          <p className="text-sm text-gray-600 mb-4">
            Payments from guest reservations will be deposited directly into your Square account.
          </p>
          <button
            onClick={handleDisconnect}
            disabled={disconnecting}
            className="text-sm text-red-600 hover:text-red-800 underline disabled:opacity-50">
            {disconnecting ? 'Disconnecting...' : 'Disconnect Square account'}
          </button>
        </div>
      )}
    </div>
  )
}

export default function SquareSettingsPage() {
  return (
    <Suspense fallback={<div className="max-w-xl mx-auto py-12 px-4 text-gray-500">Loading...</div>}>
      <SquareSettings />
    </Suspense>
  )
}
