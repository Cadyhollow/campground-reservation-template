// The booking page, as a server component.
//
// It exists to do one thing before anything reaches the browser: read the park's settings and
// hand them to the interactive half. The hero photo, the logo and the park name all come from
// that row, and until now they arrived in a useEffect AFTER mount — so the camper's first
// impression was a short flat band with "Welcome to Our Campground" on it, which a beat later
// jumped to a 520px photo hero with the real name over it. The image popping in was the least
// of it; the section grew by roughly 400px and the heading flipped from dark to white.
//
// This is the same move the theme already makes in app/layout.tsx: resolve on the server, put
// it in the HTML, no flash of the default. The <Image priority> in the hero was already
// correct and simply could not fire — Next only emits a preload link for markup it renders,
// and that markup did not exist until the client had mounted and fetched. Rendered from the
// server it now preloads in <head>, and the container's min-height reserves the space from the
// first paint, so there is nothing left to shift.

import { getSettings } from '@/lib/settings-server'
import { getHomeData } from '@/lib/home-server'
import HomeClient from './HomeClient'

// The layout already forces dynamic rendering for this tree, so this is belt-and-braces —
// but it is stated here too because the reason is local: prerendering this page would bake
// one park's hero URL into the HTML at build time and serve it until the next deploy.
export const dynamic = 'force-dynamic'

export default async function Page() {
  // Shares the layout's cache()'d read, so the theme, the page title and the hero come from
  // ONE settings query per request rather than one each.
  //
  // Security PR 7-1 adds the second call: the site types and categories HomeClient used to read
  // from the browser with the publishable key. Under the locked-down schema the `anon` role
  // cannot read either table, so a camper's browser query would return nothing at all — these
  // have to be read here, with the service key, or the feature cards and the category accordion
  // silently render empty.
  const [settings, home] = await Promise.all([getSettings(), getHomeData()])
  return <HomeClient initialSettings={settings} initialHome={home} />
}
