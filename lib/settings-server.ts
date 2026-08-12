// The park's settings, read on the server, once per request.
//
// Lifted out of app/layout.tsx so the booking page can share the SAME read. React's cache()
// dedupes by arguments for the lifetime of one request, so the layout (theme, page title) and
// the page (hero image, park name, logo) between them issue one query, not three — the
// property that made the theme cheap enough to resolve server-side in the first place.
//
// Importing this from a client component would drag a Supabase client into the browser bundle;
// it is only ever called from server components.
//
// Security PR 7-1 switched the key from the publishable one to service-role. The query never ran
// in a browser, but it ran with the browser's credential — so it was a read that depended on
// `anon` being able to see `settings`, and the locked-down schema revokes exactly that. Nothing
// about the result changes; without the swap this returns null on every request and the whole
// site renders with default branding.

import { cache } from 'react'
import { createClient } from '@supabase/supabase-js'

// select('*') on purpose, not a named column list: naming a column that doesn't exist yet
// makes PostgREST error, and neither `theme` nor `hero_image_url` is in every tenant's
// settings table. With '*' a missing column is simply absent from the row, so the readers
// fall back to their defaults instead of throwing.
export const getSettings = cache(async () => {
  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  )
  const { data } = await supabase.from('settings').select('*').limit(1).single()
  return data
})
