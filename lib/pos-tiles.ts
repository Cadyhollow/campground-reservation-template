// The POS category tile palette and the ordering rules, as plain functions.
//
// Split out of app/components/PosCategoryTiles.tsx purely so `node --test` can exercise them:
// that file contains JSX, which the test runner cannot parse. Everything here is pure — no React,
// no DOM, no I/O — which is also what lets it run in the guardrails CI job on every pull request.
//
// THIS IS THE ONE PLACE THE PALETTE IS WRITTEN DOWN. The eventual Cady port and any future colour
// tweak should touch this file and nothing else.

/**
 * Twelve jewel tones, all contrast-checked for white text at WCAG AA.
 *
 * THE SINGLE PLACE THIS PALETTE IS WRITTEN DOWN. With more than twelve categories it repeats, by
 * design: colour is a secondary cue, and the monogram, the full name and the fixed alphabetical
 * position are what actually locate a tile.
 */
export const POS_TILE_PALETTE = [
  '#a63a63', '#2f6b7e', '#5a4a86', '#8a5a2b', '#3f6b47', '#3b5a8a',
  '#556070', '#6d4a7c', '#1f7a86', '#8a3d52', '#2f6f6a', '#94631a',
] as const

/** Normalised so casing and stray whitespace cannot give one category two colours. */
export function posTileColor(key: string): string {
  const normalized = (key ?? '').trim().toLowerCase()
  let h = 0
  for (let i = 0; i < normalized.length; i++) h = (h * 31 + normalized.charCodeAt(i)) >>> 0
  return POS_TILE_PALETTE[h % POS_TILE_PALETTE.length]
}

/**
 * Case-insensitive, number-aware A→Z. Shared by the tiles and by the product lists inside each
 * category so the two orderings cannot drift.
 *
 * `numeric: true` is what keeps "3 candy bars" with the numbers rather than between "2" and "20",
 * and `sensitivity: 'base'` makes case and accents irrelevant to the ordering.
 */
export function byNameAsc(a: string, b: string): number {
  return (a ?? '').localeCompare(b ?? '', undefined, { numeric: true, sensitivity: 'base' })
}
