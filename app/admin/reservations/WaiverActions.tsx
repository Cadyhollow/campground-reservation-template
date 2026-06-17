'use client'
import { useState } from 'react'
import toast from 'react-hot-toast'

// Shown under the Waiver status on the reservation detail panel.
// When unsigned, offers "Email waiver" and "Sign on this device".
// Calls /api/send-waiver, which creates a pending signature + token.
export default function WaiverActions({
  reservationId,
  guestEmail,
  signed,
}: {
  reservationId: string
  guestEmail?: string
  signed: boolean
}) {
  const [busy, setBusy] = useState<'' | 'email' | 'person'>('')

  if (signed) {
    return (
      <div className="mt-2 text-xs font-medium text-green-700 flex items-center gap-1">
        <span>✓</span> Waiver signed
      </div>
    )
  }

  async function call(sendEmail: boolean) {
    setBusy(sendEmail ? 'email' : 'person')
    try {
      const res = await fetch('/api/send-waiver', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reservationId, sendEmail }),
      })
      const data = await res.json()
      if (!data.success) {
        toast.error(data.error || 'Could not create the waiver link.')
        setBusy('')
        return
      }
      if (sendEmail) {
        if (data.emailed) toast.success(`Waiver emailed to ${data.guestEmail}`)
        else toast.error(data.emailError ? `Link created, but email failed: ${data.emailError}` : 'Link created, but no email on file.')
        setBusy('')
      } else {
        // In-person: go to the signing page in this tab, with a hint to return
        // here (freshly loaded, so the new "Signed" status shows) when done.
        const ret = encodeURIComponent(window.location.pathname + window.location.search)
        window.location.href = `${data.signUrl}?return=${ret}`
      }
    } catch {
      toast.error('Something went wrong. Please try again.')
      setBusy('')
    }
  }

  return (
    <div className="flex gap-2 mt-2">
      <button
        onClick={() => call(true)}
        disabled={busy !== '' || !guestEmail}
        title={!guestEmail ? 'No email on file for this guest' : 'Email a signing link to the guest'}
        className="text-xs font-medium bg-green-700 text-white px-3 py-1.5 rounded-lg hover:bg-green-800 disabled:opacity-50"
      >
        {busy === 'email' ? 'Sending…' : '✉ Email waiver'}
      </button>
      <button
        onClick={() => call(false)}
        disabled={busy !== ''}
        className="text-xs font-medium bg-white text-[#2E6B8A] border border-[#2E6B8A] px-3 py-1.5 rounded-lg hover:bg-[#e8f2f7] disabled:opacity-50"
      >
        {busy === 'person' ? 'Opening…' : '✍ Sign on this device'}
      </button>
    </div>
  )
}
