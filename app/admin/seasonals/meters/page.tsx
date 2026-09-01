'use client'
import { useCallback, useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'

// THE METER READING HUB. Start a walk, resume one, read a single meter, or manage the registry.
//
// ⚠ NOT A NEW TOP-LEVEL SIDEBAR ITEM. It is reached from the Electric Billing page and from the
// Seasonals area; PR 4's Seasonal Dashboard hub is its permanent home. Adding a permanent nav
// entry for something the owner touches once a month is how a sidebar stops being scannable.

type Session = {
  id: string; label: string; billing_month: string; read_date: string
  status: 'in_progress' | 'complete'; readings_taken: number; completed_at: string | null
}

type MeterRow = {
  meter: { id: string; meter_number: string; label: string | null; active: boolean; billable_override: boolean | null }
  siteNumber: string
  camper: { id: string; name: string; site_number: string } | null
  billable: boolean
  reason: string
  reasonLabel: string
  previousValue: number | null
  previousReadAt: string | null
}

const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December']

// The month a walk usually feeds: the one just ending. The owner can pick any of them — this only
// decides where the box opens. Deliberately NOT derived from the read date anywhere downstream;
// see the migration note on billing_month being a label.
function defaultMonth(): string {
  const now = new Date()
  return `${MONTHS[now.getMonth()]} ${now.getFullYear()}`
}
function monthOptions(): string[] {
  const y = new Date().getFullYear()
  const out: string[] = []
  for (let year = y - 1; year <= y + 1; year++) for (const m of MONTHS) out.push(`${m} ${year}`)
  return out
}
const fmtDate = (d: string | null) =>
  d ? new Date(d + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '—'
const fmtNum = (n: number | null) => n === null ? '—' : n.toLocaleString('en-US', { maximumFractionDigits: 2 })

export default function MetersHubPage() {
  const router = useRouter()
  const [sessions, setSessions] = useState<Session[]>([])
  const [activeMeters, setActiveMeters] = useState(0)
  const [meters, setMeters] = useState<MeterRow[]>([])
  const [conflicts, setConflicts] = useState<{ siteNumber: string; campers: { id: string; name: string }[] }[]>([])
  const [remaining, setRemaining] = useState<Record<string, string[]>>({})
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState('')
  const [tab, setTab] = useState<'walks' | 'registry'>('walks')

  const [month, setMonth] = useState(defaultMonth)
  const [readDate, setReadDate] = useState(() => new Date().toISOString().slice(0, 10))
  const [starting, setStarting] = useState(false)
  const [syncing, setSyncing] = useState(false)
  const [syncMsg, setSyncMsg] = useState('')

  // ── FETCH AND APPLY ARE SEPARATE, DELIBERATELY ──────────────────────────────────────────
  //
  // `fetchAll` touches no state; `apply` is the only thing that does. That split is what lets the
  // mount effect below start a fetch without setState appearing in its body — no cascading
  // render — and it gives the unmount guard something to guard: a walk started, then navigated
  // away from before the two requests land, must not write into an unmounted screen.
  type Loaded = {
    sessions: Session[]; activeMeters: number
    meters: MeterRow[]; conflicts: { siteNumber: string; campers: { id: string; name: string }[] }[]
    /** Session id -> the meter numbers still unread on it. See the note at the fetch below. */
    remaining: Record<string, string[]>
    error: string
  }

  const fetchAll = useCallback(async (): Promise<Loaded> => {
    try {
      const [sRes, mRes] = await Promise.all([fetch('/api/meter-sessions'), fetch('/api/meters')])
      const [sData, mData] = await Promise.all([sRes.json(), mRes.json()])
      if (!sRes.ok) {
        return { sessions: [], activeMeters: 0, meters: [], conflicts: [], remaining: {}, error: sData.error || 'Could not load the walks.' }
      }
      // WHICH METERS REMAIN, not just how many. "67 left" sends somebody back out to walk the
      // whole park again; "sites 14, 15, 22 and 41 left" sends them to four posts. Only for walks
      // still in progress — a finished one has nothing to go and find — so this is normally one
      // extra request, and none at all once the month is done.
      const open = (sData.sessions || []).filter((x: Session) => x.status === 'in_progress').slice(0, 3)
      const remaining: Record<string, string[]> = {}
      await Promise.all(open.map(async (x: Session) => {
        try {
          const r = await fetch(`/api/meter-sessions/${x.id}`)
          if (!r.ok) return
          const d = await r.json()
          remaining[x.id] = (d.meters || [])
            .filter((m: MeterRow & { reading: unknown }) => m.reading === null)
            .map((m: MeterRow) => m.meter.meter_number)
        } catch { /* a failed detail fetch just means no list; the counts still show */ }
      }))

      return {
        sessions: sData.sessions || [],
        activeMeters: sData.activeMeters || 0,
        meters: mRes.ok ? (mData.meters || []) : [],
        conflicts: mRes.ok ? (mData.conflicts || []) : [],
        remaining,
        error: '',
      }
    } catch {
      return { sessions: [], activeMeters: 0, meters: [], conflicts: [], remaining: {}, error: 'Could not reach the server.' }
    }
  }, [])

  const apply = useCallback((d: Loaded) => {
    setSessions(d.sessions); setActiveMeters(d.activeMeters)
    setMeters(d.meters); setConflicts(d.conflicts); setRemaining(d.remaining)
    setErr(d.error); setLoading(false)
  }, [])

  const load = useCallback(async () => { apply(await fetchAll()) }, [apply, fetchAll])

  useEffect(() => {
    let live = true
    fetchAll().then(d => { if (live) apply(d) })
    return () => { live = false }
  }, [fetchAll, apply])

  async function startWalk() {
    setStarting(true); setErr('')
    const res = await fetch('/api/meter-sessions', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ billing_month: month, read_date: readDate, label: month }),
    })
    const data = await res.json()
    setStarting(false)
    if (!res.ok) { setErr(data.error || 'Could not start the walk.'); return }
    router.push(`/admin/seasonals/meters/walk/${data.session.id}`)
  }

  async function setStatus(id: string, status: 'in_progress' | 'complete') {
    const res = await fetch('/api/meter-sessions', {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, status }),
    })
    if (res.ok) load()
  }

  async function setOverride(id: string, value: boolean | null) {
    const res = await fetch('/api/meters', {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, billable_override: value }),
    })
    if (res.ok) load()
    else setErr((await res.json()).error || 'Could not change that meter.')
  }

  async function setActive(id: string, active: boolean) {
    const res = await fetch('/api/meters', {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, active }),
    })
    if (res.ok) load()
    else setErr((await res.json()).error || 'Could not change that meter.')
  }

  async function syncFromSites() {
    setSyncing(true); setSyncMsg('')
    const res = await fetch('/api/meters', { method: 'POST' })
    const data = await res.json()
    setSyncing(false)
    if (!res.ok) { setErr(data.error || 'Could not sync.'); return }
    setSyncMsg(data.created === 0
      ? 'Every site already has a meter — nothing to add.'
      : `Added ${data.created} meter${data.created === 1 ? '' : 's'}. ${data.total} in total.`)
    load()
  }

  const inProgress = sessions.filter(s => s.status === 'in_progress')

  if (loading) return <div style={{ padding: '3rem', textAlign: 'center', color: 'var(--muted)' }}>Loading meters…</div>

  return (
    <div style={{ padding: '1.25rem', maxWidth: 1000, margin: '0 auto' }}>
      <h2 style={{ fontSize: 26, fontWeight: 700, margin: '0 0 4px' }}>Electric meter readings</h2>
      <p style={{ color: 'var(--muted)', margin: '8px 0 20px', fontSize: 14, maxWidth: 620, lineHeight: 1.5 }}>
        Walk the park with a phone and enter each meter once. Every reading is kept as a permanent
        record; the ones on a <strong>seasonal or monthly</strong> camper&rsquo;s site become <strong>draft</strong> electric bills for you to
        review. Nothing is charged to anybody from this screen.
      </p>

      {err ? (
        <div role="alert" style={{ background: 'var(--danger-bg)', border: '1px solid var(--danger)', color: 'var(--danger)', borderRadius: 10, padding: '10px 14px', fontSize: 13, fontWeight: 600, marginBottom: 16 }}>{err}</div>
      ) : null}

      {/* A camper on a site somebody else also claims would bill the wrong person. Surfaced here
          rather than resolved silently — see campersBySite() in lib/meters.ts. */}
      {conflicts.length ? (
        <div style={{ background: 'var(--watch-bg)', border: '1px solid var(--watch)', borderRadius: 10, padding: '11px 14px', fontSize: 13, marginBottom: 16, color: 'var(--ink)' }}>
          <strong style={{ color: 'var(--watch)' }}>Two campers share a site.</strong>{' '}
          {conflicts.map(c => `Site ${c.siteNumber}: ${c.campers.map(p => p.name).join(' and ')}`).join('; ')}.
          {' '}The first is billed for that meter. Fix the site numbers on the Guests screen if that is wrong.
        </div>
      ) : null}

      <div style={{ display: 'flex', gap: 4, marginBottom: 18, borderBottom: '1px solid var(--line)' }}>
        {(['walks', 'registry'] as const).map(t => (
          <button key={t} onClick={() => setTab(t)} style={{
            padding: '10px 18px', fontSize: 14, fontWeight: 600, border: 'none', background: 'none', cursor: 'pointer',
            borderBottom: tab === t ? '2px solid var(--forest)' : '2px solid transparent',
            color: tab === t ? 'var(--forest)' : 'var(--muted)', marginBottom: -1,
          }}>{t === 'walks' ? 'Reading walks' : `Meters (${meters.length})`}</button>
        ))}
      </div>

      {tab === 'walks' ? (
        <>
          {inProgress.length ? (
            <div style={{ ...card, borderColor: 'var(--forest)', marginBottom: 16 }}>
              <h3 style={h3}>Pick up where you left off</h3>
              {inProgress.map(s => (
                <div key={s.id} style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 12, justifyContent: 'space-between', padding: '10px 0', borderTop: '1px solid var(--line-soft)' }}>
                  <div>
                    <div style={{ fontWeight: 700, fontSize: 15 }}>{s.label || s.billing_month}</div>
                    <div style={{ fontSize: 12, color: 'var(--muted)' }}>
                      Bills to {s.billing_month} · read {fmtDate(s.read_date)} ·{' '}
                      <span className="tnum">{s.readings_taken} / {activeMeters}</span> done
                    </div>
                    {remaining[s.id]?.length ? (
                      <div style={{ fontSize: 12, color: 'var(--ink-soft)', marginTop: 4, maxWidth: 460, lineHeight: 1.5 }}>
                        <strong style={{ color: 'var(--watch)' }}>Still to read:</strong>{' '}
                        <span className="tnum">
                          {remaining[s.id].slice(0, 14).join(', ')}
                          {remaining[s.id].length > 14 ? ` and ${remaining[s.id].length - 14} more` : ''}
                        </span>
                      </div>
                    ) : remaining[s.id] ? (
                      <div style={{ fontSize: 12, color: 'var(--good)', fontWeight: 600, marginTop: 4 }}>
                        Every meter has been read — mark it done to finish.
                      </div>
                    ) : null}
                  </div>
                  <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                    <a href={`/admin/seasonals/meters/walk/${s.id}`} style={primaryLink}>Continue walking</a>
                    <button onClick={() => setStatus(s.id, 'complete')} style={ghostBtn}>Mark done</button>
                  </div>
                </div>
              ))}
            </div>
          ) : null}

          <div style={{ ...card, marginBottom: 16 }}>
            <h3 style={h3}>Start a new walk</h3>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 12 }}>
              <div>
                <label style={lbl}>Bills to</label>
                <select value={month} onChange={e => setMonth(e.target.value)} style={input}>
                  {monthOptions().map(m => <option key={m} value={m}>{m}</option>)}
                </select>
                <p style={hint}>The Electric Billing month these readings feed. Reading in late August for the September bill is fine.</p>
              </div>
              <div>
                <label style={lbl}>Read date</label>
                <input type="date" value={readDate} onChange={e => setReadDate(e.target.value)} style={input} />
                <p style={hint}>The day you are walking the park.</p>
              </div>
            </div>
            <button onClick={startWalk} disabled={starting} style={{ ...primaryBtn, marginTop: 12 }}>
              {starting ? 'Starting…' : `Start walking · ${activeMeters} meters`}
            </button>
          </div>

          <div style={card}>
            <h3 style={h3}>Past walks</h3>
            {sessions.length === 0 ? (
              <p style={{ color: 'var(--muted)', fontSize: 14, margin: 0 }}>No walks yet.</p>
            ) : sessions.map(s => (
              <div key={s.id} style={{ display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'center', justifyContent: 'space-between', padding: '10px 0', borderTop: '1px solid var(--line-soft)' }}>
                <div>
                  <div style={{ fontWeight: 600, fontSize: 14 }}>
                    {s.label || s.billing_month}{' '}
                    <span style={{
                      fontSize: 11, fontWeight: 700, padding: '2px 8px', borderRadius: 999, marginLeft: 4,
                      background: s.status === 'complete' ? 'var(--good-bg)' : 'var(--watch-bg)',
                      color: s.status === 'complete' ? 'var(--good)' : 'var(--watch)',
                    }}>{s.status === 'complete' ? 'Done' : 'In progress'}</span>
                  </div>
                  <div style={{ fontSize: 12, color: 'var(--muted)' }}>
                    Bills to {s.billing_month} · read {fmtDate(s.read_date)} ·{' '}
                    <span className="tnum">{s.readings_taken}</span> readings
                  </div>
                </div>
                <a href={`/admin/seasonals/meters/walk/${s.id}`} style={ghostLink}>Open</a>
              </div>
            ))}
          </div>
        </>
      ) : (
        <>
          <div style={{ ...card, marginBottom: 16 }}>
            <h3 style={h3}>The meter list</h3>
            <p style={{ fontSize: 13, color: 'var(--muted)', margin: '0 0 12px', lineHeight: 1.5 }}>
              One meter per site, numbered the same as the site. On <strong>Auto</strong> a meter bills
              whoever is on its site when they are <strong>seasonal or monthly</strong> — nightly campers and
              empty sites are recorded but never billed, because a nightly camper&rsquo;s power is already in
              their rate. Use <strong>Don&rsquo;t bill</strong> for a meter that should never be charged to anyone.
            </p>
            <button onClick={syncFromSites} disabled={syncing} style={ghostBtn}>
              {syncing ? 'Checking…' : 'Add meters for any new sites'}
            </button>
            {syncMsg ? <div style={{ fontSize: 13, color: 'var(--good)', fontWeight: 600, marginTop: 8 }}>{syncMsg}</div> : null}
          </div>

          <div style={{ ...card, padding: 0, overflow: 'hidden' }}>
            {meters.map((m, i) => (
              <div key={m.meter.id} style={{
                display: 'grid', gridTemplateColumns: 'minmax(0,1fr) auto', gap: 12, alignItems: 'center',
                padding: '12px 14px', borderTop: i === 0 ? 'none' : '1px solid var(--line-soft)',
              }}>
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontWeight: 700, fontSize: 15 }}>
                    Meter {m.meter.meter_number}
                    {m.meter.label ? <span style={{ color: 'var(--muted)', fontWeight: 500 }}> · {m.meter.label}</span> : null}
                  </div>
                  <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 2 }}>
                    {m.camper ? m.camper.name : 'No camper'} · {m.reasonLabel}
                  </div>
                  <div style={{ fontSize: 12, color: 'var(--muted)' }}>
                    Last read <span className="tnum">{fmtNum(m.previousValue)}</span>
                    {m.previousReadAt ? ` on ${fmtDate(m.previousReadAt)}` : ''}
                  </div>
                </div>
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
                  {/* ── THE BILLING SETTING ─────────────────────────────────────────────────
                      Two states, and a group label so the row says what the buttons are FOR. As
                      three unlabelled buttons this read as an unexplained mode switch; "Auto"
                      and "Don't bill" sitting next to a bare "Billing:" reads as a sentence.

                      "Always" is gone — see resolveBillable() in lib/meters.ts. A bill is a
                      charge on a camper's folio, so a meter with nobody on it has nothing to
                      bill; the button could not do what its name promised. */}
                  <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--muted)', alignSelf: 'center', marginRight: 2 }}>
                    Billing:
                  </span>
                  {([
                    [null, 'Auto', 'Bills the camper automatically when they\u2019re seasonal or monthly. Transients and empty sites are recorded but not billed.'],
                    [false, 'Don\u2019t bill', 'Record the reading but never bill this meter (e.g. a work camper with free electric).'],
                  ] as const).map(([v, label, tip]) => {
                    // `true` is a removed value; a meter still carrying one reads as Auto here,
                    // matching what resolveBillable() actually does with it.
                    const active = (m.meter.billable_override ?? null) !== false
                      ? v === null
                      : v === false
                    return (
                      <button key={label} onClick={() => setOverride(m.meter.id, v as boolean | null)}
                        aria-pressed={active} title={tip}
                        style={{
                          minHeight: 36, padding: '0 11px', borderRadius: 8, fontSize: 12, fontWeight: 600, cursor: 'pointer',
                          border: '1px solid ' + (active ? 'var(--forest)' : 'var(--line-strong)'),
                          background: active ? 'var(--forest)' : 'var(--card)',
                          color: active ? 'var(--on-forest)' : 'var(--ink-soft)',
                        }}>{label}</button>
                    )
                  })}
                  <a href={`/admin/seasonals/meters/single/${m.meter.id}`} style={{ ...ghostLink, minHeight: 36, display: 'inline-flex', alignItems: 'center' }}>Read now</a>
                  <button onClick={() => setActive(m.meter.id, false)} style={{ ...ghostBtn, minHeight: 36, padding: '0 11px', fontSize: 12 }}>Retire</button>
                </div>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  )
}

