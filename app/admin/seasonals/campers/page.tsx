'use client'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import toast, { Toaster } from 'react-hot-toast'
import { planAtLeast } from '@/lib/plan'
import { createBrowserSupabase } from '@/lib/supabase-browser'
import SeasonPicker, { useSeasons } from '../SeasonPicker'
import {
  enrollmentStatus, matchesCamperSearch, ENROLLMENT_LABEL, ENROLLMENT_TONE,
  type EnrollmentStatus,
} from '@/lib/seasonal-directory'

const supabase = createBrowserSupabase()

// THE CAMPERS DIRECTORY — the people view.
//
// Distinct from /admin/seasonals, which is the season's PAPERWORK. This page lists every seasonal
// camper the park has ever had, in or out of the selected season, because the campers who are NOT
// in it are the ones somebody needs to do something about. See the long note on
// GET /api/seasonals/campers for why the two lists deliberately disagree about who is on them.

type Row = {
  guest_id: string
  name: string
  site_number: string
  active: boolean
  contract: { id: string; status: string | null; sent_at: string | null; signed_at: string | null } | null
  season_years: number[]
  member_since: number | null
  balance_cents: number
}

const fmtMoney = (c: number) => (c < 0 ? '−$' : '$') + (Math.abs(c) / 100).toFixed(2)

const TONE_CLASS: Record<'good' | 'watch' | 'draft' | 'muted', string> = {
  good: 'bg-good-bg text-good',
  watch: 'bg-watch-bg text-watch',
  draft: 'bg-draft-bg text-draft',
  // The one that matters: "not in this season" wears the DANGER tone, not a quiet grey, because
  // a grey pill reads as "nothing to do" and that is precisely how these campers went missing.
  muted: 'bg-danger-bg text-danger',
}

function Pill({ status }: { status: EnrollmentStatus }) {
  return (
    <span className={`inline-block rounded-full px-2.5 py-0.5 text-xs font-semibold ${TONE_CLASS[ENROLLMENT_TONE[status]]}`}>
      {ENROLLMENT_LABEL[status]}
    </span>
  )
}

type Filter = 'all' | 'needs_adding' | 'inactive'

