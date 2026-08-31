import type { ReactNode } from 'react'
import { Newsreader, Manrope, JetBrains_Mono } from 'next/font/google'

// THE SEASONAL THEME LIVES HERE — one wrapper, one class.
//
// The palette itself is in app/globals.css under `.seasonal-theme`; this file only
// decides WHERE it applies. Because it is a layout, it covers app/admin/seasonals
// and every route beneath it and touches nothing else in the admin — the dashboard,
// Settings, reservations and reports keep the default grey.
//
// To extend the theme to the whole admin later, move `seasonal-theme` onto
// app/admin/layout.tsx. That is the entire change: the pages reference tokens, not
// colours, so nothing under them needs editing.
//
// The fonts load here rather than in the root layout so the rest of the app — every
// camper-facing page included — does not pay for three families it never renders.

const newsreader = Newsreader({
  subsets: ['latin'],
  variable: '--font-newsreader',
  display: 'swap',
  // Headings only; the italic is used for the quiet subtitles.
  style: ['normal', 'italic'],
  weight: ['400', '500', '600', '700'],
})

const manrope = Manrope({
  subsets: ['latin'],
  variable: '--font-manrope',
  display: 'swap',
  weight: ['400', '500', '600', '700', '800'],
})

const jetbrainsMono = JetBrains_Mono({
  subsets: ['latin'],
  variable: '--font-jetbrains-mono',
  display: 'swap',
  weight: ['400', '500', '600', '700'],
})

// `data-scheme` is deliberately absent: light ships active. Adding data-scheme="dark"
// (always dark) or data-scheme="system" (follow the OS) turns the defined dark set on.
export default function SeasonalLayout({ children }: { children: ReactNode }) {
  return (
    <div
      className={`seasonal-theme ${newsreader.variable} ${manrope.variable} ${jetbrainsMono.variable} min-h-full`}
    >
      {children}
    </div>
  )
}
