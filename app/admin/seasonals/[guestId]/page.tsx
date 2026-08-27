'use client'
import { useCallback, useEffect, useState } from 'react'
import { useParams, useRouter } from 'next/navigation'
import Link from 'next/link'
import { planAtLeast } from '@/lib/plan'
import { currentSeasonYear } from '@/lib/season'
import SeasonalSections from '../SeasonalSections'
import AddressEditor from '../AddressEditor'
import RigEditor from '../RigEditor'
import PartyEditor from '../PartyEditor'
import toast, { Toaster } from 'react-hot-toast'
import type { SeasonalGuestData, SeasonalContract, SeasonalGuest } from '@/lib/seasonal-types'
import type { Rig } from '../RigEditor'
import type { Address } from '../AddressEditor'
import { createBrowserSupabase } from '@/lib/supabase-browser'

// PR 5b-1: the admin browser now talks to Supabase as the LOGGED-IN USER rather than as
// `anon`. Same publishable key, but it travels with the session cookie, so PostgREST runs
// these queries as `authenticated` and the role policies in
// db/migrations/2026-08-11-pr5b1-authenticated-role-policies.sql apply. Safe at module
// scope: createBrowserClient returns a singleton in the browser and a no-op cookie store
// during prerender.
const supabase = createBrowserSupabase()

type Occupant = { name: string; kind: 'adult' | 'child' }

