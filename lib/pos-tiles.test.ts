// The POS tile palette and ordering rules.
//
// The property worth testing here is not "what colour is Candy" — it is that a category's colour
// does not MOVE. The redesign exists so staff can reach for a tile by colour and position without
// reading it, and assigning colours by array index would repaint the whole board every time a
// category was added or renamed. These tests pin that.

import { test } from 'node:test'
import { readFileSync } from 'node:fs'
import assert from 'node:assert/strict'
import { POS_TILE_PALETTE, posTileColor, byNameAsc } from './pos-tiles.ts'

// ── THE PALETTE ───────────────────────────────────────────────────────────────────────────────

test('the palette is twelve distinct six-digit hex colours', () => {
  assert.equal(POS_TILE_PALETTE.length, 12)
  assert.equal(new Set(POS_TILE_PALETTE).size, 12)
  for (const c of POS_TILE_PALETTE) assert.match(c, /^#[0-9a-f]{6}$/)
})

test('every palette colour clears WCAG AA against white text', () => {
  // Recomputed rather than trusted: a colour swapped in later that looks fine on a bright screen
  // can still fail for someone reading it in daylight on a tablet at a service window.
  const channel = (v: number) => {
    const s = v / 255
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4)
  }
  const luminance = (hex: string) => {
    const r = channel(parseInt(hex.slice(1, 3), 16))
    const g = channel(parseInt(hex.slice(3, 5), 16))
    const b = channel(parseInt(hex.slice(5, 7), 16))
    return 0.2126 * r + 0.7152 * g + 0.0722 * b
  }
  for (const c of POS_TILE_PALETTE) {
    const ratio = 1.05 / (luminance(c) + 0.05)     // white is luminance 1
    assert.ok(ratio >= 4.5, `${c} contrast against white is ${ratio.toFixed(2)}, below AA 4.5`)
  }
})

test('the watermark stays faint enough that the contrast analysis holds', () => {
  // WHY THIS READS THE STYLESHEET. The tile's base colour carries the name, and the test above
  // proves every palette colour clears AA for white text on that base. The watermark sits BEHIND
  // the name and lightens whatever it covers, so its opacity decides whether that survives.
  //
  // Measured in a browser at the grid's minimum tile size: a one-line name clears the painted
  // glyph entirely (name top 116px vs glyph bottom 111px). Only a TWO-line name on the smallest
  // tiles overlaps, by about 13px. At normal tile sizes there is a 20px gap and no overlap at all.
  //
  // At 0.12 the overlapped region leaves three palette colours below AA (#1f7a86 4.01,
  // #94631a 4.08, #2f6f6a 4.50) — down from eight at 0.16. Lowering it further cannot close the
  // gap: all twelve only clear 4.5:1 at about 0.058, which is close to invisible. The remaining
  // fix is geometric, not optical.
  //
  // This pins the value the analysis was done at. Raising it widens the failing set across every
  // tile at once, so it has to come back through here.
  const css = readFileSync(new URL('../app/globals.css', import.meta.url), 'utf8')
  const ghost = css.slice(css.indexOf('.pos-cat-ghost'))
  const alpha = Number(/color:\s*rgba\(255,255,255,([0-9.]+)\)/.exec(ghost)?.[1])
  assert.ok(Number.isFinite(alpha), 'could not find the watermark colour in globals.css')
  assert.ok(alpha <= 0.12, `watermark opacity is ${alpha}; above 0.12 more palette colours lose AA under the name`)
})

