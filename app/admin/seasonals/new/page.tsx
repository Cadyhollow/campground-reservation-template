'use client'
import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { planAtLeast } from '@/lib/plan'
import { currentSeasonYear } from '@/lib/season'
import { renderPacketDocuments } from '@/lib/contracts'
import AddressEditor, { type Address } from '../AddressEditor'
import RigEditor, { type Rig } from '../RigEditor'
import PartyEditor, { type Occupant } from '../PartyEditor'
import PacketPreview, { missingPacketFields } from '../PacketPreview'
import toast, { Toaster } from 'react-hot-toast'
import { createBrowserSupabase } from '@/lib/supabase-browser'
import type { SeasonalContract } from '@/lib/seasonal-types'

/** Only the two fields the preview reads off `settings`. */
type SeasonalSettings = { contract_text?: string | null; waiver_text?: string | null; plan?: string | null }

// PR 5b-1: the admin browser now talks to Supabase as the LOGGED-IN USER rather than as
// `anon`. Same publishable key, but it travels with the session cookie, so PostgREST runs
// these queries as `authenticated` and the role policies in
// db/migrations/2026-08-11-pr5b1-authenticated-role-policies.sql apply. Safe at module
// scope: createBrowserClient returns a singleton in the browser and a no-op cookie store
// during prerender.
const supabase = createBrowserSupabase()

