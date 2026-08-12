// Account management — the service-role half, plus the guards that stop an Owner from ending
// the park's own access to its admin.
//
// Security PR 7-1. This is the durable replacement for scripts/seed-user.mjs: until now the ONLY
// way an account came into existence was someone with the service key running a script by hand.
// That is fine for a bootstrap and hopeless as an operating procedure — a park owner cannot add a
// seasonal staff member in April by cloning a repository and running a node script.
//
// SERVER ONLY. Every function here uses SUPABASE_SERVICE_ROLE_KEY, which bypasses RLS entirely and
// can mint auth users. It must never be imported by a client component. The rule the routes
// enforce on top of that: the service key does the work, but only after requireRole(request,
// 'owner') has said who is asking. The browser sends intent; it never sends privilege.
//
// WHY THE SERVICE KEY AT ALL, rather than widening the RLS policies so an Owner could write
// `profiles` directly from the browser: creating a LOGIN is not a table write. auth.users lives in
// a schema PostgREST does not expose, and the admin API is the only supported way in. And the
// moment `authenticated` gains UPDATE on profiles.role, every staff member can promote themselves
// — RLS would have to encode "an owner may write any row except in ways that stranded the last
// owner", which is exactly the kind of multi-row invariant a row-level policy cannot express. See
// lockoutProblem() below for the invariant in question.
//
// NO PUBLIC SIGNUP, still. Supabase's disable_signup remains ON for this project (verified via
// /auth/v1/settings). Nothing here relaxes it: admin.createUser is a service-role call that does
// not go through the signup endpoint, so accounts exist only because an Owner made one.

import { createClient } from '@supabase/supabase-js'
import { rankOf, type Role } from '@/lib/roles'

/** The ladder, in display order. Matches the profiles CHECK constraint and app.at_least(). */
export const ROLES: Role[] = ['owner', 'manager', 'staff']

export function isRole(value: unknown): value is Role {
  return typeof value === 'string' && rankOf(value) > 0
}

/**
 * The service-role client.
 *
 * persistSession/autoRefreshToken off, matching scripts/seed-user.mjs: this client is never a
 * logged-in user, and leaving the defaults on would have it try to keep a session alive on the
 * server, where there is no storage and no user to keep.
 */
export const adminDb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { autoRefreshToken: false, persistSession: false } }
)

export type AdminUser = {
  id: string
  email: string | null
  full_name: string | null
  role: Role
  active: boolean
  created_at: string
}

const PROFILE_COLUMNS = 'id, email, full_name, role, active, created_at'

/** Every admin account, oldest first. profiles is the authority; auth.users is its shadow. */
export async function listAdminUsers(): Promise<{ users: AdminUser[]; error: string | null }> {
  const { data, error } = await adminDb
    .from('profiles')
    .select(PROFILE_COLUMNS)
    .order('created_at', { ascending: true })

  if (error) return { users: [], error: error.message }
  return { users: (data ?? []) as AdminUser[], error: null }
}

export async function getAdminUser(id: string): Promise<AdminUser | null> {
  const { data } = await adminDb.from('profiles').select(PROFILE_COLUMNS).eq('id', id).maybeSingle()
  return (data as AdminUser | null) ?? null
}

/**
 * The auth user for an email, or null.
 *
 * listUsers is paged and there is no get-by-email in the admin API. 1000 is far beyond any
 * campground's staff list; if it were ever exceeded the failure mode is createUser refusing a
 * duplicate email, not a silent wrong write. Same reasoning, same number, as seed-user.mjs.
 */
export async function findAuthUserByEmail(email: string) {
  const { data, error } = await adminDb.auth.admin.listUsers({ page: 1, perPage: 1000 })
  if (error) return { user: null, error: error.message }
  const match = data?.users?.find((u) => u.email?.toLowerCase() === email.toLowerCase()) ?? null
  return { user: match, error: null }
}