test('the watermark can never grow into the name band, at any tile size', () => {
  // THE GEOMETRIC GUARANTEE, recomputed from the shipped CSS rather than trusted.
  //
  // The watermark lightens what it covers, so white text sitting ON it loses contrast — three
  // palette colours fall below AA there. Rather than fade the letter until that stops mattering
  // (it would take ~0.058, which is invisible), the letter is sized so the name never reaches it.
  //
  // This reads the real values out of globals.css and replays the geometry across every tile
  // height the grid can produce. If someone changes the name's type, the padding, or the sizing
  // formula, the two drift apart and this fails — which is the only thing standing between a
  // future tweak and a silent contrast regression.
  const css = readFileSync(new URL('../app/globals.css', import.meta.url), 'utf8')
  const block = (sel: string) => {
    const i = css.indexOf(sel + ' {')
    return css.slice(i, css.indexOf('}', i))
  }
  const num = (src: string, prop: string) =>
    Number(new RegExp(prop + ':\\s*(-?[0-9.]+)').exec(src)?.[1])

  const tile = block('.pos-cat-tile')
  const name = block('.pos-cat-name')
  const ghost = block('.pos-cat-ghost')

  const padding = num(tile, 'padding')                 // 14px, top and bottom
  const nameSize = num(name, 'font-size')              // 15px
  const nameLine = num(name, 'line-height')            // 1.2
  const ghostTop = num(ghost, 'top')                   // -14px
  const formula = /min\((\d+)px,\s*calc\(([0-9.]+)cqh\s*-\s*([0-9.]+)px\)\)/.exec(ghost)
  assert.ok(formula, 'could not read the watermark sizing formula from globals.css')
  const [, capPx, cqhPct, offsetPx] = formula!.map(Number) as unknown as number[]

  // A capital's line box measures about 1.06x its font size in the shipped face — taken from a
  // browser measurement of the rendered glyph, and deliberately generous.
  const GLYPH_BOX = 1.06
  // Two lines is the worst case; the name clamps there.
  const nameBand = 2 * nameSize * nameLine

  for (let H = 140; H <= 220; H++) {
    const contentH = H - 2 * padding                   // cqh is the CONTENT box, not the border box
    const fontSize = Math.min(capPx, (cqhPct / 100) * contentH - offsetPx)
    const glyphBottom = ghostTop + GLYPH_BOX * fontSize
    const nameTop = H - padding - nameBand
    assert.ok(
      glyphBottom <= nameTop,
      `at a ${H}px tile the watermark reaches ${glyphBottom.toFixed(1)}px but the name starts at ${nameTop.toFixed(1)}px`,
    )
  }
})

test('the watermark keeps its full size on the tiles that do not need shrinking', () => {
  // The other half of the bargain: the fix must not quietly shrink tiles that were fine. Measured
  // panel widths produce 141-204px tiles, and only the ~151px case ever overlapped.
  const css = readFileSync(new URL('../app/globals.css', import.meta.url), 'utf8')
  const i = css.indexOf('.pos-cat-ghost {')
  const ghost = css.slice(i, css.indexOf('}', i))
  const f = /min\((\d+)px,\s*calc\(([0-9.]+)cqh\s*-\s*([0-9.]+)px\)\)/.exec(ghost)!
  const [, capPx, cqhPct, offsetPx] = f.map(Number) as unknown as number[]
  const at = (H: number) => Math.min(capPx, (cqhPct / 100) * (H - 28) - offsetPx)

  // Sizes seen across the three real POS panels. Compared within half a pixel rather than for
  // exact equality: at 162px the formula lands on 117.96px, which is the cap to four decimal
  // places and identical once rasterised. Demanding exactness there would be asserting about
  // floating point, not about what anyone can see.
  for (const H of [162, 163, 165, 171, 188, 204]) {
    assert.ok(
      Math.abs(at(H) - capPx) < 0.5,
      `a ${H}px tile should keep the full ${capPx}px letter, got ${at(H).toFixed(2)}`,
    )
  }
  // And the one that genuinely overlapped does shrink.
  assert.ok(at(151) < capPx, 'the 151px tile should scale its letter down')
})

// ── COLOUR IS PINNED TO THE CATEGORY, NOT ITS POSITION ────────────────────────────────────────

test('the same name always gets the same colour', () => {
  assert.equal(posTileColor('Candy'), posTileColor('Candy'))
})

test('THE POINT: adding, removing or reordering categories moves nobody else', () => {
  const before = ['Candy', 'Drinks', 'Firewood', 'Ice']
  const colours = Object.fromEntries(before.map(c => [c, posTileColor(c)]))

  // A category added at the front, one removed from the middle, the rest shuffled.
  const after = ['Apparel', 'Ice', 'Candy', 'Firewood']
  for (const c of after) {
    if (colours[c]) {
      assert.equal(posTileColor(c), colours[c], `${c} changed colour when the list changed`)
    }
  }
  // And the newcomer does not have to displace anyone to get one.
  assert.ok(POS_TILE_PALETTE.includes(posTileColor('Apparel') as never))
})