// One-page "New Seasonal Camper" intake. Always creates a seasonal (is_seasonal via
// the consolidated guest route). Sections on one scroll: WHO / SETUP / CONTRACT
// (real rendered documents). End actions gate on contract-critical fields being
// filled AND the draft being prepared. Buttons are stubbed here — wired in Phase 3.
export default function NewSeasonalCamperPage() {
  const router = useRouter()
  const cy = currentSeasonYear()

  const [settings, setSettings] = useState<SeasonalSettings | null>(null)

  // WHO
  const [name, setName] = useState('')
  const [phone, setPhone] = useState('')
  const [email, setEmail] = useState('')
  const [addr, setAddr] = useState<Address>({})
  const [siteNumber, setSiteNumber] = useState('')
  // SETUP
  const [rig, setRig] = useState<Rig>({})
  const [occupants, setOccupants] = useState<Occupant[]>([])
  const [seasonYear, setSeasonYear] = useState(cy)
  const [seasonOpens, setSeasonOpens] = useState('')
  const [seasonCloses, setSeasonCloses] = useState('')
  // CONTRACT
  const [totalDue, setTotalDue] = useState('')
  const [chargeNote, setChargeNote] = useState('')   // CUSTOMER-FACING — prints on the contract

  const [draftId, setDraftId] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [existingId, setExistingId] = useState<string | null>(null)   // set when renewing an existing seasonal
  const [alreadyStatus, setAlreadyStatus] = useState<string | null>(null) // 'sent'|'signed' if one exists this year

  // Summit gate on the freshly-loaded plan; also grab the templates for the preview.
  useEffect(() => {
    supabase.from('settings').select('plan, contract_text, waiver_text, park_name').single().then(({ data }) => {
      if (!planAtLeast(data?.plan, 'summit')) { router.replace('/admin'); return }
      setSettings(data)
    })
  }, [router])

  // Existing seasonal (?guestId=…): prefill from the guest record; clone LAST YEAR's
  // contract party forward (always editable). Read from window.location so we don't
  // pull in useSearchParams (which would force a Suspense boundary).
  useEffect(() => {
    const gid = new URLSearchParams(window.location.search).get('guestId')
    if (!gid) return
    setExistingId(gid)
    fetch(`/api/seasonals/guest/${gid}?year=${cy}`)
      .then(r => r.json())
      .then(d => {
        const g = d?.guest
        if (!g) return
        setName(g.name || ''); setEmail(g.email || ''); setPhone(g.phone || ''); setSiteNumber(g.site_number || '')
        setAddr({ home_street: g.home_street, home_city: g.home_city, home_state: g.home_state, home_zip: g.home_zip })
        setRig({ camper_type: g.camper_type, camper_length: g.camper_length, camper_amperage: g.camper_amperage, camper_make: g.camper_make, camper_model: g.camper_model, camper_year: g.camper_year })
        if (g.season_start) setSeasonOpens(String(g.season_start).slice(0, 10))
        if (g.season_end) setSeasonCloses(String(g.season_end).slice(0, 10))
        // The STANDING roster wins over last year's contract: it is the more recently maintained
        // of the two, and it is what a NEW draft would be seeded from anyway (see
        // /api/seasonal-contracts/create). Last year's contract stays as the fallback so a camper
        // recorded before the roster existed still carries forward.
        const roster = Array.isArray(g.party) ? (g.party as Occupant[]) : []
        const lastYear = (d.contracts || []).find((c: SeasonalContract) => c.season_year === cy - 1)
        if (roster.length) setOccupants(roster)
        else if (lastYear && Array.isArray(lastYear.occupants) && lastYear.occupants.length) setOccupants(lastYear.occupants as Occupant[])
      })
      .catch(() => {})
    // `cy` is the season year this intake is for — it is read inside, so it belongs here. It is
    // computed once from currentSeasonYear() and does not change while the form is open, so this
    // still runs exactly once.
  }, [cy])

  // If any contract-relevant field changes after a draft was prepared, the draft is
  // stale — force a re-save before the action buttons re-enable.
  function invalidateDraft() { if (draftId) setDraftId(null); if (alreadyStatus) setAlreadyStatus(null) }

  const totalDueCents = totalDue ? Math.round(parseFloat(totalDue) * 100) : null

  // Live preview — the REAL documents, rendered exactly as freezePacket would.
  const previewGuest = {
    name, site_number: siteNumber,
    season_start: seasonOpens || null, season_end: seasonCloses || null,
    camper_make: rig.camper_make, camper_model: rig.camper_model, camper_year: rig.camper_year == null ? null : Number(rig.camper_year),
    home_street: addr.home_street, home_city: addr.home_city, home_state: addr.home_state, home_zip: addr.home_zip,
  }
  const previewContract = {
    season_year: seasonYear, site_number: siteNumber,
    season_opens: seasonOpens || null, season_closes: seasonCloses || null,
    occupants, total_due_cents: totalDueCents, charge_note: chargeNote,
    camper_make: rig.camper_make, camper_model: rig.camper_model, camper_year: rig.camper_year == null ? null : Number(rig.camper_year),
  }
  // The preview renders through renderPacketDocuments — the SAME function freezePacket calls, so
  // what is shown below cannot drift from what is actually frozen. (It also omits the settings
  // argument to buildContractVars for the reason documented there: the dormant season-dates tier.)
  //
  // Note this screen previews a camper who may not exist yet, so the "guest" it renders from is
  // the form's own fields rather than a saved row. That is unchanged from before the extraction —
  // and it is what the owner is about to save, so it is the right source here.
  const { contractText, waiverText } = renderPacketDocuments(previewGuest, previewContract, settings)

  // Contract-critical fields — the source-level guard against a blank freeze. Shared with the
  // review screen so both block a send on identical conditions.
  const missing = missingPacketFields({
    name, siteNumber,
    seasonOpens, seasonCloses,
    homeStreet: addr.home_street, homeCity: addr.home_city, homeState: addr.home_state, homeZip: addr.home_zip,
    contractText, waiverText,
  })
  const ready = missing.length === 0

  async function prepareDraft(): Promise<string | null> {
    setSaving(true)
    // 1) Persist the full guest FIRST. On failure, stop — no half-created state.
    const gRes = await fetch('/api/seasonals/guest', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: existingId || undefined,   // update the existing guest, don't create a duplicate
        name, email, phone, site_number: siteNumber,
        season_start: seasonOpens || null, season_end: seasonCloses || null,
        // The party typed here becomes the camper's STANDING roster, alongside their address and
        // rig — this form is the full camper record, not a per-contract editor. The send modal on
        // the camper page is the per-contract one, and deliberately does NOT write back here.
        party: occupants,
        ...addr, ...rig,
      }),
    })
    const gData = await gRes.json()
    if (!gRes.ok || !gData.guest) { setSaving(false); toast.error(gData.error || 'Could not save the camper.'); return null }
    const guestId = gData.guest.id

    // 2) Create the draft (guest now exists), then save the staff-edited contract fields.
    const cRes = await fetch('/api/seasonal-contracts/create', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ guest_id: guestId, season_year: seasonYear }),
    })
    const cData = await cRes.json()
    if (!cRes.ok || !cData.contract) { setSaving(false); toast.error(cData.error || 'Could not create the contract draft.'); return null }
    // Idempotent create returns an existing row — if it's already sent/signed this
    // year, we can't re-freeze it. Surface that instead of erroring.
    if (cData.contract.status !== 'draft') {
      setSaving(false)
      setAlreadyStatus(cData.contract.status)
      toast(`This camper already has a ${cData.contract.status} ${seasonYear} contract.`)
      return null
    }
    const id = cData.contract.id

    const pRes = await fetch(`/api/seasonal-contracts/${id}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        occupants,
        total_due_cents: totalDueCents,
        charge_note: chargeNote.trim() || null,
        season_opens: seasonOpens || null,
        season_closes: seasonCloses || null,
      }),
    })
    if (!pRes.ok) { const e = await pRes.json().catch(() => ({})); setSaving(false); toast.error(e.error || 'Could not save contract details.'); return null }

    setDraftId(id)
    setSaving(false)
    toast.success('Camper saved and contract ready — choose Sign now or Send packet.')
    return id
  }

  // Sign in person: freeze (no email), then hand the iPad to the camper on the
  // signing page. kiosk=1 tells the packet page to return here after signing
  // instead of leaving the sign URL in the shared browser (bearer-secret hygiene).
  async function onSignNow() {
    if (!draftId) return
    setSaving(true)
    const res = await fetch(`/api/seasonal-contracts/${draftId}/sign-now`, { method: 'POST' })
    const d = await res.json()
    setSaving(false)
    if (!res.ok || !d.packet_id) { toast.error(d.error || 'Could not open the signing page.'); return }
    router.push(`/packet/${d.packet_id}?kiosk=1`)
  }

  // Send the remote packet via the existing send flow (freeze + invite email).
  async function onSendPacket() {
    if (!draftId) return
    setSaving(true)
    const res = await fetch(`/api/seasonal-contracts/${draftId}/send`, { method: 'POST' })
    const d = await res.json()
    setSaving(false)
    if (!res.ok || !d.ok) { toast.error(d.error || 'Could not send the packet.'); return }
    if (d.emailed) toast.success('Packet emailed to the camper.')
    else toast('Packet created, but the email did not send — resend from the camper page.', { icon: '⚠️' })
    router.push('/admin/seasonals')
  }

  const cardCls = 'bg-white rounded-xl border border-gray-100 p-5 mb-4'
  const inp = 'w-full border border-gray-200 rounded-lg px-3 py-2 text-sm'
  const lbl = 'block text-xs text-gray-500 mb-1'

  return (
    <div className="p-4 md:p-6 max-w-3xl">
      <Toaster />
      <div className="mb-4">
        <Link href="/admin/seasonals" className="text-sm text-gray-400 hover:text-gray-600">← Seasonals</Link>
        <h2 className="text-2xl font-bold text-gray-900">{existingId ? 'Seasonal Camper' : 'New Seasonal Camper'}</h2>
        <p className="text-sm text-gray-500">One form — enter their details, then sign in person or email the packet.</p>
      </div>

      {existingId && (
        <div className="rounded-lg px-3 py-2 text-sm mb-3" style={{ background: '#eff6ff', color: '#1d4ed8', border: '1px solid #bfdbfe' }}>
          Renewing an existing seasonal — details pre-filled from their record, party carried over from last year. Review and adjust as needed.
        </div>
      )}
      {alreadyStatus && (
        <div className="rounded-lg px-3 py-2 text-sm mb-3" style={{ background: '#fffbeb', color: '#b45309', border: '1px solid #fde68a' }}>
          This camper already has a <strong>{alreadyStatus}</strong> {seasonYear} contract.{' '}
          {existingId && <Link href={`/admin/seasonals/${existingId}`} className="underline font-semibold">View it</Link>} — or pick a different season year above.
        </div>
      )}

      {/* WHO */}
      <div className={cardCls}>
        <h3 className="text-sm font-bold text-gray-400 uppercase tracking-wide mb-3">Who</h3>
        <div className="grid grid-cols-2 gap-3">
          <div className="col-span-2"><label className={lbl}>Name <span className="text-red-500">*</span></label><input value={name} onChange={e => { setName(e.target.value); invalidateDraft() }} className={inp} /></div>
          <div><label className={lbl}>Phone</label><input value={phone} onChange={e => setPhone(e.target.value)} className={inp} /></div>
          <div><label className={lbl}>Email</label><input value={email} onChange={e => setEmail(e.target.value)} className={inp} placeholder="For the packet / signed copy" /></div>
          <div className="col-span-2"><label className={lbl}>Site <span className="text-red-500">*</span></label><input value={siteNumber} onChange={e => { setSiteNumber(e.target.value); invalidateDraft() }} className={inp} /></div>
        </div>
        <div className="mt-3">
          <p className="text-xs font-bold text-gray-400 uppercase tracking-wide mb-2">Home address <span className="text-red-500">*</span></p>
          <AddressEditor value={addr} onChange={v => { setAddr(v); invalidateDraft() }} required />
        </div>
      </div>

      {/* SETUP */}
      <div className={cardCls}>
        <h3 className="text-sm font-bold text-gray-400 uppercase tracking-wide mb-3">Setup</h3>
        <p className="text-xs font-bold text-gray-400 uppercase tracking-wide mb-2">Rig</p>
        <RigEditor value={rig} onChange={v => { setRig(v); invalidateDraft() }} />
        <div className="mt-4"><PartyEditor value={occupants} onChange={v => { setOccupants(v); invalidateDraft() }} /></div>
        <div className="grid grid-cols-3 gap-3 mt-4">
          <div>
            <label className={lbl}>Season year</label>
            <select value={seasonYear} onChange={e => { setSeasonYear(parseInt(e.target.value)); invalidateDraft() }} className={`${inp} font-bold`}>
              {[cy - 1, cy, cy + 1].map(y => <option key={y} value={y}>{y}</option>)}
            </select>
          </div>
          <div><label className={lbl}>Season opens <span className="text-red-500">*</span></label><input type="date" value={seasonOpens} onChange={e => { setSeasonOpens(e.target.value); invalidateDraft() }} className={inp} /></div>
          <div><label className={lbl}>Season closes <span className="text-red-500">*</span></label><input type="date" value={seasonCloses} onChange={e => { setSeasonCloses(e.target.value); invalidateDraft() }} className={inp} /></div>
        </div>
      </div>

      {/* CONTRACT */}
      <div className={cardCls}>
        <h3 className="text-sm font-bold text-gray-400 uppercase tracking-wide mb-3">Contract</h3>
        <div className="mb-3">
          <label className={lbl}>Total due (display only, $)</label>
          <input type="number" step="0.01" value={totalDue} onChange={e => { setTotalDue(e.target.value); invalidateDraft() }} placeholder="0.00" className={`${inp} max-w-[200px]`} />
        </div>
        <div className="mb-3">
          <label className={lbl}>Note about the charge (prints on the contract)</label>
          <textarea value={chargeNote} onChange={e => { setChargeNote(e.target.value); invalidateDraft() }} rows={3}
            placeholder="e.g. Includes 2 extra family members, golf cart, and the second site."
            className={inp} />
          <p className="text-xs text-gray-400 mt-1">The camper sees this. It appears in the preview below wherever the contract body uses <code>{'{{charge_note}}'}</code>.</p>
        </div>
        <p className="text-xs text-gray-500 mb-2">This is exactly what the camper will see and sign:</p>
        <PacketPreview guest={previewGuest} contract={previewContract} settings={settings} />
      </div>

      {/* ACTIONS */}
      <div className={cardCls}>
        {!ready && (
          <p className="text-sm text-amber-700 mb-3">Still needed before you can sign or send: <strong>{missing.join(', ')}</strong>.</p>
        )}
        {ready && !draftId && (
          <p className="text-sm text-gray-500 mb-3">Ready. Save to prepare the contract, then sign in person or send the packet.</p>
        )}
        {draftId && <p className="text-sm text-green-700 mb-3">Contract prepared. Choose an action below.</p>}
        <div className="flex flex-wrap gap-3">
          <button onClick={prepareDraft} disabled={!ready || saving || !!draftId}
            className="px-5 py-2.5 rounded-xl text-sm font-bold text-white disabled:opacity-50" style={{ background: '#2E6B8A' }}>
            {saving ? 'Saving…' : draftId ? 'Saved ✓' : 'Save camper & prepare contract'}
          </button>
          <button onClick={onSignNow} disabled={!draftId || saving}
            className="px-5 py-2.5 rounded-xl text-sm font-bold text-white disabled:opacity-50" style={{ background: '#15803d' }}>
            ✍ Sign now (in person)
          </button>
          <button onClick={onSendPacket} disabled={!draftId || saving}
            className="px-5 py-2.5 rounded-xl text-sm font-bold text-white disabled:opacity-50" style={{ background: '#15803d' }}>
            ✉ Send packet
          </button>
        </div>
      </div>
    </div>
  )
}
