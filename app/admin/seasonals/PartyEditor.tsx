'use client'
// Controlled party (occupants) editor. No save of its own — the parent owns persistence
// (occupants live on seasonal_contracts). Shared by three screens: the camper page's standing
// roster, the "Full form" intake, and the Review-before-sending screen.
//
// ── WHY THE ROW CARRIES EXPLICIT WIDTH CLASSES, AND WHY THEY MUST NOT BE "TIDIED AWAY" ───────
//
// app/globals.css carries a global iOS Safari fix:
//
//     input, select, textarea { …; width: 100%; … }
//
// In a FLEX ROW that rule is a trap, and it is what made this editor unusable. A flex item's
// base size comes from its flex-basis, and `flex-basis: auto` resolves to the item's `width`:
//
//   · the <select> is `flex: 0 1 auto`, so its basis resolved to width:100% — it claimed the
//     ENTIRE row as its base size;
//   · the <input> is `flex-1` (`flex: 1 1 0%`), so its basis is 0 and it can only take FREE
//     space — of which the select had left none.
//
// Result: the Adult/Child dropdown filled the row and the name field collapsed to an untypable
// sliver. The component looked correct in isolation, which is exactly why earlier passes at this
// file never fixed it — the cause was in a stylesheet, not here.
//
// The fix is per-element and local, NOT a renarrowing of that global rule: it is load-bearing for
// text inputs across the whole app, globals.css says so itself where it documents the same trap
// biting checkboxes, and rewriting it belongs in its own pass rather than inside a UI bug fix.
//
//   w-auto on the select   → a class selector (0,1,0) beats the element selector (0,0,1), so the
//                            select sizes to its content instead of to the row.
//   shrink-0               → and never gets squeezed below it.
//   min-w-[12rem] on input → a FLOOR, not a preference. Combined with flex-wrap, a row too
//                            narrow for all three drops the kind/remove controls to the next
//                            line rather than shaving the name field — so on a counter tablet
//                            the name is never squeezed below a typable width.
//
// If any of these are removed the editor silently returns to being untypable, so they are load-
// bearing rather than decorative.
export type Occupant = { name: string; kind: 'adult' | 'child' }

const field = 'border border-gray-200 rounded-lg px-3 py-2 text-sm'

export default function PartyEditor({ value, onChange }: {
  value: Occupant[]
  onChange: (v: Occupant[]) => void
}) {
  const setAt = (i: number, o: Occupant) => onChange(value.map((x, j) => (j === i ? o : x)))
  const add = () => onChange([...value, { name: '', kind: 'adult' }])

  return (
    <div>
      <div className="flex items-center justify-between mb-1">
        <p className="text-xs font-bold text-gray-400 uppercase tracking-wide">Party</p>
        <button type="button" onClick={add}
          className="text-xs font-semibold" style={{ color: '#2E6B8A' }}>+ Add person</button>
      </div>

      {value.length === 0 && <p className="text-xs text-gray-400 mb-2">No one added yet.</p>}

      {value.map((o, i) => (
        // `flex-wrap` so that on a narrow counter tablet the name keeps a usable width and the
        // kind/remove controls drop beneath it, rather than the three of them competing for a
        // row too small for all of them.
        <div key={i} className="flex flex-wrap items-center gap-2 mb-2">
          <input
            value={o.name}
            onChange={e => setAt(i, { ...o, name: e.target.value })}
            placeholder="Full name"
            aria-label={`Party member ${i + 1} name`}
            className={`${field} flex-1 min-w-[12rem]`}
          />
          <select
            value={o.kind}
            onChange={e => setAt(i, { ...o, kind: e.target.value as Occupant['kind'] })}
            aria-label={`Party member ${i + 1} is an adult or a child`}
            className={`${field} w-auto shrink-0`}
          >
            <option value="adult">Adult</option>
            <option value="child">Child</option>
          </select>
          <button
            type="button"
            onClick={() => onChange(value.filter((_, j) => j !== i))}
            aria-label={`Remove party member ${i + 1}`}
            className="shrink-0 text-gray-400 hover:text-red-600 text-xl leading-none px-2 py-1"
          >
            ×
          </button>
        </div>
      ))}

      {/* A second way to add once the list is going — at the counter the cursor is down here,
          not back up at the heading. */}
      {value.length > 0 && (
        <button type="button" onClick={add}
          className="text-xs font-semibold" style={{ color: '#2E6B8A' }}>+ Add another person</button>
      )}
    </div>
  )
}