test('an index-based scheme would have failed the test above — this one does not', () => {
  // Demonstrates the bug being avoided, so the reason for the hash is visible in the suite.
  const byIndex = (list: string[], name: string) =>
    POS_TILE_PALETTE[list.indexOf(name) % POS_TILE_PALETTE.length]
  const before = ['Candy', 'Drinks', 'Firewood']
  const after = ['Apparel', 'Candy', 'Drinks', 'Firewood']
  assert.notEqual(byIndex(before, 'Candy'), byIndex(after, 'Candy'))   // index scheme: moves
  assert.equal(posTileColor('Candy'), posTileColor('Candy'))            // ours: does not
})

test('casing and stray whitespace do not split one category into two colours', () => {
  const base = posTileColor('Firewood')
  for (const v of ['firewood', 'FIREWOOD', '  Firewood  ', 'FireWood']) {
    assert.equal(posTileColor(v), base, `"${v}" got a different colour`)
  }
})

test('a colour is always returned, even for junk input', () => {
  for (const v of ['', '   ', '🔥', 'x'.repeat(500)]) {
    assert.ok(POS_TILE_PALETTE.includes(posTileColor(v) as never), `no colour for ${JSON.stringify(v)}`)
  }
})

test('the hash spreads a realistic category list across the palette', () => {
  // Not a uniformity proof — just a guard against a hash that collapses everything onto one or two
  // colours, which would make the board unreadable.
  const cats = ['Candy', 'Drinks', 'Firewood', 'Ice', 'Propane', 'Bait', 'Apparel',
                'Camping Supplies', 'Food & Drink', 'Rentals', 'Fees', 'General']
  const used = new Set(cats.map(posTileColor))
  assert.ok(used.size >= 6, `only ${used.size} distinct colours across 12 categories`)
})

test('more than twelve categories simply reuse colours, without error', () => {
  const many = Array.from({ length: 40 }, (_, i) => `Category ${i}`)
  const colours = many.map(posTileColor)
  assert.equal(colours.length, 40)
  for (const c of colours) assert.ok(POS_TILE_PALETTE.includes(c as never))
})

// ── ORDERING ──────────────────────────────────────────────────────────────────────────────────

test('sorting is A to Z and ignores case', () => {
  const sorted = ['ice', 'Candy', 'drinks', 'Bait'].sort(byNameAsc)
  assert.deepEqual(sorted, ['Bait', 'Candy', 'drinks', 'ice'])
})

test('numbers sort numerically, not as text', () => {
  // "3 candy bars" must land with the numbers rather than between "2" and "20".
  const sorted = ['20 pack', '3 candy bars', '2 for $5', '100 count'].sort(byNameAsc)
  assert.deepEqual(sorted, ['2 for $5', '3 candy bars', '20 pack', '100 count'])
})

test('sorting is stable enough to be predictable for equal names', () => {
  assert.equal(byNameAsc('Candy', 'candy'), 0)
})

test('a missing or null name is treated as empty and sorts first, not thrown on', () => {
  // The real case: a product or category row with no name. Array.sort parks a literal `undefined`
  // ELEMENT last without ever consulting the comparator, so the behaviour worth pinning is the
  // comparator's own — what it does when handed a missing value.
  assert.equal(byNameAsc(undefined as unknown as string, 'Ice') < 0, true)
  assert.equal(byNameAsc(null as unknown as string, 'Ice') < 0, true)
  assert.equal(byNameAsc(undefined as unknown as string, null as unknown as string), 0)

  const rows = [{ name: 'Ice' }, { name: undefined }, { name: 'Bait' }]
  const sorted = rows.slice().sort((a, b) => byNameAsc(a.name as string, b.name as string))
  assert.deepEqual(sorted.map(r => r.name), [undefined, 'Bait', 'Ice'])
})

test('sorting does not mutate the caller array when used with slice()', () => {
  const original = ['Ice', 'Bait']
  const copy = original.slice().sort(byNameAsc)
  assert.deepEqual(original, ['Ice', 'Bait'])
  assert.deepEqual(copy, ['Bait', 'Ice'])
})
