'use client'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { planAtLeast } from '@/lib/plan'
import { createBrowserSupabase } from '@/lib/supabase-browser'
import { matchesCamperSearch } from '@/lib/seasonal-directory'

const supabase = createBrowserSupabase()

// THE CAMPERS LIST — the people, and deliberately nothing else.
//
// ⚠ THERE IS NO ENROLMENT CONTROL ON THIS PAGE, ON PURPOSE.
//
// An earlier cut put "add to season" buttons and a per-season status column on these rows, and it
// made this page a second, worse Contracts page: the same campers, the same season, the same
// paperwork, in a weaker layout. The two pages have different jobs —
//     Campers  = who these people ARE. One row per person, for the whole history of the park.
//     Contracts = the PAPERWORK for one season. Fees, sending, signatures, the document itself.
// — and the single per-camper "add to season" action lives on that camper's own page, where
// choosing which season is a deliberate act rather than a button in a grid.
//
// Keep this list plain. A name, a site, and whether they are still in the programme.
type Row = { guest_id: string; name: string; site_number: string; active: boolean }

export default function CampersListPage() {
  const router = useRouter()
  const [rows, setRows] = useState<Row[]>([])
  const [hasActiveColumn, setHasActiveColumn] = useState(true)
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState('')
  const [search, setSearch] = useState('')
  const [showInactive, setShowInactive] = useState(true)

  useEffect(() => {
    supabase.from('settings').select('plan').single().then(({ data }) => {
      if (!planAtLeast(data?.plan, 'summit')) router.replace('/admin')
    })
  }, [router])

  const load = useCallback(async () => {
    setLoading(true); setErr('')
    try {
      const res = await fetch('/api/seasonals/campers')
      const d = await res.json()
      if (!res.ok) { setErr(d.error || 'Could not load campers.'); setRows([]) }
      else { setRows(d.rows || []); setHasActiveColumn(d.has_active_column !== false) }
    } catch { setErr('Could not load campers.') }
    setLoading(false)
  }, [])
  useEffect(() => { void load() }, [load])

  const visible = useMemo(
    () => rows.filter(r => matchesCamperSearch(r, search)).filter(r => showInactive || r.active),
    [rows, search, showInactive],
  )
  const inactiveCount = rows.filter(r => !r.active).length

  return (
    <div className="p-4 md:p-6 max-w-3xl">
      <div className="flex flex-col gap-3 mb-4 md:flex-row md:items-start md:justify-between">
        <div>
          <h2 className="text-2xl font-bold text-ink">Campers</h2>
          <p className="text-sm text-muted mt-0.5">
            {loading ? 'Loading…' : `${rows.length} seasonal camper${rows.length === 1 ? '' : 's'}. Open one to edit their details or add them to a season.`}
          </p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <Link href="/admin/seasonals"
            className="px-3 py-2 text-xs font-medium rounded-lg border border-line bg-card text-ink-soft whitespace-nowrap">
            Contracts &amp; sending →
          </Link>
          {/* The PERSON-only intake. The full counter/kiosk form, which also starts a contract
              and walks into signing, is still one click away from the Contracts page. */}
          <Link href="/admin/seasonals/campers/new"
            className="px-3 py-2 text-xs font-bold rounded-lg text-on-forest whitespace-nowrap"
            style={{ background: 'var(--forest)' }}>
            + New camper
          </Link>
        </div>
      </div>

      {err && <div className="bg-danger-bg border border-danger/40 text-danger rounded-lg px-3 py-2 text-sm mb-3">{err}</div>}

      <div className="flex flex-col gap-2 mb-4 sm:flex-row sm:items-center">
        <input
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder="Search by name or site number…"
          className="flex-1 rounded-lg border border-line-strong bg-card px-3 py-2 text-sm text-ink"
        />
        {inactiveCount > 0 && (
          <label className="flex items-center gap-2 text-xs text-ink-soft whitespace-nowrap">
            <input type="checkbox" checked={showInactive} onChange={e => setShowInactive(e.target.checked)} />
            Show inactive ({inactiveCount})
          </label>
        )}
      </div>

      <div className="bg-card rounded-xl border border-line-soft overflow-hidden">
        <ul>
          {visible.map(r => (
            <li key={r.guest_id} className="border-b border-line-soft last:border-b-0">
              <Link href={`/admin/seasonals/${r.guest_id}`}
                className="flex items-center justify-between gap-3 px-4 py-3 hover:bg-card-2">
                <span className="flex items-center gap-2 min-w-0">
                  <span className="font-semibold text-ink truncate">{r.name || 'Unnamed camper'}</span>
                  {!r.active && (
                    <span className="shrink-0 rounded-full bg-card-2 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-muted">
                      Inactive
                    </span>
                  )}
                </span>
                <span className="flex items-center gap-3 shrink-0">
                  <span className="text-sm text-ink-soft">{r.site_number ? `Site ${r.site_number}` : '—'}</span>
                  <span className="text-muted" aria-hidden>→</span>
                </span>
              </Link>
            </li>
          ))}
          {!loading && visible.length === 0 && (
            <li className="px-4 py-10 text-center text-muted">
              {search ? 'No campers match that search.' : 'No seasonal campers yet.'}
            </li>
          )}
        </ul>
      </div>

      {!hasActiveColumn && (
        <p className="mt-3 text-xs text-muted">
          Active/inactive needs the <code>seasonal_active</code> migration; until it is run every camper reads as active.
        </p>
      )}
    </div>
  )
}
