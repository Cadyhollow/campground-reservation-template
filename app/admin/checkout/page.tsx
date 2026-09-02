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
import { useCallback, useEffect, useState, useRef } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { planAtLeast } from '@/lib/plan'
import { createBrowserSupabase } from '@/lib/supabase-browser'
import { loadSquarePayments } from '@/lib/square-card-client'
import { normalizeBillingMode } from '@/lib/ledger-lanes'
import { accountBuckets, paymentLaneForBucket, BUCKETS, type Bucket } from '@/lib/account-buckets'
import { bucketLabels, type BucketLabels } from '@/lib/bucket-labels'
import { methodLabel as methodLabelOf } from '@/lib/transactions'
import type { SeasonalGuestData } from '@/lib/seasonal-types'
import toast, { Toaster } from 'react-hot-toast'
import TerminalChargeControls from '@/app/components/TerminalChargeControls'

const supabase = createBrowserSupabase()

/**
 * TWO DOORS, NOT FOUR LANES — and this is the fix, not a simplification.
 *
 * The three lane boxes that used to be here (Electric / Store / Seasonal) offered each lane's
 * charges against its OWN tagged payments. Almost no payment carries a lane — about 2% on the
 * live park — so Electric and Store offered their full original charges as the amount due. Staff
 * were shown "$1,865 store due" on an account whose real balance was a fraction of that, and the
 * box pre-filled that figure into the amount field.
 *
 * The two buckets are exact: Seasonal is genuinely tagged so it is computed directly, and Camp is
 * the account remainder, so every untagged payment already counts toward it. What each door
 * offers is now what the camper actually owes.
 *
 * `hint` is fixed copy; the LABELS are the park's own (settings, see bucketLabels).
 */
const DOOR_HINT: Record<Bucket, string> = {
  camp: 'Electric, store and everything else',
  seasonal: 'Site fee, deposit and installments',
}

const money = (c: number) => '$' + (Math.abs(c) / 100).toFixed(2)
const toCents = (v: string) => Math.round((parseFloat(v) || 0) * 100)

type GuestRow = { id: string; name: string; site_number: string | null }

