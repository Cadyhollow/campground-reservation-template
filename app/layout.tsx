import type { Metadata } from "next";
import { cache } from "react";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import AccentColorProvider from "./components/AccentColorProvider";
import { createClient } from "@supabase/supabase-js";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

// select('*') on purpose, not select('park_name, theme'): naming a column that doesn't
// exist yet makes PostgREST error, and `theme` isn't in every tenant's settings table.
// With '*' a missing column is simply absent from the row, so the theme read below falls
// back to light instead of throwing.
//
// cache() so metadata and the layout share ONE query per request instead of issuing two.
const getSettings = cache(async () => {
  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  );
  const { data } = await supabase.from('settings').select('*').limit(1).single();
  return data;
});

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

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  // Resolved server-side and rendered into the HTML, so the correct theme is present in
  // the first paint — no flash of the wrong palette the way a client-side effect would
  // give (see AccentColorProvider, which still applies the accent after hydration).
  const settings = await getSettings();
  const theme = resolveTheme(settings?.theme);

  return (
    <html
      lang="en"
      data-theme={theme}
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">
        <AccentColorProvider />
        {children}
      </body>
    </html>
  );
}