export default function SeasonalCamperPage() {
  const params = useParams()
  const router = useRouter()
  const guestId = params.guestId as string
  const cy = currentSeasonYear()
  const [year, setYear] = useState(cy)   // the season being viewed/acted on — a forced, visible choice

  const [data, setData] = useState<SeasonalGuestData | null>(null)
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState('')

  // Rig editor
  const [rigOpen, setRigOpen] = useState(false)
  const [rig, setRig] = useState<Rig>({})
  const [savingRig, setSavingRig] = useState(false)

  // Home address editor (writes to guests). Required for seasonal campers.
  const [addrOpen, setAddrOpen] = useState(false)
  const [addr, setAddr] = useState<Address>({})
  const [savingAddr, setSavingAddr] = useState(false)

  // Party ROSTER editor (writes to guests.party). Standing camper info, exactly like rig and
  // address above — NOT the per-contract `occupants` edited in the send modal further down.
  const [partyOpen, setPartyOpen] = useState(false)
  const [party, setParty] = useState<Occupant[]>([])
  const [savingParty, setSavingParty] = useState(false)

  const [removing, setRemoving] = useState(false)

  // Notes
  const [note, setNote] = useState('')
  const [savingNote, setSavingNote] = useState(false)

  // Send-packet modal
  const [modal, setModal] = useState(false)
  const [draft, setDraft] = useState<SeasonalContract | null>(null)
  const [occupants, setOccupants] = useState<Occupant[]>([])
  const [totalDue, setTotalDue] = useState('')
  const [chargeNote, setChargeNote] = useState('')   // CUSTOMER-FACING — prints on the contract
  const [opens, setOpens] = useState('')
  const [closes, setCloses] = useState('')
  const [working, setWorking] = useState(false)
  const [sendResult, setSendResult] = useState<{ emailed: boolean; error?: string } | null>(null)

  useEffect(() => {
    supabase.from('settings').select('plan').single().then(({ data }) => {
      if (!planAtLeast(data?.plan, 'summit')) router.replace('/admin')
    })
  }, [router])

  // useCallback so the effect can declare it, and because the send/resend/save flows all re-run
  // it after a successful write.
  const load = useCallback(async () => {
    setLoading(true); setErr('')
    try {
      const res = await fetch(`/api/seasonals/guest/${guestId}?year=${year}`)
      const d = await res.json()
      if (!res.ok) setErr(d.error || 'Could not load camper.')
      else { setData(d); setRig({ ...d.guest }); setAddr({ ...d.guest }); setParty(Array.isArray(d.guest?.party) ? d.guest.party : []) }
    } catch { setErr('Could not load camper.') }
    setLoading(false)
  }, [guestId, year])
  useEffect(() => { void load() }, [load])

  async function saveRig() {
    setSavingRig(true)
    const { error } = await supabase.from('guests').update({
      camper_type: rig.camper_type || null,
      camper_length: rig.camper_length ? parseInt(String(rig.camper_length), 10) : null,
      camper_amperage: rig.camper_amperage || null,
      camper_make: rig.camper_make || null,
      camper_model: rig.camper_model || null,
      camper_year: rig.camper_year ? parseInt(String(rig.camper_year), 10) : null,
    }).eq('id', guestId)
    setSavingRig(false)
    if (error) { toast.error('Could not save rig: ' + error.message); return } // keep the editor open
    setRigOpen(false); await load()
  }

  async function saveAddr() {
    setSavingAddr(true)
    const { error } = await supabase.from('guests').update({
      home_street: addr.home_street?.trim() || null,
      home_city: addr.home_city?.trim() || null,
      home_state: addr.home_state?.trim() || null,
      home_zip: addr.home_zip?.trim() || null,
    }).eq('id', guestId)
    setSavingAddr(false)
    if (error) { toast.error('Could not save address: ' + error.message); return } // keep the editor open
    setAddrOpen(false); await load()
  }

  // Saves the STANDING roster onto the guest, the same shape as saveRig/saveAddr above.
  //
  // ⚠ THIS DOES NOT REACH AN ALREADY-SENT PACKET, AND THAT IS THE POINT. A sent packet is a
  // frozen legal document: its occupants were copied onto the contract at send and nothing here
  // rewrites them. The roster is what the NEXT draft is seeded from. To change the party on a
  // packet that has gone out but is not yet signed, use “Cancel packet”, edit, and send again.
  //
  // Blank rows are dropped on save rather than stored: an unnamed occupant is a half-typed row,
  // and the contract renderer would silently discard it anyway (buildContractVars filters empty
  // names) — so the roster and the contract agree about who is on it.
  async function saveParty() {
    setSavingParty(true)
    const cleaned = party
      .map(o => ({ name: (o.name || '').trim(), kind: o.kind === 'child' ? 'child' as const : 'adult' as const }))
      .filter(o => o.name)
    const { error } = await supabase.from('guests').update({ party: cleaned }).eq('id', guestId)
    setSavingParty(false)
    if (error) { toast.error('Could not save party: ' + error.message); return } // keep the editor open
    setParty(cleaned); setPartyOpen(false); await load()
  }

  // Remove from the Seasonals roster — just unchecks is_seasonal. Keeps the guest
  // and ALL their records (contracts, signatures, billing); reversible from the
  // guest directory. Not a delete.
  async function removeFromSeasonals() {
    const who = data?.guest?.name || 'this camper'
    if (!confirm(`Remove ${who} from the Seasonals list?\n\nThis only unchecks “Seasonal” — all their records (contracts, signatures, billing) are kept, and you can re-add them anytime from the guest directory.`)) return
    setRemoving(true)
    const { error } = await supabase.from('guests').update({ is_seasonal: false }).eq('id', guestId)
    setRemoving(false)
    if (error) { toast.error('Could not remove: ' + error.message); return }
    toast.success(`${who} removed from seasonals.`)
    router.push('/admin/seasonals')
  }

  async function addNote() {
    if (!note.trim()) return
    setSavingNote(true)
    const res = await fetch('/api/guest-notes', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ guest_id: guestId, body: note.trim() }),
    })
    setSavingNote(false)
    if (!res.ok) {
      let msg = 'Could not add note.'
      try { const e = await res.json(); if (e?.error) msg = 'Could not add note: ' + e.error } catch {}
      toast.error(msg + ' Your note was kept — try again.') // note text deliberately NOT cleared
      return
    }
    setNote(''); await load()
  }

  async function openSendModal() {
    // Backstop against an off-year send: the year is already visible in the picker
    // and the button, but confirm if it deviates from the computed current season.
    if (year !== cy && !window.confirm(`Creating a ${year} contract — the current season is ${cy}. Is that right?`)) return
    setWorking(true); setSendResult(null)
    const res = await fetch('/api/seasonal-contracts/create', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ guest_id: guestId, season_year: year }),
    })
    const d = await res.json()
    setWorking(false)
    if (!res.ok) { setErr(d.error || 'Could not open packet.'); return }
    const c = d.contract
    setDraft(c)
    setOccupants(Array.isArray(c.occupants) ? c.occupants : [])
    setTotalDue(c.total_due_cents != null ? (c.total_due_cents / 100).toFixed(2) : '')
    setChargeNote(c.charge_note || '')
    setOpens(c.season_opens || '')
    setCloses(c.season_closes || '')
    setModal(true)
  }

  async function saveAndSend() {
    if (!draft) return
    setWorking(true); setSendResult(null)
    // 1) Persist the staff-edited fields FIRST. Send FREEZES the contract into a
    // legal document, so if this save fails we ABORT — never send on top of unsaved
    // edits (that would freeze wrong data). Editor stays open; nothing is sent.
    const saveRes = await fetch(`/api/seasonal-contracts/${draft.id}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        occupants,
        total_due_cents: totalDue ? Math.round(parseFloat(totalDue) * 100) : null,
        charge_note: chargeNote.trim() || null,
        season_opens: opens || null,
        season_closes: closes || null,
      }),
    })
    if (!saveRes.ok) {
      let msg = 'Could not save the edits — packet NOT sent.'
      try { const e = await saveRes.json(); if (e?.error) msg = `Could not save the edits (${e.error}) — packet NOT sent.` } catch {}
      setWorking(false)
      toast.error(msg)
      return
    }
    // 2) Edits are confirmed saved → only now freeze + send.
    const res = await fetch(`/api/seasonal-contracts/${draft.id}/send`, { method: 'POST' })
    const d = await res.json()
    setWorking(false)
    if (!res.ok || !d.ok) { setSendResult({ emailed: false, error: d.error || 'Send failed.' }); return }
    // Packet is committed (emailed or not) → close the modal; the banner + reloaded
    // status show the outcome, and a failed email can be retried with Resend.
    setSendResult({ emailed: !!d.emailed, error: d.error || undefined })
    setModal(false)
    await load()
  }

  // Retract a sent-but-unsigned packet. The route voids the packet's signature rows (killing the
  // camper's link) and puts the contract back to 'draft' — so after load() the header shows the
  // green “Send … packet” button again and the normal send modal handles the re-send. No separate
  // re-send UI is needed, and freezePacket mints a brand-new packet_id when it runs.
  async function cancelPacket() {
    const id = data?.currentContract?.id
    if (!id) return
    if (!window.confirm(
      `Cancel the ${year} packet?\n\n` +
      `The link already emailed to ${data?.guest?.name || 'this camper'} will stop working, and the packet goes back to a draft you can edit.\n\n` +
      `You will need to send it again afterwards. Anything already signed is not affected.`
    )) return
    setWorking(true); setSendResult(null)
    const res = await fetch(`/api/seasonal-contracts/${id}/cancel`, { method: 'POST' })
    const d = await res.json().catch(() => ({}))
    setWorking(false)
    if (!res.ok || !d.ok) { toast.error(d.error || 'Could not cancel the packet.'); return }
    toast.success('Packet canceled — the camper\u2019s link no longer works. Edit and send again when ready.')
    await load()
  }

  async function resend() {
    if (!data?.currentContract?.id) return
    setWorking(true)
    const res = await fetch(`/api/seasonal-contracts/${data.currentContract.id}/resend`, { method: 'POST' })
    const d = await res.json()
    setWorking(false)
    setSendResult({ emailed: !!d.emailed, error: d.error || undefined })
  }

  if (loading) return <div className="p-6 text-gray-500">Loading…</div>
  if (err && !data) return <div className="p-6 text-red-600">{err}</div>

  const current = data?.currentContract
  const status = current?.status || 'none'
  const g: SeasonalGuest = data?.guest || { id: '' }
  const hasAddress = !!(g.home_street && g.home_city && g.home_state && g.home_zip)
  const roster: Occupant[] = Array.isArray(g.party) ? (g.party as Occupant[]) : []

  return (
    <div className="p-4 md:p-6 max-w-3xl">
      <Toaster />
      <div className="flex items-center justify-between mb-4 flex-wrap gap-2">
        <div>
          <Link href="/admin/seasonals" className="text-sm text-gray-400 hover:text-gray-600">← Seasonals</Link>
          <h2 className="text-2xl font-bold text-gray-900">{data?.guest?.name}</h2>
          <p className="text-sm text-gray-500">Site {data?.guest?.site_number || '—'} · {year} season</p>
        </div>
        <div className="flex items-center gap-2">
          <Link href={`/admin/seasonals/new?guestId=${guestId}`} className="px-3 py-2 rounded-lg text-sm font-semibold border border-gray-200 text-gray-600 hover:bg-gray-50">↗ Full form</Link>
          <label className="text-xs font-medium text-gray-500">Season</label>
          <select value={year} onChange={e => setYear(parseInt(e.target.value))}
            className="border border-gray-200 rounded-lg px-3 py-2 text-sm font-bold text-gray-900">
            {[cy - 1, cy, cy + 1].map(y => <option key={y} value={y}>{y}</option>)}
          </select>
          {status === 'signed'
            ? <span className="px-4 py-2 rounded-lg text-sm font-semibold" style={{ background: '#f0fdf4', color: '#15803d' }}>✓ Packet signed</span>
            : status === 'sent'
              ? <>
                  <button onClick={resend} disabled={working} className="px-4 py-2 rounded-lg text-sm font-semibold text-white disabled:opacity-50" style={{ background: '#2E6B8A' }}>{working ? '…' : '↻ Resend email'}</button>
                  {/* Quiet outline, not a red fill: this is reversible by sending again, not a delete. */}
                  <button onClick={cancelPacket} disabled={working}
                    className="px-4 py-2 rounded-lg text-sm font-semibold border disabled:opacity-50"
                    style={{ borderColor: '#fecaca', color: '#b91c1c', background: '#fff' }}>
                    {working ? '…' : 'Cancel packet'}
                  </button>
                </>
              : <button onClick={openSendModal} disabled={working} className="px-4 py-2 rounded-lg text-sm font-bold text-white disabled:opacity-50" style={{ background: '#15803d' }}>{working ? '…' : `✉ Send ${year} packet`}</button>}
        </div>
      </div>

      {sendResult && (
        <div className="rounded-lg px-3 py-2 text-sm mb-3" style={sendResult.emailed ? { background: '#f0fdf4', color: '#15803d', border: '1px solid #bbf7d0' } : { background: '#fffbeb', color: '#b45309', border: '1px solid #fde68a' }}>
          {sendResult.emailed ? 'Packet emailed to the camper.' : `Packet created, but the email did not send${sendResult.error ? `: ${sendResult.error}` : ''}. Use “Resend email”.`}
        </div>
      )}

      {data && !hasAddress && (
        <div className="rounded-lg px-3 py-2 text-sm mb-3" style={{ background: '#fffbeb', color: '#b45309', border: '1px solid #fde68a' }}>
          ⚠ Home address required for seasonal campers — add it below. It prints on the contract and is the mailing fallback if email delivery fails.
        </div>
      )}

      {data && <SeasonalSections data={data} mode="admin" />}

      {/* Rig editor (writes to guests) */}
      <div className="bg-white rounded-xl border border-gray-100 p-5 mb-4">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-bold text-gray-400 uppercase tracking-wide">Edit rig (saved to the camper record)</h3>
          <button onClick={() => setRigOpen(o => !o)} className="text-sm font-semibold" style={{ color: 'var(--accent-color, #2E6B8A)' }}>{rigOpen ? 'Cancel' : 'Edit'}</button>
        </div>
        {rigOpen && (
          <div className="mt-3">
            <RigEditor value={rig} onChange={setRig} />
            <div className="mt-3">
              <button onClick={saveRig} disabled={savingRig} className="px-4 py-2 rounded-lg text-sm font-semibold text-white disabled:opacity-50" style={{ background: '#15803d' }}>{savingRig ? 'Saving…' : 'Save rig'}</button>
            </div>
          </div>
        )}
      </div>

      {/* Home address editor (writes to guests) — required for seasonal campers */}
      <div className="bg-white rounded-xl border p-5 mb-4" style={{ borderColor: hasAddress ? '#f3f4f6' : '#fde68a' }}>
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-bold uppercase tracking-wide" style={{ color: hasAddress ? '#9ca3af' : '#b45309' }}>
            Home address {hasAddress ? '(saved to the camper record)' : '· required'}
          </h3>
          <button onClick={() => setAddrOpen(o => !o)} className="text-sm font-semibold" style={{ color: 'var(--accent-color, #2E6B8A)' }}>{addrOpen ? 'Cancel' : 'Edit'}</button>
        </div>
        {!addrOpen && (
          <p className="text-sm mt-2" style={{ color: hasAddress ? '#374151' : '#9ca3af' }}>
            {hasAddress
              ? <>{g.home_street}<br />{[[g.home_city, g.home_state].filter(Boolean).join(', '), g.home_zip].filter(Boolean).join(' ')}</>
              : 'No address on file.'}
          </p>
        )}
        {addrOpen && (
          <div className="mt-3">
            <AddressEditor value={addr} onChange={setAddr} required />
            <div className="mt-3">
              <button onClick={saveAddr} disabled={savingAddr} className="px-4 py-2 rounded-lg text-sm font-semibold text-white disabled:opacity-50" style={{ background: '#15803d' }}>{savingAddr ? 'Saving…' : 'Save address'}</button>
            </div>
          </div>
        )}
      </div>

      {/* Party roster editor (writes to guests.party) — standing camper info, like rig/address.
          Editing here changes who is on the NEXT packet; it does not alter one already sent. */}
      <div className="bg-white rounded-xl border border-gray-100 p-5 mb-4">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-bold text-gray-400 uppercase tracking-wide">Party (saved to the camper record)</h3>
          <button onClick={() => { if (!partyOpen) setParty(Array.isArray(g.party) ? g.party as Occupant[] : []); setPartyOpen(o => !o) }} className="text-sm font-semibold" style={{ color: 'var(--accent-color, #2E6B8A)' }}>{partyOpen ? 'Cancel' : 'Edit'}</button>
        </div>
        {!partyOpen && (
          roster.length > 0
            ? <ul className="text-sm text-gray-700 mt-2 space-y-1">
                {roster.map((o, i) => (
                  <li key={i} className="flex justify-between"><span>{o.name || '—'}</span><span className="text-gray-400 capitalize">{o.kind || ''}</span></li>
                ))}
              </ul>
            : <p className="text-sm text-gray-400 mt-2">No one on the roster yet.</p>
        )}
        {partyOpen && (
          <div className="mt-3">
            <PartyEditor value={party} onChange={setParty} />
            <p className="text-xs text-gray-400 mt-1">
              This is the camper&rsquo;s standing party. It fills in the next packet you send — it does not change a packet that has already gone out.
            </p>
            <div className="mt-3">
              <button onClick={saveParty} disabled={savingParty} className="px-4 py-2 rounded-lg text-sm font-semibold text-white disabled:opacity-50" style={{ background: '#15803d' }}>{savingParty ? 'Saving…' : 'Save party'}</button>
            </div>
          </div>
        )}
      </div>

      {/* Add note (append-only) */}
      <div className="bg-white rounded-xl border border-gray-100 p-5 mb-4">
        <h3 className="text-sm font-bold text-gray-400 uppercase tracking-wide mb-2">Add a note</h3>
        <textarea value={note} onChange={e => setNote(e.target.value)} rows={2} placeholder="Add a note (append-only — can't be edited or deleted)" className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm" />
        <div className="mt-2"><button onClick={addNote} disabled={savingNote || !note.trim()} className="px-4 py-2 rounded-lg text-sm font-semibold text-white disabled:opacity-50" style={{ background: '#2E6B8A' }}>{savingNote ? 'Adding…' : 'Add note'}</button></div>
      </div>

      {/* Remove from seasonals — unchecks is_seasonal; keeps all records, reversible */}
      <div className="mb-4 flex justify-end">
        <button onClick={removeFromSeasonals} disabled={removing}
          className="px-4 py-2 rounded-lg text-sm font-semibold border disabled:opacity-50"
          style={{ borderColor: '#fecaca', color: '#b91c1c', background: '#fff' }}>
          {removing ? 'Removing…' : 'Remove from seasonals'}
        </button>
      </div>

      {/* Send-packet modal */}
      {modal && draft && (
        <>
          <div className="fixed inset-0 bg-black/50 z-50" onClick={() => !working && setModal(false)} />
          <div className="fixed inset-x-4 top-1/2 -translate-y-1/2 md:inset-x-auto md:left-1/2 md:-translate-x-1/2 md:w-[460px] bg-white rounded-2xl shadow-2xl z-50 overflow-hidden">
            <div className="px-6 py-4 border-b border-gray-100">
              <h3 className="text-lg font-bold text-gray-900">Send {year} packet</h3>
              <p className="text-sm text-gray-500 mt-0.5">{data?.guest?.name} · reviewed before sending</p>
            </div>
            <div className="px-6 py-4 space-y-4 max-h-[65vh] overflow-y-auto">
              <div>
                <PartyEditor value={occupants} onChange={setOccupants} />
                <p className="text-xs text-gray-400 mt-1">Prefilled from the camper&rsquo;s standing party. Changes here apply to this packet only.</p>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs text-gray-500 mb-1">Season opens</label>
                  <input type="date" value={opens || ''} onChange={e => setOpens(e.target.value)} className="w-full border border-gray-200 rounded-lg px-2 py-1.5 text-sm" />
                </div>
                <div>
                  <label className="block text-xs text-gray-500 mb-1">Season closes</label>
                  <input type="date" value={closes || ''} onChange={e => setCloses(e.target.value)} className="w-full border border-gray-200 rounded-lg px-2 py-1.5 text-sm" />
                </div>
              </div>
              <div>
                <label className="block text-xs text-gray-500 mb-1">Total due (display only, $)</label>
                <input type="number" step="0.01" value={totalDue} onChange={e => setTotalDue(e.target.value)} placeholder="0.00" className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm" />
              </div>
              <div>
                <label className="block text-xs text-gray-500 mb-1">Note about the charge (prints on the contract)</label>
                <textarea value={chargeNote} onChange={e => setChargeNote(e.target.value)} rows={3}
                  placeholder="e.g. Includes 2 extra family members, golf cart, and the second site."
                  className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm" />
                <p className="text-xs text-gray-400 mt-1">The camper sees this. It appears wherever the contract body uses <code>{'{{charge_note}}'}</code>.</p>
              </div>
              <p className="text-xs text-gray-400">Rig details are pulled from the camper record at send. Edit them above if needed before sending.</p>
              {sendResult && !sendResult.emailed && <div className="text-sm text-amber-700">{sendResult.error}</div>}
            </div>
            <div className="px-6 py-4 border-t border-gray-100 flex gap-3">
              <button onClick={() => setModal(false)} disabled={working} className="flex-1 py-2.5 rounded-xl text-sm font-semibold border border-gray-200 text-gray-600 hover:bg-gray-50">Cancel</button>
              <button onClick={saveAndSend} disabled={working} className="flex-1 py-2.5 rounded-xl text-sm font-bold text-white disabled:opacity-50" style={{ background: '#15803d' }}>{working ? 'Sending…' : 'Send packet →'}</button>
            </div>
          </div>
        </>
      )}
    </div>
  )
}
