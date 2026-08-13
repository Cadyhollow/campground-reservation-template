'use client'

// Staff Accounts — the Owner's screen for who can get into the admin.
//
// Security PR 7-1. Until now an account existed only because someone with the service key ran
// scripts/seed-user.mjs by hand. This is the durable replacement for that.
//
// NOTHING PRIVILEGED HAPPENS IN THIS FILE. Every operation is a fetch to /api/admin-users, which
// is gated with requireRole(request, 'owner') and does the work with the service-role key on the
// server. The service key is never sent to a browser, and this page holds no capability of its
// own — a Staff user who opened it by URL would find every button answering 403. The page itself
// is Owner-gated twice over: proxy.ts refuses it (lib/admin-pages.ts maps /admin/users to
// 'owner') and the nav does not draw the link below Owner.
//
// The list is read through the API rather than a browser Supabase query on purpose: the 5a policy
// on `profiles` scopes SELECT to auth.uid() = id, so a browser read would return the Owner's own
// row and nothing else. Widening that policy to make this page work would let every staff member
// enumerate their colleagues' addresses. The server reads it over service-role instead.

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import toast, { Toaster } from 'react-hot-toast'
import { ROLE_OPTIONS, type Role } from '@/lib/roles'

type AdminUser = {
  id: string
  email: string | null
  full_name: string | null
  role: Role
  active: boolean
  created_at: string
}

const emptyForm = { email: '', full_name: '', password: '', role: 'staff' as Role }