// ---------------------------------------------------------------------------
// Validation. Shared by the create and update routes so the two cannot disagree
// about what a usable password or email is.
// ---------------------------------------------------------------------------

/** Matches seed-user.mjs. Long rather than complex: length is the property that actually helps. */
export const MIN_PASSWORD_LENGTH = 12

export function passwordProblem(value: unknown): string | null {
  if (typeof value !== 'string' || value.length === 0) return 'A password is required.'
  if (value.length < MIN_PASSWORD_LENGTH) {
    return `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`
  }
  return null
}

/** Lowercased and trimmed, or null if it could not be an address. Stored lowercase so the
 *  duplicate check in findAuthUserByEmail and the profiles row agree on one spelling. */
export function normalizeEmail(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const email = value.trim().toLowerCase()
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : null
}

// ---------------------------------------------------------------------------
// THE LOCKOUT GUARD — the one rule this whole stage is built around.
// ---------------------------------------------------------------------------

/** How many accounts can currently reach the Owner-only screens. */
export async function countActiveOwners(): Promise<number | null> {
  const { count, error } = await adminDb
    .from('profiles')
    .select('id', { count: 'exact', head: true })
    .eq('role', 'owner')
    .eq('active', true)

  if (error) return null
  return count ?? 0
}

/**
 * Why a change must be refused, or null when it is safe.
 *
 * TWO DISTINCT FAILURES, and it is worth separating them because they have different remedies:
 *
 *   1. NOBODY IS LEFT. Demote or deactivate the last active Owner and this page — the only place
 *      an account can be created, promoted or reactivated — becomes unreachable by every remaining
 *      account. Nothing in the running app can undo it. Recovery means someone with the service
 *      key running scripts/seed-user.mjs, which is a laptop, a checkout and an .env.local away.
 *
 *   2. THE CALLER LOCKS THEMSELVES OUT. Deactivating your own account signs you out on the very
 *      next request, whether or not another Owner exists. That other Owner CAN put it back, so it
 *      is recoverable — but it is never what someone meant to click, so it is refused too.
 *
 * Self-DEMOTION is deliberately allowed when another active Owner exists: "I am stepping back to
 * manager" is a real thing to want, and the remaining Owner can reverse it. Case 1 already blocks
 * the version of it that strands the park.
 *
 * WHY THIS CANNOT LIVE IN RLS, for anyone tempted to move it there later: it is a count across
 * OTHER rows of the same table, evaluated before the write. A row-level policy sees one row.
 *
 * RACE, ACKNOWLEDGED: two Owners demoting each other in the same instant could both read a count
 * of 2. The window is milliseconds wide on a two-person park, and the failure is recoverable with
 * the break-glass script. Closing it properly means a transactional constraint in the database —
 * worth doing if this ever runs somewhere with a real staff roster, not worth blocking 5c on.
 */
export async function lockoutProblem(opts: {
  target: AdminUser
  callerId: string | null
  nextRole?: Role
  nextActive?: boolean
}): Promise<string | null> {
  const { target, callerId, nextRole, nextActive } = opts

  const deactivating = nextActive === false && target.active

  if (deactivating && callerId && callerId === target.id) {
    return 'You cannot deactivate your own account. Ask another owner to do it.'
  }

  // Only a currently-active Owner counts toward the population being protected.
  if (target.role !== 'owner' || !target.active) return null

  const demoting = nextRole !== undefined && nextRole !== 'owner'
  if (!demoting && !deactivating) return null

  const owners = await countActiveOwners()
  if (owners === null) {
    // Fail closed: refusing a legitimate change is an inconvenience, allowing the one that
    // strands the park is not.
    return 'Could not confirm how many owners are active, so this change was not made. Try again.'
  }

  if (owners <= 1) {
    return demoting
      ? 'This is the only active owner. Promote someone else to owner first, then change this account.'
      : 'This is the only active owner. Deactivating it would lock everyone out of owner-level settings.'
  }

  return null
}
