'use client'
// REVIEW BEFORE SENDING — Phase 1.5.
//
// Replaces the small send modal that used to live on the camper page. That modal showed the
// party, dates and total, but never the DOCUMENTS: the owner clicked "Send packet" and a legal
// agreement they had not read was frozen and emailed to a camper. This screen shows exactly what
// the camper will receive, lets the owner fix anything, and sends from here.
//
// ⚠ THE PREVIEW'S ONLY JOB IS TO BE TRUE. It renders through PacketPreview →
// renderPacketDocuments() in lib/contracts.ts — the SAME function freezePacket() calls. There is
// no second renderer. The rig and site come from the GUEST record, because that is where the
// freeze snapshots them from; the settings argument to buildContractVars is omitted, because the
// freeze omits it. Those two details are what make "this is what they will sign" a true sentence
// rather than a hopeful one.
import { useCallback, useEffect, useState } from 'react'
import { useParams, useRouter } from 'next/navigation'
import Link from 'next/link'
import { planAtLeast } from '@/lib/plan'
import { currentSeasonYear } from '@/lib/season'
import PartyEditor from '../../PartyEditor'
import PacketPreview, { missingPacketFields } from '../../PacketPreview'
import toast, { Toaster } from 'react-hot-toast'
import type { SeasonalGuestData, SeasonalContract, SeasonalGuest, Season } from '@/lib/seasonal-types'
import { effectiveSeasonDates } from '@/lib/contracts'
import { createBrowserSupabase } from '@/lib/supabase-browser'

const supabase = createBrowserSupabase()

type Occupant = { name: string; kind: 'adult' | 'child' }
/** Only the fields the preview and the Summit gate read off `settings`. */
type SeasonalSettings = { contract_text?: string | null; waiver_text?: string | null; plan?: string | null }

