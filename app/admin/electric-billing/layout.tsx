import type { ReactNode } from 'react'
import { Newsreader, Manrope, JetBrains_Mono } from 'next/font/google'

// THE SEASONAL THEME, EXTENDED TO ELECTRIC BILLING.
//
// The palette itself lives in app/globals.css under `.seasonal-theme`; this file only decides
// WHERE it applies. It is a copy of app/admin/seasonals/layout.tsx for one reason: electric
// billing is not under /admin/seasonals, so it was outside that layout and got the grey admin
// default. Seasonal campers are the only people this screen bills, so it belongs to the same
// visual family as the rest of their paperwork.
//
// ⚠ THE FONTS MUST LOAD HERE TOO. `.seasonal-theme` styles itself with var(--font-manrope) and
// friends, which are defined by next/font on the wrapper below. Applying the class without them
// would silently fall back to the system stack, and the mono figures — readings, kWh, amounts —
// would stop lining up, which is most of the point of the redesign.
//
// They are declared per-layout rather than in the root layout so camper-facing pages do not pay
// for three families they never render.

const newsreader = Newsreader({
  subsets: ['latin'],
  variable: '--font-newsreader',
  display: 'swap',
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

// `data-scheme` is deliberately absent: light ships active, matching the seasonal area.
export default function ElectricBillingLayout({ children }: { children: ReactNode }) {
  return (
    <div
      className={`seasonal-theme ${newsreader.variable} ${manrope.variable} ${jetbrainsMono.variable} min-h-full`}
    >
      {children}
    </div>
  )
}
