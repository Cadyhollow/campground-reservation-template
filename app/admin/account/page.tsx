'use client'

// My Account — change your own password.
//
// Security PR 7-1. Available to EVERY logged-in user, not just Owners: /admin/account is absent
// from lib/admin-pages.ts, so it takes the default of 'staff'. That is deliberate. An Owner sets
// the initial password and reads it out loud; if the only way to change it were to ask the Owner
// again, everyone's password would stay the one that was said across a counter.
//
// NO SERVICE KEY HERE, and none needed. Changing your OWN password is the one account operation
// that requires no privilege beyond being yourself: supabase.auth.updateUser() acts on the session
// in this browser and can touch no other account. That is why this page talks to Supabase directly
// while every operation on app/admin/users/page.tsx goes through an Owner-gated server route.
//
// GoTrue endpoints, not PostgREST — worth noting for PR 6, which revokes the `anon` Postgres role.
// Nothing on this page is a table read, so the revoke cannot break it.

import { useEffect, useState } from 'react'
import toast, { Toaster } from 'react-hot-toast'
import { createBrowserSupabase } from '@/lib/supabase-browser'
import { ROLE_OPTIONS, type Role } from '@/lib/roles'

const MIN_PASSWORD_LENGTH = 12 // matches lib/admin-users.ts and scripts/seed-user.mjs

type Me = { role: Role; email: string | null; userId: string | null }

export default function AccountPage() {
  const [me, setMe] = useState<Me | null>(null)
  const [loading, setLoading] = useState(true)
  const [current, setCurrent] = useState('')
  const [next, setNext] = useState('')
  const [confirm, setConfirm] = useState('')
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    fetch('/api/me')
      .then(res => (res.ok ? res.json() : null))
      .then(data => setMe(data))
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [])

  async function handleChange() {
    if (!me?.email) return
    if (!current) { toast.error('Enter your current password.'); return }
    if (next.length < MIN_PASSWORD_LENGTH) {
      toast.error(`New password must be at least ${MIN_PASSWORD_LENGTH} characters.`); return
    }
    if (next !== confirm) { toast.error('The new passwords do not match.'); return }
    if (next === current) { toast.error('That is already your password.'); return }

    setSaving(true)
    const supabase = createBrowserSupabase()

    // CONFIRM THE CURRENT PASSWORD FIRST.
    //
    // Supabase does not require it: a valid session is enough to call updateUser(). Asking anyway
    // is a UX judgement with a security side effect worth naming — it means an unattended, logged-in
    // browser cannot be used to change the password and take the account over, which on a shared
    // office machine at a campground is the realistic threat, not a remote attacker.
    //
    // signInWithPassword is the check, because there is no verify-password endpoint. It replaces
    // the current session with a fresh one for the SAME user, which is harmless — and on failure
    // it leaves the existing session untouched, so a wrong guess does not sign anyone out.
    const { error: wrongPassword } = await supabase.auth.signInWithPassword({
      email: me.email,
      password: current,
    })
    if (wrongPassword) {
      setSaving(false)
      toast.error('That is not your current password.')
      return
    }

    const { error } = await supabase.auth.updateUser({ password: next })
    setSaving(false)

    if (error) {
      // Supabase's own message is worth surfacing: it carries the project's password policy, which
      // this page does not otherwise know about.
      toast.error(error.message || 'Could not change your password.')
      return
    }

    setCurrent(''); setNext(''); setConfirm('')
    toast.success('Password changed. Use it the next time you log in.')
  }

  if (loading) {
    return <div className="p-6 text-center text-gray-400">Loading...</div>
  }

  const roleLabel = ROLE_OPTIONS.find(r => r.value === me?.role)

  return (
    <div className="p-6 max-w-xl mx-auto">
      <Toaster />
      <h2 className="text-2xl font-bold text-gray-900">My Account</h2>
      <p className="text-sm text-gray-500 mt-1 mb-6">Your login and your password.</p>

      <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-6 mb-6">
        <div className="flex items-center justify-between">
          <div className="min-w-0">
            <div className="text-xs uppercase tracking-widest text-gray-400 mb-1">Signed in as</div>
            <div className="font-medium text-gray-900 truncate">
              {me?.email || 'Unknown'}
            </div>
          </div>
          {roleLabel && (
            <span className="text-xs px-2.5 py-1 rounded-full bg-gray-100 text-gray-700 whitespace-nowrap">
              {roleLabel.label}
            </span>
          )}
        </div>
        {roleLabel && (
          <p className="text-sm text-gray-500 mt-3">{roleLabel.label} — {roleLabel.blurb}.</p>
        )}
      </div>

      <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-6">
        <h3 className="text-lg font-semibold text-gray-900 mb-4">Change Password</h3>
        <div className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1" htmlFor="current-password">
              Current Password
            </label>
            <input
              id="current-password"
              className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm"
              type="password"
              autoComplete="current-password"
              value={current}
              onChange={e => setCurrent(e.target.value)}
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1" htmlFor="new-password">
              New Password
            </label>
            <input
              id="new-password"
              className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm"
              type="password"
              autoComplete="new-password"
              placeholder={`At least ${MIN_PASSWORD_LENGTH} characters`}
              value={next}
              onChange={e => setNext(e.target.value)}
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1" htmlFor="confirm-password">
              Confirm New Password
            </label>
            <input
              id="confirm-password"
              className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm"
              type="password"
              autoComplete="new-password"
              value={confirm}
              onChange={e => setConfirm(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') handleChange() }}
            />
          </div>
          <button
            onClick={handleChange}
            disabled={saving}
            className="bg-green-700 text-white px-6 py-2 rounded-lg text-sm font-medium hover:bg-green-800 disabled:opacity-50"
          >
            {saving ? 'Changing...' : 'Change Password'}
          </button>
        </div>
        <p className="text-xs text-gray-400 mt-4">
          Forgotten your password? This system does not send reset emails — ask an owner to set a
          new one for you.
        </p>
      </div>
    </div>
  )
}