export default function StaffAccountsPage() {
  const router = useRouter()
  const [users, setUsers] = useState<AdminUser[]>([])
  const [loading, setLoading] = useState(true)
  const [showForm, setShowForm] = useState(false)
  const [form, setForm] = useState(emptyForm)
  const [saving, setSaving] = useState(false)
  const [meId, setMeId] = useState<string | null>(null)
  // Which row is mid-request, so its buttons can be disabled individually rather than freezing
  // the whole table.
  const [busyId, setBusyId] = useState<string | null>(null)
  const [resetFor, setResetFor] = useState<AdminUser | null>(null)
  const [resetPassword, setResetPassword] = useState('')

  useEffect(() => {
    load()
    fetch('/api/me')
      .then(res => (res.ok ? res.json() : null))
      .then(data => setMeId(data?.userId ?? null))
      .catch(() => {})
  }, [])

  async function load() {
    const res = await fetch('/api/admin-users')
    const data = await res.json().catch(() => ({}))
    if (!res.ok) {
      // A 401 here is not "something went wrong loading accounts" — it means this browser's
      // session is no longer valid, and the only cure is signing in again. Saying "Unauthorized"
      // sends the reader looking for a permission problem that does not exist. requireRole answers
      // 401 for a dead session and 403 for a live one whose role is too low, so the two cases are
      // distinguishable here and are worth wording differently.
      if (res.status === 401) {
        toast.error('Your session has ended. Sign in again to continue.', { duration: 8000 })
      } else {
        toast.error(data.error || 'Could not load accounts.')
      }
    } else {
      setUsers(data.users || [])
    }
    setLoading(false)
  }

  async function handleCreate() {
    if (!form.email.trim()) { toast.error('Enter an email address.'); return }
    if (form.password.length < 12) { toast.error('Password must be at least 12 characters.'); return }

    setSaving(true)
    const res = await fetch('/api/admin-users', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(form),
    })
    const data = await res.json().catch(() => ({}))
    setSaving(false)

    if (!res.ok) { toast.error(data.error || 'Could not create the account.'); return }

    toast.success(`${form.email.trim().toLowerCase()} can now log in. Give them the password you just set.`)
    setForm(emptyForm)
    setShowForm(false)
    load()
  }

  // Every per-user change goes through here, so the refusals from the lockout guard are reported
  // the same way wherever they come from. The guard answers 409 with a sentence written for a
  // person — "This is the only active owner…" — so it is shown as-is rather than replaced with a
  // generic failure.
  async function patch(user: AdminUser, body: Record<string, unknown>, success: string) {
    setBusyId(user.id)
    const res = await fetch(`/api/admin-users/${user.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    const data = await res.json().catch(() => ({}))
    setBusyId(null)

    if (!res.ok) {
      toast.error(data.error || 'That change could not be made.', { duration: 6000 })
      // Reload so the UI never keeps showing a value the server refused.
      load()
      return false
    }

    toast.success(success)
    load()
    return true
  }

  // Resetting your OWN password from here is the one case this screen cannot finish cleanly.
  // The route changes the password with auth.admin.updateUserById(), and GoTrue revokes the
  // target's sessions when it does — so when the target is you, your own session dies the instant
  // the write lands. The PATCH itself returns 200; the reload immediately after it comes back 401,
  // which is why this used to end in a false "Unauthorized" over a change that had in fact
  // succeeded. The session cannot be refreshed either: the refresh token is revoked with the rest.
  //
  // So it is steered to /admin/account instead, which uses supabase.auth.updateUser() — that acts
  // on the caller's own session and re-issues its tokens, leaving the person signed in.
  function isSelf(user: AdminUser) {
    return !!meId && meId === user.id
  }

  async function handleResetPassword() {
    if (!resetFor) return
    if (isSelf(resetFor)) {
      toast.error('Change your own password from My Account, so you stay signed in.', { duration: 8000 })
      router.push('/admin/account')
      return
    }
    if (resetPassword.length < 12) { toast.error('Password must be at least 12 characters.'); return }

    const ok = await patch(
      resetFor,
      { password: resetPassword },
      `Password reset for ${resetFor.email}. Give them the new one — it is not emailed.`
    )
    if (ok) { setResetFor(null); setResetPassword('') }
  }

  const activeOwners = users.filter(u => u.role === 'owner' && u.active).length

  return (
    <div className="p-6 max-w-5xl mx-auto">
      <Toaster />
      <div className="flex items-center justify-between mb-6">
        <div>
          <h2 className="text-2xl font-bold text-gray-900">Staff Accounts</h2>
          <p className="text-sm text-gray-500 mt-1">
            Who can log in to the admin, and what each person is allowed to do.
          </p>
        </div>
        <button
          onClick={() => setShowForm(true)}
          className="bg-green-700 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-green-800"
        >
          + Add Account
        </button>
      </div>

      {/* There is no password-reset email on this system, and someone will eventually wonder why.
          Saying so here is cheaper than the support call. */}
      <div className="rounded-xl px-4 py-3 mb-6 text-sm"
        style={{ background: '#eff6ff', color: '#1e40af', border: '1px solid #bfdbfe' }}>
        Passwords are handed over in person — this system does not send email for password resets.
        Set one here and tell the person what it is; they can change it themselves under{' '}
        <strong>My Account</strong>.
      </div>

      {/* Add account */}
      {showForm && (
        <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-6 mb-6">
          <h3 className="text-lg font-semibold text-gray-900 mb-4">Add Account</h3>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Email *</label>
              <input
                className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm"
                type="email"
                autoComplete="off"
                placeholder="name@example.com"
                value={form.email}
                onChange={e => setForm({ ...form, email: e.target.value })}
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Full Name</label>
              <input
                className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm"
                placeholder="Jo Smith"
                value={form.full_name}
                onChange={e => setForm({ ...form, full_name: e.target.value })}
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Initial Password *</label>
              <input
                className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm"
                type="password"
                autoComplete="new-password"
                placeholder="At least 12 characters"
                value={form.password}
                onChange={e => setForm({ ...form, password: e.target.value })}
              />
              <p className="text-xs text-gray-500 mt-1">You will need to tell them this password.</p>
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Role *</label>
              <select
                className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm"
                value={form.role}
                onChange={e => setForm({ ...form, role: e.target.value as Role })}
              >
                {ROLE_OPTIONS.map(r => (
                  <option key={r.value} value={r.value}>{r.label} — {r.blurb}</option>
                ))}
              </select>
            </div>
          </div>
          <div className="flex gap-3 mt-4">
            <button
              onClick={handleCreate}
              disabled={saving}
              className="bg-green-700 text-white px-6 py-2 rounded-lg text-sm font-medium hover:bg-green-800 disabled:opacity-50"
            >
              {saving ? 'Creating...' : 'Create Account'}
            </button>
            <button
              onClick={() => { setShowForm(false); setForm(emptyForm) }}
              className="bg-gray-100 text-gray-700 px-6 py-2 rounded-lg text-sm font-medium hover:bg-gray-200"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Reset password */}
      {resetFor && (
        <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-6 mb-6">
          <h3 className="text-lg font-semibold text-gray-900 mb-1">Reset Password</h3>
          <p className="text-sm text-gray-500 mb-4">{resetFor.email}</p>
          <input
            className="w-full max-w-sm border border-gray-200 rounded-lg px-3 py-2 text-sm"
            type="password"
            autoComplete="new-password"
            placeholder="New password, at least 12 characters"
            value={resetPassword}
            onChange={e => setResetPassword(e.target.value)}
          />
          <div className="flex gap-3 mt-4">
            <button
              onClick={handleResetPassword}
              disabled={busyId === resetFor.id}
              className="bg-green-700 text-white px-6 py-2 rounded-lg text-sm font-medium hover:bg-green-800 disabled:opacity-50"
            >
              {busyId === resetFor.id ? 'Resetting...' : 'Set Password'}
            </button>
            <button
              onClick={() => { setResetFor(null); setResetPassword('') }}
              className="bg-gray-100 text-gray-700 px-6 py-2 rounded-lg text-sm font-medium hover:bg-gray-200"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* The list */}
      {loading ? (
        <div className="text-center py-12 text-gray-400">Loading accounts...</div>
      ) : (
        <div className="bg-white rounded-xl shadow-sm border border-gray-100">
          <div className="px-6 py-4 border-b border-gray-100 flex items-center justify-between">
            <h3 className="font-semibold text-gray-900">Accounts ({users.length})</h3>
            <span className="text-xs text-gray-500">
              {activeOwners} active owner{activeOwners === 1 ? '' : 's'}
            </span>
          </div>

          {users.length === 0 ? (
            <div className="px-6 py-8 text-center text-gray-400">No accounts yet.</div>
          ) : (
            <div className="divide-y divide-gray-50">
              {users.map(user => {
                const isMe = !!meId && meId === user.id
                const busy = busyId === user.id
                return (
                  <div key={user.id} className="px-6 py-4 flex flex-wrap items-center gap-3 justify-between">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="font-medium text-gray-900 truncate">
                          {user.full_name || user.email}
                        </span>
                        {isMe && (
                          <span className="text-xs px-2 py-0.5 rounded-full bg-gray-100 text-gray-600">you</span>
                        )}
                        {!user.active && (
                          <span className="text-xs px-2 py-0.5 rounded-full bg-red-50 text-red-700">
                            deactivated
                          </span>
                        )}
                      </div>
                      {user.full_name && (
                        <div className="text-sm text-gray-500 truncate">{user.email}</div>
                      )}
                    </div>

                    <div className="flex items-center gap-2 flex-wrap">
                      <select
                        className="border border-gray-200 rounded-lg px-2 py-1.5 text-sm"
                        value={user.role}
                        disabled={busy}
                        onChange={e =>
                          patch(user, { role: e.target.value }, `${user.email} is now ${e.target.value}.`)
                        }
                      >
                        {ROLE_OPTIONS.map(r => (
                          <option key={r.value} value={r.value}>{r.label}</option>
                        ))}
                      </select>

                      {/* Your own row gets the self-service page, not the admin reset — see
                          handleResetPassword() for why the admin path cannot finish on yourself. */}
                      {isMe ? (
                        <Link
                          href="/admin/account"
                          className="bg-gray-100 text-gray-700 px-3 py-1.5 rounded-lg text-sm font-medium hover:bg-gray-200"
                        >
                          Change My Password
                        </Link>
                      ) : (
                        <button
                          onClick={() => { setResetFor(user); setResetPassword('') }}
                          disabled={busy}
                          className="bg-gray-100 text-gray-700 px-3 py-1.5 rounded-lg text-sm font-medium hover:bg-gray-200 disabled:opacity-50"
                        >
                          Reset Password
                        </button>
                      )}

                      {user.active ? (
                        <button
                          onClick={() =>
                            patch(user, { active: false }, `${user.email} can no longer log in.`)
                          }
                          disabled={busy}
                          className="bg-red-50 text-red-700 px-3 py-1.5 rounded-lg text-sm font-medium hover:bg-red-100 disabled:opacity-50"
                        >
                          Deactivate
                        </button>
                      ) : (
                        <button
                          onClick={() =>
                            patch(user, { active: true }, `${user.email} can log in again.`)
                          }
                          disabled={busy}
                          className="bg-green-50 text-green-700 px-3 py-1.5 rounded-lg text-sm font-medium hover:bg-green-100 disabled:opacity-50"
                        >
                          Reactivate
                        </button>
                      )}
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </div>
      )}

      <p className="text-xs text-gray-400 mt-4">
        Accounts are deactivated, never deleted, so past bookings and folio entries keep pointing at
        a real person.
      </p>
    </div>
  )
}
