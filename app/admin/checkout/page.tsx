'use client'
// THE LANE CHECKOUT — Phase 4, PR 3.
//
// Pull up a camper, tap the lanes they are paying, watch the total build, take the payment.
//
// ⚠ SEPARATED PARKS ONLY. A combined park has no lanes to select, so this screen sends it to the
// camper's folio, which is where it has always taken payments. Nothing about the combined flow
// changes anywhere in this PR.
//
// ⚠ NO NEW MONEY PATH. Every payment this screen records goes through machinery that already
// existed:
//   · card          → POST /api/admin-card-payment, the same server route the folio pages,
//                     walk-in booking and new-reservation all use. PR 3 taught it an OPTIONAL
//                     lane split; one Square charge, one folio_payments row per lane sharing the
//                     square_payment_id. The Square call, credential resolution and error
//                     handling are untouched and unreimplemented.
//   · everything else → the same direct folio_payments insert the folio pages perform, with the
//                     same surcharge and status handling, plus the `lane` tag.
// There is no second way to write a payment in this codebase after this PR, and that is
// deliberate: a parallel money path is exactly where a money bug hides.
import { useCallback, useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { planAtLeast } from '@/lib/plan'
import { createBrowserSupabase } from '@/lib/supabase-browser'
import { loadSquarePayments } from '@/lib/square-card-client'
import { LANES, normalizeBillingMode, type Lane } from '@/lib/ledger-lanes'
import type { SeasonalGuestData } from '@/lib/seasonal-types'
import toast, { Toaster } from 'react-hot-toast'

const supabase = createBrowserSupabase()

/** The lanes an owner can take money against. `other` is excluded: it is the classifier's
 *  catch-all, not something a camper is billed for. It still counts in the account total. */
const PAYABLE: { lane: Lane; label: string; hint: string }[] = [
  { lane: 'electric', label: 'Electric', hint: 'Metered electricity' },
  { lane: 'store', label: 'Store', hint: 'Camp store tab' },
  { lane: 'seasonal', label: 'Seasonal', hint: 'Site fee for the season' },
]

const money = (c: number) => '$' + (Math.abs(c) / 100).toFixed(2)
const toCents = (v: string) => Math.round((parseFloat(v) || 0) * 100)

type GuestRow = { id: string; name: string; site_number: string | null }

export default function LaneCheckoutPage() {
  const router = useRouter()

  const [mode, setMode] = useState<'combined' | 'separated' | null>(null)
  const [surchargePct, setSurchargePct] = useState(0)
  const [customMethods, setCustomMethods] = useState<string[]>([])

  // Camper selection
  const [guestId, setGuestId] = useState('')
  const [search, setSearch] = useState('')
  const [results, setResults] = useState<GuestRow[]>([])
  const [data, setData] = useState<SeasonalGuestData | null>(null)
  const [loading, setLoading] = useState(false)

  // Lane selection + per-lane amounts (as typed, so a half-typed number is not clobbered)
  const [selected, setSelected] = useState<Record<string, boolean>>({})
  const [amounts, setAmounts] = useState<Record<string, string>>({})

  // Payment
  const [method, setMethod] = useState('cash')
  const [note, setNote] = useState('')
  const [waiveFee, setWaiveFee] = useState(false)
  const [saving, setSaving] = useState(false)
  const [cardReady, setCardReady] = useState(false)
  const [squareErr, setSquareErr] = useState('')
  // `unknown` rather than a Square type: lib/square-card-client owns that shape and this screen
  // only ever calls .attach()/.tokenize() through it.
  const [cardRef, setCardRef] = useState<{ tokenize: () => Promise<{ status: string; token?: string }> } | null>(null)

  useEffect(() => {
    supabase.from('settings').select('plan, billing_mode, card_surcharge_percent, custom_payment_methods').single()
      .then(({ data, error }) => {
        // Fail safe to combined: a park without the Phase 4 column must land on the flow it
        // already has, never on a lane screen it cannot use.
        if (error) { setMode('combined'); return }
        if (!planAtLeast(data?.plan, 'summit')) { router.replace('/admin'); return }
        setMode(normalizeBillingMode(data?.billing_mode))
        setSurchargePct(Number(data?.card_surcharge_percent) || 0)
        setCustomMethods((data?.custom_payment_methods as string[]) || [])
      })
  }, [router])

  // ?guestId= — opened from a camper's page with them already loaded.
  useEffect(() => {
    const g = new URLSearchParams(window.location.search).get('guestId')
    if (g) setGuestId(g)
  }, [])

  const load = useCallback(async (id: string) => {
    if (!id) { setData(null); return }
    setLoading(true)
    try {
      const res = await fetch(`/api/seasonals/guest/${id}`)
      const d = await res.json()
      if (res.ok) setData(d)
    } catch { /* the empty state below covers it */ }
    setLoading(false)
  }, [])
  useEffect(() => { void load(guestId) }, [load, guestId])

  // Camper search — seasonal campers by name or site.
  useEffect(() => {
    const q = search.trim()
    if (q.length < 2) { setResults([]); return }
    let cancelled = false
    const t = setTimeout(async () => {
      const { data: rows } = await supabase
        .from('guests').select('id, name, site_number')
        .eq('is_seasonal', true).ilike('name', `%${q}%`).order('name').limit(8)
      if (!cancelled) setResults((rows as GuestRow[]) || [])
    }, 200)
    return () => { cancelled = true; clearTimeout(t) }
  }, [search])

  const lanes = data?.lanes || null
  const dueFor = (lane: Lane) => Math.max(0, lanes?.byLane[lane]?.balance ?? 0)

  /** Selecting a lane pre-fills its full amount due — the common case is "pay it off". */
  function toggle(lane: Lane) {
    setSelected(prev => {
      const on = !prev[lane]
      if (on) setAmounts(a => ({ ...a, [lane]: a[lane] ?? (dueFor(lane) / 100).toFixed(2) }))
      return { ...prev, [lane]: on }
    })
  }

  const lineFor = (lane: Lane) => (selected[lane] ? Math.max(0, toCents(amounts[lane] ?? '')) : 0)
  const baseTotal = PAYABLE.reduce((s, p) => s + lineFor(p.lane), 0)
  const surcharge = method === 'card' && surchargePct > 0 && !waiveFee
    ? PAYABLE.reduce((s, p) => s + Math.round(lineFor(p.lane) * (surchargePct / 100)), 0)
    : 0
  const grandTotal = baseTotal + surcharge

  async function mountCard() {
    setSquareErr('')
    try {
      const loaded = await loadSquarePayments()
      if (!loaded.ok) { setSquareErr(loaded.error); return }
      const card = await loaded.payments.card()
      await card.attach('#lane-checkout-card')
      setCardRef(card as never)
      setCardReady(true)
    } catch {
      setSquareErr('The card form could not be loaded. Refresh, or take this payment another way.')
    }
  }

  /** The lanes actually being paid, with each one's own surcharge computed from its own amount —
   *  so no proportional allocation and no rounding drift between the charge and the ledger. */
  function splits() {
    return PAYABLE
      .map(p => ({ lane: p.lane, amount: lineFor(p.lane) }))
      .filter(l => l.amount > 0)
      .map(l => ({
        ...l,
        surchargeAmount: method === 'card' && surchargePct > 0 && !waiveFee
          ? Math.round(l.amount * (surchargePct / 100)) : 0,
      }))
  }

  async function takePayment() {
    if (!data?.folioId || baseTotal <= 0) return
    const split = splits()
    setSaving(true)
    try {
      if (method === 'card') {
        if (!cardRef) { setSaving(false); return }
        const tok = await cardRef.tokenize()
        if (tok.status !== 'OK' || !tok.token) { setSaving(false); return }
        // ONE Square charge for the whole total; the route writes one row per lane under its id.
        const res = await fetch('/api/admin-card-payment', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            sourceId: tok.token, folioId: data.folioId, note,
            guestName: data.guest?.name || '',
            lanes: split.map(l => ({ lane: l.lane, amount: l.amount + l.surchargeAmount, surchargeAmount: l.surchargeAmount })),
          }),
        })
        const d = await res.json()
        if (!res.ok || !d.success) { toast.error(d.error || 'Card payment failed.'); setSaving(false); return }
        if (d.warning) toast(d.warning, { icon: '⚠️', duration: 12000 })
      } else {
        // The same insert the folio pages perform, one row per lane, plus the lane tag. A single
        // insert call so a multi-lane payment cannot land half-recorded.
        const { error } = await supabase.from('folio_payments').insert(
          split.map(l => ({
            folio_id: data.folioId,
            method,
            amount: l.amount,
            surcharge_amount: 0,
            status: 'completed',
            note,
            lane: l.lane,
          }))
        )
        if (error) { toast.error('Could not record the payment: ' + error.message); setSaving(false); return }
      }

      // PR 4 leaves a receipt hook here — deliberately NOT sent in this PR.
      toast.success(`${money(grandTotal)} recorded.`)
      setSelected({}); setAmounts({}); setNote(''); setWaiveFee(false)
      await load(guestId)
      router.push(`/admin/seasonals/${guestId}`)
    } catch {
      toast.error('Something went wrong taking that payment.')
    }
    setSaving(false)
  }

  const card = 'bg-white rounded-xl border border-gray-100 p-5 mb-4'
  const inp = 'w-full border border-gray-200 rounded-lg px-3 py-2 text-sm'

  if (mode === null) return <div className="p-6 text-gray-500">Loading…</div>

  // Combined: nothing to select. Send them where payments have always been taken.
  if (mode === 'combined') {
    return (
      <div className="p-4 md:p-6 max-w-2xl">
        <h2 className="text-2xl font-bold text-gray-900 mb-1">Take a payment</h2>
        <div className={card}>
          <p className="text-sm text-gray-600">
            This park tracks seasonal money as <strong>one combined balance</strong>, so there are no separate lanes to
            pay against. Take payments on the camper&rsquo;s folio, exactly as you do now.
          </p>
          <p className="text-sm text-gray-500 mt-3">
            To pay Electric, Store and Seasonal separately, switch to <strong>Separated</strong> under{' '}
            <Link href="/admin/settings" className="underline font-semibold">Settings → How seasonal money is tracked</Link>.
          </p>
        </div>
      </div>
    )
  }

  return (
    <div className="p-4 md:p-6 max-w-2xl pb-40">
      <Toaster />
      <div className="mb-4">
        <Link href={guestId ? `/admin/seasonals/${guestId}` : '/admin/seasonals'} className="text-sm text-gray-400 hover:text-gray-600">← Back</Link>
        <h2 className="text-2xl font-bold text-gray-900">Take a payment</h2>
      </div>

      {/* WHO */}
      <div className={card}>
        {data ? (
          <div className="flex items-center justify-between gap-3">
            <div>
              <p className="text-lg font-bold text-gray-900">{data.guest?.name || '—'}</p>
              <p className="text-sm text-gray-500">Site {data.guest?.site_number || '—'}</p>
            </div>
            <button onClick={() => { setGuestId(''); setData(null); setSelected({}); setAmounts({}); setSearch('') }}
              className="text-xs font-semibold" style={{ color: 'var(--accent-color, #2E6B8A)' }}>Change camper</button>
          </div>
        ) : (
          <>
            <label className="block text-xs text-gray-500 mb-1">Find a camper</label>
            <input autoFocus value={search} onChange={e => setSearch(e.target.value)} placeholder="Start typing a name…" className={inp} />
            {results.length > 0 && (
              <div className="mt-2 divide-y divide-gray-100">
                {results.map(r => (
                  <button key={r.id} onClick={() => { setGuestId(r.id); setSearch(''); setResults([]) }}
                    className="w-full text-left py-2 hover:bg-gray-50">
                    <span className="text-sm font-semibold text-gray-900">{r.name}</span>
                    <span className="text-xs text-gray-500 ml-2">Site {r.site_number || '—'}</span>
                  </button>
                ))}
              </div>
            )}
            {search.trim().length >= 2 && results.length === 0 && (
              <p className="text-sm text-gray-400 mt-2">No seasonal camper matches that.</p>
            )}
          </>
        )}
      </div>

      {loading && <p className="text-sm text-gray-500">Loading balances…</p>}

      {data && !loading && (
        <>
          {/* LANES */}
          <div className="mb-4">
            <p className="text-xs font-bold text-gray-400 uppercase tracking-wide mb-2">What are they paying?</p>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              {PAYABLE.map(({ lane, label, hint }) => {
                const due = dueFor(lane)
                const on = !!selected[lane]
                return (
                  <div key={lane}
                    onClick={() => toggle(lane)}
                    role="checkbox" aria-checked={on} tabIndex={0}
                    onKeyDown={e => { if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); toggle(lane) } }}
                    className="rounded-xl border-2 p-4 cursor-pointer transition-colors"
                    style={{ borderColor: on ? '#15803d' : '#e5e7eb', background: on ? '#f0fdf4' : '#fff' }}>
                    <div className="flex items-start justify-between gap-2">
                      <div>
                        <p className="text-sm font-bold text-gray-900">{label}</p>
                        <p className="text-[11px] text-gray-400">{hint}</p>
                      </div>
                      <span style={{
                        width: 22, height: 22, borderRadius: 6, flexShrink: 0, display: 'inline-flex',
                        alignItems: 'center', justifyContent: 'center', fontSize: 14, fontWeight: 700, color: '#fff',
                        border: `2px solid ${on ? '#15803d' : '#9ca3af'}`, background: on ? '#15803d' : '#fff',
                      }}>{on ? '✓' : ''}</span>
                    </div>
                    <p className="mt-3 text-xl font-bold" style={{ color: due > 0 ? '#d97706' : '#15803d' }}>
                      {due > 0 ? money(due) : 'Paid up'}
                    </p>
                    <p className="text-[11px] text-gray-400">
                      {due > 0 ? 'due' : (lanes?.byLane[lane]?.balance ?? 0) < 0 ? 'in credit' : 'nothing owing'}
                    </p>
                    {on && (
                      // Editable once selected: lower it for a part payment, raise it for a
                      // prepayment — an overpayment simply becomes a credit in that lane.
                      <div className="mt-3" onClick={e => e.stopPropagation()}>
                        <label className="block text-[11px] text-gray-500 mb-1">Amount</label>
                        <div className="flex items-center gap-1">
                          <span className="text-sm text-gray-500">$</span>
                          <input type="number" step="0.01" min="0"
                            value={amounts[lane] ?? ''} onChange={e => setAmounts(a => ({ ...a, [lane]: e.target.value }))}
                            className="w-full border border-gray-200 rounded-lg px-2 py-1.5 text-sm font-bold" />
                        </div>
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
            {lanes && lanes.untaggedPayments !== 0 && (
              <p className="text-xs text-gray-400 mt-2">
                {money(lanes.untaggedPayments)} of past payments isn&rsquo;t assigned to a lane yet, so it sits against the
                account as a whole. Account balance {money(data.balance_cents)}.
              </p>
            )}
          </div>

          {/* METHOD */}
          <div className={card}>
            <p className="text-xs font-bold text-gray-400 uppercase tracking-wide mb-2">How are they paying?</p>
            <div className="flex flex-wrap gap-2">
              {['cash', 'check', 'card', ...customMethods].map(m => (
                <button key={m} onClick={() => { setMethod(m); if (m !== 'card') { setCardReady(false); setCardRef(null) } }}
                  className="px-3 py-2 rounded-lg text-sm font-semibold border capitalize"
                  style={method === m
                    ? { background: '#f0fdf4', borderColor: '#15803d', color: '#15803d' }
                    : { background: '#fff', borderColor: '#e5e7eb', color: '#6b7280' }}>
                  {m}
                </button>
              ))}
            </div>

            {method === 'card' && (
              <div className="mt-3">
                {surchargePct > 0 && (
                  <label className="flex items-center gap-2 text-xs text-gray-600 mb-2">
                    <input type="checkbox" checked={waiveFee} onChange={e => setWaiveFee(e.target.checked)} />
                    Waive the {surchargePct}% card fee
                  </label>
                )}
                {!cardReady && (
                  <button onClick={mountCard} className="px-3 py-2 rounded-lg text-sm font-semibold text-white" style={{ background: '#2E6B8A' }}>
                    Enter card details
                  </button>
                )}
                <div id="lane-checkout-card" className="mt-2" />
                {squareErr && <p className="text-sm text-amber-700 mt-2">{squareErr}</p>}
              </div>
            )}

            <div className="mt-3">
              <label className="block text-xs text-gray-500 mb-1">Note (optional)</label>
              <input value={note} onChange={e => setNote(e.target.value)} className={inp} />
            </div>
          </div>
        </>
      )}

      {/* RUNNING TOTAL — pinned, so the figure is always in view as cards are tapped. */}
      {data && !loading && (
        <div className="fixed inset-x-0 bottom-0 border-t border-gray-200 bg-white/95 backdrop-blur px-4 py-3 z-40">
          <div className="max-w-2xl mx-auto">
            <div className="flex items-end justify-between mb-2">
              <div>
                <p className="text-xs text-gray-500">
                  {PAYABLE.filter(p => lineFor(p.lane) > 0).map(p => p.label).join(' + ') || 'Nothing selected'}
                </p>
                {surcharge > 0 && <p className="text-[11px] text-gray-400">includes {money(surcharge)} card fee</p>}
              </div>
              <p className="text-2xl font-bold text-gray-900">{money(grandTotal)}</p>
            </div>
            <button onClick={takePayment}
              disabled={saving || baseTotal <= 0 || !data.folioId || (method === 'card' && !cardReady)}
              className="w-full py-3 rounded-xl text-sm font-bold text-white disabled:opacity-50"
              style={{ background: '#15803d' }}>
              {saving ? 'Recording…' : `Take payment · ${money(grandTotal)}`}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
