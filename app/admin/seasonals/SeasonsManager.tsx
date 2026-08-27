'use client'
// THE SEASONS MANAGER — Phase 2a.
//
// Where "2027 Spring" gets defined. A park-level list of named seasons, each with a year and an
// optional pair of dates. Opened from the Seasonals list page; reads and writes through
// /api/seasons (manager + Summit, service-role behind the route).
//
// ⚠ DEFINING A SEASON HERE CHANGES NOTHING ON ANY EXISTING SCREEN YET, AND THAT IS THE POINT OF
// SPLITTING PHASE 2. The list's year dropdown, the camper page and the clone button still work by
// YEAR; Phase 2b is what moves them onto seasons, adds the picker and the date auto-fill, and
// makes a second season in one year actually reachable from the rest of the app. Until then this
// panel is where an owner gets their seasons named and dated, ready for that.
//
// Editing a season is safe even once contracts hang off it: a SENT contract carries its own
// frozen dates, so a rename or a date correction cannot alter a document a camper already signed.
import { useCallback, useEffect, useState } from 'react'
import type { Season } from '@/lib/seasonal-types'

type Draft = { name: string; year: string; opens: string; closes: string }

const blankDraft = (year: number): Draft => ({ name: '', year: String(year), opens: '', closes: '' })
const toDraft = (s: Season): Draft => ({
  name: s.name || '',
  year: String(s.year ?? ''),
  opens: s.opens || '',
  closes: s.closes || '',
})

