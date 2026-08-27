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

  // The season being sent. Read from ?year= so the camper page's picker carries through; falls
  // back to the computed current season when the link is opened bare.
  //
  // Read in an EFFECT rather than a lazy useState initializer, and from window.location rather
  // than useSearchParams — both deliberate, both matching app/admin/seasonals/new/page.tsx.
  // useSearchParams would force a Suspense boundary; a lazy initializer would return `cy` during
  // the server render and the URL's year on the client's first render, which is a hydration
  // mismatch whenever the owner is sending for a non-current season.
  const [year, setYear] = useState(cy)
  useEffect(() => {
    const y = parseInt(new URLSearchParams(window.location.search).get('year') || '', 10)
    if (Number.isFinite(y) && y > 0 && y !== cy) setYear(y)
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
      const res = await fetch(`/api/seasonals/guest/${guestId}?year=${year}`)
      const d = await res.json()
      if (!res.ok) { setErr(d.error || 'Could not load camper.'); setLoading(false); return }
      setData(d)

      const cRes = await fetch('/api/seasonal-contracts/create', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ guest_id: guestId, season_year: year }),
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
  }, [guestId, year])
  useEffect(() => { void load() }, [load])

  const g: SeasonalGuest = data?.guest || { id: '' }
  const totalDueCents = totalDue ? Math.round(parseFloat(totalDue) * 100) : null

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

  const cardCls = 'bg-white rounded-xl border border-gray-100 p-5 mb-4'
  const inp = 'w-full border border-gray-200 rounded-lg px-3 py-2 text-sm'
  const lbl = 'block text-xs text-gray-500 mb-1'
  const backHref = `/admin/seasonals/${guestId}`

  if (loading) return <div className="p-6 text-gray-500">Loading…</div>
  if (err && !data) return <div className="p-6 text-red-600">{err}</div>

  return (
    <div className="p-4 md:p-6 max-w-3xl">
      <Toaster />

      <div className="mb-4">
        <Link href={backHref} className="text-sm text-gray-400 hover:text-gray-600">← {g.name || 'Camper'}</Link>
        <h2 className="text-2xl font-bold text-gray-900">Review before sending</h2>
        <p className="text-sm text-gray-500">
          {g.name || '—'} · Site {g.site_number || '—'} · {season?.name || `${year} season`}
        </p>
      </div>

      <div className="rounded-lg px-3 py-2 text-sm mb-4" style={{ background: '#eff6ff', color: '#1d4ed8', border: '1px solid #bfdbfe' }}>
        Nothing has been sent yet. Check the documents below, fix anything that is wrong, then send.
      </div>

      {alreadyStatus && (
        <div className="rounded-lg px-3 py-2 text-sm mb-4" style={{ background: '#fffbeb', color: '#b45309', border: '1px solid #fde68a' }}>
          This camper already has a <strong>{alreadyStatus}</strong> {year} packet, so it can no longer be edited or re-sent from here.{' '}
          <Link href={backHref} className="underline font-semibold">Go back</Link>
          {alreadyStatus === 'sent' && <> — from there you can resend the email, or cancel the packet to edit and send it again.</>}
        </div>
      )}

      {/* ── The editable fields ─────────────────────────────────────────────────────────────── */}
      <div className={cardCls}>
        <h3 className="text-sm font-bold text-gray-400 uppercase tracking-wide mb-3">Details for this packet</h3>
        <PartyEditor value={occupants} onChange={setOccupants} />
        <p className="text-xs text-gray-400 mt-1 mb-4">
          Prefilled from the camper&rsquo;s standing party. Changes here apply to this packet only — to change the
          standing party, edit it on the camper page.
        </p>
        <div>
          <label className={lbl}>Season</label>
          <p className="text-sm font-semibold text-gray-900">{season?.name || `${year} season`}</p>
          {!overrideOn ? (
            <div className="flex items-start justify-between gap-3 mt-1">
              <p className="text-sm text-gray-600">
                {eff.opens || eff.closes
                  ? <>Runs <strong>{fmtRange(eff.opens, eff.closes)}</strong> <span className="text-gray-400">— from the season</span></>
                  : <span className="text-amber-700">This season has no dates set yet. Add them under Manage seasons, or set dates just for this camper.</span>}
              </p>
              <button type="button" onClick={() => { setOverrideOn(true); setOvOpens(season?.opens || ''); setOvCloses(season?.closes || '') }}
                className="text-xs font-semibold whitespace-nowrap" style={{ color: 'var(--accent-color, #2E6B8A)' }}>
                Use different dates
              </button>
            </div>
          ) : (
            <div className="mt-2">
              <div className="flex items-center justify-between mb-1">
                <p className="text-xs font-bold text-gray-400 uppercase tracking-wide">Dates for this camper only</p>
                <button type="button" onClick={() => { setOverrideOn(false); setOvOpens(''); setOvCloses('') }}
                  className="text-xs font-semibold" style={{ color: 'var(--accent-color, #2E6B8A)' }}>
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
        <div className="mt-3">
          <label className={lbl}>Note about the charge (prints on the contract)</label>
          <textarea value={chargeNote} onChange={e => setChargeNote(e.target.value)} rows={3}
            placeholder="e.g. Includes 2 extra family members, golf cart, and the second site."
            className={inp} />
        </div>
        <p className="text-xs text-gray-400 mt-3">
          The site and rig printed below come from the camper record and are snapshotted when you send. Edit them on the
          camper page if they are wrong.
        </p>
      </div>

      {/* ── The documents ───────────────────────────────────────────────────────────────────── */}
      <div className={cardCls}>
        <h3 className="text-sm font-bold text-gray-400 uppercase tracking-wide mb-3">The packet</h3>
        <p className="text-xs text-gray-500 mb-2">This is exactly what the camper will see and sign:</p>
        <PacketPreview guest={g} contract={previewContract} settings={settings} season={season} maxHeight="45vh" />
      </div>

      {/* ── Actions ─────────────────────────────────────────────────────────────────────────── */}
      <div className={cardCls}>
        {missing.length > 0 && (
          <p className="text-sm text-amber-700 mb-3">
            Still needed before you can send: <strong>{missing.join(', ')}</strong>.
          </p>
        )}
        <div className="flex flex-wrap gap-3">
          <button onClick={sendPacket} disabled={!ready || working}
            className="px-5 py-2.5 rounded-xl text-sm font-bold text-white disabled:opacity-50" style={{ background: '#15803d' }}>
            {working ? 'Working…' : 'Send packet →'}
          </button>
          <button onClick={signInPerson} disabled={!ready || working}
            className="px-5 py-2.5 rounded-xl text-sm font-bold text-white disabled:opacity-50" style={{ background: '#2E6B8A' }}>
            ✍ Sign now (in person)
          </button>
          <Link href={backHref}
            className="px-5 py-2.5 rounded-xl text-sm font-semibold border border-gray-200 text-gray-600 hover:bg-gray-50">
            Back — don&rsquo;t send
          </Link>
        </div>
      </div>
    </div>
  )
}
