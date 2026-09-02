'use client'
import { allPaymentMethods, methodLabel } from '@/lib/transactions'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { Fragment, useEffect, useRef, useState } from 'react'
import { createBrowserSupabase } from '@/lib/supabase-browser'
// ⚠ ONE ELECTRIC CALCULATION, SHARED. This page, the meter walk and the draft staging all price a
// reading through lib/electric-billing.ts. The arithmetic is byte-identical to the expression
// that used to live in updateReading() below — see the transcription test in
// lib/electric-billing.test.ts, which pins it.
import {
  computeElectricCharge, rateFromSettings, LEGACY_RATE_PER_KWH, LEGACY_MINIMUM_CHARGE_CENTS,
  type ElectricRate,
} from '@/lib/electric-billing'
import { detectReadingAnomaly } from '@/lib/meters'
import { normalizeBillingMode } from '@/lib/ledger-lanes'
import { seasonalBalanceOf, campFromAccount } from '@/lib/account-buckets'
// ⚠ THE APP'S ONE VOID RULE. Every other balance in the app — the folio, /api/guests/balances,
// laneBalances() — excludes voided charges. This page did not, so a camper with a voided charge
// showed a HIGHER balance here than on their own folio.
import { notVoided } from '@/lib/ledger'
import {
  cardStatus, primaryLabel, menuFor, tallyCards, matchesFilter, owesBalance,
  type CardRow, type CardFilter, type MenuActionId,
} from '@/lib/electric-billing-cards'
import {
  ELECTRIC_TOKENS, tokenText, insertAtCursor, unknownTokensIn,
} from '@/lib/electric-bill-tokens'
import { planElectricPost, postSkipLabel, allTimeBilled, describeVoid } from '@/lib/electric-billing'

// Security PR 7-1: the admin browser talks to Supabase as the LOGGED-IN USER, not as `anon`.
// Same publishable key, but it travels with the session cookie, so PostgREST runs these queries
// as `authenticated` and the role-gated RLS policies apply. Safe at module scope:
// createBrowserClient returns a singleton in the browser and a no-op cookie store during
// prerender.
const supabase = createBrowserSupabase()

type Guest = {
  id: string
  name: string
  email: string
  phone: string
  site_number: string
  is_seasonal: boolean
}

type ElectricReading = {
  id: string
  billing_month: string
  previous_reading: number
  current_reading: number
  kwh_used: number
  rate_per_kwh: number
  final_amount: number
  created_at: string
  notes: string
  /** A voided bill is off the camper's balance. The column exists in the schema and is already
   *  filtered when checking whether this month is billed; the history total honours it too. */
  voided?: boolean | null
  /** Who voided it, when, and why. Recorded at void time; displayed, never recomputed. */
  voided_by?: string | null
  voided_at?: string | null
  reason?: string | null
}

/**
 * One meter's contribution to a bill, as staged by a meter walk.
 *
 * ⚠ A SNAPSHOT OF WHAT WAS BILLED, not a live join to meter_readings. The reading is the record
 * of what the meter SAID in the field; this is the record of what the camper was CHARGED for. An
 * owner correcting an amount here has not changed what the meter read, and next month still
 * carries forward from the meter.
 */
type MeterLine = {
  meter_id: string
  meter_number: string
  previous_reading: number
  current_reading: number
  kwh: number
  is_reset?: boolean
  replaced_meter_final?: number | null
}

type FolioPayment = {
  id: string
  amount: number
  surcharge_amount: number
  method: string
  paid_at: string
  note: string
  receipt_sent_at: string | null
}

type CamperRow = {
  guest: Guest
  folioId: string
  folioBalance: number
  /** The seasonal slice of the same folio. Camp = folioBalance − this. Separated mode only;
   *  it is computed either way, because it costs nothing — the rows are already loaded. */
  seasonalBalance: number
  recentCharges: { id: string; description: string; line_total: number; charged_at: string }[]
  folioPayments: FolioPayment[]
  previousReading: string
  currentReading: string
  kwhUsed: number
  calculatedAmount: number
  finalAmount: string
  skip: boolean
  sent: boolean
  sending: boolean
  error: string
  showHistory: boolean
  showPayment: boolean
  paymentAmount: string
  paymentMethod: string
  paymentNote: string
  savingPayment: boolean
  lastPaymentRecorded: FolioPayment | null
  showReceiptConfirm: boolean
  sendingReceipt: boolean
  receiptSent: boolean
  readings: ElectricReading[]
  historyLoaded: boolean
  // ── Filled in by a meter walk (Part B). All absent on a park that never walks the meters. ──
  /** The id of the DRAFT electric_readings row this camper's figures came from, if any. */
  draftId: string
  /** The owner has looked at a flagged reading and chosen to bill it anyway. */
  anomalyAcknowledged: boolean
  /** True when this camper has been billed for electric before — so a zero baseline means a
   *  missing carry-forward rather than a genuinely new meter. */
  hadPriorBill: boolean
  /** One line per meter the camper holds. Empty for a bill typed in by hand, which is the
   *  pre-existing behaviour and still fully supported. */
  meterBreakdown: MeterLine[]
  /** The walk that produced the draft, for the "from the September walk" note. */
  draftReadDate: string
  editEmailMode: boolean
  editEmailValue: string
  showBillConfirm: boolean
}

const MONTH_NAMES = ['January','February','March','April','May','June','July','August','September','October','November','December']

// The month the owner almost always means: the one that just ENDED. Parks bill on the 1st
// for the period behind them, so seeding this box with the CURRENT month was permanently one
// month ahead of intent — and a whole batch can go out mislabelled before anyone notices.
// Rolls back across the year boundary (January -> December of the prior year). The owner can
// still pick any month; this only decides where the box opens.
function getPreviousMonthOption(): string {
  const now = new Date()
  const monthIdx = now.getMonth() - 1
  const year = monthIdx < 0 ? now.getFullYear() - 1 : now.getFullYear()
  return `${MONTH_NAMES[(monthIdx + 12) % 12]} ${year}`
}

function generateMonthOptions(): string[] {
  const now = new Date()
  // Start at the DEFAULT's year, not today's: in January the default is last December, and a
  // <select> whose value is absent from its own options renders blank. Outside January this
  // is the same two-year list as before.
  const startYear = now.getMonth() === 0 ? now.getFullYear() - 1 : now.getFullYear()
  const options: string[] = []
  for (let year = startYear; year <= now.getFullYear() + 1; year++) {
    for (const month of MONTH_NAMES) {
      options.push(`${month} ${year}`)
    }
  }
  return options
}

function parseMonthValue(s: string): number {
  const p = s.split(' ')
  return p.length === 2 ? parseInt(p[1]) * 12 + MONTH_NAMES.indexOf(p[0]) : 0
}

// --- The billing period, for the confirmation headline ------------------------------------
// Pure string math on ISO 'YYYY-MM-DD'; no Date is ever constructed here, so there is no
// timezone drift exactly at the month boundary. The period is half-open [start, end): the end
// is the next month's 1st, i.e. the meter-read boundary the bill runs up to. Derived from the
// month label alone, so a tenant whose electric_readings table has no period columns still
// gets the headline.
function pad2(n: number): string { return n < 10 ? '0' + n : String(n) }

function periodForMonth(billingMonth: string): { start: string; end: string } | null {
  const parts = billingMonth.trim().split(' ')
  if (parts.length !== 2) return null
  const monthIdx = MONTH_NAMES.indexOf(parts[0])
  const year = parseInt(parts[1], 10)
  if (monthIdx < 0 || !Number.isFinite(year)) return null
  const endYear = monthIdx === 11 ? year + 1 : year
  const endMonth = monthIdx === 11 ? 1 : monthIdx + 2 // 1-based next month
  return { start: `${year}-${pad2(monthIdx + 1)}-01`, end: `${endYear}-${pad2(endMonth)}-01` }
}

// 'YYYY-MM-DD' -> 'M/D/YY'
function fmtMDY(iso: string): string {
  const [y, m, d] = iso.split('-')
  return `${parseInt(m, 10)}/${parseInt(d, 10)}/${y.slice(2)}`
}

// "July 2026" -> "7/1/26-8/1/26" (en dash). '' if the label can't be parsed.
function periodLabel(billingMonth: string): string {
  const p = periodForMonth(billingMonth)
  return p ? `${fmtMDY(p.start)}\u2013${fmtMDY(p.end)}` : ''
}

// ── PRE-FILLING A MONTH: posted, draft, or carry-forward ─────────────────────────────────────
//
// This used to be copy-pasted between fetchCampers() and handleMonthChange(). It is one function
// now because the meter walk gives it a THIRD case to handle, and two copies of a three-branch
// rule is how one of them silently keeps only two.
//
// The three cases, in the order they are tested:
//
//   1. A POSTED bill for this month  -> show it and mark the row ✓ Billed. Unchanged behaviour:
//      before drafts existed, the mere existence of a row meant exactly this.
//   2. A DRAFT for this month        -> pre-fill readings AND the amount, and leave the row
//      BILLABLE. This is the meter walk's output: reviewed here, posted here, never sooner.
//   3. Neither                       -> carry the most recent prior month's current reading into
//      "previous", exactly as before.
//
// ⚠ CASE 2 MUST NOT SET `sent`. A draft that marked itself billed would disable its own Bill
// Electric button, and a whole month of walked meters would sit on the screen looking finished
// while nothing had been charged and nothing had been sent.
async function applyMonthReadings(row: CamperRow, month: string, rate: ElectricRate): Promise<CamperRow> {
  const { data: readings } = await supabase
    .from('electric_readings')
    .select('id, billing_month, previous_reading, current_reading, kwh_used, calculated_amount, final_amount, status, meter_breakdown, reading_session_id, created_at')
    .eq('guest_id', row.guest.id)
    .order('created_at', { ascending: false })

  const cleared: CamperRow = {
    ...row, previousReading: '', currentReading: '', kwhUsed: 0, calculatedAmount: 0,
    finalAmount: '', sent: false, draftId: '', meterBreakdown: [], draftReadDate: '',
  }
  if (!readings || readings.length === 0) return cleared

  const thisMonth = readings.filter(r => r.billing_month === month)
  const posted = thisMonth.find(r => r.status !== 'draft')
  if (posted) {
    return {
      ...cleared,
      previousReading: String(posted.previous_reading),
      currentReading: String(posted.current_reading),
      kwhUsed: Number(posted.kwh_used) || 0,
      calculatedAmount: Number(posted.calculated_amount) || 0,
      finalAmount: ((Number(posted.final_amount) || 0) / 100).toFixed(2),
      meterBreakdown: Array.isArray(posted.meter_breakdown) ? posted.meter_breakdown as MeterLine[] : [],
      sent: true,
    }
  }

  const draft = thisMonth.find(r => r.status === 'draft')
  if (draft) {
    const kwh = Number(draft.kwh_used) || 0
    // Recomputed from the CURRENT rate rather than trusted from the draft, so an owner who
    // corrects the rate before reviewing sees the corrected money — the readings are the fact,
    // the price is a setting.
    const recalculated = computeElectricCharge(kwh, rate).calculatedAmountCents
    const stored = Number(draft.calculated_amount) || 0
    const storedFinal = Number(draft.final_amount) || 0
    // An owner's edit survives; an untouched draft follows the calculation.
    const edited = storedFinal !== stored
    return {
      ...cleared,
      previousReading: String(draft.previous_reading),
      currentReading: String(draft.current_reading),
      kwhUsed: kwh,
      calculatedAmount: recalculated,
      finalAmount: ((edited ? storedFinal : recalculated) / 100).toFixed(2),
      meterBreakdown: Array.isArray(draft.meter_breakdown) ? draft.meter_breakdown as MeterLine[] : [],
      draftId: String(draft.id),
      draftReadDate: String(draft.created_at || ''),
      sent: false,
    }
  }

  // ⚠ CARRY-FORWARD IGNORES DRAFTS FROM OTHER MONTHS. A draft is a proposal; taking its current
  // reading as this month's "previous" would carry a number nobody has confirmed.
  const selectedVal = parseMonthValue(month)
  const prior = readings.filter(r => r.status !== 'draft' && parseMonthValue(r.billing_month) < selectedVal)
  if (prior.length === 0) return cleared
  return { ...cleared, previousReading: String(prior[0].current_reading) }
}

