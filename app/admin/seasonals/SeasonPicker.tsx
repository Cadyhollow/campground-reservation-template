'use client'
// THE SEASON PICKER — Phase 2c. Built once, used by the seasonals list, the camper page, and the
// clone modal, so those three can never disagree about what seasons exist, how they are ordered,
// or which one a screen opens on.
//
// The ORDER and the DEFAULT deliberately do NOT live here: they are pure functions in
// lib/season.ts, because /api/seasonals/unsigned-count has to resolve "the current season" the
// same way with no screen involved. If the badge and the list used different rules they would
// quietly count different seasons.
import { useCallback, useEffect, useState } from 'react'
import { sortSeasonsForPicker, pickCurrentSeason, todayISO, seasonLabel } from '@/lib/season'
import type { Season } from '@/lib/seasonal-types'

/**
 * Load the park's seasons once, in picker order, with the default selection already worked out.
 *
 * Returns `defaultId` rather than selecting anything itself: each screen owns its own selection
 * state (the list filters by it, the camper page sends by it), and a hook that reached in and set
 * it would fight them.
 */
export function useSeasons() {
  const [seasons, setSeasons] = useState<Season[]>([])
  const [loaded, setLoaded] = useState(false)
  const [err, setErr] = useState('')

  const reload = useCallback(async () => {
    try {
      const res = await fetch('/api/seasons')
      const d = await res.json()
      if (!res.ok) { setErr(d.error || 'Could not load seasons.'); setSeasons([]) }
      else setSeasons(sortSeasonsForPicker((d.seasons || []) as Season[]))
    } catch { setErr('Could not load seasons.') }
    setLoaded(true)
  }, [])
  useEffect(() => { void reload() }, [reload])

  const defaultId = pickCurrentSeason(seasons, todayISO())?.id || ''
  return { seasons, loaded, err, defaultId, reload }
}

/** The dropdown itself. Controlled — the parent owns the selection. */
export default function SeasonPicker({ seasons, value, onChange, className, disabled }: {
  seasons: Season[]
  value: string
  onChange: (seasonId: string) => void
  className?: string
  disabled?: boolean
}) {
  return (
    <select
      value={value}
      disabled={disabled}
      onChange={e => onChange(e.target.value)}
      className={className || 'border border-line rounded-lg px-3 py-2 text-sm'}
    >
      {/* Present only until a default lands, so the control is never blank-with-no-explanation. */}
      {!value && <option value="">Select a season…</option>}
      {seasons.map(s => <option key={s.id} value={s.id}>{seasonLabel(s)}</option>)}
    </select>
  )
}
