'use client'
import { useCallback, useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { planAtLeast } from '@/lib/plan'
import { sortSeasonsForPicker } from '@/lib/season'
import { createBrowserSupabase } from '@/lib/supabase-browser'
import SeasonsManager from './SeasonsManager'
import SeasonPicker, { useSeasons } from './SeasonPicker'
import type { Season } from '@/lib/seasonal-types'

// PR 5b-1: the admin browser now talks to Supabase as the LOGGED-IN USER rather than as
// `anon`. Same publishable key, but it travels with the session cookie, so PostgREST runs
// these queries as `authenticated` and the role policies in
// db/migrations/2026-08-11-pr5b1-authenticated-role-policies.sql apply. Safe at module
// scope: createBrowserClient returns a singleton in the browser and a no-op cookie store
// during prerender.
const supabase = createBrowserSupabase()

type Row = {
  guest_id: string
  contract_id: string | null
  name: string
  site_number: string
  contract_status: string
  contract_doc_status: string | null
  waiver_doc_status: string | null
  balance_cents: number
  last_note_at: string | null
}

const fmtMoney = (c: number) => (c < 0 ? '−$' : '$') + (Math.abs(c) / 100).toFixed(2)
const fmtDate = (d: string | null) => d ? new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '—'

function statusPill(status: string) {
  const map: Record<string, { bg: string; color: string; label: string }> = {
    signed: { bg: 'var(--good-bg)', color: 'var(--good)', label: 'Signed' },
    sent: { bg: 'var(--watch-bg)', color: 'var(--watch)', label: 'Sent · unsigned' },
    draft: { bg: 'var(--draft-bg)', color: 'var(--draft)', label: 'Draft' },
    none: { bg: 'var(--card-2)', color: 'var(--muted)', label: 'Not started' },
  }
  const s = map[status] || map.none
  return <span style={{ background: s.bg, color: s.color, fontSize: 12, fontWeight: 600, padding: '3px 9px', borderRadius: 999 }}>{s.label}</span>
}

export default function SeasonalsPage() {
  const router = useRouter()
  const [loading, setLoading] = useState(true)
  const [rows, setRows] = useState<Row[]>([])
  // Phase 2c: the list is filtered by SEASON. `seasonId` is the selection; the picker's default
  // (the season containing today, else the newest) arrives from useSeasons.
  const { seasons, loaded: seasonsLoaded, defaultId, reload: reloadSeasons } = useSeasons()
  const [seasonId, setSeasonId] = useState('')
  const [signed, setSigned] = useState(0)
  const [total, setTotal] = useState(0)
  const [unsignedOnly, setUnsignedOnly] = useState(false)
  const [err, setErr] = useState('')
  // Clone-from-last-year flow: 'confirm' shows a preview count, 'done' the summary.
  const [cloneStep, setCloneStep] = useState<'idle' | 'confirm' | 'done'>('idle')
  const [clonePreview, setClonePreview] = useState<{ from_year: number; to_year: number; from_season_id: string; to_season_id: string; would_create: number; would_skip: number } | null>(null)
  // The season being cloned FROM. Defaults to the most recent season before the selected one.
  const [fromSeasonId, setFromSeasonId] = useState('')
  const [cloneResult, setCloneResult] = useState<{ created: number; skipped: number; errors: { guest_id: string; reason: string }[] } | null>(null)
  const [cloneBusy, setCloneBusy] = useState(false)
  const [cloneErr, setCloneErr] = useState('')
  // Phase 2a: the seasons manager. Purely additive — nothing else on this page reads seasons yet.
  const [seasonsOpen, setSeasonsOpen] = useState(false)
  // SENDING LIVES HERE NOW. Reviewing, resending and cancelling a packet used to sit on the camper
  // page; that page is the PERSON, and having the paperwork on it too is what made the two screens
  // feel like the same screen. The routes are unchanged — only which screen calls them.
  const [busyId, setBusyId] = useState('')

  // Batch-1 gate: decide on the freshly-loaded plan, never the state default.
  useEffect(() => {
    supabase.from('settings').select('plan').single().then(({ data }) => {
      if (!planAtLeast(data?.plan, 'summit')) router.replace('/admin')
    })
  }, [router])

  // useCallback so the effect below can DECLARE this as a dependency instead of suppressing the
  // warning. It is also called by the clone flow after a successful run, so it cannot be inlined.
  useEffect(() => { if (!seasonId && defaultId) setSeasonId(defaultId) }, [defaultId, seasonId])

  const load = useCallback(async (sid: string) => {
    if (!sid) { setRows([]); setSigned(0); setTotal(0); setLoading(false); return }
    setLoading(true); setErr('')
    try {
      const res = await fetch(`/api/seasonals/list?season_id=${encodeURIComponent(sid)}`)
      const d = await res.json()
      if (!res.ok) { setErr(d.error || 'Could not load seasonals.'); setRows([]) }
      else { setRows(d.rows || []); setSigned(d.signed_count || 0); setTotal(d.total || 0) }
    } catch { setErr('Could not load seasonals.') }
    setLoading(false)
  }, [])
  useEffect(() => { if (seasonsLoaded) void load(seasonId) }, [load, seasonId, seasonsLoaded])

  // Preview first (writes nothing), then the staff confirms to actually create.
  // The most recent season BEFORE the selected one, in picker order — the sensible "from".
  const previousSeasonId = (() => {
    const ordered = sortSeasonsForPicker(seasons)
    const i = ordered.findIndex(s => s.id === seasonId)
    return i >= 0 ? (ordered[i + 1]?.id || '') : (ordered[0]?.id || '')
  })()

  function openClone() {
    setCloneErr(''); setCloneResult(null); setClonePreview(null)
    setFromSeasonId(previousSeasonId)
    setCloneStep('confirm')
    if (previousSeasonId) void previewClone(previousSeasonId)
  }

  // Preview writes NOTHING — it only counts. Re-run whenever the "from" season changes.
  async function previewClone(fromId: string) {
    setCloneErr(''); setClonePreview(null); setCloneBusy(true)
    try {
      const res = await fetch('/api/seasonal-contracts/clone', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ from_season_id: fromId, to_season_id: seasonId, preview: true }),
      })
      const d = await res.json()
      if (!res.ok) setCloneErr(d.error || 'Could not preview.')
      else setClonePreview(d)
    } catch { setCloneErr('Could not preview.') }
    setCloneBusy(false)
  }

  async function runClone() {
    setCloneBusy(true); setCloneErr('')
    try {
      const res = await fetch('/api/seasonal-contracts/clone', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ from_season_id: fromSeasonId, to_season_id: seasonId }),
      })
      const d = await res.json()
      if (!res.ok) { setCloneErr(d.error || 'Clone failed.'); setCloneBusy(false); return }
      setCloneResult(d); setCloneStep('done')
      await load(seasonId)   // refresh the list so the new drafts are visible for review
    } catch { setCloneErr('Clone failed.') }
    setCloneBusy(false)
  }

  async function resend(r: Row) {
    if (!r.contract_id) return
    setBusyId(r.contract_id)
    try {
      const res = await fetch(`/api/seasonal-contracts/${r.contract_id}/resend`, { method: 'POST' })
      const d = await res.json().catch(() => ({}))
      if (!res.ok) setErr(d.error || 'Could not resend.')
      else { setErr(''); await load(seasonId) }
    } catch { setErr('Could not resend.') }
    setBusyId('')
  }

  // Quiet, and reversible: cancelling puts the packet back to a draft so it can be edited and sent
  // again. It is not a delete, which is why it does not wear a red fill.
  async function cancelPacket(r: Row) {
    if (!r.contract_id) return
    if (!confirm(`Cancel ${r.name}'s packet? It goes back to a draft so you can edit and send it again.`)) return
    setBusyId(r.contract_id)
    try {
      const res = await fetch(`/api/seasonal-contracts/${r.contract_id}/cancel`, { method: 'POST' })
      const d = await res.json().catch(() => ({}))
      if (!res.ok) setErr(d.error || 'Could not cancel the packet.')
      else { setErr(''); await load(seasonId) }
    } catch { setErr('Could not cancel the packet.') }
    setBusyId('')
  }

  function closeClone() { setCloneStep('idle'); setClonePreview(null); setCloneResult(null); setCloneErr('') }

  const selectedSeason: Season | null = seasons.find(s => s.id === seasonId) || null
  const nameOf = (id: string) => seasons.find(s => s.id === id)?.name || 'that season'

  const visible = unsignedOnly ? rows.filter(r => r.contract_status !== 'signed') : rows

  return (
    <div className="p-4 md:p-6">
      <div className="flex flex-col gap-3 mb-4 md:flex-row md:items-center md:justify-between">
        <div>
          <h2 className="text-2xl font-bold text-ink">Seasonal Campers</h2>
          <p className="text-sm text-muted mt-0.5">
            {loading ? 'Loading…' : `${signed} of ${total} contracts signed for ${selectedSeason?.name || 'this season'}`}
          </p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <Link href="/admin/seasonals/new"
            className="px-3 py-2 text-xs font-bold rounded-lg text-on-forest"
            style={{ background: 'var(--forest)' }}>
            + New Seasonal Camper
          </Link>
          {/* The meter walk's second entry point. Deliberately not a new permanent sidebar item —
              PR 4's Seasonal Dashboard hub is where this belongs. */}
          <Link href="/admin/seasonals/meters"
            className="px-3 py-2 text-xs font-bold rounded-lg border border-line-strong text-ink">
            📱 Read electric meters
          </Link>
          <SeasonPicker seasons={seasons} value={seasonId} onChange={setSeasonId} disabled={!seasonsLoaded} />
          <button onClick={() => setUnsignedOnly(v => !v)}
            className="px-3 py-2 text-xs font-medium rounded-lg border"
            style={unsignedOnly ? { background: 'var(--watch-bg)', borderColor: 'color-mix(in srgb, var(--watch) 40%, transparent)', color: 'var(--watch)' } : { background: 'var(--card)', borderColor: 'var(--line)', color: 'var(--muted)' }}>
            {unsignedOnly ? 'Showing unsigned' : 'Unsigned only'}
          </button>
          <button onClick={() => setSeasonsOpen(true)}
            className="px-3 py-2 text-xs font-medium rounded-lg border"
            style={{ background: 'var(--card)', borderColor: 'var(--line)', color: 'var(--muted)' }}>
            Manage seasons
          </button>
          <button onClick={openClone}
            className="px-3 py-2 text-xs font-semibold rounded-lg border text-on-good"
            style={{ background: 'var(--good)', borderColor: 'var(--good)' }}>
            Clone from previous season
          </button>
        </div>
      </div>

      {err && <div className="bg-danger-bg border border-danger/40 text-danger rounded-lg px-3 py-2 text-sm mb-3">{err}</div>}

      <div className="bg-card rounded-xl border border-line-soft overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-[11px] uppercase tracking-wide text-muted border-b border-line-soft">
                <th className="px-4 py-3">Camper</th>
                <th className="px-4 py-3">Site</th>
                <th className="px-4 py-3">Contract</th>
                <th className="px-4 py-3">Waiver</th>
                <th className="px-4 py-3 text-right">Balance</th>
                <th className="px-4 py-3">Last note</th>
                <th className="px-4 py-3 text-right">Payment</th>
                <th className="px-4 py-3 text-right">Packet</th>
              </tr>
            </thead>
            <tbody>
              {visible.map(r => (
                <tr key={r.guest_id} className="border-b border-line-soft hover:bg-card-2">
                  <td className="px-4 py-3">
                    {/* The season selected here TRAVELS. Without it the camper page fell back to its own
                        default season, so a park working through 2027 clicked a name and landed on 2028. */}
                    <Link href={`/admin/seasonals/${r.guest_id}${seasonId ? `?season_id=${encodeURIComponent(seasonId)}` : ''}`} className="font-semibold text-ink hover:underline">{r.name}</Link>
                  </td>
                  <td className="px-4 py-3 text-ink-soft">{r.site_number || '—'}</td>
                  <td className="px-4 py-3">{statusPill(r.contract_status)}</td>
                  <td className="px-4 py-3">
                    {r.contract_status === 'none'
                      ? <span className="text-muted text-xs">—</span>
                      : statusPill(r.waiver_doc_status === 'signed' ? 'signed' : r.contract_status === 'draft' ? 'draft' : 'sent')}
                  </td>
                  <td className="tnum px-4 py-3 text-right font-medium" style={{ color: r.balance_cents > 0 ? 'var(--watch)' : 'var(--good)' }}>
                    {r.balance_cents < 0 ? 'Credit ' + fmtMoney(-r.balance_cents) : fmtMoney(r.balance_cents)}
                  </td>
                  <td className="px-4 py-3 text-muted">{fmtDate(r.last_note_at)}</td>
                  {/* Straight into this camper's Take-a-payment screen, with the SEASON carried
                      through the same way the name link carries it (#64). */}
                  <td className="px-4 py-3 text-right">
                    <Link
                      href={`/admin/checkout?guestId=${r.guest_id}${seasonId ? `&season_id=${encodeURIComponent(seasonId)}` : ''}`}
                      className="px-3 py-1.5 rounded-lg text-xs font-semibold border whitespace-nowrap"
                      style={{ borderColor: 'color-mix(in srgb, var(--good) 35%, transparent)', color: 'var(--good)', background: 'var(--good-bg)' }}>
                      Pay
                    </Link>
                  </td>
                  {/* The packet actions. Sending is this page's job — the camper page is the person. */}
                  <td className="px-4 py-3 text-right whitespace-nowrap">
                    {r.contract_status === 'signed' ? (
                      <span className="text-xs text-muted">—</span>
                    ) : r.contract_status === 'sent' ? (
                      <span className="inline-flex items-center gap-2">
                        <button onClick={() => resend(r)} disabled={busyId === r.contract_id}
                          className="px-3 py-1.5 rounded-lg text-xs font-semibold text-on-forest disabled:opacity-50"
                          style={{ background: 'var(--forest)' }}>
                          {busyId === r.contract_id ? '…' : '↻ Resend'}
                        </button>
                        <button onClick={() => cancelPacket(r)} disabled={busyId === r.contract_id}
                          className="px-3 py-1.5 rounded-lg text-xs font-semibold border disabled:opacity-50"
                          style={{ borderColor: 'color-mix(in srgb, var(--danger) 35%, transparent)', color: 'var(--danger)', background: 'var(--card)' }}>
                          Cancel
                        </button>
                      </span>
                    ) : (
                      <Link
                        href={`/admin/seasonals/${r.guest_id}/review${seasonId ? `?season_id=${encodeURIComponent(seasonId)}` : ''}`}
                        className="px-3 py-1.5 rounded-lg text-xs font-bold text-on-good whitespace-nowrap"
                        style={{ background: 'var(--good)' }}>
                        ✉ Review &amp; send
                      </Link>
                    )}
                  </td>
                </tr>
              ))}
              {!loading && visible.length === 0 && (
                <tr><td colSpan={8} className="px-4 py-10 text-center text-muted">{unsignedOnly ? 'All contracts signed 🎉' : 'No seasonal campers.'}</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {seasonsOpen && <SeasonsManager defaultYear={selectedSeason?.year ?? new Date().getFullYear()} onClose={() => { setSeasonsOpen(false); void reloadSeasons() }} />}

      {cloneStep !== 'idle' && (
        <>
          <div className="fixed inset-0 bg-forest-deep/50 z-40" onClick={() => !cloneBusy && closeClone()} />
          <div className="fixed inset-x-4 top-1/2 -translate-y-1/2 md:inset-x-auto md:left-1/2 md:-translate-x-1/2 md:w-[440px] bg-card rounded-2xl shadow-2xl z-50 overflow-hidden">
            <div className="px-6 py-4 border-b border-line-soft">
              <h3 className="text-lg font-bold text-ink">Clone from a previous season</h3>
            </div>
            <div className="px-6 py-4 text-sm text-ink-soft space-y-3">
              {cloneErr && <div className="bg-danger-bg border border-danger/40 text-danger rounded-lg px-3 py-2">{cloneErr}</div>}

              {cloneStep === 'confirm' && (
                <>
                  <div>
                    <label className="block text-xs text-muted mb-1">Copy campers from</label>
                    <SeasonPicker
                      seasons={seasons.filter(x => x.id !== seasonId)}
                      value={fromSeasonId}
                      onChange={id => { setFromSeasonId(id); void previewClone(id) }}
                      disabled={cloneBusy}
                      className="w-full border border-line rounded-lg px-3 py-2 text-sm"
                    />
                    <p className="text-xs text-muted mt-1">
                      Into <strong>{selectedSeason?.name || 'the selected season'}</strong> — the season you have selected on the list.
                    </p>
                  </div>

                  {!fromSeasonId ? (
                    <p className="text-muted">There is no other season to copy from yet. Add one under <strong>Manage seasons</strong>.</p>
                  ) : cloneBusy && !clonePreview ? (
                    <p className="text-muted">Checking {nameOf(fromSeasonId)}…</p>
                  ) : clonePreview ? (
                    <>
                      <p>Create <strong>{clonePreview.would_create}</strong> new draft{clonePreview.would_create === 1 ? '' : 's'} in <strong>{nameOf(clonePreview.to_season_id)}</strong> from <strong>{nameOf(clonePreview.from_season_id)}</strong>’s seasonal campers.</p>
                      {clonePreview.would_skip > 0 && <p className="text-muted">{clonePreview.would_skip} already have a contract in {nameOf(clonePreview.to_season_id)} and will be skipped.</p>}
                      <p className="text-xs text-muted">Drafts only — occupants and amount due carry over; site and rig are refreshed from each guest. Dates come from the season. Nothing is sent.</p>
                    </>
                  ) : null}
                </>
              )}

              {cloneStep === 'done' && cloneResult && (
                <>
                  <p><strong>{cloneResult.created}</strong> draft{cloneResult.created === 1 ? '' : 's'} created.{cloneResult.skipped > 0 ? ` ${cloneResult.skipped} skipped.` : ''}</p>
                  {cloneResult.errors.length > 0 && (
                    <div className="bg-watch-bg border border-watch/40 text-watch rounded-lg px-3 py-2 text-xs">
                      {cloneResult.errors.length} could not be created:
                      <ul className="list-disc ml-4 mt-1">{cloneResult.errors.map((e, i) => <li key={i}>{e.guest_id.slice(0, 8)}… — {e.reason}</li>)}</ul>
                    </div>
                  )}
                  <p className="text-xs text-muted">Review each new draft below before sending anything.</p>
                </>
              )}
            </div>
            <div className="px-6 py-4 border-t border-line-soft flex gap-2 justify-end">
              {cloneStep === 'confirm' ? (
                <>
                  <button onClick={closeClone} disabled={cloneBusy} className="px-4 py-2 rounded-xl text-sm font-semibold border border-line text-ink-soft hover:bg-card-2 disabled:opacity-50">Cancel</button>
                  <button onClick={runClone} disabled={cloneBusy || !fromSeasonId || !clonePreview || clonePreview.would_create === 0}
                    className="px-4 py-2 rounded-xl text-sm font-bold text-on-good disabled:opacity-50" style={{ background: 'var(--good)' }}>
                    {cloneBusy ? 'Cloning…' : clonePreview ? `Create ${clonePreview.would_create} draft${clonePreview.would_create === 1 ? '' : 's'}` : 'Create'}
                  </button>
                </>
              ) : (
                <button onClick={closeClone} className="px-4 py-2 rounded-xl text-sm font-bold text-on-good" style={{ background: 'var(--good)' }}>Done</button>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  )
}
