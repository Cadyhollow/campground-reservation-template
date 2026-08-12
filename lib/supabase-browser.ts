// The admin browser's Supabase client, session-aware.
//
// Security PR 7-1. This replaces lib/supabase.ts, which created a plain client with the
// publishable key and NO session — so every query it made ran as the `anon` Postgres role. Since
// the locked-down schema (PR 7-2) revokes anon entirely, a client built that way now reaches
// exactly nothing. This one stores the logged-in user's session in cookies, which means the same
// publishable key travels with a user JWT and PostgREST executes as `authenticated` instead,
// against the role-gated policy set the schema installs.
//
// WORTH BEING PRECISE ABOUT, because it is easy to describe wrongly: the publishable key stays in
// the browser. It is the API key, and it is not a secret. "Revoking anon" means revoking what the
// anon Postgres ROLE may do — not removing this key from the client.
//
// Cookies rather than localStorage on purpose: the server guards (proxy.ts, requireRole) read the
// session from the request's cookies, and localStorage is invisible to them.
//
// WHAT THIS DOES NOT DO: it does not authorise anything. It carries an identity, and the database
// decides what that identity may read and write. An admin page using this client can only ever
// see what its RLS policies allow — which is why moving the pages onto it and installing those
// policies had to happen together.

import { createBrowserClient } from '@supabase/ssr'

export function createBrowserSupabase() {
  return createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  )
}