const card: React.CSSProperties = { background: 'var(--card)', border: '1px solid var(--line)', borderRadius: 14, padding: 18 }
const h3: React.CSSProperties = { margin: '0 0 12px', fontSize: 15, fontWeight: 700 }
const lbl: React.CSSProperties = { display: 'block', fontSize: 12, fontWeight: 700, color: 'var(--ink-soft)', marginBottom: 5 }
const hint: React.CSSProperties = { fontSize: 11, color: 'var(--muted)', margin: '5px 0 0', lineHeight: 1.45 }
const input: React.CSSProperties = { width: '100%', minHeight: 46, borderRadius: 10, border: '1px solid var(--line-strong)', padding: '0 11px', fontSize: 15 }
const primaryBtn: React.CSSProperties = { minHeight: 50, padding: '0 22px', borderRadius: 11, border: 'none', background: 'var(--forest)', color: 'var(--on-forest)', fontSize: 15, fontWeight: 700, cursor: 'pointer' }
const primaryLink: React.CSSProperties = { ...primaryBtn, display: 'inline-flex', alignItems: 'center', textDecoration: 'none' }
const ghostBtn: React.CSSProperties = { minHeight: 44, padding: '0 16px', borderRadius: 10, border: '1px solid var(--line-strong)', background: 'var(--card)', color: 'var(--ink)', fontSize: 14, fontWeight: 600, cursor: 'pointer' }
const ghostLink: React.CSSProperties = { ...ghostBtn, display: 'inline-flex', alignItems: 'center', textDecoration: 'none' }
