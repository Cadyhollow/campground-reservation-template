'use client'
// Controlled party (occupants) editor. No save of its own — the parent owns
// persistence (occupants live on seasonal_contracts). Shared by the camper page's
// send modal and the new intake form.
export type Occupant = { name: string; kind: 'adult' | 'child' }

export default function PartyEditor({ value, onChange }: {
  value: Occupant[]
  onChange: (v: Occupant[]) => void
}) {
  const setAt = (i: number, o: Occupant) => onChange(value.map((x, j) => (j === i ? o : x)))
  return (
    <div>
      <div className="flex items-center justify-between mb-1">
        <p className="text-xs font-bold text-gray-400 uppercase tracking-wide">Party</p>
        <button type="button" onClick={() => onChange([...value, { name: '', kind: 'adult' }])}
          className="text-xs font-semibold" style={{ color: '#2E6B8A' }}>+ Add person</button>
      </div>
      {value.length === 0 && <p className="text-xs text-gray-400">No one added yet.</p>}
      {value.map((o, i) => (
        <div key={i} className="flex items-center gap-2 mb-2">
          <input value={o.name} onChange={e => setAt(i, { ...o, name: e.target.value })}
            placeholder="Full name" className="flex-1 border border-gray-200 rounded-lg px-2 py-1.5 text-sm" />
          <select value={o.kind} onChange={e => setAt(i, { ...o, kind: e.target.value as Occupant['kind'] })}
            className="border border-gray-200 rounded-lg px-2 py-1.5 text-sm">
            <option value="adult">Adult</option><option value="child">Child</option>
          </select>
          <button type="button" onClick={() => onChange(value.filter((_, j) => j !== i))}
            className="text-gray-400 hover:text-red-600 text-lg">×</button>
        </div>
      ))}
    </div>
  )
}