export default function SeasonalReviewPage() {
  const params = useParams()
  const router = useRouter()
  const guestId = params.guestId as string
  const cy = currentSeasonYear()

  // Phase 2c: the SEASON being sent, from ?season_id=. That is what makes "open or create the
  // contract for exactly this season" work, and it is what lets a camper hold a Spring and a Fall.
  // ?year= is still honoured for any older link.
  //
  // Read in an EFFECT rather than a lazy useState initializer, and from window.location rather
  // than useSearchParams — both deliberate, both matching app/admin/seasonals/new/page.tsx.
  // useSearchParams would force a Suspense boundary; a lazy initializer would read the URL during
  // the client's first render but not the server's, which is a hydration mismatch.
  const [year, setYear] = useState(cy)
  const [seasonIdParam, setSeasonIdParam] = useState('')
  const [paramsRead, setParamsRead] = useState(false)
  useEffect(() => {
    const q = new URLSearchParams(window.location.search)
    const sid = q.get('season_id') || ''
    if (sid) setSeasonIdParam(sid)
    const y = parseInt(q.get('year') || '', 10)
    if (Number.isFinite(y) && y > 0 && y !== cy) setYear(y)
    setParamsRead(true)
  }, [cy])

  const [settings, setSettings] = useState<SeasonalSettings | null>(null)
  const [data, setData] = useState<SeasonalGuestData | null>(null)
  const [draft, setDraft] = useState<SeasonalContract | null>(null)
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState('')
  // Set when create returned a contract that is already 'sent' or 'signed' this year. Surfaced
  // the way the old flow did rather than treated as an error — it is a normal thing to walk into.
  const [alreadyStatus, setAlreadyStatus] = useState<string | null>(null)

  // The editable fields — the same set the modal carried, plus Phase 1's charge note.
  const [occupants, setOccupants] = useState<Occupant[]>([])
  const [totalDue, setTotalDue] = useState('')
  // Phase 3 — DISPLAY ONLY, like Total due.
  const [depositDue, setDepositDue] = useState('')
  const [totalDueBy, setTotalDueBy] = useState('')
  const [depositDueBy, setDepositDueBy] = useState('')
  const [chargeNote, setChargeNote] = useState('')
  // Phase 2b: the screen is driven by the contract's SEASON. Its dates are the default; these
  // three pieces of state are the per-camper override.
  const [season, setSeason] = useState<Season | null>(null)
  const [overrideOn, setOverrideOn] = useState(false)
  const [ovOpens, setOvOpens] = useState('')
  const [ovCloses, setOvCloses] = useState('')
  const [working, setWorking] = useState(false)

  useEffect(() => {
    supabase.from('settings').select('plan, contract_text, waiver_text').single().then(({ data }) => {
      if (!planAtLeast(data?.plan, 'summit')) { router.replace('/admin'); return }
      setSettings(data)
    })
  }, [router])

  // Load the camper AND create-or-load the draft. `create` is idempotent on
  // (guest_id, season_year), so arriving here twice does not make a second contract.
  const load = useCallback(async () => {
    setLoading(true); setErr('')
    try {
      const res = await fetch(`/api/seasonals/guest/${guestId}?` + (seasonIdParam
        ? `season_id=${encodeURIComponent(seasonIdParam)}`
        : `year=${year}`))
      const d = await res.json()
      if (!res.ok) { setErr(d.error || 'Could not load camper.'); setLoading(false); return }
      setData(d)

      const cRes = await fetch('/api/seasonal-contracts/create', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        // season_id is what create keys idempotency on (2b), so arriving here opens or creates
        // the contract for EXACTLY the chosen season rather than "this camper's contract this year".
        body: JSON.stringify({ guest_id: guestId, season_year: year, season_id: seasonIdParam || undefined }),
      })
      const cData = await cRes.json()
      if (!cRes.ok || !cData.contract) { setErr(cData.error || 'Could not open the packet.'); setLoading(false); return }

      const c: SeasonalContract = cData.contract
      setDraft(c)
      setAlreadyStatus(c.status !== 'draft' ? c.status : null)
      // Occupants come from the contract, which Phase 1 seeds from the guest's standing roster.
      setOccupants(Array.isArray(c.occupants) ? (c.occupants as Occupant[]) : [])
      setTotalDue(c.total_due_cents != null ? (c.total_due_cents / 100).toFixed(2) : '')
      setChargeNote(c.charge_note || '')
      setDepositDue(c.deposit_due_cents != null ? (c.deposit_due_cents / 100).toFixed(2) : '')
      setTotalDueBy(c.total_due_by || '')
      setDepositDueBy(c.deposit_due_by || '')
      // The contract's own dates ARE the override. A pre-2b draft has them filled in (they were
      // seeded from the guest back then), so it opens with the override already on and keeps
      // exactly the dates it had — nothing shifts under the owner. A 2b draft has them null and
      // inherits its season.
      const hasOverride = !!(c.season_opens || c.season_closes)
      setOverrideOn(hasOverride)
      setOvOpens(c.season_opens || '')
      setOvCloses(c.season_closes || '')

      // Resolve the season the contract is filed under. The camper page still links here with
      // ?year=, which is fine — the contract itself carries the season, so that is what we read.
      if (c.season_id) {
        try {
          const sRes = await fetch('/api/seasons')
          const sData = await sRes.json()
          setSeason((sData?.seasons || []).find((x: Season) => x.id === c.season_id) || null)
        } catch { /* the screen still works without it; dates just fall back to the override */ }
      }
    } catch { setErr('Could not load camper.') }
    setLoading(false)
  }, [guestId, year, seasonIdParam])
  // Wait until the query string has been read, so the first load already knows its season.
  useEffect(() => { if (paramsRead) void load() }, [load, paramsRead])

  const g: SeasonalGuest = data?.guest || { id: '' }
  const totalDueCents = totalDue ? Math.round(parseFloat(totalDue) * 100) : null
  // null, not 0, when blank — a stated $0.00 deposit and no deposit are different terms.
  const depositDueCents = depositDue ? Math.round(parseFloat(depositDue) * 100) : null

  // The override exactly as it will be saved, and the dates the packet actually runs on.
  const overrideDates = {
    season_opens: overrideOn ? (ovOpens || null) : null,
    season_closes: overrideOn ? (ovCloses || null) : null,
  }
  const eff = effectiveSeasonDates(overrideDates, season)
  const fmtShort = (d?: string | null) => d ? new Date(d + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : ''
  const fmtRange = (a?: string | null, b?: string | null) => [fmtShort(a), fmtShort(b)].filter(Boolean).join(' – ')

  // What the preview renders. The GUEST supplies name/site/rig/home address — matching the
  // freeze, which snapshots rig and site off the guest record rather than the draft. The CONTRACT
  // supplies the staff-edited fields, taken from the live inputs so the documents update as they
  // are typed.
  const previewContract = {
    ...(draft || {}),
    season_year: year,
    occupants,
    total_due_cents: totalDueCents,
    deposit_due_cents: depositDueCents,
    total_due_by: totalDueBy || null,
    deposit_due_by: depositDueBy || null,
    charge_note: chargeNote,
    ...overrideDates,
  }

  // Recomputed here (rather than read out of PacketPreview) only to build the "still needed"
  // list; PacketPreview renders from the same function, so the two agree by construction.
  const contractText = settings?.contract_text || ''
  const waiverText = settings?.waiver_text || ''
  const missing = missingPacketFields({
    name: g.name, siteNumber: g.site_number,
    // EFFECTIVE dates: inheriting a dated season passes; a season with no dates and no override
    // is blocked, with a message naming both ways to fix it.
    seasonOpens: eff.opens, seasonCloses: eff.closes,
    homeStreet: g.home_street, homeCity: g.home_city, homeState: g.home_state, homeZip: g.home_zip,
    // The rendered body, not the raw template: a template that renders to nothing is just as
    // empty as an unset one, and freezePacket refuses both.
    contractText: contractText.trim() ? 'set' : '',
    waiverText: waiverText.trim() ? 'set' : '',
  })
  const ready = missing.length === 0 && !!draft && draft.status === 'draft'

  /** Persist the edited fields. Returns false on failure — the caller must NOT proceed. */
  async function saveEdits(): Promise<boolean> {
    if (!draft) return false
    const res = await fetch(`/api/seasonal-contracts/${draft.id}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        occupants,
        total_due_cents: totalDueCents,
        deposit_due_cents: depositDueCents,
        total_due_by: totalDueBy || null,
        deposit_due_by: depositDueBy || null,
        charge_note: chargeNote.trim() || null,
        // Null unless the owner explicitly chose different dates — a null override is what makes
        // this contract inherit its season. The freeze resolves and snapshots the result.
        ...overrideDates,
      }),
    })
    if (res.ok) return true
    let msg = 'Could not save the edits — nothing was sent.'
    try { const e = await res.json(); if (e?.error) msg = `Could not save the edits (${e.error}) — nothing was sent.` } catch {}
    toast.error(msg)
    return false
  }

  // SAVE FIRST, THEN FREEZE — unchanged from the modal, and the ordering is the safeguard.
  // Sending FREEZES the contract into a legal document, so if the save fails we ABORT rather than
  // freeze stale data. The screen stays open and nothing has been sent.
  async function sendPacket() {
    if (!draft) return
    setWorking(true)
    if (!(await saveEdits())) { setWorking(false); return }

    const res = await fetch(`/api/seasonal-contracts/${draft.id}/send`, { method: 'POST' })
    const d = await res.json().catch(() => ({}))
    setWorking(false)
    if (!res.ok || !d.ok) { toast.error(d.error || 'Send failed.'); return }
    // Committed (emailed or not). Hand the outcome back to the camper page so its existing banner
    // reports it, exactly as it did when the modal closed.
    const q = new URLSearchParams({ sent: d.emailed ? '1' : '0' })
    if (d.error) q.set('err', String(d.error))
    router.push(`/admin/seasonals/${guestId}?${q.toString()}`)
  }

  // In person: save, freeze WITHOUT emailing, then hand over the iPad. kiosk=1 returns to admin
  // after signing instead of leaving the packet URL in a shared browser.
  async function signInPerson() {
    if (!draft) return
    setWorking(true)
    if (!(await saveEdits())) { setWorking(false); return }

    const res = await fetch(`/api/seasonal-contracts/${draft.id}/sign-now`, { method: 'POST' })
    const d = await res.json().catch(() => ({}))
    setWorking(false)
    if (!res.ok || !d.packet_id) { toast.error(d.error || 'Could not open the signing page.'); return }
    router.push(`/packet/${d.packet_id}?kiosk=1`)
  }

  const cardCls = 'bg-card rounded-xl border border-line-soft p-5 mb-4'
  const inp = 'w-full border border-line rounded-lg px-3 py-2 text-sm'
  const lbl = 'block text-xs text-muted mb-1'
  const backHref = `/admin/seasonals/${guestId}`

  if (loading) return <div className="p-6 text-muted">Loading…</div>
  if (err && !data) return <div className="p-6 text-danger">{err}</div>

  return (
    <div className="p-4 md:p-6 max-w-3xl">
      <Toaster />

      <div className="mb-4">
        <Link href={backHref} className="text-sm text-muted hover:text-ink-soft">← {g.name || 'Camper'}</Link>
        <h2 className="text-2xl font-bold text-ink">Review before sending</h2>
        <p className="text-sm text-muted">
          {g.name || '—'} · Site {g.site_number || '—'} · {season?.name || `${year} season`}
        </p>
      </div>

      <div className="rounded-lg px-3 py-2 text-sm mb-4" style={{ background: 'var(--draft-bg)', color: 'var(--draft)', border: '1px solid color-mix(in srgb, var(--draft) 35%, transparent)' }}>
        Nothing has been sent yet. Check the documents below, fix anything that is wrong, then send.
      </div>

      {alreadyStatus && (
        <div className="rounded-lg px-3 py-2 text-sm mb-4" style={{ background: 'var(--watch-bg)', color: 'var(--watch)', border: '1px solid color-mix(in srgb, var(--watch) 40%, transparent)' }}>
          This camper already has a <strong>{alreadyStatus}</strong> {year} packet, so it can no longer be edited or re-sent from here.{' '}
          <Link href={backHref} className="underline font-semibold">Go back</Link>
          {alreadyStatus === 'sent' && <> — on the Contracts list you can resend the email, or cancel the packet to edit and send it again.</>}
        </div>
      )}

      {/* ── The editable fields ─────────────────────────────────────────────────────────────── */}
      <div className={cardCls}>
        <h3 className="text-sm font-bold text-muted uppercase tracking-wide mb-3">Details for this packet</h3>
        <PartyEditor value={occupants} onChange={setOccupants} />
        <p className="text-xs text-muted mt-1 mb-4">
          Prefilled from the camper&rsquo;s standing party. Changes here apply to this packet only — to change the
          standing party, edit it on the camper page.
        </p>
        <div>
          <label className={lbl}>Season</label>
          <p className="text-sm font-semibold text-ink">{season?.name || `${year} season`}</p>
          {!overrideOn ? (
            <div className="flex items-start justify-between gap-3 mt-1">
              <p className="text-sm text-ink-soft">
                {eff.opens || eff.closes
                  ? <>Runs <strong>{fmtRange(eff.opens, eff.closes)}</strong> <span className="text-muted">— from the season</span></>
                  : <span className="text-watch">This season has no dates set yet. Add them under Manage seasons, or set dates just for this camper.</span>}
              </p>
              <button type="button" onClick={() => { setOverrideOn(true); setOvOpens(season?.opens || ''); setOvCloses(season?.closes || '') }}
                className="text-xs font-semibold whitespace-nowrap" style={{ color: 'var(--link)' }}>
                Use different dates
              </button>
            </div>
          ) : (
            <div className="mt-2">
              <div className="flex items-center justify-between mb-1">
                <p className="text-xs font-bold text-muted uppercase tracking-wide">Dates for this camper only</p>
                <button type="button" onClick={() => { setOverrideOn(false); setOvOpens(''); setOvCloses('') }}
                  className="text-xs font-semibold" style={{ color: 'var(--link)' }}>
                  Use the season&rsquo;s dates
                </button>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div><label className={lbl}>Opens</label><input type="date" value={ovOpens} onChange={e => setOvOpens(e.target.value)} className={inp} /></div>
                <div><label className={lbl}>Closes</label><input type="date" value={ovCloses} onChange={e => setOvCloses(e.target.value)} className={inp} /></div>
              </div>
            </div>
          )}
        </div>
        <div className="mt-3">
          <label className={lbl}>Total due (display only, $)</label>
          <input type="number" step="0.01" value={totalDue} onChange={e => setTotalDue(e.target.value)} placeholder="0.00" className={`${inp} max-w-[200px]`} />
        </div>
        <div className="grid grid-cols-2 gap-3 mt-3">
          <div>
            <label className={lbl}>Deposit due (display only, $)</label>
            <input type="number" step="0.01" value={depositDue} onChange={e => setDepositDue(e.target.value)} placeholder="0.00" className={inp} />
          </div>
          <div>
            <label className={lbl}>Deposit due by</label>
            <input type="date" value={depositDueBy} onChange={e => setDepositDueBy(e.target.value)} className={inp} />
          </div>
          <div>
            <label className={lbl}>Total due by</label>
            <input type="date" value={totalDueBy} onChange={e => setTotalDueBy(e.target.value)} className={inp} />
          </div>
        </div>
        <p className="text-xs text-muted mt-1">
          Display only — these print on the contract and nothing is charged from them.
        </p>
        <div className="mt-3">
          <label className={lbl}>Note about the charge (prints on the contract)</label>
          <textarea value={chargeNote} onChange={e => setChargeNote(e.target.value)} rows={3}
            placeholder="e.g. Includes 2 extra family members, golf cart, and the second site."
            className={inp} />
        </div>
        <p className="text-xs text-muted mt-3">
          The site and rig printed below come from the camper record and are snapshotted when you send. Edit them on the
          camper page if they are wrong.
        </p>
      </div>

      {/* ── The documents ───────────────────────────────────────────────────────────────────── */}
      <div className={cardCls}>
        <h3 className="text-sm font-bold text-muted uppercase tracking-wide mb-3">The packet</h3>
        <p className="text-xs text-muted mb-2">This is exactly what the camper will see and sign:</p>
        <PacketPreview guest={g} contract={previewContract} settings={settings} season={season} maxHeight="45vh" />
      </div>

      {/* ── Actions ─────────────────────────────────────────────────────────────────────────── */}
      <div className={cardCls}>
        {missing.length > 0 && (
          <p className="text-sm text-watch mb-3">
            Still needed before you can send: <strong>{missing.join(', ')}</strong>.
          </p>
        )}
        <div className="flex flex-wrap gap-3">
          <button onClick={sendPacket} disabled={!ready || working}
            className="px-5 py-2.5 rounded-xl text-sm font-bold text-on-good disabled:opacity-50" style={{ background: 'var(--good)' }}>
            {working ? 'Working…' : 'Send packet →'}
          </button>
          <button onClick={signInPerson} disabled={!ready || working}
            className="px-5 py-2.5 rounded-xl text-sm font-bold text-on-forest disabled:opacity-50" style={{ background: 'var(--forest)' }}>
            ✍ Sign now (in person)
          </button>
          <Link href={backHref}
            className="px-5 py-2.5 rounded-xl text-sm font-semibold border border-line text-ink-soft hover:bg-card-2">
            Back — don&rsquo;t send
          </Link>
        </div>
      </div>
    </div>
  )
}
