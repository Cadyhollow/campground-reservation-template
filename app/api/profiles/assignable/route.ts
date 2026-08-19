import { NextRequest, NextResponse } from 'next/server'
import { requireRole } from '@/lib/require-role'
import { adminDb } from '@/lib/admin-users'

// GET /api/profiles/assignable → { people: [{ id, full_name }] }
//
// The staff roster for the To-Do board: who a task can be assigned to, and whose name to show
// against "Done by …".
//
// WHY A ROUTE AND NOT A SUPABASE QUERY FROM THE BROWSER. `profiles` carries RLS with exactly one
// policy — "Users read their own profile", scoped to auth.uid() = id — and the table grants are
// REVOKE ALL / GRANT SELECT. That is deliberate: it stops one member of staff enumerating their
// colleagues' email addresses out of the browser with the publishable key. It also means the
// board cannot ask the database "who works here", and a PostgREST join from tasks to profiles
// comes back with everyone else's name as null rather than erroring — a silent wrong answer,
// which is the worst shape a failure can take. So the roster is served here instead.
//
// STAFF-GATED, NOT OWNER-GATED, and that is the whole reason this route exists rather than
// reusing /api/admin-users. That one is Owner-only and returns email, role, active and
// created_at — the account-management view. A Staff member cannot call it, and should not: they
// have no business reading their colleagues' roles or addresses. But they do need to be able to
// assign a task to Maria.
//
// SO THIS RETURNS TWO COLUMNS AND NOTHING ELSE. id and full_name. No email, no role, no active
// flag, no created_at. The id is a uuid a staff member can already see on any task they were
// assigned, and the name is what the dropdown is for. Widening this select is a real decision
// about what one member of staff may learn about another — it is not a convenience.
//
// requireRole is the FIRST statement, before anything else runs: proxy.ts's matcher is
// ['/admin/:path*'] and never sees /api/*, so an ungated route here is open to anyone who guesses
// the URL. lib/api-auth.test.ts asserts this stays 401 for an unauthenticated caller.
//
// Service-role client because the caller's own session provably cannot read other people's rows —
// that is the point of the policy above. The privilege is used only after requireRole has
// established who is asking, which is the same shape as every other service-role route here.

export async function GET(request: NextRequest) {
  const denied = await requireRole(request, 'staff')
  if (denied) return denied

  // active = true only. A deactivated account cannot sign in, so assigning work to one would put
  // a task somewhere nobody is ever going to look. Tasks already assigned to someone who is later
  // deactivated keep pointing at them — the row is untouched, and the board falls back to showing
  // the raw assignment rather than pretending it is unassigned.
  const { data, error } = await adminDb
    .from('profiles')
    .select('id, full_name')
    .eq('active', true)
    .order('full_name', { ascending: true })

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({ people: data ?? [] })
}
