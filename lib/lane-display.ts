// HOW A LANE LOOKS — the one place the app decides what a money lane is CALLED and what COLOUR
// it is drawn in. Reports R1 introduced it; the R2 dashboard is meant to import the same two
// maps, so the language a park learns on one screen is the language on every other.
//
// ⚠ DISPLAY ONLY. Nothing here classifies, sums, or decides which lane a charge belongs to —
// that is lib/ledger-lanes.ts, and this module deliberately adds nothing to it. It imports the
// `Lane` type so a lane added there is a compile error here until it is given a label and a
// colour, rather than silently rendering blank.
//
// Relative import with the extension: the repo's convention for one lib module importing
// another, and the only form that resolves under `node --test` (see the note in ledger-lanes.ts).
import type { Lane } from './ledger-lanes.ts'

/**
 * The label beside the colour. Matches the camper-facing wording already in use on the seasonal
 * camper page (app/admin/seasonals/SeasonalSections.tsx) so an owner reading a report and a
 * camper reading their account are shown the same three words.
 */
export const LANE_LABEL: Record<Lane, string> = {
  electric: 'Electric',
  store: 'Store',
  seasonal: 'Seasonal fee',
  other: 'Other charges',
}

/**
 * COLOURBLIND-SAFE, and never the only signal.
 *
 * The three real lanes are taken from the Okabe–Ito qualitative palette, which is designed to
 * stay distinguishable under deuteranopia, protanopia and tritanopia — the reason it is these
 * hues and not the house chart palette, whose blues sit too close together to separate a lane
 * from its neighbour at swatch size.
 *
 * `other` is deliberately a neutral grey rather than a fourth hue: it is the classifier's
 * catch-all, not a bill a park sends, and giving it a colour of its own would read as a peer of
 * the three lanes an owner actually manages.
 *
 * ⚠ EVERY PLACE THESE ARE USED MUST PRINT LANE_LABEL BESIDE THE SWATCH. Colour is the shortcut
 * for someone who already knows the lanes; the word is what makes it legible to everyone else.
 */
export const LANE_COLOR: Record<Lane, string> = {
  electric: '#E69F00', // Okabe–Ito orange
  store:    '#009E73', // Okabe–Ito bluish green
  seasonal: '#0072B2', // Okabe–Ito blue
  other:    '#6B7280', // neutral grey — the catch-all, not a peer lane
}

/**
 * The lanes a SEASONAL CAMPER is actually billed for, in the order an owner reads them.
 *
 * `other` is absent for the same reason it is absent from the camper page's LANE_ROWS: it is
 * where an uncategorised charge lands honestly, not a heading to report against. It still counts
 * in every total — see the reconciliation line on the Seasonal report, which is what proves it.
 */
export const SEASONAL_CAMPER_LANES: readonly Lane[] = ['seasonal', 'electric', 'store'] as const