export default function CampersDirectoryPage() {
  const router = useRouter()
  const { seasons, loaded: seasonsLoaded, defaultId } = useSeasons()
  const [seasonId, setSeasonId] = useState('')
  const [rows, setRows] = useState<Row[]>([])
  const [year, setYear] = useState<number | null>(null)
  const [seasonName, setSeasonName] = useState('')
  const [hasActiveColumn, setHasActiveColumn] = useState(true)
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState('')
  const [search, setSearch] = useState('')
  const [filter, setFilter] = useState<Filter>('all')
  const [addingId, setAddingId] = useState('')

  // Plan gate, decided on the freshly-loaded plan rather than the state default.
  useEffect(() => {
    supabase.from('settings').select('plan').single().then(({ data }) => {
      if (!planAtLeast(data?.plan, 'summit')) router.replace('/admin')
    })
  }, [router])

  useEffect(() => { if (!seasonId && defaultId) setSeasonId(defaultId) }, [defaultId, seasonId])

  const load = useCallback(async (sid: string) => {
    // ⚠ NEVER LOAD WITHOUT A SEASON. Before this guard the first render fired a request with no
    // season_id — which the route answers for currentSeasonYear() — and it raced the real
    // request the picker's default triggered a moment later. Whichever landed second won, so the
    // picker could read "2028 Season" beside a table of 2027 enrolments, and every camper would
    // appear to need adding. The roster page has always had this same early return.
    if (!sid) { setRows([]); setLoading(false); return }
    setLoading(true); setErr('')
    try {
      const res = await fetch(`/api/seasonals/campers?season_id=${encodeURIComponent(sid)}`)
      const d = await res.json()
      if (!res.ok) { setErr(d.error || 'Could not load campers.'); setRows([]) }
      else {
        setRows(d.rows || []); setYear(d.year ?? null)
        setSeasonName(d.season_name || ''); setHasActiveColumn(d.has_active_column !== false)
      }
    } catch { setErr('Could not load campers.') }
    setLoading(false)
  }, [])
  useEffect(() => { if (seasonsLoaded) void load(seasonId) }, [load, seasonId, seasonsLoaded])

  // ONE CLICK FROM ENROLLED. Reuses POST /api/seasonal-contracts/create, which is already
  // idempotent and already respects the (guest_id, season_id) unique constraint — so a double
  // click, or two staff clicking at once, returns the existing draft instead of a second one.
  async function addToSeason(r: Row) {
    if (!year) return
    setAddingId(r.guest_id)
    try {
      const res = await fetch('/api/seasonal-contracts/create', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ guest_id: r.guest_id, season_year: year, season_id: seasonId || undefined }),
      })
      const d = await res.json()
      if (!res.ok) toast.error(d.error || 'Could not add them.')
      else {
        toast.success(d.created
          ? `${r.name} added to ${seasonName || year} as a draft.`
          : `${r.name} was already in ${seasonName || year}.`)
        await load(seasonId)
      }
    } catch { toast.error('Could not add them.') }
    setAddingId('')
  }

  const visible = useMemo(() => rows.filter(r => {
    if (!matchesCamperSearch(r, search)) return false
    if (filter === 'needs_adding') return !r.contract
    if (filter === 'inactive') return !r.active
    return true
  }), [rows, search, filter])

  const needsAdding = rows.filter(r => !r.contract).length
  const inactive = rows.filter(r => !r.active).length

  return (
    <div className="p-4 md:p-6">
      <Toaster position="top-right" />

      <div className="flex flex-col gap-3 mb-4 md:flex-row md:items-start md:justify-between">
        <div>
          <h2 className="text-2xl font-bold text-ink">Campers</h2>
          <p className="text-sm text-muted mt-0.5">
            {loading ? 'Loading…' : `${rows.length} seasonal camper${rows.length === 1 ? '' : 's'} — everyone, in or out of ${seasonName || year || 'this season'}.`}
          </p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <Link href="/admin/seasonals"
            className="px-3 py-2 text-xs font-medium rounded-lg border border-line bg-card text-ink-soft">
            Contracts for this season →
          </Link>
          <Link href="/admin/seasonals/new"
            className="px-3 py-2 text-xs font-bold rounded-lg text-on-forest" style={{ background: 'var(--forest)' }}>
            + New Seasonal Camper
          </Link>
          <SeasonPicker seasons={seasons} value={seasonId} onChange={setSeasonId} disabled={!seasonsLoaded} />
        </div>
      </div>

      {/* The banner is the whole point of the page: if anyone is missing from the season, say so
          before the owner has to notice a name they cannot find. */}
      {!loading && needsAdding > 0 && (
        <div className="mb-4 rounded-xl border border-danger/40 bg-danger-bg px-4 py-3 text-sm text-danger">
          <strong>{needsAdding} camper{needsAdding === 1 ? ' is' : 's are'} not in {seasonName || year} yet.</strong>{' '}
          They will not appear on the Contracts list until they are added — that is what made campers
          seem to vanish. Add them below, or use{' '}
          <Link href="/admin/seasonals" className="underline font-semibold">Clone from previous season</Link>{' '}
          to bring a whole year across at once.
        </div>
      )}

      {err && <div className="bg-danger-bg border border-danger/40 text-danger rounded-lg px-3 py-2 text-sm mb-3">{err}</div>}

      <div className="flex flex-col gap-2 mb-4 md:flex-row md:items-center">
        <input
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder="Search by name or site number…"
          className="flex-1 rounded-lg border border-line-strong bg-card px-3 py-2 text-sm text-ink"
        />
        <div className="flex items-center gap-2">
          {([['all', `All (${rows.length})`], ['needs_adding', `Needs adding (${needsAdding})`], ['inactive', `Inactive (${inactive})`]] as [Filter, string][]).map(([k, label]) => (
            <button key={k} onClick={() => setFilter(k)}
              className={`px-3 py-2 text-xs font-semibold rounded-lg border ${filter === k ? 'border-forest text-on-forest' : 'border-line bg-card text-ink-soft'}`}
              style={filter === k ? { background: 'var(--forest)' } : undefined}>
              {label}
            </button>
          ))}
        </div>
      </div>

      <div className="bg-card rounded-xl border border-line-soft overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-[11px] uppercase tracking-wide text-muted border-b border-line-soft">
                <th className="px-4 py-3">Camper</th>
                <th className="px-4 py-3">Site</th>
                <th className="px-4 py-3">Seasons</th>
                <th className="px-4 py-3">{seasonName || year || 'This season'}</th>
                <th className="px-4 py-3 text-right">Balance</th>
                <th className="px-4 py-3 text-right">Action</th>
              </tr>
            </thead>
            <tbody>
              {visible.map(r => {
                const status = enrollmentStatus(r.contract)
                return (
                  <tr key={r.guest_id} className="border-b border-line-soft hover:bg-card-2">
                    <td className="px-4 py-3">
                      <Link href={`/admin/seasonals/${r.guest_id}${seasonId ? `?season_id=${encodeURIComponent(seasonId)}` : ''}`}
                        className="font-semibold text-ink hover:underline">{r.name}</Link>
                      {!r.active && (
                        <span className="ml-2 inline-block rounded-full bg-card-2 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-muted">
                          Inactive
                        </span>
                      )}
                      {r.member_since && <div className="text-xs text-muted mt-0.5">Since {r.member_since}</div>}
                    </td>
                    <td className="px-4 py-3 text-ink-soft">{r.site_number || '—'}</td>
                    <td className="px-4 py-3 text-muted text-xs">
                      {r.season_years.length ? r.season_years.join(', ') : 'None yet'}
                    </td>
                    <td className="px-4 py-3"><Pill status={status} /></td>
                    <td className="tnum px-4 py-3 text-right font-medium"
                      style={{ color: r.balance_cents > 0 ? 'var(--watch)' : 'var(--good)' }}>
                      {r.balance_cents < 0 ? 'Credit ' + fmtMoney(-r.balance_cents) : fmtMoney(r.balance_cents)}
                    </td>
                    <td className="px-4 py-3 text-right">
                      {r.contract ? (
                        <Link href={`/admin/seasonals/${r.guest_id}${seasonId ? `?season_id=${encodeURIComponent(seasonId)}` : ''}`}
                          className="text-xs font-semibold" style={{ color: 'var(--link)' }}>Open →</Link>
                      ) : (
                        <button onClick={() => addToSeason(r)} disabled={addingId === r.guest_id || !year}
                          className="px-3 py-1.5 rounded-lg text-xs font-bold text-on-forest disabled:opacity-50 whitespace-nowrap"
                          style={{ background: 'var(--forest)' }}>
                          {addingId === r.guest_id ? 'Adding…' : `Add to ${seasonName || year}`}
                        </button>
                      )}
                    </td>
                  </tr>
                )
              })}
              {!loading && visible.length === 0 && (
                <tr><td colSpan={6} className="px-4 py-10 text-center text-muted">
                  {search ? 'No campers match that search.'
                    : filter === 'needs_adding' ? 'Everyone is in this season 🎉'
                    : filter === 'inactive' ? 'No inactive campers.'
                    : 'No seasonal campers yet.'}
                </td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {!hasActiveColumn && (
        <p className="mt-3 text-xs text-muted">
          Active/inactive needs the <code>seasonal_active</code> migration; until it is run every camper reads as active.
        </p>
      )}
    </div>
  )
}