export default function SeasonsManager({ defaultYear, onClose }: {
  defaultYear: number
  onClose: () => void
}) {
  const [seasons, setSeasons] = useState<Season[]>([])
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)

  // `null` = not adding. Editing is keyed by season id so only one row is open at a time.
  const [adding, setAdding] = useState<Draft | null>(null)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editDraft, setEditDraft] = useState<Draft>(blankDraft(defaultYear))

  const load = useCallback(async () => {
    setLoading(true); setErr('')
    try {
      const res = await fetch('/api/seasons')
      const d = await res.json()
      if (!res.ok) setErr(d.error || 'Could not load seasons.')
      else setSeasons(d.seasons || [])
    } catch { setErr('Could not load seasons.') }
    setLoading(false)
  }, [])
  useEffect(() => { void load() }, [load])

  /** Shared body-builder: dates are sent as null when blank, so clearing one actually clears it. */
  const payload = (d: Draft) => ({
    name: d.name.trim(),
    year: parseInt(d.year, 10),
    opens: d.opens || null,
    closes: d.closes || null,
  })

  async function createSeason() {
    if (!adding) return
    if (!adding.name.trim()) { setErr('Give the season a name.'); return }
    setBusy(true); setErr('')
    try {
      const res = await fetch('/api/seasons', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload(adding)),
      })
      const d = await res.json()
      if (!res.ok) { setErr(d.error || 'Could not create the season.'); setBusy(false); return }
      setAdding(null)
      await load()
    } catch { setErr('Could not create the season.') }
    setBusy(false)
  }

  async function saveEdit(id: string) {
    if (!editDraft.name.trim()) { setErr('Give the season a name.'); return }
    setBusy(true); setErr('')
    try {
      const res = await fetch(`/api/seasons/${id}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload(editDraft)),
      })
      const d = await res.json()
      if (!res.ok) { setErr(d.error || 'Could not save the season.'); setBusy(false); return }
      setEditingId(null)
      await load()
    } catch { setErr('Could not save the season.') }
    setBusy(false)
  }

  const inp = 'border border-gray-200 rounded-lg px-2 py-1.5 text-sm w-full'
  const lbl = 'block text-[11px] text-gray-500 mb-1'
  const fmt = (d?: string | null) => d ? new Date(d + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '—'

  const fields = (d: Draft, set: (v: Draft) => void) => (
    <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
      <div className="col-span-2 md:col-span-1">
        <label className={lbl}>Name</label>
        <input value={d.name} onChange={e => set({ ...d, name: e.target.value })} placeholder="2027 Spring" className={inp} />
      </div>
      <div>
        <label className={lbl}>Year</label>
        <input type="number" value={d.year} onChange={e => set({ ...d, year: e.target.value })} className={inp} />
      </div>
      <div>
        <label className={lbl}>Opens</label>
        <input type="date" value={d.opens} onChange={e => set({ ...d, opens: e.target.value })} className={inp} />
      </div>
      <div>
        <label className={lbl}>Closes</label>
        <input type="date" value={d.closes} onChange={e => set({ ...d, closes: e.target.value })} className={inp} />
      </div>
    </div>
  )

  return (
    <>
      <div className="fixed inset-0 bg-black/50 z-40" onClick={() => !busy && onClose()} />
      <div className="fixed inset-x-4 top-1/2 -translate-y-1/2 md:inset-x-auto md:left-1/2 md:-translate-x-1/2 md:w-[620px] bg-white rounded-2xl shadow-2xl z-50 overflow-hidden">
        <div className="px-6 py-4 border-b border-gray-100 flex items-center justify-between">
          <div>
            <h3 className="text-lg font-bold text-gray-900">Seasons</h3>
            <p className="text-xs text-gray-500 mt-0.5">Name the seasons your park runs — a year can have more than one.</p>
          </div>
          {!adding && (
            <button onClick={() => { setAdding(blankDraft(defaultYear)); setEditingId(null); setErr('') }}
              className="px-3 py-2 text-xs font-bold rounded-lg text-white" style={{ background: '#2E6B8A' }}>
              + New season
            </button>
          )}
        </div>

        <div className="px-6 py-4 max-h-[60vh] overflow-y-auto">
          {err && <div className="bg-red-50 border border-red-200 text-red-700 rounded-lg px-3 py-2 text-sm mb-3">{err}</div>}

          {adding && (
            <div className="border border-gray-200 rounded-xl p-3 mb-4" style={{ background: '#f9fafb' }}>
              {fields(adding, setAdding)}
              <div className="flex gap-2 justify-end mt-3">
                <button onClick={() => { setAdding(null); setErr('') }} disabled={busy}
                  className="px-3 py-1.5 rounded-lg text-xs font-semibold border border-gray-200 text-gray-600 hover:bg-white disabled:opacity-50">Cancel</button>
                <button onClick={createSeason} disabled={busy || !adding.name.trim()}
                  className="px-3 py-1.5 rounded-lg text-xs font-bold text-white disabled:opacity-50" style={{ background: '#15803d' }}>
                  {busy ? 'Saving…' : 'Add season'}
                </button>
              </div>
            </div>
          )}

          {loading ? (
            <p className="text-sm text-gray-500 py-6 text-center">Loading…</p>
          ) : seasons.length === 0 && !adding ? (
            <p className="text-sm text-gray-400 py-6 text-center">No seasons yet. Add one to get started.</p>
          ) : (
            <div className="divide-y divide-gray-100">
              {seasons.map(s => (
                <div key={s.id} className="py-3">
                  {editingId === s.id ? (
                    <>
                      {fields(editDraft, setEditDraft)}
                      <div className="flex gap-2 justify-end mt-3">
                        <button onClick={() => { setEditingId(null); setErr('') }} disabled={busy}
                          className="px-3 py-1.5 rounded-lg text-xs font-semibold border border-gray-200 text-gray-600 hover:bg-gray-50 disabled:opacity-50">Cancel</button>
                        <button onClick={() => saveEdit(s.id)} disabled={busy || !editDraft.name.trim()}
                          className="px-3 py-1.5 rounded-lg text-xs font-bold text-white disabled:opacity-50" style={{ background: '#15803d' }}>
                          {busy ? 'Saving…' : 'Save'}
                        </button>
                      </div>
                    </>
                  ) : (
                    <div className="flex items-center justify-between gap-3">
                      <div>
                        <p className="text-sm font-semibold text-gray-900">{s.name}</p>
                        <p className="text-xs text-gray-500">{s.year} · {fmt(s.opens)} – {fmt(s.closes)}</p>
                      </div>
                      <button onClick={() => { setEditingId(s.id); setEditDraft(toDraft(s)); setAdding(null); setErr('') }}
                        className="text-xs font-semibold" style={{ color: 'var(--accent-color, #2E6B8A)' }}>Edit</button>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}

          <p className="text-xs text-gray-400 mt-4">
            Dates are optional, and a season with no dates is fine. Renaming a season or fixing its dates never changes a
            packet a camper has already been sent — a sent packet keeps the dates it was signed with.
          </p>
        </div>

        <div className="px-6 py-4 border-t border-gray-100 flex justify-end">
          <button onClick={onClose} disabled={busy}
            className="px-4 py-2 rounded-xl text-sm font-bold text-white disabled:opacity-50" style={{ background: '#15803d' }}>Done</button>
        </div>
      </div>
    </>
  )
}