export default function LaneCheckoutPage() {
  const router = useRouter()

  const [mode, setMode] = useState<'combined' | 'separated' | null>(null)
  const [surchargePct, setSurchargePct] = useState(0)
  const [maxCreditAmount, setMaxCreditAmount] = useState(0)
  const [customMethods, setCustomMethods] = useState<string[]>([])
  const [labels, setLabels] = useState<BucketLabels>(() => bucketLabels(null))

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
  // Cash handed over. Exactly the folio's model: the LANE AMOUNTS are what gets recorded, this is
  // what was physically received, and the difference is change-or-credit.
  const [cashTendered, setCashTendered] = useState('')
  /** Set by "Apply as Credit", cleared by "Give Change". Declared with the other state rather
   *  than beside the derived values — a hook must never sit in a conditional region. */
  const [keepAsCredit, setKeepAsCredit] = useState(false)
  const [saving, setSaving] = useState(false)
  /** Non-null once a payment has gone through — switches the screen to the receipt step. */
  const [paidTotal, setPaidTotal] = useState<number | null>(null)
  const [emailing, setEmailing] = useState(false)
  const [emailed, setEmailed] = useState(false)
  const [cardReady, setCardReady] = useState(false)
  // ── SEND TO TERMINAL ──────────────────────────────────────────────────────────────────────
  // A terminal charge is asynchronous: we send it, the customer taps, and completion arrives
  // later. `checkoutId` non-null IS the waiting state.
  const [terminalDeviceId, setTerminalDeviceId] = useState('')
  const [checkoutId, setCheckoutId] = useState<string | null>(null)
  // Which way a card is being taken. Mirrors the folio's Collect Payment modal: one option is
  // shown at a time, never both stacked — showing both is what made this screen look cluttered
  // and duplicated.
  const [cardEntryMode, setCardEntryMode] = useState<'terminal' | 'manual'>('terminal')
  const [squareErr, setSquareErr] = useState('')
  // `unknown` rather than a Square type: lib/square-card-client owns that shape and this screen
  // only ever calls .attach()/.tokenize() through it.
  const [cardRef, setCardRef] = useState<{ tokenize: () => Promise<{ status: string; token?: string }> } | null>(null)

  // The park's wording for the two doors. ⚠ ITS OWN GUARDED SELECT: a park that has not run
  // db/migrations/2026-09-02-bucket-labels.sql has neither column, and folding these into the
  // select below would fail that query and take the whole screen — including the billing mode —
  // down with it. A failure here just means "not configured", so it falls back to the defaults.
  useEffect(() => {
    supabase.from('settings').select('bucket_label_camp, bucket_label_seasonal').single()
      .then(({ data, error }) => { if (!error) setLabels(bucketLabels(data)) })
  }, [])

  useEffect(() => {
    supabase.from('settings').select('plan, billing_mode, card_surcharge_percent, custom_payment_methods, max_credit_amount, square_terminal_device_id').single()
      .then(({ data, error }) => {
        // Fail safe to combined: a park without the Phase 4 column must land on the flow it
        // already has, never on a lane screen it cannot use.
        if (error) { setMode('combined'); return }
        if (!planAtLeast(data?.plan, 'summit')) { router.replace('/admin'); return }
        setMode(normalizeBillingMode(data?.billing_mode))
        setSurchargePct(Number(data?.card_surcharge_percent) || 0)
        setMaxCreditAmount(Number(data?.max_credit_amount) || 0)
        setTerminalDeviceId(String(data?.square_terminal_device_id || ''))
        setCustomMethods((data?.custom_payment_methods as string[]) || [])
      })
  }, [router])

  // ?guestId= — opened from a camper's page with them already loaded.
  // ?bucket=  — opened ON a specific door. "Take a payment" under a seasonal camper's record
  //             means their season fee, and landing on this screen with nothing chosen made
  //             somebody re-find and re-pick it every time. Only the door is preselected; the
  //             AMOUNT is filled in by the effect below, once balances have actually loaded.
  const pendingBucket = useRef<Bucket | null>(null)
  useEffect(() => {
    const q = new URLSearchParams(window.location.search)
    const g = q.get('guestId')
    if (g) setGuestId(g)
    const b = q.get('bucket')
    if (b === 'camp' || b === 'seasonal') pendingBucket.current = b
  }, [])

  const load = useCallback(async (id: string) => {
    if (!id) { setData(null); return }
    setLoading(true)
    try {
      const res = await fetch(`/api/seasonals/guest/${id}`)
      const d = await res.json()
      if (res.ok) {
        setData(d)
        // ⚠ THE DOOR OPENS HERE, NOT ON MOUNT, because only now is there a balance to put in it.
        // Preselecting before the fetch returned would prefill $0.00 and quietly offer to take
        // nothing. The ref is cleared as it is consumed, so this is a one-shot: it never fights a
        // staff member who then closes that door or retypes the amount.
        const want: Bucket | null = pendingBucket.current
        if (want) {
          pendingBucket.current = null
          const due = d?.lanes ? Math.max(0, accountBuckets(d.lanes)[want].balance) : 0
          setSelected(prev => ({ ...prev, [want]: true }))
          setAmounts(a => (a[want] !== undefined ? a : { ...a, [want]: (due / 100).toFixed(2) }))
        }
      }
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
  // ⚠ ONE DERIVATION OF THE TWO BUCKETS, shared with the cards on every other screen. Nothing on
  // this page recomputes a balance of its own, so the amount a door offers is by construction the
  // amount the camper's card shows.
  const buckets = lanes ? accountBuckets(lanes) : null
  const dueFor = (b: Bucket) => Math.max(0, buckets?.[b].balance ?? 0)

  /** Opening a door pre-fills its full amount due — the common case is "pay it off". */
  function toggle(b: Bucket) {
    setSelected(prev => {
      const on = !prev[b]
      if (on) setAmounts(a => ({ ...a, [b]: a[b] ?? (dueFor(b) / 100).toFixed(2) }))
      return { ...prev, [b]: on }
    })
  }

  /** PAY BOTH — one tender, both doors, each pre-filled with its own balance. It records TWO
   *  rows (see splits()), so each bucket settles exactly rather than one absorbing the other. */
  function payBoth() {
    setAmounts(a => {
      const next = { ...a }
      for (const b of BUCKETS) if (next[b] === undefined) next[b] = (dueFor(b) / 100).toFixed(2)
      return next
    })
    setSelected({ camp: true, seasonal: true })
  }

  const lineFor = (b: Bucket) => (selected[b] ? Math.max(0, toCents(amounts[b] ?? '')) : 0)
  const baseTotal = BUCKETS.reduce((s, b) => s + lineFor(b), 0)
  const surcharge = method === 'card' && surchargePct > 0 && !waiveFee
    ? BUCKETS.reduce((s, b) => s + Math.round(lineFor(b) * (surchargePct / 100)), 0)
    : 0
  const grandTotal = baseTotal + surcharge

  // ── THE CREDIT-OR-CHANGE OVERAGE (Phase 4 PR 3b, Part B) ──────────────────────────────────
  //
  // The SAME mechanism the folio has always used, and not a new one: a credit is not a record of
  // its own, it is simply a payment recorded for more than was owed, which drives the balance
  // negative. Here the lane rows carry what each lane is paying, and a kept overage is recorded
  // as ONE UNTAGGED row — untagged being precisely what "an account credit, applicable to any
  // lane later" already means everywhere else in Phase 4.
  //
  // Cash is the only tender that can give change, so it is the only one offered the choice —
  // again matching the folio, where an electronic overage can only become a credit.
  const tenderedCents = method === 'cash' ? toCents(cashTendered) : 0
  const overageCents = method === 'cash' && cashTendered !== '' ? Math.max(0, tenderedCents - grandTotal) : 0
  const overageExceedsCap = maxCreditAmount > 0 && overageCents > maxCreditAmount
  const shortCents = method === 'cash' && cashTendered !== '' ? Math.max(0, grandTotal - tenderedCents) : 0
  const creditCents = keepAsCredit ? overageCents : 0
  // Which bucket a kept credit will be filed under — only when exactly one door is being paid.
  const selectedBuckets = BUCKETS.filter(b => lineFor(b) > 0)
  const creditLaneLabel = selectedBuckets.length === 1 ? labels[selectedBuckets[0]] : ''

  // ⚠ THE CARD FORM RENDERED TWICE, AND THIS IS WHY.
  //
  // Square's card.attach() APPENDS an iframe into the container; it does not replace what is
  // there. React does not own that iframe, so it survives any re-render of the container div.
  // Mounting was triggered by a button, so a second press — or leaving Card and coming back,
  // which cleared `cardReady` and put the button back — attached a SECOND form into a container
  // that still held the first. Two "Card number / MM/YY / CVV" rows, exactly as observed.
  //
  // Fixed by making the mount an EFFECT with a real teardown: exactly one form exists while
  // manual entry is on screen, and it is destroyed the moment it leaves. The ref guard also
  // makes a double-invoked effect (React StrictMode in development) harmless.
  useEffect(() => {
    if (method !== 'card' || cardEntryMode !== 'manual') return
    let cancelled = false
    let mounted: { destroy?: () => Promise<void> | void } | null = null
    setSquareErr('')
    ;(async () => {
      try {
        const loaded = await loadSquarePayments()
        if (cancelled) return
        if (!loaded.ok) { setSquareErr(loaded.error); return }
        const card = await loaded.payments.card()
        if (cancelled) { await (card as { destroy?: () => void }).destroy?.(); return }
        // Belt and braces: if anything was left behind by an earlier mount, clear it before
        // attaching so a stale iframe can never sit above the live one.
        const host = document.getElementById('lane-checkout-card')
        if (host) host.innerHTML = ''
        await card.attach('#lane-checkout-card')
        if (cancelled) { await (card as { destroy?: () => void }).destroy?.(); return }
        mounted = card as { destroy?: () => void }
        setCardRef(card as never)
        setCardReady(true)
      } catch {
        if (!cancelled) setSquareErr('The card form could not be loaded. Refresh, or take this payment another way.')
      }
    })()
    return () => {
      cancelled = true
      void mounted?.destroy?.()
      const host = document.getElementById('lane-checkout-card')
      if (host) host.innerHTML = ''
      setCardRef(null)
      setCardReady(false)
    }
  }, [method, cardEntryMode])

  /**
   * The doors actually being paid, each with its own surcharge computed from its own amount — so
   * no proportional allocation and no rounding drift between the charge and the ledger.
   *
   * ⚠ A CAMP ROW IS UNTAGGED, AND THAT IS DELIBERATE, NOT AN OMISSION. paymentLaneForBucket()
   * returns null for Camp: a whole-account payment, exactly what every payment already is today.
   * Camp is computed as the account remainder, so an untagged row settles it precisely, and the
   * park's existing untagged history already reads as Camp without being retagged.
   *
   * "Pay both" therefore writes TWO rows from one tender — one seasonal-tagged, one untagged —
   * which is what lets each bucket land on exactly zero instead of one swallowing the other.
   */
  function splits() {
    return BUCKETS
      .map(b => ({ lane: paymentLaneForBucket(b), amount: lineFor(b) }))
      .filter(l => l.amount > 0)
      .map(l => ({
        ...l,
        surchargeAmount: method === 'card' && surchargePct > 0 && !waiveFee
          ? Math.round(l.amount * (surchargePct / 100)) : 0,
      }))
  }

  /**
   * The camper's guest_account folio, created if they have never had one.
   *
   * ⚠ WHY THIS IS SAFE FROM CREATING A SECOND FOLIO. `data.folioId` comes from
   * GET /api/seasonals/guest, whose lookup is the BROADER one — folio_type + guest_id, with no
   * status filter — so an empty string here means the camper genuinely has no guest_account
   * folio at all, not merely no OPEN one. (The folio page's own find-or-create does filter on
   * status='open'; that asymmetry predates this and is left alone.)
   *
   * An empty folio is a valid state and is NOT created up front. It is created here, on the first
   * payment, which is the moment it first means anything — an autumn deposit months before the
   * contract is sent is the ordinary case, not an edge one.
   */
  async function ensureFolio(): Promise<string | null> {
    if (data?.folioId) return data.folioId
    const g = data?.guest
    if (!g?.id) return null
    const { data: created, error } = await supabase.from('folios').insert({
      reservation_id: null,
      guest_id: g.id,
      guest_name: g.name || '',
      guest_email: g.email || '',
      folio_type: 'guest_account',
      status: 'open',
      label: 'Seasonal Account',
    }).select('id').single()
    if (error || !created) { toast.error('Could not open a folio for this camper.'); return null }
    return created.id as string
  }

  async function takePayment() {
    if (baseTotal <= 0) return
    const folioId = await ensureFolio()
    if (!folioId) return
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
            sourceId: tok.token, folioId, note,
            guestName: data?.guest?.name || '',
            lanes: split.map(l => ({ lane: l.lane, amount: l.amount + l.surchargeAmount, surchargeAmount: l.surchargeAmount })),
          }),
        })
        const d = await res.json()
        if (!res.ok || !d.success) { toast.error(d.error || 'Card payment failed.'); setSaving(false); return }
        if (d.warning) toast(d.warning, { icon: '⚠️', duration: 12000 })
      } else {
        // The same insert the folio pages perform, one row per lane, plus the lane tag. A single
        // insert call so a multi-lane payment cannot land half-recorded.
        // `lane: string | null` — the credit row below carries null, which is the whole point of
        // it (an account credit belongs to no single lane).
        const rows: Record<string, unknown>[] = split.map(l => ({
          folio_id: folioId,
          method,
          amount: l.amount,
          surcharge_amount: 0,
          status: 'completed',
          note,
          // null for Camp — an untagged, whole-account row.
          lane: l.lane,
        }))
        // ── PR 3c: A KEPT OVERPAYMENT CARRIES THE LANE IT WAS PAID ON ───────────────────────
        //
        // Previously this row was untagged, and that broke the thing Phase 4 exists for: an
        // untagged credit floats outside every lane, so the lanes stop summing to the account
        // and a camper is told they owe more on a lane than they owe in total.
        //
        // When ONE lane was being paid, "the lane it was paid on" is unambiguous, so the credit
        // is filed there automatically — no extra tap for staff, and the lanes stay reconciled.
        //
        // When SEVERAL lanes were paid at once there is no honest answer, so the credit stays
        // unassigned and is shown as such on the folio, with the one-tap control to file it.
        // Picking the largest lane, or the first, would be a guess dressed up as a fact — and a
        // wrong guess silently misstates what a camper owes on a specific lane.
        const creditLane = split.length === 1 ? split[0].lane : null
        if (creditCents > 0) {
          rows.push({
            folio_id: folioId, method, amount: creditCents, surcharge_amount: 0,
            status: 'completed', note: (note ? note + ' · ' : '') + 'Account credit',
            lane: creditLane,
          })
        }
        const { error } = await supabase.from('folio_payments').insert(rows)
        if (error) { toast.error('Could not record the payment: ' + error.message); setSaving(false); return }
      }

      toast.success(creditCents > 0
        ? `${money(grandTotal)} recorded, plus ${money(creditCents)} account credit.`
        : `${money(grandTotal)} recorded.`)
      // PR 4 — THE RECEIPT STEP. The payment is already recorded and final; the receipt is a
      // follow-on the staff member chooses. Nothing auto-fires: an email a camper did not ask
      // for, sent the instant money changes hands, is worse than no email.
      setPaidTotal(grandTotal + creditCents)
      setSelected({}); setAmounts({}); setNote(''); setWaiveFee(false)
      setCashTendered(''); setKeepAsCredit(false)
      await load(guestId)
    } catch {
      toast.error('Something went wrong taking that payment.')
    }
    setSaving(false)
  }

  /**
   * Push the charge to the paired Square Terminal and wait for the tap.
   *
   * ⚠ NOTHING IS RECORDED HERE. This screen only asks the device to collect; the money reaches
   * the folio from the server, on COMPLETED, through the one shared sink both card paths use —
   * and idempotently, so this poll and Square's webhook can both drive it without the customer
   * being recorded as having paid twice.
   */
  async function sendToTerminal() {
    if (baseTotal <= 0) return
    const folioId = await ensureFolio()
    if (!folioId) return
    setSaving(true)
    try {
      const res = await fetch('/api/terminal/charge', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ folioId, note, lanes: splits() }),
      })
      const d = await res.json()
      if (!res.ok || !d.checkoutId) { toast.error(d.error || 'Could not reach the terminal.'); setSaving(false); return }
      setCheckoutId(d.checkoutId)
    } catch { toast.error('Could not reach the terminal.') }
    setSaving(false)
  }

  /** Email the receipt through the EXISTING receipt route. Reads folio data and sends; it
   *  writes no money and cannot alter the payment that was just recorded. */
  async function emailReceipt() {
    if (!data?.folioId) return
    setEmailing(true)
    try {
      const res = await fetch('/api/receipt', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ folioId: data.folioId, receiptType: 'account' }),
      })
      const d = await res.json()
      if (!res.ok) { toast.error(d.error || 'Could not send the receipt.'); setEmailing(false); return }
      setEmailed(true)
      toast.success('Receipt emailed.')
    } catch { toast.error('Could not send the receipt.') }
    setEmailing(false)
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
          {/* ── THE TWO DOORS ────────────────────────────────────────────────────────────
              One balance each, and "Pay both" for the common case of settling a camper up in a
              single tender. The old third box and the "not yet assigned" footnote are both gone:
              with Camp computed as the account remainder there is no unassigned money left to
              confess, and the two doors always sum to the account balance. */}
          <div className="mb-4">
            <div className="flex items-center justify-between gap-3 mb-2">
              <p className="text-xs font-bold text-gray-400 uppercase tracking-wide">What are they paying?</p>
              {buckets && (buckets.camp.balance > 0 || buckets.seasonal.balance > 0) && (
                <button type="button" onClick={payBoth}
                  className="text-xs font-bold rounded-lg px-3 py-1.5"
                  style={{ background: '#15803d', color: '#fff' }}>
                  Pay both
                </button>
              )}
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              {BUCKETS.map(b => {
                const due = dueFor(b)
                const on = !!selected[b]
                const bal = buckets?.[b].balance ?? 0
                // Camp keeps the green this screen has always used; Seasonal takes the gold the
                // theme reserves for the season, so the two doors are tellable apart at a glance
                // and match the camper's cards on every other screen.
                const accent = b === 'seasonal' ? '#B4842B' : '#15803d'
                const tint = b === 'seasonal' ? '#FFFBEB' : '#f0fdf4'
                return (
                  <div key={b}
                    onClick={() => toggle(b)}
                    role="checkbox" aria-checked={on} tabIndex={0}
                    onKeyDown={e => { if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); toggle(b) } }}
                    className="rounded-xl border-2 p-4 cursor-pointer transition-colors"
                    style={{ borderColor: on ? accent : '#e5e7eb', background: on ? tint : '#fff' }}>
                    <div className="flex items-start justify-between gap-2">
                      <div>
                        <p className="text-sm font-bold text-gray-900">{labels[b]}</p>
                        <p className="text-[11px] text-gray-400">{DOOR_HINT[b]}</p>
                      </div>
                      <span style={{
                        width: 22, height: 22, borderRadius: 6, flexShrink: 0, display: 'inline-flex',
                        alignItems: 'center', justifyContent: 'center', fontSize: 14, fontWeight: 700, color: '#fff',
                        border: `2px solid ${on ? accent : '#9ca3af'}`, background: on ? accent : '#fff',
                      }}>{on ? '✓' : ''}</span>
                    </div>
                    <p className="mt-3 text-xl font-bold" style={{ color: due > 0 ? accent : '#15803d' }}>
                      {due > 0 ? money(due) : 'Paid up'}
                    </p>
                    <p className="text-[11px] text-gray-400">
                      {due > 0 ? 'due' : bal < 0 ? `in credit ${money(bal)}` : 'nothing owing'}
                    </p>
                    {on && (
                      // Editable once opened: lower it for a part payment, raise it for a
                      // prepayment — an overpayment simply becomes a credit on that account.
                      <div className="mt-3" onClick={e => e.stopPropagation()}>
                        <label className="block text-[11px] text-gray-500 mb-1">Amount</label>
                        <div className="flex items-center gap-1">
                          <span className="text-sm text-gray-500">$</span>
                          <input type="number" step="0.01" min="0"
                            value={amounts[b] ?? ''} onChange={e => setAmounts(a => ({ ...a, [b]: e.target.value }))}
                            className="w-full border border-gray-200 rounded-lg px-2 py-1.5 text-sm font-bold" />
                        </div>
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
            {buckets && (
              <p className="text-xs text-gray-400 mt-2">
                Account balance {money(buckets.accountBalance)} — {labels.camp} {money(buckets.camp.balance)} plus{' '}
                {labels.seasonal} {money(buckets.seasonal.balance)}.
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
                {/* THE SAME STRUCTURE THE FOLIO'S COLLECT PAYMENT MODAL USES: pick a way to take
                    the card, then see ONE of them. Showing the terminal panel and a key-entry
                    form stacked together is what made this screen look cluttered and duplicated. */}
                {terminalDeviceId && !checkoutId && (
                  <div className="grid grid-cols-2 gap-2 mb-3">
                    {([['terminal', 'Use Terminal'], ['manual', 'Enter Card Manually']] as const).map(([mode, label]) => (
                      <button key={mode} type="button" onClick={() => setCardEntryMode(mode)}
                        className="rounded-lg text-sm font-semibold border-2"
                        style={{ padding: '11px', borderColor: cardEntryMode === mode ? '#2E6B8A' : '#e5e7eb', background: cardEntryMode === mode ? '#e8f2f7' : '#fff', color: cardEntryMode === mode ? '#2E6B8A' : '#374151' }}>
                        {label}
                      </button>
                    ))}
                  </div>
                )}

                {surchargePct > 0 && (
                  <label className="flex items-center gap-2 text-xs text-gray-600 mb-2">
                    <input type="checkbox" checked={waiveFee} onChange={e => setWaiveFee(e.target.checked)} />
                    Waive the {surchargePct}% card fee
                  </label>
                )}

                {/* IN FLIGHT — the SHARED component the folio modal already uses, so both screens
                    show the same "Customer is paying on the terminal…" with the same Cancel charge
                    and Retry on terminal. Not a second, divergent terminal UI. */}
                {checkoutId ? (
                  <TerminalChargeControls
                    checkoutId={checkoutId}
                    onRetry={async () => { setCheckoutId(null); await sendToTerminal() }}
                    onCanceled={() => {
                      setCheckoutId(null)
                      toast('Charge cancelled — nothing was taken.', { icon: '↩️' })
                    }}
                    onCompleted={async () => {
                      // The money is recorded server-side by the same poll this component runs
                      // (idempotently), so by now it is on the folio. Move to the receipt step.
                      setCheckoutId(null)
                      setPaidTotal(grandTotal + creditCents)
                      setSelected({}); setAmounts({}); setNote(''); setWaiveFee(false)
                      setCashTendered(''); setKeepAsCredit(false)
                      toast.success('Card approved on the terminal.')
                      await load(guestId)
                    }}
                  />
                ) : cardEntryMode === 'terminal' && terminalDeviceId ? (
                  <div className="rounded-xl text-center" style={{ background: '#f0f9ff', border: '1px solid #bae6fd', padding: '1.25rem' }}>
                    <div style={{ fontSize: 28, marginBottom: 6 }}>💳</div>
                    <div style={{ fontWeight: 700, fontSize: 14, color: '#0369a1', marginBottom: 2 }}>Send to Square Terminal</div>
                    <div style={{ fontSize: 13, color: '#6b7280', marginBottom: 12 }}>
                      Amount: <strong>{money(baseTotal)}</strong>
                      {surcharge > 0 && <> + {surchargePct}% fee = <strong>{money(grandTotal)}</strong></>}
                    </div>
                    <button onClick={sendToTerminal} disabled={saving || baseTotal <= 0}
                      className="w-full rounded-xl font-bold text-white disabled:opacity-50"
                      style={{ background: '#2E6B8A', padding: '14px', fontSize: 16 }}>
                      Send to Terminal →
                    </button>
                  </div>
                ) : (
                  <>
                    {/* ONE container, mounted once by the effect above and torn down when this
                        leaves the screen. */}
                    <div id="lane-checkout-card" />
                    {!cardReady && !squareErr && <p className="text-sm text-gray-500 mt-2">Loading the card form…</p>}
                  </>
                )}

                {squareErr && <p className="text-sm text-amber-700 mt-2">{squareErr}</p>}
              </div>
            )}

            {method === 'cash' && baseTotal > 0 && (
              <div className="mt-3">
                <label className="block text-xs text-gray-500 mb-1">Cash tendered</label>
                <div className="flex items-center gap-1 mb-2">
                  <span className="text-sm text-gray-500">$</span>
                  <input type="number" step="0.01" min="0" value={cashTendered}
                    onChange={e => { setCashTendered(e.target.value); setKeepAsCredit(false) }}
                    placeholder="0.00" className={`${inp} font-bold`} />
                </div>
                {cashTendered !== '' && (overageCents > 0 || shortCents > 0) && (
                  <div className="rounded-lg px-3 py-2 mb-2 flex items-center justify-between text-sm font-semibold"
                    style={shortCents > 0
                      ? { background: '#fef2f2', border: '1px solid #fecaca', color: '#dc2626' }
                      : { background: '#f0fdf4', border: '1px solid #bbf7d0', color: '#15803d' }}>
                    <span>{shortCents > 0 ? 'Amount short' : keepAsCredit ? 'Kept as credit' : 'Change due'}</span>
                    <span className="font-extrabold">{money(shortCents > 0 ? shortCents : overageCents)}</span>
                  </div>
                )}
                {/* The SAME choice, the same wording, the same credit cap as the folio. */}
                {overageCents > 0 && maxCreditAmount > 0 && (
                  <>
                    <div className="flex gap-2">
                      <button type="button" onClick={() => setKeepAsCredit(false)}
                        className="flex-1 rounded-lg px-3 py-2 text-xs font-semibold border"
                        style={!keepAsCredit
                          ? { background: '#f3f4f6', borderColor: '#9ca3af', color: '#374151' }
                          : { background: '#fff', borderColor: '#e5e7eb', color: '#6b7280' }}>
                        Give {money(overageCents)} Change
                      </button>
                      <button type="button" disabled={overageExceedsCap}
                        onClick={() => !overageExceedsCap && setKeepAsCredit(true)}
                        className="flex-1 rounded-lg px-3 py-2 text-xs font-semibold border disabled:opacity-60"
                        style={keepAsCredit
                          ? { background: '#f0fdf4', borderColor: '#15803d', color: '#15803d' }
                          : { background: '#fff', borderColor: '#e5e7eb', color: overageExceedsCap ? '#9ca3af' : '#15803d' }}>
                        Apply {money(overageCents)} as Credit
                      </button>
                    </div>
                    {overageExceedsCap && (
                      <p className="text-xs mt-1 rounded px-2 py-1.5" style={{ background: '#fef3c7', border: '1px solid #fde68a', color: '#92400e' }}>
                        Overpayment of {money(overageCents)} exceeds the {money(maxCreditAmount)} credit limit — please give change instead.
                      </p>
                    )}
                    {keepAsCredit && (
                      <p className="text-xs text-gray-500 mt-1">
                        {creditLaneLabel
                          ? <>Kept as credit on <strong>{creditLaneLabel}</strong> — it comes off that lane&rsquo;s next charge. You can move it to another lane from the folio.</>
                          : <>Kept as an <strong>account credit</strong>. You&rsquo;re paying more than one lane, so it isn&rsquo;t filed against a particular one — file it from the folio in a tap.</>}
                      </p>
                    )}
                  </>
                )}
              </div>
            )}

            {/* An electronic tender cannot give change, so an overage there can only be a credit —
                and it lands in the LANE that was overpaid, not on the account. Same reasoning the
                folio prints for a card or check. */}
            {method !== 'cash' && BUCKETS.some(b => lineFor(b) > dueFor(b)) && (
              <p className="text-xs mt-3 rounded-lg px-3 py-2" style={{ background: '#f0fdf4', border: '1px solid #bbf7d0', color: '#166534' }}>
                One of these amounts is more than that account owes. {methodLabelOf(method)} can&rsquo;t give change, so the
                extra stays as a credit on that account and comes off its next charge.
              </p>
            )}

            <div className="mt-3">
              <label className="block text-xs text-gray-500 mb-1">Note (optional)</label>
              <input value={note} onChange={e => setNote(e.target.value)} className={inp} />
            </div>
          </div>
        </>
      )}

      {/* ── THE RECEIPT STEP (PR 4) ───────────────────────────────────────────────────────────
          Shown only AFTER money has changed hands. Both actions are optional and staff-driven,
          and both go through /api/receipt — the printable copy asks the same route to RENDER
          rather than SEND, so the printed and emailed receipts cannot differ. */}
      {paidTotal !== null && data && (
        <div className={card} style={{ borderColor: '#bbf7d0', background: '#f0fdf4' }}>
          <p className="text-sm font-bold text-green-800">{money(paidTotal)} taken from {data.guest?.name || 'this camper'}.</p>
          <p className="text-xs text-gray-600 mt-0.5 mb-3">The payment is recorded. A receipt is optional.</p>
          <div className="flex flex-wrap gap-2">
            {data.guest?.email ? (
              <button onClick={emailReceipt} disabled={emailing || emailed}
                className="px-4 py-2 rounded-lg text-sm font-bold text-white disabled:opacity-50" style={{ background: '#2E6B8A' }}>
                {emailed ? '✓ Emailed' : emailing ? 'Sending…' : `✉ Email receipt to ${data.guest.email}`}
              </button>
            ) : (
              <span className="text-xs text-gray-500 self-center">No email on file — print one instead.</span>
            )}
            <Link href={`/admin/receipt/${data.folioId}`} target="_blank"
              className="px-4 py-2 rounded-lg text-sm font-semibold border border-gray-300 text-gray-700 bg-white">
              🖨 Print receipt
            </Link>
            <button onClick={() => router.push(`/admin/seasonals/${guestId}`)}
              className="px-4 py-2 rounded-lg text-sm font-semibold border border-gray-200 text-gray-600 bg-white">
              Done
            </button>
          </div>
        </div>
      )}

      {/* RUNNING TOTAL — pinned, so the figure is always in view as cards are tapped. */}
      {data && !loading && (
        <div className="fixed inset-x-0 bottom-0 border-t border-gray-200 bg-white/95 backdrop-blur px-4 py-3 z-40">
          <div className="max-w-2xl mx-auto">
            <div className="flex items-end justify-between mb-2">
              <div>
                <p className="text-xs text-gray-500">
                  {BUCKETS.filter(b => lineFor(b) > 0).map(b => labels[b]).join(' + ') || 'Nothing selected'}
                </p>
                {surcharge > 0 && <p className="text-[11px] text-gray-400">includes {money(surcharge)} card fee</p>}
                {creditCents > 0 && <p className="text-[11px] text-green-700">plus {money(creditCents)} kept as account credit</p>}
              </div>
              <p className="text-2xl font-bold text-gray-900">{money(grandTotal)}</p>
            </div>
            <button onClick={takePayment}
              // No `!data.folioId` here any more: a camper with no folio is one who has simply
              // never been charged, and taking their first payment is what opens one.
              disabled={saving || baseTotal <= 0 || !!checkoutId || (method === 'card' && (cardEntryMode === 'terminal' || !cardReady))}
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
