'use client'
// Controlled home-address field group. No save of its own — the parent owns
// persistence. Used by both the camper page and the new intake form.
export type Address = {
  home_street?: string | null
  home_city?: string | null
  home_state?: string | null
  home_zip?: string | null
}

export default function AddressEditor({ value, onChange, required }: {
  value: Address
  onChange: (v: Address) => void
  required?: boolean
}) {
  const set = (k: keyof Address, v: string) => onChange({ ...value, [k]: v })
  const star = required ? <span className="text-red-500">*</span> : null
  const inp = 'w-full border border-gray-200 rounded-lg px-3 py-2 text-sm'
  const lbl = 'block text-xs text-gray-500 mb-1'
  return (
    <div className="grid grid-cols-2 gap-3">
      <div className="col-span-2">
        <label className={lbl}>Street {star}</label>
        <input value={value.home_street ?? ''} onChange={e => set('home_street', e.target.value)} className={inp} />
      </div>
      <div>
        <label className={lbl}>City {star}</label>
        <input value={value.home_city ?? ''} onChange={e => set('home_city', e.target.value)} className={inp} />
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className={lbl}>State {star}</label>
          <input value={value.home_state ?? ''} onChange={e => set('home_state', e.target.value)} className={inp} />
        </div>
        <div>
          <label className={lbl}>ZIP {star}</label>
          <input value={value.home_zip ?? ''} onChange={e => set('home_zip', e.target.value)} className={inp} />
        </div>
      </div>
    </div>
  )
}