// The one fact a busy person must not be able to skate past: WHICH MONTH is being billed.
// Deliberately the largest thing in either confirmation, above the amount and the recipient.
function MonthHeadline({ lead, billingMonth }: { lead: string; billingMonth: string }) {
  const period = periodLabel(billingMonth)
  return (
    <div style={{ background: '#fff', border: '2px solid #1e40af', borderRadius: 9, padding: '10px 14px', marginBottom: 12 }}>
      <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', color: '#6b7280' }}>{lead}</div>
      <div style={{ fontSize: 26, fontWeight: 800, letterSpacing: '0.01em', color: '#1e3a8a', lineHeight: 1.2 }}>
        {billingMonth.toUpperCase()}
      </div>
      {period && (
        <div style={{ fontSize: 15, fontWeight: 700, color: '#1e40af' }}>
          {'\u00b7'} {period}
        </div>
      )}
    </div>
  )
}

export default function ElectricBillingPage() {
  const router = useRouter()

  useEffect(() => {
    supabase.from('settings').select('plan, pos_enabled, custom_payment_methods, max_credit_amount').single().then(({ data }) => {
      setCustomMethods((data as any)?.custom_payment_methods || [])
      setMaxCreditAmount((data as any)?.max_credit_amount || 0)
      if (data?.plan !== 'summit') router.replace('/admin')
    })
  }, [])

  const [campers, setCampers] = useState<CamperRow[]>([])
  const [customMethods, setCustomMethods] = useState<string[]>([])
  // Same credit cap the guest folio enforces, so an overpayment taken here is held to the
  // same limit rather than being the one door with no check on it.
  const [maxCreditAmount, setMaxCreditAmount] = useState(0)
  const [loading, setLoading] = useState(true)
  // ── THE PARK'S RATE ────────────────────────────────────────────────────────────────────────
  //
  // These two boxes used to be page-local state seeded with '0.27' / '15.00' and never saved
  // anywhere: the owner retyped their rate every visit, and one park's rates were hard-coded into
  // the blueprint every park is cloned from. They now load from settings and save with the
  // message, and the meter walk reads the same stored values — which is what lets the live "≈ $"
  // on the phone agree with the bill on this screen.
  //
  // ⚠ THE BOXES STILL OPEN AT 0.27 / 15.00 FOR A PARK THAT HAS NEVER SAVED ONE, so nothing about
  // this screen changes for a park that ignores the new setting. See rateFromSettings().
  const [ratePerKwh, setRatePerKwh] = useState(String(LEGACY_RATE_PER_KWH))
  const [minimumCharge, setMinimumCharge] = useState((LEGACY_MINIMUM_CHARGE_CENTS / 100).toFixed(2))
  const [savingRate, setSavingRate] = useState(false)
  const [rateSaved, setRateSaved] = useState('')

  // The single source of truth for pricing on this page. Derived from the boxes so an unsaved
  // edit previews immediately, exactly as it did before.
  const rate: ElectricRate = {
    ratePerKwh: parseFloat(ratePerKwh) || LEGACY_RATE_PER_KWH,
    minimumChargeCents: Math.round((parseFloat(minimumCharge) || LEGACY_MINIMUM_CHARGE_CENTS / 100) * 100),
  }
  const [activeTab, setActiveTab] = useState<'billing' | 'history'>('billing')
  const [billingMonth, setBillingMonth] = useState(getPreviousMonthOption)
  const [emailMessage, setEmailMessage] = useState("Please find your monthly electric statement below. If you have any questions, please don't hesitate to reach out.")
  const [sendingAll, setSendingAll] = useState(false)
  // The bulk action now asks first, and the ask leads with the month (see MonthHeadline).
  const [showSendAllConfirm, setShowSendAllConfirm] = useState(false)
  // ── Redesign UI state. Presentation only: none of these change what is billed. ──
  /** Which card's "⋯" menu is open. One at a time, closed on outside click. */
  /** ⚠ ITS OWN GUARDED SELECT, and it fails safe to 'combined'. A park that has not run the
   *  Phase 4 migration has no billing_mode column; folding this into another settings query would
   *  fail that query and take the screen with it. */
  const [billingMode, setBillingMode] = useState<'combined' | 'separated'>('combined')
  const [openMenu, setOpenMenu] = useState<number | null>(null)
  /** Which card has its inline edit panel open. */
  const [editing, setEditing] = useState<number | null>(null)
  /** The gentle filter tabs. A VIEW filter — Send All still walks the whole list. */
  const [filter, setFilter] = useState<CardFilter>('ready')
  /** The billing settings (rate, minimum, email message) start folded away. */
  const [showSettings, setShowSettings] = useState(false)
  /** The bill-email box, so a clicked merge field lands at the cursor rather than at the end. */
  const emailBoxRef = useRef<HTMLTextAreaElement | null>(null)
  const [autoPopulating, setAutoPopulating] = useState(false)

  const monthOptions = generateMonthOptions()

  useEffect(() => { fetchCampers(); fetchMessage() }, [])
  useEffect(() => {
    supabase.from('settings').select('billing_mode').single()
      .then(({ data, error }) => { if (!error) setBillingMode(normalizeBillingMode(data?.billing_mode)) })
  }, [])

  async function fetchMessage() {
    const { data } = await supabase.from('settings')
      .select('electric_bill_message, electric_rate_per_kwh, electric_minimum_charge').single()
    if (data?.electric_bill_message) setEmailMessage(data.electric_bill_message)
    // A park that has never saved a rate keeps the boxes it has always seen.
    const stored = rateFromSettings(data)
    if (data?.electric_rate_per_kwh !== null && data?.electric_rate_per_kwh !== undefined) {
      setRatePerKwh(String(stored.ratePerKwh))
    }
    if (data?.electric_minimum_charge !== null && data?.electric_minimum_charge !== undefined) {
      setMinimumCharge((stored.minimumChargeCents / 100).toFixed(2))
    }
  }

  // Saving the rate is what makes it reach the phone. Without it the walk's live usage preview
  // would price at the fallback while this screen priced at whatever was typed here.
  async function saveRate() {
    setSavingRate(true); setRateSaved('')
    const { data: row } = await supabase.from('settings').select('id').single()
    const { error } = await supabase.from('settings').update({
      electric_rate_per_kwh: rate.ratePerKwh,
      electric_minimum_charge: rate.minimumChargeCents,
    }).eq('id', row?.id)
    setSavingRate(false)
    setRateSaved(error ? 'Could not save the rate.' : 'Rate saved — the meter-reading screen will use it too.')
  }

  async function saveMessage() {
    await supabase.from('settings').update({ electric_bill_message: emailMessage }).eq('id', (await supabase.from('settings').select('id').single()).data?.id)
    alert('Message saved!')
  }

  /**
   * The balance this screen shows for a camper.
   *
   * ⚠ SEPARATED PARKS SEE THE CAMP ACCOUNT, NOT THE WHOLE ACCOUNT. This is the ELECTRIC screen:
   * a seasonal camper with an outstanding season fee must not appear here as owing it. Their
   * $32 of electric should read $32, not $1,632 — the same rule the camper's own bill follows.
   *
   * Camp is the account remainder (account − seasonal), which is exact even though almost no
   * payment carries a lane. See campFromAccount().
   *
   * COMBINED PARKS ARE UNTOUCHED: they read folioBalance, exactly as before, and never consult
   * the seasonal slice at all.
   */
  const shownBalance = (row: CamperRow) =>
    billingMode === 'separated'
      ? campFromAccount(row.folioBalance, row.seasonalBalance)
      : row.folioBalance

  async function fetchCampers() {
    setLoading(true)
    const { data: guests } = await supabase.from('guests').select('*').eq('electric_billing_enabled', true)
    const sortedGuests = (guests || []).sort((a, b) => parseInt(a.site_number) - parseInt(b.site_number))
    if (sortedGuests.length === 0) { setLoading(false); return }

    const rows: CamperRow[] = await Promise.all(sortedGuests.map(async (guest: Guest) => {
      const { data: folio } = await supabase
        .from('folios').select('id').eq('guest_id', guest.id)
        .eq('folio_type', 'guest_account').eq('status', 'open').single()

      let folioBalance = 0
      let seasonalBalance = 0
      let recentCharges: any[] = []
      let folioPayments: FolioPayment[] = []

      if (folio) {
        const [{ data: items }, { data: pmts }] = await Promise.all([
          supabase.from('folio_line_items').select('*').eq('folio_id', folio.id).order('charged_at'),
          supabase.from('folio_payments').select('*').eq('folio_id', folio.id).eq('status', 'completed').order('paid_at', { ascending: false }),
        ])
        // ⚠ VOIDED CHARGES ARE NOT COUNTED, but they are still SHOWN. `recentCharges` keeps the
        // full list below so a voided row remains visible and marked; only the totals exclude it.
        const liveItems = (items || []).filter(notVoided)
        const itemsTotal = liveItems.reduce((sum: number, i: any) => sum + i.line_total, 0)
        const paymentsTotal = (pmts || []).reduce((sum: number, p: any) => sum + p.amount - (p.surcharge_amount || 0), 0)
        folioBalance = itemsTotal - paymentsTotal
        // ⚠ THE SAME ROWS, SUMMED THE SAME WAY as folioBalance above — void-filtered, payments net
        // of surcharge — because Camp is the REMAINDER of that figure. Two different summation
        // rules here would make camp + seasonal fail to equal the account.
        seasonalBalance = seasonalBalanceOf(liveItems, pmts || [])
        recentCharges = items || []
        folioPayments = pmts || []
      }

      // Check if the most recent payment has a receipt sent
      const mostRecentPayment = folioPayments.length > 0 ? folioPayments[0] : null
      const receiptAlreadySent = mostRecentPayment?.receipt_sent_at ? true : false

      return {
        guest, folioId: folio?.id || '', folioBalance, seasonalBalance, recentCharges, folioPayments,
        previousReading: '', currentReading: '', kwhUsed: 0, calculatedAmount: 0, finalAmount: '',
        skip: false, sent: false, sending: false, error: '',
        showHistory: false, showPayment: false, paymentAmount: '', paymentMethod: 'cash', paymentNote: '', savingPayment: false, editEmailMode: false, editEmailValue: '', showBillConfirm: false,
        lastPaymentRecorded: mostRecentPayment, showReceiptConfirm: false, sendingReceipt: false, receiptSent: receiptAlreadySent,
        readings: [], historyLoaded: false,
        draftId: '', meterBreakdown: [], draftReadDate: '',
        anomalyAcknowledged: false, hadPriorBill: false,
      }
    }))

    const populatedRows = await Promise.all(rows.map(row => applyMonthReadings(row, billingMonth, rate)))
    setCampers(populatedRows)
    setLoading(false)
  }

 async function handleMonthChange(newMonth: string) {
    setBillingMonth(newMonth)
    setShowSendAllConfirm(false) // never leave a confirmation open across a month change
    if (campers.length === 0) return
    setAutoPopulating(true)

    const updatedCampers = await Promise.all(campers.map(row => applyMonthReadings(row, newMonth, rate)))
    setCampers(updatedCampers)
    setAutoPopulating(false)
  }

  async function loadHistory(index: number) {
    const row = campers[index]
    if (row.historyLoaded) {
      setCampers(prev => { const u = [...prev]; u[index] = { ...u[index], showHistory: !u[index].showHistory }; return u })
      return
    }
    // Posted only: this is the record of what this camper has been BILLED. A draft is a proposal.
    const { data } = await supabase.from('electric_readings').select('*').eq('guest_id', row.guest.id).eq('status', 'posted').order('created_at', { ascending: false })
    setCampers(prev => { const u = [...prev]; u[index] = { ...u[index], readings: data || [], historyLoaded: true, showHistory: true }; return u })
  }

  async function recordPayment(index: number) {
    const row = campers[index]
    if (!row.folioId || !row.paymentAmount) return
    setCampers(prev => { const u = [...prev]; u[index] = { ...u[index], savingPayment: true }; return u })

    const amountCents = Math.round(parseFloat(row.paymentAmount) * 100)
    // Anything beyond the balance becomes an account credit. Warn rather than block: this
    // screen records money already received, so refusing would leave it recorded nowhere.
    //
    // ⚠ MEASURED AGAINST THE BALANCE THE OPERATOR IS LOOKING AT. On a separated park this screen
    // shows — and this button pays down — the CAMP ACCOUNT. Measuring the overpayment against the
    // whole account instead meant an electric overpayment went unrecognised for as long as any
    // seasonal balance was outstanding: pay $100 against a $42 Camp balance while $2,000 of season
    // fee is owing, and the $58 credit was silently not flagged. shownBalance() is the same figure
    // the pill and the panel show, so the warning now matches what is on screen.
    //
    // COMBINED IS UNCHANGED: shownBalance() returns folioBalance there, exactly as before.
    const creditCents = Math.max(0, amountCents - Math.max(0, shownBalance(row)))
    if (creditCents > 0 && maxCreditAmount > 0 && creditCents > maxCreditAmount) {
      if (!confirm('This will add a credit of $' + (creditCents / 100).toFixed(2) + ', which exceeds the $' + (maxCreditAmount / 100).toFixed(2) + ' credit limit for this account. Add it anyway?')) {
        setCampers(prev => { const u = [...prev]; u[index] = { ...u[index], savingPayment: false }; return u })
        return
      }
    }

    const { data: newPayment } = await supabase.from('folio_payments').insert({
      folio_id: row.folioId, method: row.paymentMethod, amount: amountCents,
      surcharge_amount: 0, status: 'completed', note: row.paymentNote || null,
    }).select().single()

    const [{ data: items }, { data: pmts }] = await Promise.all([
      supabase.from('folio_line_items').select('*').eq('folio_id', row.folioId),
      supabase.from('folio_payments').select('*').eq('folio_id', row.folioId).eq('status', 'completed'),
    ])
    const liveItems = (items || []).filter(notVoided)
    const itemsTotal = liveItems.reduce((sum: number, i: any) => sum + i.line_total, 0)
    const paymentsTotal = (pmts || []).reduce((sum: number, p: any) => sum + p.amount - (p.surcharge_amount || 0), 0)
    // Not clamped at zero. An overpayment leaves the folio negative and that negative IS the
    // account credit — clamping it here recorded the credit but hid it, so the operator saw a
    // settled account and no sign of the money sitting on it.
    const newBalance = itemsTotal - paymentsTotal
    // Recomputed alongside the account balance, from the same rows, so the Camp figure the pill
    // shows cannot go stale after a payment.
    const newSeasonal = seasonalBalanceOf(liveItems, pmts || [])

    setCampers(prev => {
      const u = [...prev]
      u[index] = { ...u[index], folioBalance: newBalance, seasonalBalance: newSeasonal, folioPayments: pmts || [], savingPayment: false, showPayment: false, paymentAmount: '', paymentNote: '', lastPaymentRecorded: newPayment || null, showReceiptConfirm: false, receiptSent: false }
      return u
    })
  }

  async function sendReceipt(index: number) {
    const row = campers[index]
    if (!row.lastPaymentRecorded || !row.guest.email) return
    setCampers(prev => { const u = [...prev]; u[index] = { ...u[index], sendingReceipt: true }; return u })

    const res = await fetch('/api/electric-payment-receipt', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        guestName: row.guest.name, guestEmail: row.guest.email, siteNumber: row.guest.site_number,
        paymentAmount: row.lastPaymentRecorded.amount, paymentMethod: row.lastPaymentRecorded.method,
        paymentNote: row.lastPaymentRecorded.note, paidAt: row.lastPaymentRecorded.paid_at,
        // ⚠ THE FOLIO IS WHAT MATTERS NOW. /api/electric-payment-receipt recomputes the balance
        // it states from this folio — the Camp Account in separated mode, the whole account in
        // combined — so no figure from this screen can put a wrong balance in a camper's receipt.
        // `remainingBalance` is still sent as the route's fallback for a folio it cannot read.
        folioId: row.folioId,
        remainingBalance: shownBalance(row), paymentId: row.lastPaymentRecorded.id,
      }),
    })
    const data = await res.json()
    if (data.success) {
      // Update the payment in local state with the receipt timestamp
      const now = new Date().toISOString()
      setCampers(prev => {
        const u = [...prev]
        u[index] = {
          ...u[index],
          sendingReceipt: false,
          receiptSent: true,
          showReceiptConfirm: false,
          lastPaymentRecorded: u[index].lastPaymentRecorded
            ? { ...u[index].lastPaymentRecorded, receipt_sent_at: now }
            : null,
          folioPayments: u[index].folioPayments.map(p =>
            p.id === u[index].lastPaymentRecorded?.id ? { ...p, receipt_sent_at: now } : p
          ),
        }
        return u
      })
    } else {
      setCampers(prev => { const u = [...prev]; u[index] = { ...u[index], sendingReceipt: false, showReceiptConfirm: false }; return u })
    }
  }

  function updateReading(index: number, field: 'previousReading' | 'currentReading', value: string) {
    setCampers(prev => {
      const updated = [...prev]
      updated[index] = { ...updated[index], [field]: value }
      const prev_r = parseFloat(field === 'previousReading' ? value : updated[index].previousReading) || 0
      const curr_r = parseFloat(field === 'currentReading' ? value : updated[index].currentReading) || 0
      // ⚠ EDITING A READING BY HAND DROPS THE PER-METER LINES. Those lines describe a specific
      // pair of meter numbers; once the totals are typed over, they no longer describe the bill,
      // and showing stale lines under a corrected total is worse than showing none. The readings
      // themselves are untouched in meter_readings.
      if (updated[index].meterBreakdown.length) updated[index].meterBreakdown = []
      const { kwhUsed: kwh, calculatedAmountCents: calculated } =
        computeElectricCharge(Math.max(0, curr_r - prev_r), rate)
      updated[index].kwhUsed = kwh
      updated[index].calculatedAmount = calculated
      if (updated[index].finalAmount === '' || updated[index].finalAmount === (updated[index].calculatedAmount / 100).toFixed(2)) {
        updated[index].finalAmount = (calculated / 100).toFixed(2)
      }
      return updated
    })
  }

  function updateFinalAmount(index: number, value: string) {
    setCampers(prev => { const u = [...prev]; u[index] = { ...u[index], finalAmount: value }; return u })
  }

  function toggleSkip(index: number) {
    setCampers(prev => { const u = [...prev]; u[index] = { ...u[index], skip: !u[index].skip }; return u })
  }

  function updatePaymentField(index: number, field: string, value: string) {
    setCampers(prev => { const u = [...prev]; u[index] = { ...u[index], [field]: value }; return u })
  }

  async function resendBill(index: number, overrideEmail?: string) {
    const row = campers[index]
    const emailToUse = overrideEmail || row.guest.email
    if (!emailToUse) return
    setCampers(prev => { const u = [...prev]; u[index] = { ...u[index], sending: true, error: '', editEmailMode: false }; return u })

    // Just re-send the email — don't touch the database
    const { data: allItems } = await supabase.from('folio_line_items').select('*').eq('folio_id', row.folioId).order('charged_at')
    const { data: allPayments } = await supabase.from('folio_payments').select('*').eq('folio_id', row.folioId).eq('status', 'completed')
    const liveAllItems = (allItems || []).filter(notVoided)
    const itemsTotal = liveAllItems.reduce((sum: number, i: any) => sum + i.line_total, 0)
    const paymentsTotal = (allPayments || []).reduce((sum: number, p: any) => sum + p.amount - (p.surcharge_amount || 0), 0)
    const balance = Math.max(0, itemsTotal - paymentsTotal)

    const thisElectricDesc = billingMonth + ' Electric'
    const electricItem = (allItems || []).find((i: any) => i.description === thisElectricDesc)
    const electricAmount = electricItem?.line_total || row.calculatedAmount

    // ⚠ POSTED ONLY. A draft has never been sent to anybody, so letting one answer "when was the
    // last bill sent" would date the balance-forward split from a walk nobody has reviewed and
    // silently move charges between "brought forward" and "new this month" on a real statement.
    const { data: prevBills } = await supabase.from('electric_readings').select('created_at')
      .eq('guest_id', row.guest.id).neq('billing_month', billingMonth).eq('status', 'posted')
      .order('created_at', { ascending: false }).limit(1)
    const previousBillSentAt = prevBills && prevBills.length > 0 ? prevBills[0].created_at : null

    const newLineItems = (allItems || []).filter((item: any) => {
      if (item.description === thisElectricDesc) return false
      if (!previousBillSentAt) return true
      return new Date(item.charged_at) > new Date(previousBillSentAt)
    })
    const newLineItemsTotal = newLineItems.reduce((s: number, i: any) => s + i.line_total, 0)
    const previousBalance = balance - electricAmount - newLineItemsTotal

    // Payments received since last bill
    const paymentsReceivedAmt = (allPayments || [])
      .filter((p: any) => !previousBillSentAt || new Date(p.paid_at) > new Date(previousBillSentAt))
      .reduce((s: number, p: any) => s + p.amount - (p.surcharge_amount || 0), 0)
    const chargesBeforeResend = (allItems || [])
      .filter((i: any) => i.description !== thisElectricDesc && (!previousBillSentAt || new Date(i.charged_at) <= new Date(previousBillSentAt)))
      .reduce((s: number, i: any) => s + i.line_total, 0)
    const paymentsBeforeResend = (allPayments || [])
      .filter((p: any) => !previousBillSentAt || new Date(p.paid_at) <= new Date(previousBillSentAt))
      .reduce((s: number, p: any) => s + p.amount - (p.surcharge_amount || 0), 0)
    const balanceForwardResend = chargesBeforeResend - paymentsBeforeResend
    const liveBalanceResend = itemsTotal - paymentsTotal

    const res = await fetch('/api/electric-bill-email', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        guestName: row.guest.name, guestEmail: emailToUse, siteNumber: row.guest.site_number,
        folioId: row.folioId,
        billingMonth, emailMessage, electricAmount,
        newCharges: newLineItems, paymentsReceived: paymentsReceivedAmt,
        totalBalance: liveBalanceResend, balanceForward: balanceForwardResend,
        kwhUsed: row.kwhUsed,
      }),
    })
    const data = await res.json()
    setCampers(prev => { const u = [...prev]; u[index] = { ...u[index], sending: false, error: data.success ? '' : (data.error || 'Failed to send') }; return u })
  }

  async function sendBill(index: number) {
    const row = campers[index]
    if (row.skip || row.sent) return
    if (!row.guest.email) { setCampers(prev => { const u = [...prev]; u[index] = { ...u[index], error: 'No email on file' }; return u }); return }
    const finalAmountCents = Math.round(parseFloat(row.finalAmount) * 100) || row.calculatedAmount

    // ⚠ THE DOUBLE-BILL GUARD. Asks the DATABASE whether this camper already has a posted bill
    // for this month, rather than trusting the screen's `sent` flag — `sent` is React state and
    // is false after a reload, so a camper billed yesterday, or on another machine, or left
    // behind as an orphaned draft, looks unbilled to this page.
    const { data: alreadyPosted } = await supabase.from('electric_readings')
      .select('id').eq('guest_id', row.guest.id).eq('billing_month', billingMonth)
      .eq('status', 'posted').eq('voided', false).limit(1)
    const plan = planElectricPost({
      alreadyPostedThisMonth: (alreadyPosted?.length || 0) > 0,
      skipped: row.skip,
      draftId: row.draftId,
      finalAmountCents,
    })
    if (plan.action === 'skip') {
      setCampers(prev => { const u = [...prev]; u[index] = { ...u[index], sending: false, error: postSkipLabel(plan.reason) }; return u })
      return
    }
    setCampers(prev => { const u = [...prev]; u[index] = { ...u[index], sending: true, error: '' }; return u })

    let folioId = row.folioId
    if (!folioId) {
      const { data: newFolio } = await supabase.from('folios').insert({
        guest_id: row.guest.id, guest_name: row.guest.name, guest_email: row.guest.email,
        folio_type: 'guest_account', status: 'open', label: 'Seasonal Account',
      }).select().single()
      if (newFolio) folioId = newFolio.id
    }

    const { data: lineItem } = await supabase.from('folio_line_items').insert({
      folio_id: folioId, product_id: null, description: billingMonth + ' Electric',
      quantity: 1, unit_price: finalAmountCents, tax_amount: 0, line_total: finalAmountCents, category: 'Fees',
    }).select().single()

    // ⚠ THIS IS THE ONE PLACE A CHARGE IS CREATED, AND IT IS UNCHANGED. The folio_line_items
    // insert above is the money; what follows only records the reading against it.
    //
    // The one thing that IS new: when a meter walk staged a draft for this camper and month, the
    // draft is PROMOTED to posted rather than a second row being inserted beside it. Two rows for
    // one month would double-count the camper in every history and total on this page, and leave
    // a draft behind that the next walk would try to update.
    const readingRow = {
      guest_id: row.guest.id, billing_month: billingMonth,
      previous_reading: parseFloat(row.previousReading) || 0,
      current_reading: parseFloat(row.currentReading) || 0,
      kwh_used: row.kwhUsed, rate_per_kwh: rate.ratePerKwh,
      minimum_charge: rate.minimumChargeCents,
      calculated_amount: row.calculatedAmount, final_amount: finalAmountCents,
      folio_line_item_id: lineItem?.id || null,
      status: 'posted',
    }
    // ⚠ POSTING CONSUMES THE DRAFT — it is PROMOTED in place, draft -> posted, not copied.
    // Inserting a new posted row and leaving the draft behind is what stranded 47 postable
    // orphans on a live park after a correct billing run.
    //
    // ⚠ AND THE RESULT IS CHECKED. `.select()` makes PostgREST return the affected rows; an
    // empty array means the promotion did not happen (a missing grant, a row already posted by
    // someone else, RLS) and we must NOT silently continue as though it had — falling back to an
    // insert here is what turns a blocked write into a duplicate. That exact silence, on a
    // delete whose result nobody read, is how the orphans were created.
    if (plan.consumesDraftId) {
      const { data: promoted } = await supabase.from('electric_readings')
        .update(readingRow).eq('id', plan.consumesDraftId).eq('status', 'draft').select('id')
      if (!promoted || promoted.length === 0) {
        setCampers(prev => { const u = [...prev]; u[index] = { ...u[index], sending: false, error: 'Could not convert the draft into a bill — nothing was billed. Reload and try again.' }; return u })
        return
      }
    } else {
      await supabase.from('electric_readings').insert(readingRow)
    }

    const { data: allItems } = await supabase.from('folio_line_items').select('*').eq('folio_id', folioId).order('charged_at')
    const { data: allPayments } = await supabase.from('folio_payments').select('*').eq('folio_id', folioId).eq('status', 'completed').order('paid_at')
    const liveAllItems = (allItems || []).filter(notVoided)
    const itemsTotal = liveAllItems.reduce((sum: number, i: any) => sum + i.line_total, 0)
    const paymentsTotal = (allPayments || []).reduce((sum: number, p: any) => sum + p.amount - (p.surcharge_amount || 0), 0)
    // Live folio balance — matches what shows in their guest folio exactly
    const liveBalance = itemsTotal - paymentsTotal
    const liveSeasonal = seasonalBalanceOf(liveAllItems, allPayments || [])

    // Find the date the previous electric bill was sent for this camper
    // ⚠ POSTED ONLY — same reason as in resendBill() above.
    const { data: prevBills } = await supabase
      .from('electric_readings')
      .select('created_at')
      .eq('guest_id', row.guest.id)
      .neq('billing_month', billingMonth)
      .eq('status', 'posted')
      .order('created_at', { ascending: false })
      .limit(1)
    const previousBillSentAt = prevBills && prevBills.length > 0 ? prevBills[0].created_at : null

    const thisElectricDesc = billingMonth + ' Electric'

    // Balance Forward = everything owed BEFORE this billing month
    // = all charges before this electric bill minus all payments before this electric bill
    const chargesBefore = (allItems || [])
      .filter((i: any) => i.description !== thisElectricDesc && (!previousBillSentAt || new Date(i.charged_at) <= new Date(previousBillSentAt)))
      .reduce((s: number, i: any) => s + i.line_total, 0)
    const paymentsBefore = (allPayments || [])
      .filter((p: any) => !previousBillSentAt || new Date(p.paid_at) <= new Date(previousBillSentAt))
      .reduce((s: number, p: any) => s + p.amount - (p.surcharge_amount || 0), 0)
    const balanceForward = chargesBefore - paymentsBefore

    // New charges since last bill (excluding this month's electric — shown separately)
    const newCharges = (allItems || []).filter((item: any) => {
      if (item.description === thisElectricDesc) return false
      if (!previousBillSentAt) return true
      return new Date(item.charged_at) > new Date(previousBillSentAt)
    })

    // Payments received since last bill
    const paymentsReceivedAmount = (allPayments || [])
      .filter((p: any) => !previousBillSentAt || new Date(p.paid_at) > new Date(previousBillSentAt))
      .reduce((s: number, p: any) => s + p.amount - (p.surcharge_amount || 0), 0)

    const res = await fetch('/api/electric-bill-email', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        guestName: row.guest.name, guestEmail: row.guest.email, siteNumber: row.guest.site_number,
        folioId,
        billingMonth, emailMessage, electricAmount: finalAmountCents,
        newCharges, paymentsReceived: paymentsReceivedAmount,
        totalBalance: liveBalance, balanceForward,
        kwhUsed: row.kwhUsed,
      }),
    })
    const data = await res.json()
    setCampers(prev => { const u = [...prev]; u[index] = { ...u[index], sending: false, sent: data.success, folioId, folioBalance: liveBalance, seasonalBalance: liveSeasonal, historyLoaded: false, draftId: data.success ? '' : u[index].draftId, error: data.success ? '' : (data.error || 'Failed to send') }; return u })
  }

  async function sendAllBills() {
    setSendingAll(true)
    // ⚠ EVERY ROW STILL GOES THROUGH sendBill(), WHICH ASKS THE DATABASE FIRST. The `sent` check
    // here is only a cheap skip for rows billed in this session; the guard that actually prevents
    // a second bill lives in sendBill() and cannot be bypassed from here. Bulk posting is exactly
    // where a stray leftover draft would otherwise become 47 duplicate charges in one click.
    for (let i = 0; i < campers.length; i++) {
      if (!campers[i].skip && !campers[i].sent) await sendBill(i)
    }
    setSendingAll(false)
  }

  // The guard, per row. Reads the meter lines when a walk staged them, otherwise the row's own
  // typed figures — so a hand-entered bill is checked too.
  function anomalyFor(row: CamperRow) {
    if (row.sent) return null
    const prev = parseFloat(row.previousReading)
    const curr = parseFloat(row.currentReading)
    if (!Number.isFinite(curr)) return null
    // "Has history" = this camper has been billed before, which is exactly when a zero baseline
    // means something went missing rather than the meter genuinely starting at zero.
    const hasPriorHistory = row.readings.length > 0 || row.folioPayments.length > 0 || row.hadPriorBill
    const recentKwh = row.readings.slice(0, 4).map(r => Number(r.kwh_used)).filter(n => Number.isFinite(n))
    const line = row.meterBreakdown.length === 1 ? row.meterBreakdown[0] : null
    return detectReadingAnomaly(
      line
        ? { previousReading: Number(line.previous_reading), currentReading: Number(line.current_reading), kwh: Number(line.kwh), isReset: line.is_reset }
        : { previousReading: Number.isFinite(prev) ? prev : 0, currentReading: curr, kwh: row.kwhUsed },
      { hasPriorHistory, recentKwh },
    )
  }
  const blockedByAnomaly = (row: CamperRow) => !!anomalyFor(row) && !row.anomalyAcknowledged

  // ── CARD DERIVATIONS ───────────────────────────────────────────────────────────────────────
  // The card's status and menu come from lib/electric-billing-cards.ts, which is pure and tested.
  // This adapter is the only place the page's CamperRow meets that module's smaller CardRow.
  const asCardRow = (row: CamperRow): CardRow => ({
    sent: row.sent,
    skip: row.skip,
    hasEmail: !!row.guest.email,
    hasRecordedPayment: !!row.lastPaymentRecorded,
    anomaly: !!anomalyFor(row),
    anomalyAcknowledged: row.anomalyAcknowledged,
    meterLines: row.meterBreakdown.length,
    finalAmount: row.finalAmount,
    // ⚠ SURFACED, NOT RECOMPUTED. shownBalance() picks between the whole account and the Camp
    // Account; both figures were read off the folio by fetchCampers().
    balanceCents: shownBalance(row),
  })

  /** Every menu item dispatches to a handler that already existed. Nothing is reimplemented. */
  function runMenuAction(id: MenuActionId, i: number) {
    const row = campers[i]
    setOpenMenu(null)
    switch (id) {
      case 'folio-receipt':      router.push(`/admin/folio/guest/${row.guest.id}`); break
      case 'resend':             resendBill(i); break
      case 'resend-other-email': setCampers(prev => { const u = [...prev]; u[i] = { ...u[i], editEmailMode: true, editEmailValue: row.guest.email }; return u }); break
      case 'adjust':             setEditing(i); break
      case 'payment':
        updatePaymentField(i, 'showPayment', 'true')
        updatePaymentField(i, 'paymentAmount', (Math.max(0, row.folioBalance) / 100).toFixed(2))
        break
      case 'history':            loadHistory(i); break
      case 'dont-bill':
      case 'do-bill':            toggleSkip(i); break
    }
  }

  /**
   * Insert a merge field at the cursor. Same pure helper the packet-email editor uses, so both
   * boxes behave identically under the owner's hands.
   */
  function insertEmailToken(key: string) {
    const el = emailBoxRef.current
    const at = el ? el.selectionStart ?? emailMessage.length : emailMessage.length
    const to = el ? el.selectionEnd ?? at : at
    const { value, cursor } = insertAtCursor(emailMessage, at, to, tokenText(key))
    setEmailMessage(value)
    // Put the caret back after what was inserted, so typing continues where it left off.
    requestAnimationFrame(() => { if (el) { el.focus(); el.setSelectionRange(cursor, cursor) } })
  }
  const unknownEmailTokens = unknownTokensIn(emailMessage)

  const counts = tallyCards(campers.map(asCardRow))
  const visible = campers
    .map((row, i) => ({ row, i }))
    .filter(({ row }) => matchesFilter(asCardRow(row), filter))
  /** The money the ready pile would bill. Display only — Send All computes its own set. */
  const readyTotalCents = campers
    .filter(c => !c.skip && !c.sent && c.finalAmount)
    .reduce((sum, c) => sum + (Math.round(parseFloat(c.finalAmount) * 100) || 0), 0)
  const fmtUsd = (cents: number) => '$' + (cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  const fmtNum = (n: number) => Number(n).toLocaleString('en-US', { maximumFractionDigits: 2 })

  const readyToSend = campers.filter(c => !c.skip && !c.sent && c.finalAmount).length
  const draftCount = campers.filter(c => c.draftId && !c.sent).length
  if (loading) return <div style={{ padding: '3rem', textAlign: 'center', color: 'var(--muted)' }}>Loading seasonal campers…</div>

  return (
    <div className="eb-wrap" onClick={() => setOpenMenu(null)}>
      <style>{EB_CSS}</style>

      {/* ── Page head: title + the month this screen is about ─────────────────────────────── */}
      <div className="eb-pagehead">
        <h1 className="eb-title">Electric Billing</h1>
        <div className="eb-monthwrap">
          <button className="eb-gear" onClick={e => { e.stopPropagation(); setShowSettings(v => !v) }}
            aria-expanded={showSettings}>⚙ Settings</button>
          <select className="eb-month" value={billingMonth} onChange={e => handleMonthChange(e.target.value)} disabled={autoPopulating} aria-label="Billing month">
            {monthOptions.map(m => <option key={m} value={m}>{m}</option>)}
          </select>
          {autoPopulating && <span className="eb-loadingnote">⟳ loading readings…</span>}
        </div>
      </div>

      {/* Top-level view switch — the Account History tab the old page had, kept. */}
      <div className="eb-viewtabs">
        {(['billing', 'history'] as const).map(tab => (
          <button key={tab} onClick={() => setActiveTab(tab)} className={`eb-viewtab${activeTab === tab ? ' on' : ''}`}>
            {tab === 'billing' ? 'Monthly billing' : 'Account history'}
          </button>
        ))}
      </div>

      {activeTab === 'billing' && (
        <>
          {/* The walk's own reassurance, kept from the old page: a month that LOOKS billed when
              nothing has been charged is the failure the draft state exists to prevent. */}
          {draftCount > 0 && (
            <div className="eb-draftnote">
              <strong>{draftCount} reading{draftCount === 1 ? '' : 's'} from a meter walk {draftCount === 1 ? 'is' : 'are'} filled in for {billingMonth}.</strong>{' '}
              Nothing has been charged or sent yet.
            </div>
          )}

          {/* ── Summary: reassurance first, then the one bulk action ─────────────────────── */}
          <div className="eb-summary">
            <div>
              <p className="eb-headline">
                {counts.ready === 0
                  ? 'Nothing is waiting to be sent.'
                  : `${counts.ready} reading${counts.ready === 1 ? ' is' : 's are'} ready to send.`}
              </p>
              <div className="eb-sub">
                {counts.billed} already billed this month
                {counts.attention > 0 && <> · {counts.attention} worth a look before you send</>}
              </div>
            </div>
            <div className="eb-total">
              <div className="eb-amt tnum">{fmtUsd(readyTotalCents)}</div>
              <div className="eb-lbl">ready to bill</div>
            </div>
          </div>

          <div className="eb-sendall">
            <button className="eb-primary" onClick={e => { e.stopPropagation(); setShowSendAllConfirm(true) }}
              disabled={sendingAll || readyToSend === 0}>
              {sendingAll ? 'Sending…' : 'Review & send all ready'}
            </button>
            <Link className="eb-ghost" href="/admin/seasonals/meters">Read meters</Link>
          </div>

          {/* The batch confirm, unchanged in behaviour — it still leads with the month. */}
          {showSendAllConfirm && (
            <div className="eb-panel" onClick={e => e.stopPropagation()}>
              <MonthHeadline lead="Billing everyone for" billingMonth={billingMonth} />
              <div className="eb-paneltext">
                This creates a <strong>{billingMonth} electric charge</strong> on <strong>{readyToSend} camper account{readyToSend !== 1 ? 's' : ''}</strong> and emails each of them a statement. Campers already billed for this month, and any set to not bill, are left alone.
              </div>
              <div className="eb-panelactions">
                <button className="eb-primary sm" onClick={() => { setShowSendAllConfirm(false); sendAllBills() }}>Yes, bill {billingMonth}</button>
                <button className="eb-ghost sm" onClick={() => setShowSendAllConfirm(false)}>Cancel</button>
              </div>
            </div>
          )}

          {/* ── ⚙ SETTINGS DRAWER ─────────────────────────────────────────────────────────
              The same rate, minimum and bill-email settings the old page carried, and the same
              save paths — restyled and tucked behind the gear so they stop competing with the
              month's work. Nothing new is stored. */}
          {showSettings && (
            <div className="eb-drawer" onClick={e => e.stopPropagation()}>
              <div className="eb-dh">
                <span className="t">Electric settings</span>
                <button className="x" aria-label="Close settings" onClick={() => setShowSettings(false)}>✕</button>
              </div>
              <div className="eb-dnote">Sets how every electric bill is calculated and worded.</div>

              <div className="eb-srow">
                <div className="eb-field">
                  <label>Rate per kWh ($)</label>
                  <input type="number" step="0.01" value={ratePerKwh}
                    onChange={e => { setRatePerKwh(e.target.value); setRateSaved('') }} />
                </div>
                <div className="eb-field">
                  <label>Minimum charge ($)</label>
                  <input type="number" step="0.01" value={minimumCharge}
                    onChange={e => { setMinimumCharge(e.target.value); setRateSaved('') }} />
                </div>
                <div className="eb-field">
                  <label>&nbsp;</label>
                  <button className="eb-ghost sm" onClick={saveRate} disabled={savingRate}>
                    {savingRate ? 'Saving…' : 'Save rate'}
                  </button>
                </div>
                {rateSaved ? <span className={`eb-note${rateSaved.startsWith('Could not') ? ' bad' : ' good'}`}>{rateSaved}</span> : null}
              </div>
              <div className="eb-dnote sm">
                The rate and minimum feed the same calculation as before, here and on the
                meter-reading screen.
              </div>

              <div className="eb-srow">
                <div className="eb-field email">
                  <label>Bill email to the camper</label>
                  <textarea ref={emailBoxRef} value={emailMessage}
                    onChange={e => setEmailMessage(e.target.value)} />
                  {/* ⚠ CLICKING, NOT TYPING. A hand-typed token that this catalog does not know
                      is left visible rather than blanked (see renderElectricMessage), but a
                      button cannot misspell in the first place. */}
                  <div className="eb-chips">
                    <span className="cl">Insert a field:</span>
                    {ELECTRIC_TOKENS.map(t => (
                      <button key={t.key} type="button" className="eb-chip" title={tokenText(t.key)}
                        onClick={() => insertEmailToken(t.key)}>+ {t.label}</button>
                    ))}
                  </div>
                  {unknownEmailTokens.length > 0 && (
                    <div className="eb-note bad">
                      {unknownEmailTokens.map(k => `{{${k}}}`).join(', ')} {unknownEmailTokens.length === 1 ? 'is not a field' : 'are not fields'} this email knows — it will be sent exactly as written.
                    </div>
                  )}
                </div>
              </div>
              <div className="eb-editactions">
                <button className="eb-primary sm" onClick={saveMessage}>Save message</button>
                <button className="eb-ghost sm" onClick={() => setShowSettings(false)}>Close</button>
              </div>
            </div>
          )}

          {campers.length === 0 ? (
            <div className="eb-empty">No seasonal campers found.</div>
          ) : (
            <>
              {/* ── Gentle filter tabs. A VIEW filter only — Send All still walks every row. ── */}
              <div className="eb-tabs">
                {([['ready', 'Ready', counts.ready], ['attention', 'Worth a look', counts.attention],
                   ['billed', 'Billed', counts.billed], ['owing', 'Owes a balance', counts.owing],
                   ['everyone', 'Everyone', counts.everyone]] as const).map(([id, label, n]) => (
                  <button key={id} className={`eb-tab${filter === id ? ' active' : ''}`}
                    onClick={e => { e.stopPropagation(); setFilter(id as CardFilter) }}>
                    {label} <span className="n tnum">{n}</span>
                  </button>
                ))}
              </div>

              <div className="eb-cards">
                {visible.length === 0 && (
                  <div className="eb-empty">Nothing in this view.</div>
                )}

                {visible.map(({ row, i }) => {
                  const cr = asCardRow(row)
                  const status = cardStatus(cr)
                  const anomaly = anomalyFor(row)
                  const blocked = blockedByAnomaly(row)
                  const sites = (row.guest.site_number || '—').split(',').map(x => x.trim()).filter(Boolean)
                  const isEditing = editing === i
                  const lines = row.meterBreakdown

                  return (
                    <div key={row.guest.id}
                      className={`eb-card ${status}${isEditing ? ' editing' : ''}${row.skip ? ' skipped' : ''}`}>
                      <div className="eb-row">
                        {/* Site tile */}
                        <div className={`eb-site${sites.length > 1 ? ' dbl' : ''}`}>
                          <span className="num tnum">{sites.join('·')}</span>
                          <span className="cap">{sites.length > 1 ? 'sites' : 'site'}</span>
                        </div>

                        {/* Who + the meter line(s) */}
                        <div className="eb-who">
                          <div className="eb-name">{row.guest.name}</div>

                          {lines.length > 0 ? (
                            <div className={`eb-meter tnum${lines.length > 1 ? ' two' : ''}`} style={isEditing ? { opacity: .55 } : undefined}>
                              {lines.map(l => (
                                <span key={l.meter_id}>
                                  {lines.length > 1 && <span className="mlabel">Meter {l.meter_number}</span>}
                                  {fmtNum(l.previous_reading)} <span className="arrow">→</span> {fmtNum(l.current_reading)} · <span className="kwh">{fmtNum(l.kwh)} kWh</span>
                                  {l.is_reset ? <span className="eb-tag warn">meter replaced</span> : null}
                                </span>
                              ))}
                            </div>
                          ) : status === 'manual' ? (
                            <div className="eb-meter">Entered by hand · no meter reading</div>
                          ) : (
                            <div className={`eb-meter tnum`} style={isEditing ? { opacity: .55 } : undefined}>
                              {row.previousReading || '—'} <span className="arrow">→</span> {row.currentReading || '—'}
                              {row.kwhUsed > 0 && <> · <span className="kwh">{fmtNum(row.kwhUsed)} kWh</span></>}
                            </div>
                          )}

                          {!isEditing && !row.sent && (
                            <button className="eb-pencil" onClick={e => { e.stopPropagation(); setEditing(i) }}>✎ edit</button>
                          )}

                          <div className="eb-tags">
                            {row.draftId && !row.sent && <span className="eb-tag draft">Draft · not charged</span>}
                            {lines.length > 1 && <span className="eb-tag">Two meters · summed</span>}
                            {status === 'manual' && <span className="eb-tag manual">Manual amount</span>}
                            {row.skip && <span className="eb-tag">Not billing this month</span>}
                            {row.sent && <span className="eb-tag done">Billed · on their folio</span>}
                            {row.receiptSent && <span className="eb-tag good">Receipt sent</span>}
                            {/* ⚠ WHAT THEY OWE, WHICH IS NOT THIS MONTH'S CHARGE. The big number
                                on the right is what this bill adds; this is what is outstanding on
                                their folio right now, read straight off it and never recomputed. A
                                camper can owe nothing this month and still carry a balance. */}
                            {(() => {
                              // In separated mode this is the CAMP balance. The tooltip says so,
                              // because "Balance $42.00" beside a camper who also owes a season
                              // fee is only unambiguous if the screen tells you which account.
                              const bt = billingMode === 'separated'
                                ? 'Camp Account — electric & store; seasonal is billed separately'
                                : undefined
                              return cr.balanceCents < 0
                                ? <span className="eb-bal paid" title={bt}>Credit <span className="bd tnum">{fmtUsd(Math.abs(cr.balanceCents))}</span></span>
                                : owesBalance(cr)
                                  ? <span className="eb-bal owe" title={bt}>Balance <span className="bd tnum">{fmtUsd(cr.balanceCents)}</span></span>
                                  : <span className="eb-bal paid" title={bt}>Paid up</span>
                            })()}
                          </div>

                          {/* The existing anomaly guard, presented kindly rather than as an alarm. */}
                          {anomaly && !row.anomalyAcknowledged && (
                            <div className="eb-attn">
                              <span className="dot">!</span>
                              <span>{anomaly.message}{' '}
                                <button className="eb-inlinelink" onClick={e => { e.stopPropagation(); setCampers(prev => { const u = [...prev]; u[i] = { ...u[i], anomalyAcknowledged: true }; return u }) }}>
                                  I&rsquo;ve checked it
                                </button>
                              </span>
                            </div>
                          )}

                          {row.error && <div className="eb-err">{row.error}</div>}
                          {!row.guest.email && <div className="eb-muted">No email on file</div>}
                        </div>

                        {/* Amount + the one primary action + the ⋯ menu */}
                        <div className="eb-act">
                          <div className={`eb-amtwrap${row.sent ? ' dim' : ''}`}>
                            <div className="eb-big tnum">{row.finalAmount ? '$' + row.finalAmount : '—'}</div>
                            <div className="eb-foot">
                              {row.sent ? 'billed'
                                : isEditing ? 'editing…'
                                : status === 'manual' ? <>you set this <button className="eb-pencil sm" onClick={e => { e.stopPropagation(); setEditing(i) }}>✎</button></>
                                : row.kwhUsed > 0 ? `${fmtNum(row.kwhUsed)} × $${rate.ratePerKwh}` : ''}
                            </div>
                          </div>

                          {row.sent ? (
                            <span className="eb-billed"><span className="ck">✓</span> Billed</span>
                          ) : row.skip ? (
                            <span className="eb-skipped">Not billing</span>
                          ) : (
                            <button
                              className={`eb-bill${status === 'attention' ? ' gold' : ''}`}
                              onClick={e => {
                                e.stopPropagation()
                                // "Review" opens the editor; "Bill" opens the existing confirm.
                                if (status === 'attention') { setEditing(i); return }
                                setCampers(prev => { const u = [...prev]; u[i] = { ...u[i], showBillConfirm: true }; return u })
                              }}
                              disabled={row.sending || !row.finalAmount || (status !== 'attention' && blocked)}>
                              {row.sending ? 'Billing…' : primaryLabel(status)}
                            </button>
                          )}

                          <div className="eb-menuwrap" onClick={e => e.stopPropagation()}>
                            <button className={`eb-more${openMenu === i ? ' open' : ''}`}
                              aria-label={`More actions for ${row.guest.name}`} aria-expanded={openMenu === i}
                              onClick={() => setOpenMenu(openMenu === i ? null : i)}>⋯</button>
                            {openMenu === i && (
                              <div className="eb-menu" role="menu">
                                {menuFor(cr).map(a => (
                                  <div key={a.id}>
                                    {a.dividerBefore && <div className="div" />}
                                    <button role="menuitem" className={a.tone === 'warn' ? 'warn' : undefined}
                                      onClick={() => runMenuAction(a.id, i)}>
                                      <span className="mi">{a.icon}</span> {a.label}
                                    </button>
                                  </div>
                                ))}
                              </div>
                            )}
                          </div>
                        </div>
                      </div>

                      {/* ── Inline edit: readings and the amount, exactly as before ────────── */}
                      {isEditing && (
                        <div className="eb-editpanel" onClick={e => e.stopPropagation()}>
                          <div className="eb-eh">{row.sent ? 'Adjust this bill' : 'Edit this bill'}</div>
                          <div className="eb-fields">
                            <div className="eb-field">
                              <label>Previous reading</label>
                              <input type="number" value={row.previousReading} disabled={row.skip}
                                onChange={e => updateReading(i, 'previousReading', e.target.value)} />
                            </div>
                            <div className="eb-field">
                              <label>Current reading</label>
                              <input type="number" value={row.currentReading} disabled={row.skip}
                                onChange={e => updateReading(i, 'currentReading', e.target.value)} />
                            </div>
                            <div className="eb-live tnum">= {fmtNum(row.kwhUsed)} kWh</div>
                            <div className="eb-field amt">
                              <label>Amount due</label>
                              <input type="number" step="0.01" value={row.finalAmount} disabled={row.skip}
                                onChange={e => updateFinalAmount(i, e.target.value)} />
                              <span className="hint">Auto from reading — type to override</span>
                            </div>
                          </div>
                          <div className="eb-editactions">
                            <button className="eb-primary sm" onClick={() => setEditing(null)}>Done</button>
                            {row.calculatedAmount > 0 && (
                              <button className="eb-ghost sm" onClick={() => updateFinalAmount(i, (row.calculatedAmount / 100).toFixed(2))}>
                                Reset to {fmtUsd(row.calculatedAmount)}
                              </button>
                            )}
                          </div>
                        </div>
                      )}

                      {/* Send to a corrected address — the old "wrong email?" path. */}
                      {row.editEmailMode && (
                        <div className="eb-editpanel" onClick={e => e.stopPropagation()}>
                          <div className="eb-eh">Send this statement to a different email</div>
                          <div className="eb-fields">
                            <div className="eb-field wide">
                              <label>Email address</label>
                              <input type="email" value={row.editEmailValue} placeholder="name@example.com"
                                onChange={e => setCampers(prev => { const u = [...prev]; u[i] = { ...u[i], editEmailValue: e.target.value }; return u })} />
                            </div>
                          </div>
                          <div className="eb-editactions">
                            <button className="eb-primary sm" onClick={() => resendBill(i, row.editEmailValue)}>Send</button>
                            <button className="eb-ghost sm" onClick={() => setCampers(prev => { const u = [...prev]; u[i] = { ...u[i], editEmailMode: false }; return u })}>Cancel</button>
                          </div>
                        </div>
                      )}

                      {/* ── The existing bill confirmation, unchanged ──────────────────────── */}
                      {row.showBillConfirm && (
                        <div className="eb-panel" onClick={e => e.stopPropagation()}>
                          <MonthHeadline lead={'Billing ' + row.guest.name + ' for'} billingMonth={billingMonth} />
                          <div className="eb-paneltext">
                            This creates a <strong>{billingMonth} electric charge of ${row.finalAmount}</strong> on their account and emails their statement to <strong>{row.guest.email}</strong>.
                          </div>
                          <div className="eb-panelactions">
                            <button className="eb-primary sm" onClick={() => { setCampers(prev => { const u = [...prev]; u[i] = { ...u[i], showBillConfirm: false }; return u }); sendBill(i) }}>
                              Yes, bill electric
                            </button>
                            <button className="eb-ghost sm" onClick={() => setCampers(prev => { const u = [...prev]; u[i] = { ...u[i], showBillConfirm: false }; return u })}>Cancel</button>
                          </div>
                        </div>
                      )}

                      {/* ── The existing receipt confirmation, unchanged ───────────────────── */}
                      {row.showReceiptConfirm && row.lastPaymentRecorded && (
                        <div className="eb-panel warm" onClick={e => e.stopPropagation()}>
                          <div className="eb-paneltext">
                            Email a receipt for <strong>{fmtUsd(row.lastPaymentRecorded.amount)}</strong> to <strong>{row.guest.email}</strong>?
                          </div>
                          <div className="eb-panelactions">
                            <button className="eb-primary sm" onClick={() => sendReceipt(i)} disabled={row.sendingReceipt}>
                              {row.sendingReceipt ? 'Sending…' : 'Yes, send receipt'}
                            </button>
                            <button className="eb-ghost sm" onClick={() => setCampers(prev => { const u = [...prev]; u[i] = { ...u[i], showReceiptConfirm: false }; return u })}>Cancel</button>
                          </div>
                        </div>
                      )}

                      {/* ── The existing payment panel, unchanged ──────────────────────────── */}
                      {row.showPayment && (
                        <div className="eb-editpanel" onClick={e => e.stopPropagation()}>
                          <div className="eb-eh">
                            Take a payment — {row.guest.name}
                            {shownBalance(row) !== 0 && (
                              <span className={`eb-balance${shownBalance(row) < 0 ? ' credit' : ''}`}
                                title={billingMode === 'separated' ? 'Camp Account — electric & store; seasonal is billed separately' : undefined}>
                                {shownBalance(row) < 0
                                  ? `Credit on account ${fmtUsd(Math.abs(shownBalance(row)))}`
                                  : `Balance due ${fmtUsd(shownBalance(row))}`}
                              </span>
                            )}
                          </div>
                          <div className="eb-fields">
                            <div className="eb-field">
                              <label>Amount ($)</label>
                              <input type="number" step="0.01" value={row.paymentAmount}
                                onChange={e => updatePaymentField(i, 'paymentAmount', e.target.value)} />
                            </div>
                            <div className="eb-field">
                              <label>Method</label>
                              <select value={row.paymentMethod} onChange={e => updatePaymentField(i, 'paymentMethod', e.target.value)}>
                                {allPaymentMethods(customMethods).map(m => <option key={m} value={m}>{methodLabel(m)}</option>)}
                                <option value="other">Other</option>
                              </select>
                              {row.paymentMethod === 'card' && <span className="hint">→ opens the folio to charge the terminal</span>}
                            </div>
                            <div className="eb-field wide">
                              <label>Note (optional)</label>
                              <input placeholder="e.g. Check #1042" value={row.paymentNote}
                                onChange={e => updatePaymentField(i, 'paymentNote', e.target.value)} />
                            </div>
                          </div>
                          <div className="eb-editactions">
                            <button className="eb-primary sm" disabled={row.savingPayment || !row.paymentAmount}
                              onClick={() => {
                                if (row.paymentMethod === 'card') { router.push(`/admin/folio/guest/${row.guest.id}`) }
                                else { recordPayment(i) }
                              }}>
                              {row.savingPayment ? 'Saving…' : 'Save payment'}
                            </button>
                            <button className="eb-ghost sm" onClick={() => updatePaymentField(i, 'showPayment', false as unknown as string)}>Cancel</button>
                          </div>
                        </div>
                      )}

                      {/* ── The existing per-camper history, unchanged ─────────────────────── */}
                      {row.showHistory && (
                        <div className="eb-history" onClick={e => e.stopPropagation()}>
                          <div className="eb-eh">Billing history — {row.guest.name}</div>
                          {row.readings.length === 0 ? (
                            <div className="eb-muted">No billing history yet.</div>
                          ) : (
                            <table className="eb-table">
                              <thead>
                                <tr>{['Month', 'Prev', 'Curr', 'kWh', 'Billed'].map(h => <th key={h}>{h}</th>)}</tr>
                              </thead>
                              <tbody>
                                {row.readings.map(r => {
                                  // ⚠ A VOIDED BILL MUST NEVER LOOK LIVE. It is left out of the
                                  // total below, so an unmarked voided row makes the rows visibly
                                  // fail to add up with nothing on screen explaining the gap.
                                  const v = describeVoid(r)
                                  return (
                                  <Fragment key={r.id}>
                                    <tr className={v ? 'voided' : undefined}>
                                      <td>
                                        <span className="mo">{r.billing_month}</span>
                                        {v && <span className="eb-tag void">{v.tag}</span>}
                                      </td>
                                      <td className="tnum">{fmtNum(r.previous_reading)}</td>
                                      <td className="tnum">{fmtNum(r.current_reading)}</td>
                                      <td className="tnum">{fmtNum(r.kwh_used)}</td>
                                      <td className="tnum amt">{fmtUsd(r.final_amount)}</td>
                                    </tr>
                                    {v && (
                                      <tr className="eb-voidnote">
                                        <td colSpan={5}>{v.detail}</td>
                                      </tr>
                                    )}
                                  </Fragment>
                                  )
                                })}
                              </tbody>
                              {/* ⚠ RESTORED. The Seasonal redesign dropped this row, which had been
                                  here since the page was built — the only place a camper's all-time
                                  billed figure appears. Voided bills are excluded: they are off the
                                  camper's balance, so counting them would overstate what they have
                                  actually been charged. */}
                              <tfoot>
                                <tr>
                                  <td colSpan={4}>
                                    Total billed (all time)
                                    {row.readings.some(r => r.voided) && (
                                      <span className="eb-foot-note">voided bills excluded</span>
                                    )}
                                  </td>
                                  <td className="tnum">{fmtUsd(allTimeBilled(row.readings))}</td>
                                </tr>
                              </tfoot>
                            </table>
                          )}
                          {row.folioPayments.length > 0 && (
                            <>
                              <div className="eb-eh sub">Payments received</div>
                              {row.folioPayments.map(pm => (
                                <div key={pm.id} className="eb-payrow">
                                  <span>
                                    <strong>{methodLabel(pm.method)}</strong>
                                    {pm.note ? <span className="eb-muted"> {pm.note}</span> : null}
                                    <span className="eb-muted"> {new Date(pm.paid_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: '2-digit' })}</span>
                                    {pm.receipt_sent_at
                                      ? <span className="eb-tag good">receipt sent</span>
                                      : <span className="eb-tag">no receipt</span>}
                                  </span>
                                  <span className="eb-payright">
                                    <span className="tnum">−{fmtUsd(pm.amount - (pm.surcharge_amount || 0))}</span>
                                    <button className="eb-ghost xs" onClick={() => setCampers(prev => { const u = [...prev]; u[i] = { ...u[i], lastPaymentRecorded: pm, showReceiptConfirm: true, receiptSent: false }; return u })}>
                                      {pm.receipt_sent_at ? 'Re-send' : 'Send receipt'}
                                    </button>
                                  </span>
                                </div>
                              ))}
                            </>
                          )}
                          {/* Camp in separated mode, like the pill above — a staff member must not
                              see two different "balance due" figures for the same camper. */}
                          <div className={`eb-balrow${shownBalance(row) > 0 ? ' due' : ''}`}>
                            <span>
                              {shownBalance(row) < 0 ? 'Credit on account' : shownBalance(row) === 0 ? 'Paid in full' : 'Balance due'}
                              {billingMode === 'separated' && <span className="eb-balnote"> · Camp Account</span>}
                            </span>
                            <span className="tnum">{fmtUsd(Math.abs(shownBalance(row)))}</span>
                          </div>
                          <div className="eb-editactions">
                            <button className="eb-ghost sm" onClick={() => loadHistory(i)}>Hide history</button>
                          </div>
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>
            </>
          )}
        </>
      )}

      {activeTab === 'history' && (
        campers.length === 0
          ? <div className="eb-empty">No seasonal campers found.</div>
          : <div className="eb-cards">
              {campers.map(row => <GuestAccountCard key={row.guest.id} guest={row.guest} balanceCents={shownBalance(row)} />)}
            </div>
      )}
    </div>
  )
}


/** `balanceCents` is whatever the page decided to show — the Camp Account in separated mode,
 *  the whole account in combined. Named for what it is rather than where it came from, because
 *  it is no longer always the raw folio balance. */
function GuestAccountCard({ guest, balanceCents: folioBalance }: { guest: Guest; balanceCents: number }) {
  const [readings, setReadings] = useState<any[]>([])
  const [payments, setPayments] = useState<any[]>([])
  const [loaded, setLoaded] = useState(false)
  const [open, setOpen] = useState(false)

  async function load() {
    if (loaded) { setOpen(!open); return }
    const [{ data: r }, { data: folio }] = await Promise.all([
      // Posted only — `totalBilled` below sums final_amount, and a draft is not billed.
      supabase.from('electric_readings').select('*').eq('guest_id', guest.id).eq('status', 'posted').order('created_at', { ascending: false }),
      supabase.from('folios').select('id').eq('guest_id', guest.id).eq('folio_type', 'guest_account').single(),
    ])
    let pmts: any[] = []
    if (folio) {
      const { data: pData } = await supabase.from('folio_payments').select('*').eq('folio_id', folio.id).eq('status', 'completed').order('paid_at', { ascending: false })
      pmts = pData || []
    }
    setReadings(r || [])
    setPayments(pmts)
    setLoaded(true)
    setOpen(true)
  }

  const totalBilled = readings.reduce((s, r) => s + r.final_amount, 0)
  const totalPaid = payments.reduce((s, p) => s + p.amount - (p.surcharge_amount || 0), 0)

  return (
    <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 12, overflow: 'hidden' }}>
      <div onClick={load} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '14px 20px', cursor: 'pointer' }}
        onMouseEnter={e => (e.currentTarget.style.background = '#f9fafb')}
        onMouseLeave={e => (e.currentTarget.style.background = '#fff')}>
        <div>
          <div style={{ fontWeight: 700, fontSize: 15, color: '#111827' }}>{guest.name}</div>
          <div style={{ fontSize: 12, color: '#9ca3af' }}>Site {guest.site_number} · {guest.email || 'No email'}</div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 20 }}>
          {loaded && <div style={{ fontSize: 12, color: '#6b7280' }}>{readings.length} bill{readings.length !== 1 ? 's' : ''} · ${(totalBilled / 100).toFixed(2)} billed · ${(totalPaid / 100).toFixed(2)} paid</div>}
          <div style={{ fontWeight: 800, fontSize: 16, color: folioBalance > 0 ? '#dc2626' : '#15803d' }}>
            {folioBalance > 0 ? '$' + (folioBalance / 100).toFixed(2) + ' due' : '✓ Current'}
          </div>
          <span style={{ color: '#9ca3af', fontSize: 18 }}>{open ? '▲' : '▼'}</span>
        </div>
      </div>
      {open && (
        <div style={{ borderTop: '1px solid #e5e7eb' }}>
          {readings.length === 0 ? (
            <div style={{ padding: '1rem 20px', fontSize: 13, color: '#9ca3af' }}>No billing history yet.</div>
          ) : (
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
              <thead>
                <tr style={{ background: '#f9fafb' }}>
                  {['Month', 'Prev Reading', 'Curr Reading', 'kWh Used', 'Rate', 'Amount Billed', 'Billed On'].map(h => (
                    <th key={h} style={{ padding: '8px 16px', textAlign: 'left', color: '#6b7280', fontWeight: 700, fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.04em', borderBottom: '1px solid #e5e7eb' }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {readings.map((r, i) => (
                  <tr key={r.id} style={{ borderBottom: '1px solid #f3f4f6', background: i % 2 === 0 ? '#fff' : '#fafafa' }}>
                    <td style={{ padding: '10px 16px', fontWeight: 600, color: '#111827' }}>{r.billing_month}</td>
                    <td style={{ padding: '10px 16px', color: '#6b7280' }}>{Number(r.previous_reading).toLocaleString()}</td>
                    <td style={{ padding: '10px 16px', color: '#6b7280' }}>{Number(r.current_reading).toLocaleString()}</td>
                    <td style={{ padding: '10px 16px', fontWeight: 600 }}>{Number(r.kwh_used).toFixed(1)}</td>
                    <td style={{ padding: '10px 16px', color: '#6b7280' }}>${Number(r.rate_per_kwh).toFixed(3)}/kWh</td>
                    <td style={{ padding: '10px 16px', fontWeight: 700, color: '#15803d' }}>${(r.final_amount / 100).toFixed(2)}</td>
                    <td style={{ padding: '10px 16px', color: '#9ca3af' }}>{new Date(r.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr style={{ background: '#f0fdf4', borderTop: '2px solid #bbf7d0' }}>
                  <td colSpan={5} style={{ padding: '10px 16px', fontWeight: 700, color: '#15803d' }}>All-time totals</td>
                  <td style={{ padding: '10px 16px', fontWeight: 800, color: '#15803d' }}>${(totalBilled / 100).toFixed(2)}</td>
                  <td />
                </tr>
              </tfoot>
            </table>
          )}
          {payments.length > 0 && (
            <div style={{ borderTop: '1px solid #e5e7eb', padding: '0 0 4px' }}>
              <div style={{ padding: '10px 16px', fontSize: 11, fontWeight: 700, color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.06em', background: '#f9fafb', borderBottom: '1px solid #f3f4f6' }}>Payments received</div>
              {payments.map((p, pi) => (
                <div key={p.id} style={{ display: 'flex', justifyContent: 'space-between', padding: '8px 16px', borderBottom: pi < payments.length - 1 ? '1px solid #f3f4f6' : 'none', fontSize: 13 }}>
                  <div>
                    <span style={{ fontWeight: 600, textTransform: 'capitalize' }}>{p.method}</span>
                    {p.note && <span style={{ color: '#9ca3af', marginLeft: 10 }}>{p.note}</span>}
                  </div>
                  <div style={{ display: 'flex', gap: 20, alignItems: 'center' }}>
                    <span style={{ color: '#9ca3af', fontSize: 12 }}>{new Date(p.paid_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}</span>
                    <span style={{ fontWeight: 700, color: '#15803d' }}>-${((p.amount - (p.surcharge_amount || 0)) / 100).toFixed(2)}</span>
                  </div>
                </div>
              ))}
              <div style={{ display: 'flex', justifyContent: 'space-between', padding: '10px 16px', borderTop: '2px solid #bbf7d0', background: '#f0fdf4' }}>
                <span style={{ fontWeight: 700, color: '#15803d' }}>Total paid</span>
                <span style={{ fontWeight: 800, color: '#15803d' }}>${(totalPaid / 100).toFixed(2)}</span>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}


// ── THE LOOK ─────────────────────────────────────────────────────────────────────────────────
//
// Spacing, radii and hierarchy come from the approved mock-up; every COLOUR and FACE comes from
// the `.seasonal-theme` tokens in globals.css, which app/admin/electric-billing/layout.tsx puts
// on this page. That split is deliberate: the mock-up is the spec for the shape, the tokens are
// the single source of truth for the palette, so a later change to the theme carries here for
// free and there is no second copy of the cream to drift.
//
// It is a <style> element rather than inline styles because the design needs three things inline
// styles cannot express: the ::before status spine, hover/focus states, and the ≤560px reflow.
// Every selector is prefixed `eb-` so it cannot reach anything else in the admin.
const EB_CSS = `
.eb-wrap{max-width:820px;margin:0 auto;padding:28px 20px 80px;font-family:var(--font-manrope),ui-sans-serif,system-ui,sans-serif;color:var(--ink);font-size:15px;line-height:1.5}
.eb-wrap *{box-sizing:border-box}
.tnum{font-family:var(--font-jetbrains-mono),ui-monospace,SFMono-Regular,Menlo,monospace;font-variant-numeric:tabular-nums}

.eb-pagehead{display:flex;align-items:baseline;justify-content:space-between;gap:16px;flex-wrap:wrap}
.eb-title{font-family:var(--font-newsreader),ui-serif,Georgia,serif;font-weight:500;font-size:30px;letter-spacing:-.01em;color:var(--forest);margin:0}
.eb-monthwrap{display:flex;align-items:center;gap:10px}
.eb-month{font-family:inherit;font-weight:600;font-size:14px;color:var(--forest);background:var(--card);border:1px solid var(--line);border-radius:999px;padding:7px 14px;cursor:pointer}
.eb-month:focus-visible{outline:2px solid var(--forest);outline-offset:2px}
.eb-loadingnote{font-size:12px;color:var(--muted)}

.eb-viewtabs{display:flex;gap:4px;margin:18px 0 4px;border-bottom:1px solid var(--line)}
.eb-viewtab{font-family:inherit;font-size:14px;font-weight:600;color:var(--muted);background:none;border:none;border-bottom:2px solid transparent;padding:10px 16px;margin-bottom:-1px;cursor:pointer}
.eb-viewtab.on{color:var(--forest);border-bottom-color:var(--forest)}

.eb-summary{margin:18px 0 6px;background:var(--card);border:1px solid var(--line);border-radius:16px;padding:18px 20px;display:flex;align-items:center;justify-content:space-between;gap:18px;flex-wrap:wrap}
.eb-headline{font-family:var(--font-newsreader),ui-serif,Georgia,serif;font-size:19px;color:var(--forest);font-weight:500;margin:0 0 3px}
.eb-sub{color:var(--ink-soft);font-size:13.5px}
.eb-total{text-align:right}
.eb-amt{font-size:26px;font-weight:600;color:var(--forest);letter-spacing:-.02em}
.eb-lbl{font-size:12px;color:var(--muted);text-transform:uppercase;letter-spacing:.08em}

.eb-sendall{margin-top:14px;display:flex;gap:10px;align-items:center;flex-wrap:wrap}
.eb-primary{appearance:none;border:none;cursor:pointer;font-family:inherit;font-weight:600;font-size:14.5px;background:var(--forest);color:var(--on-forest);border-radius:11px;padding:11px 20px}
.eb-primary:hover:not(:disabled){background:var(--forest-deep)}
.eb-primary:disabled{opacity:.45;cursor:default}
.eb-primary.sm{font-size:13.5px;padding:9px 16px;border-radius:9px}
.eb-ghost{appearance:none;cursor:pointer;font-family:inherit;font-weight:600;font-size:14px;background:transparent;color:var(--forest);border:1px solid var(--line-strong);border-radius:11px;padding:10px 16px;text-decoration:none;display:inline-flex;align-items:center}
.eb-ghost:hover:not(:disabled){background:var(--card)}
.eb-ghost:disabled{opacity:.45;cursor:default}
.eb-ghost.sm{font-size:13px;padding:8px 14px;border-radius:9px}
.eb-ghost.xs{font-size:11.5px;padding:4px 9px;border-radius:7px}

.eb-tabs{display:flex;gap:6px;margin:26px 0 12px;flex-wrap:wrap}
.eb-tab{font-family:inherit;font-size:13.5px;font-weight:600;color:var(--ink-soft);background:transparent;border:1px solid transparent;border-radius:999px;padding:6px 14px;cursor:pointer}
.eb-tab .n{color:var(--muted);font-weight:600;margin-left:5px;font-size:12.5px}
.eb-tab.active{background:var(--forest);color:var(--on-forest);border-color:var(--forest)}
.eb-tab.active .n{color:var(--gold)}
.eb-tab:not(.active):hover{background:var(--card);border-color:var(--line)}

.eb-cards{display:flex;flex-direction:column;gap:12px}
.eb-card{position:relative;background:var(--card);border:1px solid var(--line);border-radius:16px;padding:18px 20px 18px 22px}
.eb-card::before{content:"";position:absolute;left:0;top:14px;bottom:14px;width:4px;border-radius:4px;background:var(--good)}
.eb-card.billed::before{background:var(--muted)}
.eb-card.attention::before{background:var(--gold)}
.eb-card.manual::before{background:var(--line-strong)}
.eb-card.editing::before{background:var(--forest)}
.eb-card.editing{outline:2px solid var(--card-2);outline-offset:-2px}
.eb-card.skipped{opacity:.72}
.eb-row{display:flex;align-items:flex-start;gap:18px}

.eb-site{flex:0 0 auto;width:56px;height:56px;border-radius:13px;background:var(--card-2);border:1px solid var(--line);display:flex;flex-direction:column;align-items:center;justify-content:center;gap:1px}
.eb-site .num{font-family:var(--font-jetbrains-mono),ui-monospace,monospace;font-weight:600;font-size:19px;color:var(--forest);line-height:1}
.eb-site.dbl .num{font-size:13px}
.eb-site .cap{font-size:9.5px;text-transform:uppercase;letter-spacing:.09em;color:var(--muted)}

.eb-who{flex:1 1 auto;min-width:0}
.eb-name{font-family:var(--font-newsreader),ui-serif,Georgia,serif;font-size:18px;font-weight:500;color:var(--ink);letter-spacing:-.01em}
.eb-meter{margin-top:3px;font-size:12.5px;color:var(--ink-soft);letter-spacing:-.01em}
.eb-meter.two{display:flex;flex-direction:column;gap:2px}
.eb-meter .mlabel{color:var(--muted);margin-right:6px}
.eb-meter .arrow{color:var(--muted);margin:0 5px}
.eb-meter .kwh{color:var(--forest);font-weight:500}
.eb-pencil{background:none;border:none;cursor:pointer;color:var(--muted);font-size:11px;margin-left:7px;font-family:inherit;padding:2px 4px}
.eb-pencil:hover{color:var(--gold-ink)}
.eb-tags{display:flex;gap:6px;flex-wrap:wrap;margin-top:7px}
.eb-tag{display:inline-flex;align-items:center;gap:5px;font-size:11.5px;font-weight:600;border-radius:999px;padding:3px 9px;background:var(--card-2);color:var(--ink-soft)}
.eb-tag.draft{background:var(--draft-bg);color:var(--draft)}
.eb-tag.done{background:var(--good-bg);color:var(--good)}
.eb-tag.good{background:var(--good-bg);color:var(--good)}
.eb-tag.warn{background:var(--watch-bg);color:var(--watch)}
.eb-tag.manual{background:var(--card-2);color:var(--ink-soft)}

.eb-attn{margin-top:9px;font-size:12.5px;color:var(--gold-ink);display:flex;align-items:flex-start;gap:7px;line-height:1.45}
.eb-attn .dot{flex:0 0 auto;width:15px;height:15px;margin-top:2px;border-radius:50%;background:var(--watch-bg);color:var(--gold-ink);display:flex;align-items:center;justify-content:center;font-size:10px;font-weight:700}
.eb-inlinelink{background:none;border:none;padding:0;font-family:inherit;font-size:12.5px;font-weight:700;color:var(--gold-ink);text-decoration:underline;cursor:pointer}
.eb-err{margin-top:7px;font-size:12.5px;color:var(--danger);font-weight:600}
.eb-muted{font-size:12px;color:var(--muted)}

.eb-act{flex:0 0 auto;display:flex;align-items:center;gap:10px}
.eb-amtwrap{text-align:right;min-width:88px}
.eb-big{font-size:19px;font-weight:600;color:var(--forest);letter-spacing:-.02em}
.eb-amtwrap.dim .eb-big{color:var(--muted)}
.eb-foot{font-size:11px;color:var(--muted);margin-top:1px}
.eb-bill{appearance:none;border:none;cursor:pointer;font-family:inherit;font-weight:600;font-size:14px;background:var(--forest);color:var(--on-forest);border-radius:10px;padding:10px 16px;white-space:nowrap}
.eb-bill:hover:not(:disabled){background:var(--forest-deep)}
.eb-bill:disabled{opacity:.45;cursor:default}
.eb-bill.gold{background:var(--gold);color:var(--on-watch)}
.eb-billed{display:inline-flex;align-items:center;gap:6px;font-weight:600;font-size:14px;color:var(--good);white-space:nowrap}
.eb-billed .ck{width:19px;height:19px;border-radius:50%;background:var(--good-bg);display:flex;align-items:center;justify-content:center;font-size:12px}
.eb-skipped{font-size:13px;font-weight:600;color:var(--muted);white-space:nowrap}
.eb-more{width:34px;height:34px;border-radius:9px;border:1px solid var(--line);background:transparent;cursor:pointer;color:var(--muted);font-size:18px;line-height:1;display:flex;align-items:center;justify-content:center}
.eb-more:hover,.eb-more.open{background:var(--card-2);color:var(--forest);border-color:var(--line-strong)}

.eb-menuwrap{position:relative}
.eb-menu{position:absolute;right:0;top:40px;z-index:20;background:var(--card);border:1px solid var(--line);border-radius:12px;box-shadow:0 8px 30px rgba(34,64,45,.14);padding:6px;width:236px;
  /* ⚠ max-width:none IS LOAD-BEARING. A global \`* { max-width:100% }\` in the app stylesheet
     clamps an absolutely-positioned child to its containing block — here the 34px "⋯" button —
     which squeezed every menu item into a four-line column. The global rule is right (it is what
     keeps pages from scrolling sideways) so it stays; this is the one element that must opt out.
     The menu opens leftward from the button, well inside the card, so nothing overflows. */
  max-width:none}
.eb-menu button{display:flex;width:100%;align-items:center;gap:10px;padding:9px 11px;border:none;background:none;border-radius:8px;font-family:inherit;font-size:13.5px;font-weight:500;color:var(--ink);text-align:left;cursor:pointer;white-space:nowrap}
.eb-menu button:hover{background:var(--card-2)}
.eb-menu button.warn{color:var(--danger)}
.eb-menu .div{height:1px;background:var(--line-soft);margin:5px 8px}
.eb-menu .mi{width:16px;color:var(--muted);text-align:center;font-size:13px}

.eb-panel{margin:14px 0 2px;background:var(--draft-bg);border:1px solid var(--draft);border-radius:13px;padding:15px 16px}
.eb-panel.warm{background:var(--watch-bg);border-color:var(--watch)}
.eb-paneltext{font-size:13px;color:var(--ink);margin-bottom:12px;line-height:1.5}
.eb-panelactions,.eb-editactions{display:flex;gap:9px;align-items:center;flex-wrap:wrap}
.eb-editactions{margin-top:14px}

.eb-settings,.eb-editpanel,.eb-history{margin:14px 0 2px;background:var(--card-2);border:1px solid var(--line);border-radius:13px;padding:15px 16px}
.eb-settings{margin-top:16px}
.eb-eh{font-size:11.5px;font-weight:700;text-transform:uppercase;letter-spacing:.07em;color:var(--forest);margin-bottom:10px;display:flex;gap:10px;align-items:center;flex-wrap:wrap}
.eb-eh.sub{margin-top:14px}
.eb-balance{font-weight:600;text-transform:none;letter-spacing:0;font-size:12px;color:var(--watch)}
.eb-balance.credit{color:var(--good)}
.eb-fields{display:flex;gap:20px;flex-wrap:wrap;align-items:flex-end}
.eb-field{display:flex;flex-direction:column;gap:5px}
.eb-field.wide{flex:1 1 260px}
.eb-field label{font-size:11.5px;color:var(--ink-soft);font-weight:600}
.eb-field input,.eb-field select,.eb-field textarea{font-family:var(--font-jetbrains-mono),ui-monospace,monospace;font-size:15px;font-weight:500;color:var(--forest);background:var(--card);border:1px solid var(--line-strong);border-radius:9px;padding:9px 11px;width:120px}
.eb-field.wide input,.eb-field textarea{width:100%;font-family:inherit}
.eb-field textarea{height:76px;resize:vertical;font-size:14px;color:var(--ink)}
.eb-field select{width:auto;font-family:inherit;font-size:14px}
.eb-field input:focus-visible,.eb-field select:focus-visible,.eb-field textarea:focus-visible{outline:none;border-color:var(--gold);box-shadow:0 0 0 3px rgba(180,132,43,.16)}
.eb-field .hint{font-size:10.5px;color:var(--muted)}
.eb-live{font-family:var(--font-jetbrains-mono),ui-monospace,monospace;font-size:13px;color:var(--forest);font-weight:600;padding-bottom:10px}
.eb-note{font-size:12px;font-weight:600}
.eb-note.good{color:var(--good)} .eb-note.bad{color:var(--danger)}

.eb-table{width:100%;border-collapse:collapse;font-size:12.5px}
.eb-table th{text-align:left;color:var(--muted);font-weight:700;font-size:10.5px;text-transform:uppercase;letter-spacing:.05em;padding:6px 10px;border-bottom:1px solid var(--line)}
.eb-table td{padding:7px 10px;border-bottom:1px solid var(--line-soft);color:var(--ink-soft)}
.eb-payrow{display:flex;justify-content:space-between;align-items:center;gap:12px;padding:7px 0;border-bottom:1px solid var(--line-soft);font-size:12.5px;flex-wrap:wrap}
.eb-payright{display:flex;align-items:center;gap:10px}
.eb-balrow{display:flex;justify-content:space-between;padding:10px 0 2px;margin-top:8px;border-top:1px solid var(--line);font-weight:700;font-size:13px;color:var(--good)}
.eb-balrow.due{color:var(--watch)}
.eb-balnote{font-weight:600;font-size:11px;color:var(--muted)}
.eb-empty{text-align:center;color:var(--muted);padding:3rem 0}
.eb-table tfoot td{border-bottom:none;border-top:1px solid var(--line);padding-top:9px;font-weight:700;color:var(--forest)}
/* ── A voided bill, marked. Quiet on purpose: this is a record, not a warning. The strike and
   the dimming do the work; the tag names it, and the note underneath says who and why. ── */
.eb-table tr.voided td{opacity:.55;border-bottom:none}
.eb-table tr.voided .mo,.eb-table tr.voided .amt{text-decoration:line-through}
.eb-tag.void{margin-left:7px;background:var(--card-2);color:var(--muted);font-weight:600}
.eb-table tr.eb-voidnote td{padding-top:0;padding-left:10px;font-size:11.5px;color:var(--muted);font-style:italic}
.eb-foot-note{margin-left:8px;font-size:10.5px;font-weight:600;font-style:italic;color:var(--muted);text-transform:none;letter-spacing:0}
.eb-gear{font-family:inherit;font-weight:600;font-size:14px;color:var(--ink-soft);background:var(--card);border:1px solid var(--line);border-radius:999px;padding:7px 14px;cursor:pointer;white-space:nowrap}
.eb-gear:hover{border-color:var(--line-strong);color:var(--forest)}

.eb-drawer{margin:16px 0 4px;background:var(--card);border:1px solid var(--gold);border-radius:16px;padding:18px 20px}
.eb-dh{display:flex;align-items:center;justify-content:space-between;margin-bottom:6px}
.eb-dh .t{font-family:var(--font-newsreader),ui-serif,Georgia,serif;font-size:18px;color:var(--forest);font-weight:500}
.eb-dh .x{cursor:pointer;color:var(--muted);font-size:18px;border:none;background:none;line-height:1}
.eb-dnote{font-size:12px;color:var(--muted);margin:0 0 14px}
.eb-dnote.sm{margin:-6px 0 14px}
.eb-srow{display:flex;gap:24px;flex-wrap:wrap;margin-bottom:14px;align-items:flex-end}
.eb-field.email{flex:1 1 100%}
.eb-field.email textarea{width:100%;min-height:96px;font-family:inherit;font-size:13.5px;color:var(--ink);line-height:1.55;resize:vertical}
.eb-chips{display:flex;gap:6px;flex-wrap:wrap;margin-top:8px;align-items:center}
.eb-chips .cl{font-size:11.5px;color:var(--muted);margin-right:2px}
.eb-chip{font-family:var(--font-jetbrains-mono),ui-monospace,monospace;font-size:11.5px;font-weight:500;color:var(--forest);background:var(--card-2);border:1px solid var(--line);border-radius:7px;padding:3px 8px;cursor:pointer}
.eb-chip:hover{border-color:var(--gold);color:var(--gold-ink)}

.eb-bal{display:inline-flex;align-items:center;gap:5px;font-size:11.5px;font-weight:600;border-radius:999px;padding:3px 9px}
.eb-bal.owe{background:var(--watch-bg);color:var(--gold-ink)}
.eb-bal.paid{background:var(--good-bg);color:var(--good)}
.eb-bal .bd{font-weight:600}

.eb-draftnote{margin:16px 0 0;background:var(--draft-bg);border:1px solid var(--draft);border-radius:12px;padding:11px 15px;font-size:13.5px;color:var(--draft)}

@media (max-width:560px){
  .eb-row{flex-wrap:wrap}
  .eb-act{width:100%;justify-content:flex-end;border-top:1px dashed var(--line-soft);padding-top:12px;margin-top:12px}
  .eb-amtwrap{flex:1 1 auto;text-align:left}
  .eb-menu{width:212px}
}
`
