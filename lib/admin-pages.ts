// The minimum role each admin PAGE requires.
//
// Security PR 7-1. This is the page half of the route→role map; the API half lives at each
// route's requireRole() call. It is a module of its own rather than a constant inside proxy.ts
// because two places need the same answer and they must not drift:
//
//   proxy.ts             — enforces it, server-side, before the page renders
//   app/admin/layout.tsx — hides nav items the user cannot use
//
// The nav is UX. The proxy is the guard. If these two ever disagree the nav shows a link that
// redirects, which is a cosmetic bug; the reverse — enforcing in the nav only — is the security
// bug this file exists to make impossible.
//
// WHY SOME OF THESE SIT WHERE THEY DO:
//
//   /admin/products is the product CATALOGUE editor (pricing a product), not the till. Ringing a
//   product up happens on the folio pages, which are Staff. So this is Owner.
//
//   /admin/transactions is a financial listing, so Manager — same reasoning as /admin/reports.
//
//   /admin/electric-billing is Manager, and this is a DELIBERATE DEVIATION from the default that
//   recording a reading is a Staff operation. create_electric_bill() inserts the reading and the
//   folio charge in one RPC, and this page is the only place a reading can be entered, so
//   Staff-level reading entry cannot be separated from Manager-level bill issuance without
//   splitting the UI. Splitting it is a follow-up; until then the whole page is Manager.
//
//   /admin/settings/terminal and /admin/settings/square are covered by the /admin/settings
//   prefix — pairing a card reader and connecting the park's Square account are both integration
//   configuration, and the Square one decides where the park's money lands.
//
//   /admin/users is the account-management screen, and it is Owner for the obvious reason: it
//   decides who may issue a refund. Note that listing it here is the SECOND gate, not the only
//   one — every operation on that page is a call to /api/admin-users, which runs its own
//   requireRole(request, 'owner'). A page-level entry alone would leave the routes open.
//
//   /admin/account is deliberately ABSENT, so it takes the 'staff' default. It is the
//   self-service password screen and every logged-in user needs it, including a Staff member who
//   can reach nothing else on this list.

import type { Role } from '@/lib/roles'

// Longest prefix wins, so /admin/settings/terminal resolves through /admin/settings and a future
// /admin/reports/detail inherits Manager without needing its own entry.
const PAGE_ROLES: [string, Role][] = [
  ['/admin/sites', 'owner'],
  ['/admin/pricing', 'owner'],
  ['/admin/min-stay', 'owner'],
  ['/admin/cancellation-rules', 'owner'],
  ['/admin/addons', 'owner'],
  ['/admin/fees', 'owner'],
  ['/admin/discounts', 'owner'],
  ['/admin/products', 'owner'],
  ['/admin/settings', 'owner'],
  ['/admin/users', 'owner'],

  // Seasonal management. MANAGER (decided 2026-08-19), and listed here deliberately rather than
  // left to the 'staff' default this map falls back to.
  //
  // Cady never listed it, so on that park the page is staff-reachable while its own Create, Edit
  // and Send buttons 403 on a staff member — a screen more open than its own actions. Listing it
  // is what stops the same thing happening to every Summit client.
  ['/admin/seasonals', 'manager'],
  ['/admin/reports', 'manager'],
  ['/admin/transactions', 'manager'],
  ['/admin/send-email', 'manager'],
  ['/admin/electric-billing', 'manager'],
]

/**
 * The minimum role for a path. Everything else under /admin is Staff — the default is the
 * permissive one ON PURPOSE: a new page added without touching this file is reachable by staff
 * but still behind a login, rather than silently unreachable by everyone.
 *
 * The corollary is that a new SENSITIVE page must be added here. That is why the nav reads from
 * this same table: a page missing from it shows up for everyone, which is visible immediately.
 */
export function roleForPath(pathname: string): Role {
  let best: Role = 'staff'
  let bestLength = -1

  for (const [prefix, role] of PAGE_ROLES) {
    // Path-boundary match, not startsWith: '/admin/sites' must not also claim '/admin/sites-x'.
    const matches = pathname === prefix || pathname.startsWith(prefix + '/')
    if (matches && prefix.length > bestLength) {
      best = role
      bestLength = prefix.length
    }
  }

  return best
}
