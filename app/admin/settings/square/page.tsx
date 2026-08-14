'use client'

import { useEffect, useState, Suspense } from 'react'
import { useSearchParams } from 'next/navigation'

// THE SQUARE SETTINGS SCREEN — and, since step 9, the place a dying connection becomes visible.
//
// Square access tokens expire 30 days after issue. The platform renews them on a 3-day sweep, with
// a second attempt on the charge path itself. When BOTH of those fail — most often because the
// owner revoked the authorization in their own Square dashboard, so no amount of retrying will
// ever work — the connection is stamped `reconnect_required`.
//
// That stamp has to surface HERE, and prominently, because the alternative is the failure mode
// this whole step exists to remove: a park that looks connected, a green badge, and a camper
// discovering at the payment step that the card cannot be charged. The owner needs to find out
// from their own settings screen, days early, in language that says what to do about it.

type Status = {
  connected: boolean
  merchant_id: string | null
  connected_at: string | null
  status: string | null
  refresh_failed_at: string | null
  token_expires_at: string | null
  location_id: string | null
}

function SquareSettings() {
  const searchParams = useSearchParams()
  const error = searchParams.get('error')
  // 'pending' until the status endpoint answers; null once it has answered with nothing usable.
  const [info, setInfo] = useState<Status | null | 'pending'>('pending')
  const [disconnecting, setDisconnecting] = useState(false)

  useEffect(() => {
    // A failed handshake is decided by the URL alone — nothing to fetch, and fetching would only
    // race the error the callback just told us about.
    if (error) return

    let cancelled = false
    // Even straight after a successful connect, the status is FETCHED rather than assumed. The
    // health fields are the reason: `?success=true` says the handshake finished, not that the
    // connection is usable — it may have landed on location_pending with a choice still to make,
    // or (step 9) be carrying a failed token refresh from a previous authorisation.
    fetch('/api/square/status')
      .then(res => res.json())
      .then((data: Status) => { if (!cancelled) setInfo(data) })
      .catch(() => { if (!cancelled) setInfo(null) })
    return () => { cancelled = true }
  }, [error])

  // Derived, not stored. Keeping this out of state is what stops the error case and the fetched
  // case from being able to disagree with each other.
  const state: 'loading' | 'connected' | 'disconnected' =
    error ? 'disconnected'
    : info === 'pending' ? 'loading'
    : info?.connected ? 'connected'
    : 'disconnected'

  const status = info === 'pending' ? null : info

  async function handleDisconnect() {
    if (!confirm('Are you sure you want to disconnect your Square account? Payments will stop working until you reconnect.')) return
    setDisconnecting(true)
    await fetch('/api/square/disconnect', { method: 'POST' })
    setInfo(null)
    setDisconnecting(false)
  }

  const needsReconnect = status?.status === 'reconnect_required' || !!status?.refresh_failed_at
  const needsLocation = status?.status === 'location_pending' || (status?.connected && !status?.location_id)

  return (
    <div className="max-w-xl mx-auto py-12 px-4">
      <h1 className="text-2xl font-bold mb-2">Square Payments</h1>
      <p className="text-gray-600 mb-8">
        Connect your Square account so guests can pay for reservations directly into your account.
      </p>

      {state === 'loading' && (
        <div className="text-gray-500">Checking connection status...</div>
      )}

      {state === 'disconnected' && (
        <div>
          {error && (
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
            You&apos;ll be redirected to Square to log in and approve access. You&apos;ll come right back here when done.
          </p>
        </div>
      )}

      {state === 'connected' && (
        <div>
          {/* Ordered worst-first. An owner scanning this page should hit the thing that will stop
              their payments before they hit the reassuring green badge. */}
          {needsReconnect ? (
            <div className="mb-6 p-4 bg-red-50 border border-red-300 rounded-lg">
              <div className="flex items-center gap-3 mb-2">
                <div className="w-3 h-3 rounded-full bg-red-500"></div>
                <span className="text-red-900 font-semibold">Reconnect required</span>
              </div>
              <p className="text-sm text-red-800 mb-3">
                We could no longer renew the secure connection to your Square account. This usually
                means access was removed from inside Square. <strong>Payments will stop working
                when the current authorisation expires</strong>, so please reconnect now.
              </p>
              <a
                href="/api/square/connect"
                className="inline-block bg-red-600 text-white px-4 py-2 rounded font-medium text-sm hover:bg-red-700 transition-colors">
                Reconnect Square
              </a>
            </div>
          ) : needsLocation ? (
            <div className="mb-6 p-4 bg-amber-50 border border-amber-300 rounded-lg">
              <div className="flex items-center gap-3 mb-2">
                <div className="w-3 h-3 rounded-full bg-amber-500"></div>
                <span className="text-amber-900 font-semibold">One step left</span>
              </div>
              <p className="text-sm text-amber-800">
                Your Square account is connected, but we still need to know which of your Square
                locations should receive payments. Contact support to finish setting this up —
                payments cannot be taken until it is chosen.
              </p>
            </div>
          ) : (
            <div className="mb-6 p-4 bg-green-50 border border-green-200 rounded-lg flex items-center gap-3">
              <div className="w-3 h-3 rounded-full bg-green-500"></div>
              <span className="text-green-800 font-medium">Square account connected</span>
            </div>
          )}

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
