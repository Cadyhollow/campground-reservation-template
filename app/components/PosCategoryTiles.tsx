'use client'

// The POS "Select a category" tiles.
//
// Three screens render this picker — /admin/folio/[id], /admin/folio/guest/[id] and
// /admin/walkin-booking — and before this they each carried their own copy of the same teal
// button block. One module means a future tweak, and the Cady port, touch a single file.
//
// PURELY PRESENTATIONAL. It renders the category names it is handed and calls back with the one
// that was tapped. It knows nothing about products, prices or how a category is stored.
//
// THE PALETTE AND THE ORDERING RULES LIVE IN lib/pos-tiles.ts, not here — this file has JSX in
// it, which `node --test` cannot parse, and those rules are exactly the part worth testing. That
// module is the single place to change a colour.
//
// ── WHY THE CSS IS IN globals.css AND NOT A <style> TAG HERE ──────────────────────────────────
//
// :hover and :focus-visible cannot be expressed as inline styles, and a keyboard user needs a real
// focus ring, so these rules have to live in a stylesheet. They sit in app/globals.css under the
// .pos-cat-* names rather than in a <style> block inside this component: React 19 treats <style>
// as a hoistable resource and dedupes it, which is a subtlety worth not depending on for something
// three screens render. A stylesheet is the conventional home for it and raises no such question.
//
// ── WHY COLOUR IS HASHED FROM THE NAME, NOT TAKEN FROM THE POSITION ───────────────────────────
//
// The point of the redesign is muscle memory: staff should reach for "the purple one, second row"
// without reading. Assigning colours by array index would repaint every tile the moment a category
// is added, renamed or reordered — the one thing that would destroy what the colours are for. So
// position is alphabetical and colour is pinned to the category's identity; the two are
// independent, and adding a category leaves every existing tile exactly as it was.
//
// THE KEY IS THE NAME, and on this platform that is not a compromise. `product_categories` is read
// as `.select('name')`, the list is a plain string[], and `products.category` holds the NAME, not
// a foreign key — so the name is the actual identity of a category here. Renaming one is therefore
// a new category as far as the colour is concerned, which matches how the rest of the POS already
// treats it (its products would no longer match either).

import { POS_TILE_PALETTE, posTileColor, byNameAsc } from '@/lib/pos-tiles'

// Re-exported so a caller has one import to reach for, and so the Cady port can pull the tiles
// and their palette from the same place.
export { POS_TILE_PALETTE, posTileColor, byNameAsc }

/** The first character, uppercased. Decorative — the tile is labelled by its full name. */
function monogram(name: string): string {
  return (name ?? '').trim().charAt(0).toUpperCase() || '?'
}

export function PosCategoryTiles({
  categories,
  onSelect,
}: {
  categories: string[]
  onSelect: (category: string) => void
}) {
  // Sorted here rather than at every call site, so no screen can forget.
  const sorted = [...categories].sort(byNameAsc)

  return (
    <>
      {sorted.map(cat => (
        <button
          key={cat}
          type="button"
          className="pos-cat-tile"
          // The full name, because the monogram below is hidden from assistive tech — a screen
          // reader announcing "C" would be useless.
          aria-label={cat}
          title={cat}
          onClick={() => onSelect(cat)}
          style={{ background: posTileColor(cat) }}
        >
          <span className="pos-cat-mono" aria-hidden="true">{monogram(cat)}</span>
          <span className="pos-cat-name">{cat}</span>
        </button>
      ))}
    </>
  )
}

/**
 * The grid the tiles sit in. `auto-fill` with a minimum rather than a fixed column count, so the
 * same markup gives roughly four across in the wide folio panel and degrades to three and then two
 * in the narrow guest-account and walk-in panels without a media query.
 */
export const POS_TILE_GRID: React.CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fill, minmax(140px, 1fr))',
  gap: 12,
  alignContent: 'start',
}
