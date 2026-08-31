'use client'
import { useCallback, useEffect, useState } from 'react'
import { useParams, useRouter } from 'next/navigation'
import Link from 'next/link'
import { planAtLeast } from '@/lib/plan'
import { sortSeasonsForPicker } from '@/lib/season'
import SeasonPicker, { useSeasons } from '../SeasonPicker'
import SeasonalSections from '../SeasonalSections'
import PartyEditor from '../PartyEditor'
import {
  depositView, depositSummary, enrollmentStatus, ENROLLMENT_LABEL, ENROLLMENT_TONE,
} from '@/lib/seasonal-directory'
import {
  guestFormFrom, guestPatchFrom, GUEST_FIELD_GROUPS, type GuestRecordForm,
} from '@/lib/guest-record'
import toast, { Toaster } from 'react-hot-toast'
import type { SeasonalGuestData, SeasonalGuest } from '@/lib/seasonal-types'
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
  // Phase 2c: the SEASON being viewed/acted on — a forced, visible choice, and what decides which
  // contract this page shows and sends. Replaces the year picker.
  const { seasons, loaded: seasonsLoaded, defaultId } = useSeasons()
  const [seasonId, setSeasonId] = useState('')

  const [data, setData] = useState<SeasonalGuestData | null>(null)
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState('')

  // PERSONAL INFORMATION — one editor over the one `guests` row.
  //
  // This replaces the separate rig and home-address cards. They wrote the same row through two
  // hand-built field lists, which is the drift lib/guest-record.ts exists to end: the fields, the
  // grouping and the normalisation all come from there now, and the Guest Directory builds its
  // patch with the same function. Editing a phone number here and editing it there are the same
  // write to the same row — which is why the two screens can never disagree.
  const [personalOpen, setPersonalOpen] = useState(false)
  const [personal, setPersonal] = useState<GuestRecordForm>(guestFormFrom(null))
  const [savingPersonal, setSavingPersonal] = useState(false)

  // Active / inactive, and enrolment. `active` is seeded from the loaded row and defaults to
  // true on a park that has not run the seasonal_active migration — matching the column default.
  const [active, setActive] = useState(true)
  const [togglingActive, setTogglingActive] = useState(false)
  const [enrolling, setEnrolling] = useState(false)
  // Which season the "Add to season" dropdown is pointed at. Its own state, NOT the page's season
  // picker: the picker decides what you are LOOKING at, this decides what you are adding them to.
  const [addSeasonId, setAddSeasonId] = useState('')

  // Party ROSTER editor (writes to guests.party). Standing camper info, exactly like rig and
  // address above — NOT the per-contract `occupants` edited on the review screen at ./review.
  const [partyOpen, setPartyOpen] = useState(false)
  const [party, setParty] = useState<Occupant[]>([])
  const [savingParty, setSavingParty] = useState(false)

  const [removing, setRemoving] = useState(false)

  // Notes
  const [note, setNote] = useState('')
  const [savingNote, setSavingNote] = useState(false)

  // The send outcome, still read from the query string: the review screen returns HERE after a
  // send, so the banner stays even though the send button itself has moved to Contracts.
  const [sendResult, setSendResult] = useState<{ emailed: boolean; error?: string } | null>(null)

  useEffect(() => {
    supabase.from('settings').select('plan').single().then(({ data }) => {
      if (!planAtLeast(data?.plan, 'summit')) router.replace('/admin')
    })
  }, [router])

  // useCallback so the effect can declare it, and because the send/resend/save flows all re-run
  // it after a successful write.
  // An incoming ?season_id= is the season the owner was already looking at on the list, so it
  // wins over the picker's computed default. Read in an effect (not a lazy initializer) for the
  // same hydration reason the rest of this area does.
  const [urlSeasonId, setUrlSeasonId] = useState<string | null>(null)
  useEffect(() => {
    setUrlSeasonId(new URLSearchParams(window.location.search).get('season_id') || '')
  }, [])
  useEffect(() => {
    if (seasonId || urlSeasonId === null) return          // wait until the URL has been read
    if (urlSeasonId) setSeasonId(urlSeasonId)             // the season they came in on
    else if (defaultId) setSeasonId(defaultId)            // otherwise the picker's default
  }, [defaultId, seasonId, urlSeasonId])

  const load = useCallback(async () => {
    setLoading(true); setErr('')
    try {
      const res = await fetch(`/api/seasonals/guest/${guestId}?season_id=${encodeURIComponent(seasonId)}`)
      const d = await res.json()
      if (!res.ok) setErr(d.error || 'Could not load camper.')
      else {
        setData(d)
        setPersonal(guestFormFrom(d.guest as Record<string, unknown>))
        setActive((d.guest as { seasonal_active?: boolean })?.seasonal_active !== false)
        setParty(Array.isArray(d.guest?.party) ? d.guest.party : [])
      }
    } catch { setErr('Could not load camper.') }
    setLoading(false)
  }, [guestId, seasonId])
  useEffect(() => { if (seasonsLoaded && seasonId) void load() }, [load, seasonsLoaded, seasonId])

  // The review screen sends, then returns here with the outcome on the query string — the modal
  // used to close in place and set this state directly. Read it once, show the same banner, and
  // strip the params so a refresh (or a back-navigation) doesn't re-announce a stale send.
  useEffect(() => {
    const q = new URLSearchParams(window.location.search)
    const sent = q.get('sent')
    if (sent === null) return
    setSendResult({ emailed: sent === '1', error: q.get('err') || undefined })
    router.replace(`/admin/seasonals/${guestId}`)
  }, [router, guestId])

  // ONE SAVE FOR THE WHOLE RECORD, through the shared patch builder.
  //
  // ⚠ WHAT THIS DELIBERATELY DOES NOT TOUCH: is_seasonal, seasonal_active, and the party roster.
  // guestPatchFrom() omits all three, so correcting a phone number can never un-flag a camper or
  // wipe their roster. Membership and active/inactive are their own deliberate actions below.
  //
  // ⚠ AND WHAT IT CANNOT REACH: a contract that has already been SENT or SIGNED. Those render
  // from `document_text` frozen onto their signature rows at send time — the packet route reads
  // that row and never re-renders — so a sent agreement is a fixed document whatever changes
  // here. A DRAFT has no signature rows yet and is rendered live at preview, so edits show up in
  // it. That boundary is what keeps the paperwork trustworthy, and it is structural rather than
  // something this screen has to remember.
  async function savePersonal() {
    if (!personal.name.trim()) { toast.error('A name is required.'); return }
    setSavingPersonal(true)
    const { error } = await supabase.from('guests').update(guestPatchFrom(personal)).eq('id', guestId)
    setSavingPersonal(false)
    if (error) { toast.error('Could not save: ' + error.message); return }  // keep the editor open
    setPersonalOpen(false); await load()
    toast.success('Saved to the camper record.')
  }

  // ENROLMENT — the fix for the vanishing camper.
  //
  // Reuses POST /api/seasonal-contracts/create rather than inserting here, because that route is
  // already idempotent and already handles losing the race on the (guest_id, season_id) unique
  // constraint. Clicking twice returns the existing draft; it never creates a second contract.
  async function addToSeason(targetSeasonId: string) {
    const season = seasons.find(x => x.id === targetSeasonId)
    if (!season) return
    setEnrolling(true)
    try {
      const res = await fetch('/api/seasonal-contracts/create', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ guest_id: guestId, season_year: season.year, season_id: season.id }),
      })
      const d = await res.json()
      if (!res.ok) toast.error(d.error || 'Could not add them to the season.')
      else {
        toast.success(d.created
          ? `Added to ${season.name} — set the fee and send from Contracts.`
          : `Already in ${season.name}.`)
        setAddSeasonId('')
        await load()
      }
    } catch { toast.error('Could not add them to the season.') }
    setEnrolling(false)
  }

  // Active / inactive. Its own endpoint and its own button — "they left the programme" is a
  // decision, never something that rides along on a typo correction.
  async function toggleActive(next: boolean) {
    setTogglingActive(true)
    try {
      const res = await fetch('/api/seasonals/campers', {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ guest_id: guestId, active: next }),
      })
      const d = await res.json()
      if (!res.ok) toast.error(d.error || 'Could not change that.')
      else { setActive(d.active); toast.success(next ? 'Marked active.' : 'Marked inactive — their history is kept.') }
    } catch { toast.error('Could not change that.') }
    setTogglingActive(false)
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

  // The draft send path. Phase 1.5 replaced the old modal — which showed the party, dates and
  // total but never the DOCUMENTS — with a full review screen that renders the real contract and
  // waiver before anything is frozen. This only navigates; the draft is created there.

  // Retract a sent-but-unsigned packet. The route voids the packet's signature rows (killing the
  // camper's link) and puts the contract back to 'draft' — so after load() the header shows the
  // green “Review & send …” button again and the normal review screen handles the re-send. No separate
  // re-send UI is needed, and freezePacket mints a brand-new packet_id when it runs.


  if (loading) return <div className="p-6 text-muted">Loading…</div>
  if (err && !data) return <div className="p-6 text-danger">{err}</div>

  const current = data?.currentContract
  const status = current?.status || 'none'
  const g: SeasonalGuest = data?.guest || { id: '' }
  const hasAddress = !!(g.home_street && g.home_city && g.home_state && g.home_zip)
  const roster: Occupant[] = Array.isArray(g.party) ? (g.party as Occupant[]) : []
  const selectedSeason = seasons.find(s => s.id === seasonId) || null
  // The two facts this release adds: where they stand with THIS season's paperwork, and how the
  // seasonal fee is actually being paid off. Both are read-only derivations — depositView only
  // arranges the lane totals /api/seasonals/guest already computed.
  const fmtMoney = (c: number) => (c < 0 ? '−$' : '$') + (Math.abs(c) / 100).toFixed(2)
  const enrollment = enrollmentStatus(current)
  const deposit = depositView(current, data?.lanes)
  const seasonLabel = selectedSeason?.name || (data?.year ? String(data.year) : 'this season')
  const memberSince = (data?.contracts || []).reduce<number | null>(
    (min, c) => (c.season_year != null && (min === null || c.season_year < min) ? c.season_year : min), null)
  const allYears = [...new Set((data?.contracts || []).map(c => c.season_year).filter(y => y != null))].sort()

  return (
    <div className="p-4 md:p-6 max-w-3xl">
      <Toaster />
      <div className="flex items-center justify-between mb-4 flex-wrap gap-2">
        <div>
          <Link href="/admin/seasonals/campers" className="text-sm text-muted hover:text-ink-soft">← Campers</Link>
          <h2 className="text-2xl font-bold text-ink">
            {data?.guest?.name}
            {!active && (
              <span className="ml-2 align-middle inline-block rounded-full bg-card-2 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-muted">
                Inactive
              </span>
            )}
          </h2>
          <p className="text-sm text-muted">
            Site {data?.guest?.site_number || '—'} · {seasonLabel}
            {memberSince != null && <> · member since {memberSince}</>}
          </p>
          {allYears.length > 0 && (
            <p className="text-xs text-muted mt-0.5">Seasons: {allYears.join(', ')}</p>
          )}
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <Link href={`/admin/seasonals/new?guestId=${guestId}${seasonId ? `&season_id=${encodeURIComponent(seasonId)}` : ''}`} className="px-3 py-2 rounded-lg text-sm font-semibold border border-line text-ink-soft hover:bg-card-2">↗ Full form</Link>
          <label className="text-xs font-medium text-muted">Season</label>
          <SeasonPicker seasons={seasons} value={seasonId} onChange={setSeasonId} disabled={!seasonsLoaded}
            className="border border-line rounded-lg px-3 py-2 text-sm font-bold text-ink" />
          {/* ⚠ NO SEND CONTROLS HERE — AND NO CONTRACT DOCUMENT.
              Reviewing, sending, resending and cancelling a packet all live on the Contracts page
              now, along with the document itself. This page is the PERSON: who they are, what they
              owe, and which seasons they are in. A link across is right; a second place to send
              the paperwork from is what made the two pages feel like the same page. */}
          <Link href={`/admin/seasonals${seasonId ? `?season_id=${encodeURIComponent(seasonId)}` : ''}`}
            className="px-3 py-2 rounded-lg text-sm font-semibold border border-line text-ink-soft hover:bg-card-2 whitespace-nowrap">
            Contracts &amp; sending →
          </Link>
        </div>
      </div>

      {sendResult && (
        <div className="rounded-lg px-3 py-2 text-sm mb-3" style={sendResult.emailed ? { background: 'var(--good-bg)', color: 'var(--good)', border: '1px solid color-mix(in srgb, var(--good) 35%, transparent)' } : { background: 'var(--watch-bg)', color: 'var(--watch)', border: '1px solid color-mix(in srgb, var(--watch) 40%, transparent)' }}>
          {sendResult.emailed ? 'Packet emailed to the camper.' : `Packet created, but the email did not send${sendResult.error ? `: ${sendResult.error}` : ''}. Resend it from the Contracts page.`}
        </div>
      )}

      {data && !hasAddress && (
        <div className="rounded-lg px-3 py-2 text-sm mb-3" style={{ background: 'var(--watch-bg)', color: 'var(--watch)', border: '1px solid color-mix(in srgb, var(--watch) 40%, transparent)' }}>
          ⚠ Home address required for seasonal campers — add it below. It prints on the contract and is the mailing fallback if email delivery fails.
        </div>
      )}

      {/* SEASONS — STATUS ONLY.
          One line per season this park runs, saying where this camper stands. Deliberately not a
          contract: no document, no draft text, no preview, no send. Those are the Contracts
          page's job, and duplicating them here is what made the two pages feel like one. */}
      {data && seasons.length > 0 && (
        <div className="bg-card rounded-xl border border-line-soft p-5 mb-4">
          <div className="flex items-center justify-between mb-3 gap-3 flex-wrap">
            <h3 className="text-sm font-bold text-muted uppercase tracking-wide">Seasons</h3>
            <Link href={`/admin/seasonals${seasonId ? `?season_id=${encodeURIComponent(seasonId)}` : ''}`}
              className="text-xs font-semibold" style={{ color: 'var(--link)' }}>
              Fees, sending &amp; documents →
            </Link>
          </div>
          <ul>
            {sortSeasonsForPicker(seasons).map(se => {
              const c = (data.contracts || []).find(x => x.season_id === se.id)
                     || (data.contracts || []).find(x => !x.season_id && x.season_year === se.year)
              const st = enrollmentStatus(c)
              const tone = ENROLLMENT_TONE[st]
              return (
                <li key={se.id} className="flex items-center justify-between gap-3 py-1.5 border-b border-line-soft last:border-b-0">
                  <span className="text-sm text-ink">{se.name}</span>
                  <span className={`shrink-0 rounded-full px-2.5 py-0.5 text-xs font-semibold ${
                    tone === 'good' ? 'bg-good-bg text-good'
                      : tone === 'watch' ? 'bg-watch-bg text-watch'
                      : tone === 'draft' ? 'bg-draft-bg text-draft'
                      : 'bg-card-2 text-muted'}`}>
                    {ENROLLMENT_LABEL[st]}
                  </span>
                </li>
              )
            })}
          </ul>
        </div>
      )}

      {/* DEPOSIT AND BALANCE — these campers pay a deposit in the fall and the balance in the
          spring, so those are the four numbers that matter at the counter. Nothing is recomputed:
          paid and balance ARE the seasonal lane's own totals. */}
      {data && current && (deposit.feeCents != null || deposit.depositDueCents != null) && (
        <div className="bg-card rounded-xl border border-line-soft p-5 mb-4">
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-sm font-bold text-muted uppercase tracking-wide">Seasonal fee · {seasonLabel}</h3>
            <span className={`inline-block rounded-full px-2.5 py-0.5 text-xs font-semibold ${
              ENROLLMENT_TONE[enrollment] === 'good' ? 'bg-good-bg text-good'
                : ENROLLMENT_TONE[enrollment] === 'watch' ? 'bg-watch-bg text-watch'
                : ENROLLMENT_TONE[enrollment] === 'draft' ? 'bg-draft-bg text-draft' : 'bg-danger-bg text-danger'}`}>
              {ENROLLMENT_LABEL[enrollment]}
            </span>
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            {([
              ['Season fee', deposit.feeCents, 'var(--ink)'],
              ['Deposit due', deposit.depositDueCents, 'var(--ink-soft)'],
              ['Paid', deposit.paidCents, 'var(--good)'],
              ['Balance', deposit.balanceCents, deposit.balanceCents && deposit.balanceCents > 0 ? 'var(--watch)' : 'var(--good)'],
            ] as [string, number | null, string][]).map(([label, cents, color]) => (
              <div key={label} className="rounded-lg bg-card-2 px-3 py-2">
                <p className="text-[11px] uppercase tracking-wide text-muted">{label}</p>
                <p className="tnum text-lg font-bold" style={{ color }}>
                  {cents == null ? '—' : (cents < 0 ? '−$' : '$') + (Math.abs(cents) / 100).toFixed(2)}
                </p>
              </div>
            ))}
          </div>
          <p className="text-sm text-ink-soft mt-3">{depositSummary(deposit)}</p>
          {deposit.depositDueCents == null && (
            <p className="text-xs text-muted mt-1">No deposit is stated on this agreement.</p>
          )}
          {/* ⚠ THE HONEST FOOTNOTE, AND IT MATTERS MORE THAN IT LOOKS.
              Every payment taken before lane tagging shipped is UNTAGGED: it is real money on the
              account, but it names no lane, and laneBalances deliberately does not guess one —
              guessing would rewrite a park's financial history. So "Paid $0.00" above can sit
              beside a camper who has plainly paid, and without this line an owner would read it
              as "they have paid nothing" and go and ask them for money they already sent. */}
          {data.lanes && data.lanes.untaggedPayments > 0 && (
            <p className="text-xs mt-2 rounded-lg px-3 py-2"
              style={{ background: 'var(--watch-bg)', color: 'var(--watch)' }}>
              <strong>{fmtMoney(data.lanes.untaggedPayments)}</strong> of payments on this account are not
              filed to a lane, so they are not counted in <em>Paid</em> above. That is every payment taken
              before payments could be tagged — the money is on the account, it just does not name the
              seasonal fee. The whole-account balance below is the complete picture.
            </p>
          )}
        </div>
      )}

      {data && <SeasonalSections data={data} mode="admin" />}

      {/* PERSONAL INFORMATION — one card over the one guests row. Replaces the separate rig and
          home-address editors, which wrote the same row through two hand-built field lists. */}
      <div className="bg-card rounded-xl border p-5 mb-4"
        style={{ borderColor: hasAddress ? 'var(--line-soft)' : 'color-mix(in srgb, var(--watch) 40%, transparent)' }}>
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-bold uppercase tracking-wide" style={{ color: hasAddress ? 'var(--muted)' : 'var(--watch)' }}>
            Personal information {hasAddress ? '' : '· home address required'}
          </h3>
          <button onClick={() => { if (!personalOpen) setPersonal(guestFormFrom(g as unknown as Record<string, unknown>)); setPersonalOpen(o => !o) }}
            className="text-sm font-semibold" style={{ color: 'var(--link)' }}>
            {personalOpen ? 'Cancel' : 'Edit'}
          </button>
        </div>

        {!personalOpen && (
          <div className="mt-3 grid gap-x-6 gap-y-1 sm:grid-cols-2">
            {GUEST_FIELD_GROUPS.flatMap(grp => grp.fields).map(f => {
              const v = (g as unknown as Record<string, unknown>)[f.key]
              const shown = v === null || v === undefined || v === '' ? '—' : String(v)
              return (
                <div key={f.key} className="flex justify-between gap-4 py-0.5 text-sm">
                  <span className="text-muted">{f.label}</span>
                  <span className="text-ink text-right">{shown}</span>
                </div>
              )
            })}
          </div>
        )}

        {personalOpen && (
          <div className="mt-3">
            {GUEST_FIELD_GROUPS.map(grp => (
              <div key={grp.title} className="mb-4">
                <p className="text-xs font-bold uppercase tracking-wide text-muted mb-2">{grp.title}</p>
                <div className="grid gap-3 sm:grid-cols-2">
                  {grp.fields.map(f => (
                    <div key={f.key} className={f.wide ? 'sm:col-span-2' : ''}>
                      <label className="block text-xs text-muted mb-1">{f.label}</label>
                      <input
                        type={f.type === 'number' ? 'number' : 'text'}
                        value={personal[f.key]}
                        onChange={e => setPersonal(prev => ({ ...prev, [f.key]: e.target.value }))}
                        className="w-full rounded-lg border border-line-strong bg-card px-3 py-2 text-sm text-ink"
                      />
                    </div>
                  ))}
                </div>
              </div>
            ))}
            <p className="text-xs text-muted mb-3">
              This is the camper&rsquo;s one record — the Guest Directory shows these same fields, because it is
              the same row. Saving updates any <strong>draft</strong> packet that renders from it; a packet
              already <strong>sent or signed</strong> is a frozen document and never changes.
            </p>
            <button onClick={savePersonal} disabled={savingPersonal}
              className="px-4 py-2 rounded-lg text-sm font-semibold text-on-good disabled:opacity-50"
              style={{ background: 'var(--good)' }}>
              {savingPersonal ? 'Saving…' : 'Save camper record'}
            </button>
          </div>
        )}
      </div>

      {/* Party roster editor (writes to guests.party) — standing camper info, like rig/address.
          Editing here changes who is on the NEXT packet; it does not alter one already sent. */}
      <div className="bg-card rounded-xl border border-line-soft p-5 mb-4">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-bold text-muted uppercase tracking-wide">Party (saved to the camper record)</h3>
          <button onClick={() => { if (!partyOpen) setParty(Array.isArray(g.party) ? g.party as Occupant[] : []); setPartyOpen(o => !o) }} className="text-sm font-semibold" style={{ color: 'var(--link)' }}>{partyOpen ? 'Cancel' : 'Edit'}</button>
        </div>
        {!partyOpen && (
          roster.length > 0
            ? <ul className="text-sm text-ink-soft mt-2 space-y-1">
                {roster.map((o, i) => (
                  <li key={i} className="flex justify-between"><span>{o.name || '—'}</span><span className="text-muted capitalize">{o.kind || ''}</span></li>
                ))}
              </ul>
            : <p className="text-sm text-muted mt-2">No one on the roster yet.</p>
        )}
        {partyOpen && (
          <div className="mt-3">
            <PartyEditor value={party} onChange={setParty} />
            <p className="text-xs text-muted mt-1">
              This is the camper&rsquo;s standing party. It fills in the next packet you send — it does not change a packet that has already gone out.
            </p>
            <div className="mt-3">
              <button onClick={saveParty} disabled={savingParty} className="px-4 py-2 rounded-lg text-sm font-semibold text-on-good disabled:opacity-50" style={{ background: 'var(--good)' }}>{savingParty ? 'Saving…' : 'Save party'}</button>
            </div>
          </div>
        )}
      </div>

      {/* Add note (append-only) */}
      <div className="bg-card rounded-xl border border-line-soft p-5 mb-4">
        <h3 className="text-sm font-bold text-muted uppercase tracking-wide mb-2">Add a note</h3>
        <textarea value={note} onChange={e => setNote(e.target.value)} rows={2} placeholder="Add a note (append-only — can't be edited or deleted)" className="w-full border border-line rounded-lg px-3 py-2 text-sm" />
        <div className="mt-2"><button onClick={addNote} disabled={savingNote || !note.trim()} className="px-4 py-2 rounded-lg text-sm font-semibold text-on-forest disabled:opacity-50" style={{ background: 'var(--forest)' }}>{savingNote ? 'Adding…' : 'Add note'}</button></div>
      </div>

      {/* ACTIVE / INACTIVE — "they left the programme", which is NOT the same as "remove from
          seasonals" beside it. Inactive keeps them in the Campers directory with all their
          history; removing un-flags them and takes them out of the seasonal screens entirely. */}
      <div className="bg-card rounded-xl border border-line-soft p-5 mb-4 flex items-center justify-between gap-4 flex-wrap">
        <div>
          <h3 className="text-sm font-bold text-muted uppercase tracking-wide">Programme status</h3>
          <p className="text-sm text-ink-soft mt-1">
            {active
              ? 'Active — a current seasonal camper.'
              : 'Inactive — they have left the programme. Their contracts, payments and readings are all kept.'}
          </p>
        </div>
        <button onClick={() => toggleActive(!active)} disabled={togglingActive}
          className="px-4 py-2 rounded-lg text-sm font-semibold border border-line bg-card text-ink-soft disabled:opacity-50 whitespace-nowrap">
          {togglingActive ? '…' : active ? 'Mark inactive' : 'Mark active'}
        </button>
      </div>

      {/* ADD TO SEASON — the ONE enrolment entry point on the camper side.
          Creating a camper makes the person only; it does not create a contract. This is where a
          person becomes enrolled: it creates their DRAFT contract for the season chosen, and that
          draft then appears on the Contracts page to have its fee set and be sent. The camper page
          starts it, the Contracts page finishes it.
          Idempotent by construction — POST /api/seasonal-contracts/create returns the existing row
          rather than a second one, so a double click cannot duplicate a contract. */}
      {data && seasons.length > 0 && (
        <div className="bg-card rounded-xl border border-line-soft p-5 mb-4">
          <h3 className="text-sm font-bold text-muted uppercase tracking-wide">Add to a season</h3>
          <p className="text-sm text-ink-soft mt-1 mb-3">
            Creates a draft contract for the season you choose. Nothing is sent — set the fee and
            send it from the Contracts page.
          </p>
          <div className="flex items-center gap-2 flex-wrap">
            <select value={addSeasonId} onChange={e => setAddSeasonId(e.target.value)}
              className="rounded-lg border border-line-strong bg-card px-3 py-2 text-sm text-ink">
              <option value="">Choose a season…</option>
              {sortSeasonsForPicker(seasons).map(se => {
                const already = (data.contracts || []).some(
                  x => x.season_id === se.id || (!x.season_id && x.season_year === se.year))
                return (
                  <option key={se.id} value={se.id} disabled={already}>
                    {se.name}{already ? ' — already in it' : ''}
                  </option>
                )
              })}
            </select>
            <button onClick={() => addToSeason(addSeasonId)} disabled={!addSeasonId || enrolling}
              className="px-4 py-2 rounded-lg text-sm font-bold text-on-forest disabled:opacity-50 whitespace-nowrap"
              style={{ background: 'var(--forest)' }}>
              {enrolling ? 'Adding…' : 'Add to season'}
            </button>
          </div>
        </div>
      )}

      {/* Remove from seasonals — unchecks is_seasonal; keeps all records, reversible */}
      <div className="mb-4 flex justify-end">
        <button onClick={removeFromSeasonals} disabled={removing}
          className="px-4 py-2 rounded-lg text-sm font-semibold border disabled:opacity-50"
          style={{ borderColor: 'color-mix(in srgb, var(--danger) 35%, transparent)', color: 'var(--danger)', background: 'var(--card)' }}>
          {removing ? 'Removing…' : 'Remove from seasonals'}
        </button>
      </div>

    </div>
  )
}
