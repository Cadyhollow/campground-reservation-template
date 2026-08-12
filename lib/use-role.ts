'use client'

// The signed-in user's role, for client components that need to hide an action.
//
// Security PR 7-1. The nav gate shipped first and was not enough: hiding a nav item
// stops nobody from reaching an ACTION on a page they are legitimately allowed to open. A Staff
// user could open /admin/reservations — correctly, it is a Staff page — and still see Cancel,
// Issue Refund and Permanently Delete sitting on the panel.
//
// WHY A MODULE-LEVEL CACHE. Every component that needs the role would otherwise fetch /api/me for
// itself, which on the folio pages is several requests for one answer that cannot change while the
// page is open. The promise is created once per page load and shared; a full navigation (which is
// what login does) starts a new one.
//
// FAILS CLOSED. A failed or 401 fetch yields null, and atLeast(null, …) is false, so an action is
// hidden rather than shown when we do not know. `roleLoaded` exists so callers can hold the UI
// until the answer arrives instead of flashing a privileged button and snatching it back.
//
// THIS IS PRESENTATION ONLY. Nothing here authorises anything. The API routes enforce with
// requireRole(), the pages with proxy.ts, and the raw PostgREST writes with the role-gated RLS
// policies in the schema. Editing the response in devtools reveals buttons that then fail at all
// three.

import { useEffect, useState } from 'react'
import type { Role } from '@/lib/roles'

let cached: Promise<Role | null> | null = null

function fetchRole(): Promise<Role | null> {
  if (!cached) {
    cached = fetch('/api/me')
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => (data?.role ?? null) as Role | null)
      .catch(() => null)
  }
  return cached
}

export function useRole(): { role: Role | null; roleLoaded: boolean } {
  const [role, setRole] = useState<Role | null>(null)
  const [roleLoaded, setRoleLoaded] = useState(false)

  useEffect(() => {
    let alive = true
    fetchRole().then((value) => {
      if (!alive) return
      setRole(value)
      setRoleLoaded(true)
    })
    return () => {
      alive = false
    }
  }, [])

  return { role, roleLoaded }
}
