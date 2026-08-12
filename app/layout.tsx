import type { Metadata } from "next";
import type { CSSProperties } from "react";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { getSettings } from "@/lib/settings-server";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

// Render every request instead of prerendering at build. `theme` below is read from the
// database and written into the HTML, so a prerendered layout bakes in whatever the value
// was at build time and never picks up a change — the admin toggle saves correctly but the
// booking page keeps serving the old palette until the next deploy.
//
// An uncached read is NOT enough to fix this: supabase-js uses fetch, fetch is already
// uncached by default in this version, and the route still prerendered. Only Request-time
// APIs or this segment config opt a route out of prerendering.
//
// Cost is one settings query per render (deduped by the cache() below, so one, not two) and
// no CDN caching of the HTML. Fine for a booking site, and the theme has to be correct on
// first paint. NOTE: this option is removed if Cache Components is ever enabled in
// next.config.ts — it would need migrating then.
export const dynamic = 'force-dynamic'

// getSettings moved to lib/settings-server.ts so the booking page can share the same
// cache()'d read: metadata, this layout and the page now issue ONE query per request
// between them rather than one each. Its select('*') and the reasoning behind it are
// documented there.

// Anything that isn't exactly 'dark' — missing column, null, '', a typo — resolves to
// light. Fail toward the default rather than toward a half-applied dark theme.
function resolveTheme(raw: unknown): 'light' | 'dark' {
  return raw === 'dark' ? 'dark' : 'light';
}

export async function generateMetadata(): Promise<Metadata> {
  const settings = await getSettings();
  const name = settings?.park_name || "Campground";
  return {
    title: `${name} - Reservations`,
    description: `Book your stay at ${name}.`,
  };
}

// The park's accent colour, as an inline custom property on <html> — or nothing at all.
//
// Security PR 7-1. This used to be AccentColorProvider: a client component that, on EVERY route
// including the whole admin section, opened a publishable-key Supabase client and read
// settings.accent_color, then called document.documentElement.style.setProperty(). It was the
// last browser read left outside the public pages, and under the locked-down schema it returns
// nothing at all — so every park would render in the default accent forever.
//
// It was also redundant. The layout already reads the settings row server-side for the theme, so
// the colour was in hand before the HTML was written — the browser was spending a round trip to
// fetch something the server had already fetched. Setting it here is the same mechanism the
// effect used (an inline style on the root element, which outranks the :root rule in
// globals.css) applied a beat earlier, so the accent is correct in the first paint. That also
// removes the flash: every accent-coloured button and heading rendered in the default and then
// changed colour.
//
// A missing, null or blank value returns undefined rather than an empty custom property, so the
// CSS default in globals.css stands — exactly what the old `if (data?.accent_color)` guard did.
function accentStyle(raw: unknown): CSSProperties | undefined {
  const accent = typeof raw === 'string' ? raw.trim() : '';
  if (!accent) return undefined;
  return { '--accent-color': accent } as CSSProperties;
}

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  // Resolved server-side and rendered into the HTML, so the correct theme is present in
  // the first paint — no flash of the wrong palette the way a client-side effect would give.
  // As of PR 7-1 the accent colour rides along on the same read, for the same reason.
  const settings = await getSettings();
  const theme = resolveTheme(settings?.theme);

  return (
    <html
      lang="en"
      data-theme={theme}
      style={accentStyle(settings?.accent_color)}
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">
        {children}
      </body>
    </html>
  );
}