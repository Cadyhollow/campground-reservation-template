// The home page's reference data, read on the server with the service-role key.
//
// Security PR 7-1. HomeClient used to open a Supabase client with the publishable key on mount
// and read two tables for itself: every site's `site_type` (to decide which feature cards to
// show) and the whole `categories` table with select('*'). Both are settled before the camper
// does anything, so neither needed to be a browser query at all — they are page data, and page
// data is read where the page is rendered.
//
// It is also the only way these reads can work now. The camper has no session, so a browser
// client resolves to the `anon` role, and the locked-down schema grants anon nothing. Every
// public read has to happen server-side or not at all.
//
// The third read HomeClient did — `site_categories` for the sites a search returned — cannot
// move here, because it depends on the search. It moves into /api/availability instead, which
// was already the server route that produced those sites.
//
// Importing this from a client component would drag the service-role key toward the browser
// bundle. It is only ever called from the home page's server component.

import { createClient } from '@supabase/supabase-js'

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

export type HomeCategory = { id: number; name: string }

export type HomeData = {
  /** Distinct site types across the park, in first-seen order — drives the feature cards. */
  siteTypes: string[]
  categories: HomeCategory[]
}

export async function getHomeData(): Promise<HomeData> {
  const [{ data: sites }, { data: categories }] = await Promise.all([
    // Unfiltered, exactly as the browser read it: the feature cards describe what the park
    // OFFERS, not what happens to be free today, so an unavailable site still counts.
    supabase.from('sites').select('site_type'),
    // Named columns instead of select('*'). The accordion renders id and name; the browser
    // used to receive whatever else a tenant had hung on the row.
    supabase.from('categories').select('id, name').order('name'),
  ])

  // Same dedupe the browser did, and deliberately nothing more — no sort, no filter — so the
  // cards appear in the same order they always have.
  const siteTypes = [...new Set((sites || []).map((s: { site_type: string }) => s.site_type))]

  return { siteTypes, categories: (categories || []) as HomeCategory[] }
}
