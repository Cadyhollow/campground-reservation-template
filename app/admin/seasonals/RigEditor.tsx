'use client'
// Controlled rig field group (the six camper_* fields). No save of its own — the
// parent owns persistence. Shared by the camper page and the new intake form.
export type Rig = {
  camper_type?: string | null
  camper_length?: string | number | null
  camper_amperage?: string | null
  camper_make?: string | null
  camper_model?: string | null
  camper_year?: string | number | null
}

const FIELDS: [keyof Rig, string, string][] = [
  ['camper_type', 'Type', 'text'],
  ['camper_length', 'Length (ft)', 'number'],
  ['camper_amperage', 'Amperage', 'text'],
  ['camper_make', 'Make', 'text'],
  ['camper_model', 'Model', 'text'],
  ['camper_year', 'Year', 'number'],
]

export default function RigEditor({ value, onChange }: {
  value: Rig
  onChange: (v: Rig) => void
}) {
  return (
    <div className="grid grid-cols-2 gap-3">
      {FIELDS.map(([k, label, type]) => (
        <div key={k}>
          <label className="block text-xs text-muted mb-1">{label}</label>
          <input
            type={type}
            // The six fields are string | number | null (a number input holds a string while it is
            // being typed), so coerce for the input rather than widen the type.
            value={value[k] == null ? '' : String(value[k])}
            onChange={e => onChange({ ...value, [k]: e.target.value })}
            className="w-full border border-line rounded-lg px-3 py-2 text-sm"
          />
        </div>
      ))}
    </div>
  )
}
