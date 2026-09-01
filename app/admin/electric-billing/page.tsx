'use client'
import { allPaymentMethods, methodLabel } from '@/lib/transactions'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useEffect, useState } from 'react'
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
  const [autoPopulating, setAutoPopulating] = useState(false)

  const monthOptions = generateMonthOptions()

  useEffect(() => { fetchCampers(); fetchMessage() }, [])

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
      let recentCharges: any[] = []
      let folioPayments: FolioPayment[] = []

      if (folio) {
        const [{ data: items }, { data: pmts }] = await Promise.all([
          supabase.from('folio_line_items').select('*').eq('folio_id', folio.id).order('charged_at'),
          supabase.from('folio_payments').select('*').eq('folio_id', folio.id).eq('status', 'completed').order('paid_at', { ascending: false }),
        ])
        const itemsTotal = (items || []).reduce((sum: number, i: any) => sum + i.line_total, 0)
        const paymentsTotal = (pmts || []).reduce((sum: number, p: any) => sum + p.amount - (p.surcharge_amount || 0), 0)
        folioBalance = itemsTotal - paymentsTotal
        recentCharges = items || []
        folioPayments = pmts || []
      }

      // Check if the most recent payment has a receipt sent
      const mostRecentPayment = folioPayments.length > 0 ? folioPayments[0] : null
      const receiptAlreadySent = mostRecentPayment?.receipt_sent_at ? true : false

      return {
        guest, folioId: folio?.id || '', folioBalance, recentCharges, folioPayments,
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
    const creditCents = Math.max(0, amountCents - Math.max(0, row.folioBalance))
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
    const itemsTotal = (items || []).reduce((sum: number, i: any) => sum + i.line_total, 0)
    const paymentsTotal = (pmts || []).reduce((sum: number, p: any) => sum + p.amount - (p.surcharge_amount || 0), 0)
    // Not clamped at zero. An overpayment leaves the folio negative and that negative IS the
    // account credit — clamping it here recorded the credit but hid it, so the operator saw a
    // settled account and no sign of the money sitting on it.
    const newBalance = itemsTotal - paymentsTotal

    setCampers(prev => {
      const u = [...prev]
      u[index] = { ...u[index], folioBalance: newBalance, folioPayments: pmts || [], savingPayment: false, showPayment: false, paymentAmount: '', paymentNote: '', lastPaymentRecorded: newPayment || null, showReceiptConfirm: false, receiptSent: false }
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
        remainingBalance: row.folioBalance, paymentId: row.lastPaymentRecorded.id,
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
    const itemsTotal = (allItems || []).reduce((sum: number, i: any) => sum + i.line_total, 0)
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
    if (!finalAmountCents) { setCampers(prev => { const u = [...prev]; u[index] = { ...u[index], error: 'Enter meter readings first' }; return u }); return }
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
    if (row.draftId) {
      await supabase.from('electric_readings').update(readingRow).eq('id', row.draftId).eq('status', 'draft')
    } else {
      await supabase.from('electric_readings').insert(readingRow)
    }

    const { data: allItems } = await supabase.from('folio_line_items').select('*').eq('folio_id', folioId).order('charged_at')
    const { data: allPayments } = await supabase.from('folio_payments').select('*').eq('folio_id', folioId).eq('status', 'completed').order('paid_at')
    const itemsTotal = (allItems || []).reduce((sum: number, i: any) => sum + i.line_total, 0)
    const paymentsTotal = (allPayments || []).reduce((sum: number, p: any) => sum + p.amount - (p.surcharge_amount || 0), 0)
    // Live folio balance — matches what shows in their guest folio exactly
    const liveBalance = itemsTotal - paymentsTotal

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
      }),
    })
    const data = await res.json()
    setCampers(prev => { const u = [...prev]; u[index] = { ...u[index], sending: false, sent: data.success, folioId, folioBalance: liveBalance, historyLoaded: false, draftId: data.success ? '' : u[index].draftId, error: data.success ? '' : (data.error || 'Failed to send') }; return u })
  }

  async function sendAllBills() {
    setSendingAll(true)
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

  const readyToSend = campers.filter(c => !c.skip && !c.sent && c.finalAmount).length
  const draftCount = campers.filter(c => c.draftId && !c.sent).length

  if (loading) return <div style={{ padding: '3rem', textAlign: 'center', color: '#6b7280' }}>Loading seasonal campers...</div>

  return (
    <div style={{ padding: '2rem', maxWidth: 1200, margin: '0 auto', fontFamily: 'sans-serif' }}>
      <div style={{ marginBottom: '1.5rem', display: 'flex', flexWrap: 'wrap', gap: 12, alignItems: 'flex-start', justifyContent: 'space-between' }}>
        <div>
          <h1 style={{ fontSize: 24, fontWeight: 700, margin: 0 }}>Electric Billing</h1>
          <p style={{ color: '#6b7280', margin: '4px 0 0', fontSize: 14 }}>Generate and send monthly electric bills to seasonal campers</p>
        </div>
        {/* THE ENTRY POINT to the meter walk. Here and in the seasonals area rather than as a new
            permanent sidebar item — PR 4's Seasonal Dashboard hub is its intended home. */}
        <Link href="/admin/seasonals/meters" style={{
          display: 'inline-flex', alignItems: 'center', gap: 8, minHeight: 44, padding: '0 18px',
          borderRadius: 9, background: '#2E6B8A', color: '#fff', textDecoration: 'none',
          fontSize: 14, fontWeight: 600, flexShrink: 0,
        }}>
          📱 Read electric meters
        </Link>
      </div>

      {/* Drafts waiting for review. Deliberately loud and deliberately explicit that nothing has
          been charged — a walked month that LOOKS billed is the failure this whole status column
          exists to prevent. */}
      {draftCount > 0 && (
        <div style={{ background: '#eff6ff', border: '1px solid #bfdbfe', borderRadius: 10, padding: '11px 15px', marginBottom: 16, fontSize: 14, color: '#1e3a8a' }}>
          <strong>{draftCount} reading{draftCount === 1 ? '' : 's'} from a meter walk {draftCount === 1 ? 'is' : 'are'} filled in below for {billingMonth}.</strong>
          {' '}Nothing has been charged or sent. Check the amounts, then use Bill Electric as usual.
        </div>
      )}

      <div style={{ display: 'flex', gap: 4, marginBottom: 20, borderBottom: '1px solid #e5e7eb' }}>
        {(['billing', 'history'] as const).map(tab => (
          <button key={tab} onClick={() => setActiveTab(tab)} style={{ padding: '10px 20px', fontSize: 14, fontWeight: 600, border: 'none', background: 'none', cursor: 'pointer', borderBottom: activeTab === tab ? '2px solid #2E6B8A' : '2px solid transparent', color: activeTab === tab ? '#2E6B8A' : '#6b7280', marginBottom: -1 }}>
            {tab === 'billing' ? 'Monthly Billing' : 'Account History'}
          </button>
        ))}
      </div>

      {activeTab === 'billing' && (
        <>
          <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 12, padding: '1.5rem', marginBottom: 20 }}>
            <h3 style={{ margin: '0 0 1rem', fontSize: 15, fontWeight: 700 }}>Billing Settings</h3>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 16, marginBottom: 16 }}>
              <div>
                <label style={lbl}>Billing month</label>
                <select style={inp} value={billingMonth} onChange={e => handleMonthChange(e.target.value)} disabled={autoPopulating}>
                  {monthOptions.map(m => <option key={m} value={m}>{m}</option>)}
                </select>
                {autoPopulating && <div style={{ fontSize: 11, color: '#2E6B8A', marginTop: 4 }}>⟳ Loading previous readings...</div>}
              </div>
              <div>
                <label style={lbl}>Rate per kWh ($)</label>
                <input style={inp} type='number' step='0.01' value={ratePerKwh} onChange={e => { setRatePerKwh(e.target.value); setRateSaved('') }} />
              </div>
              <div>
                <label style={lbl}>Minimum charge ($)</label>
                <input style={inp} type='number' step='0.01' value={minimumCharge} onChange={e => { setMinimumCharge(e.target.value); setRateSaved('') }} />
              </div>
            </div>
            {/* Saving is what carries the rate to the phone. Without it the walk's live "≈ $"
                would price at the fallback while this screen priced at whatever was typed here. */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 16 }}>
              <button onClick={saveRate} disabled={savingRate} style={{ background: '#fff', color: '#2E6B8A', border: '1px solid #2E6B8A', borderRadius: 7, padding: '7px 16px', fontSize: 13, fontWeight: 600, cursor: 'pointer', minHeight: 38 }}>
                {savingRate ? 'Saving…' : 'Save rate for the meter-reading screen'}
              </button>
              {rateSaved ? <span style={{ fontSize: 12, fontWeight: 600, color: rateSaved.startsWith('Could not') ? '#b91c1c' : '#15803d' }}>{rateSaved}</span> : null}
            </div>
            <div>
              <label style={lbl}>Custom email message</label>
              <textarea style={{ ...inp, height: 80, resize: 'vertical' }} value={emailMessage} onChange={e => setEmailMessage(e.target.value)} />
              <button onClick={saveMessage} style={{ marginTop: 8, background: '#2E6B8A', color: '#fff', border: 'none', borderRadius: 7, padding: '7px 18px', fontSize: 13, fontWeight: 600, cursor: 'pointer' }}>Save Message</button>
            </div>
          </div>

          {campers.length === 0 ? (
            <div style={{ textAlign: 'center', color: '#9ca3af', padding: '3rem 0' }}>No seasonal campers found.</div>
          ) : (
            <>
              <div style={{ overflowX: 'auto', marginBottom: 20 }}>
                <div style={{ border: '1px solid #e5e7eb', borderRadius: 12, overflow: 'hidden', background: '#fff', minWidth: 960 }}>
                  <div style={{ display: 'grid', gridTemplateColumns: '1.2fr 60px 100px 100px 60px 90px 100px 110px 80px', gap: 6, padding: '10px 14px', background: '#f9fafb', borderBottom: '1px solid #e5e7eb', fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', color: '#6b7280' }}>
                    <div>Guest</div><div>Site</div><div>Prev reading</div><div>Curr reading</div><div>kWh</div><div>Calculated</div><div>Final amount</div><div>Balance</div><div>Skip</div>
                  </div>

                  {campers.map((row, i) => (
                    <div key={row.guest.id} style={{ borderBottom: i < campers.length - 1 ? '1px solid #f3f4f6' : 'none', background: row.skip ? '#f9fafb' : row.sent ? '#f0fdf4' : '#fff' }}>
                      <div style={{ display: 'grid', gridTemplateColumns: '1.2fr 60px 100px 100px 60px 90px 100px 110px 80px', gap: 6, padding: '10px 14px', alignItems: 'center' }}>
                        <div>
                          <div style={{ fontWeight: 600, fontSize: 13, color: row.skip ? '#9ca3af' : '#111827' }}>
                            {row.guest.name}
                          </div>
                          {/* On its own line and non-wrapping: as an inline badge after the name it
                              broke mid-phrase ("DRAFT ·" / "not charged"), and half a warning that
                              nothing has been charged is worse than none. */}
                          {row.draftId && !row.sent ? (
                            <div style={{ marginTop: 3 }}>
                              <span style={{ display: 'inline-block', whiteSpace: 'nowrap', background: '#eff6ff', color: '#1d4ed8', border: '1px solid #bfdbfe', borderRadius: 999, padding: '1px 7px', fontSize: 10, fontWeight: 700 }}>
                                DRAFT · not charged
                              </span>
                            </div>
                          ) : null}
                          <div style={{ fontSize: 11, color: '#9ca3af' }}>{row.guest.email || 'No email'}</div>
                        </div>
                        <div style={{ fontSize: 13, fontWeight: 600, color: '#6b7280' }}>{row.guest.site_number}</div>
                        <input style={{ ...si, opacity: row.skip ? 0.4 : 1 }} type='number' placeholder='0' value={row.previousReading} disabled={row.skip || row.sent} onChange={e => updateReading(i, 'previousReading', e.target.value)} />
                        <input style={{ ...si, opacity: row.skip ? 0.4 : 1 }} type='number' placeholder='0' value={row.currentReading} disabled={row.skip || row.sent} onChange={e => updateReading(i, 'currentReading', e.target.value)} />
                        <div style={{ fontSize: 13, fontWeight: 600, color: '#374151' }}>{row.kwhUsed > 0 ? row.kwhUsed.toFixed(1) : '—'}</div>
                        <div style={{ fontSize: 13, color: '#6b7280' }}>{row.calculatedAmount > 0 ? '$' + (row.calculatedAmount / 100).toFixed(2) : '—'}</div>
                        <div style={{ position: 'relative' }}>
                          <span style={{ position: 'absolute', left: 8, top: '50%', transform: 'translateY(-50%)', color: '#6b7280', fontSize: 13 }}>$</span>
                          <input style={{ ...si, paddingLeft: 20, opacity: row.skip ? 0.4 : 1 }} type='number' step='0.01' placeholder='0.00' value={row.finalAmount} disabled={row.skip || row.sent} onChange={e => updateFinalAmount(i, e.target.value)} />
                        </div>
                        <div style={{ fontSize: 13, fontWeight: 700, color: row.folioBalance > 0 ? '#dc2626' : '#15803d' }}>
                          {row.folioBalance > 0
                            ? '$' + (row.folioBalance / 100).toFixed(2)
                            : row.folioBalance < 0
                            ? 'Credit $' + (Math.abs(row.folioBalance) / 100).toFixed(2)
                            : '✓ Current'}
                        </div>
                        <button onClick={() => toggleSkip(i)} disabled={row.sent} style={{ fontSize: 11, fontWeight: 600, border: '1px solid', borderColor: row.skip ? '#d1d5db' : '#fca5a5', borderRadius: 6, padding: '4px 8px', cursor: 'pointer', background: row.skip ? '#f3f4f6' : '#fef2f2', color: row.skip ? '#6b7280' : '#dc2626' }}>
                          {row.skip ? 'Skipped' : 'Skip'}
                        </button>
                      </div>

                      {/* ── THE PER-METER LINES ────────────────────────────────────────────
                          A camper on more than one site has more than one meter, and this is the
                          whole double-site answer: they appear ONCE, under their own name, with a
                          reading line per meter and a single summed total. Never two camper rows,
                          never two bills, never two statements.

                          Each line stays individually visible so the readings can be checked
                          against the meters. Editing the totals above clears these lines rather
                          than leaving them describing a bill they no longer describe. */}
                      {!row.skip && row.meterBreakdown.length > 0 && (
                        <div style={{ padding: '0 14px 10px' }}>
                          <div style={{ background: '#f9fafb', border: '1px solid #e5e7eb', borderRadius: 9, overflow: 'hidden' }}>
                            <div style={{ padding: '6px 12px', fontSize: 10, fontWeight: 700, letterSpacing: '.06em', textTransform: 'uppercase', color: '#6b7280', borderBottom: '1px solid #e5e7eb' }}>
                              {row.meterBreakdown.length > 1
                                ? `${row.meterBreakdown.length} meters on this camper's sites — one bill, summed`
                                : 'Meter reading'}
                            </div>
                            {row.meterBreakdown.map(line => (
                              <div key={line.meter_id} style={{ display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'center', justifyContent: 'space-between', padding: '7px 12px', borderTop: '1px solid #f3f4f6', fontSize: 12 }}>
                                <span style={{ fontWeight: 700, color: '#374151', minWidth: 74 }}>Meter {line.meter_number}</span>
                                <span style={{ color: '#6b7280', fontVariantNumeric: 'tabular-nums' }}>
                                  {Number(line.previous_reading).toLocaleString()} → {Number(line.current_reading).toLocaleString()}
                                </span>
                                <span style={{ fontWeight: 600, color: '#374151', fontVariantNumeric: 'tabular-nums' }}>
                                  {Number(line.kwh).toLocaleString()} kWh
                                </span>
                                {line.is_reset ? (
                                  <span title={line.replaced_meter_final != null ? `The old meter last read ${Number(line.replaced_meter_final).toLocaleString()}. Power used on it since its previous reading is not included — add it to the amount if you noted it down.` : undefined}
                                    style={{ background: '#fffbeb', border: '1px solid #f59e0b', color: '#92400e', borderRadius: 999, padding: '1px 8px', fontSize: 11, fontWeight: 700 }}>
                                    meter replaced
                                  </span>
                                ) : null}
                              </div>
                            ))}
                            {row.meterBreakdown.length > 1 && (
                              <div style={{ display: 'flex', justifyContent: 'space-between', padding: '7px 12px', borderTop: '1px solid #e5e7eb', background: '#fff', fontSize: 12, fontWeight: 700, color: '#111827' }}>
                                <span>Total</span>
                                <span style={{ fontVariantNumeric: 'tabular-nums' }}>{row.kwhUsed.toLocaleString()} kWh</span>
                              </div>
                            )}
                          </div>
                        </div>
                      )}

                      {/* ── ⚠ THE READING-LOOKS-OFF GUARD ─────────────────────────────────────
                          Defence in depth for a bill that already happened once: a meter with no
                          baseline was measured from zero, so 43 kWh of usage staged as 5,803 kWh
                          — $1,566.81 instead of $15.00. It was a draft and draft-first caught it.
                          This is the second net. It does not just warn: it WITHHOLDS the one-click
                          Bill Electric, so a bill of this shape cannot be posted without somebody
                          deliberately looking at it first. */}
                      {!row.skip && anomalyFor(row) && (
                        <div style={{ padding: '0 14px 10px' }}>
                          <div style={{ background: '#fffbeb', border: '1px solid #f59e0b', borderRadius: 9, padding: '10px 13px', fontSize: 13, color: '#92400e' }}>
                            <strong>This reading looks off — check it before billing.</strong>
                            <div style={{ marginTop: 3, lineHeight: 1.5 }}>{anomalyFor(row)!.message}</div>
                            <button onClick={() => setCampers(prev => { const u = [...prev]; u[i] = { ...u[i], anomalyAcknowledged: true }; return u })}
                              style={{ marginTop: 8, background: '#fff', border: '1px solid #f59e0b', color: '#92400e', borderRadius: 7, padding: '5px 12px', fontSize: 12, fontWeight: 700, cursor: 'pointer' }}>
                              I&rsquo;ve checked it — let me bill this
                            </button>
                          </div>
                        </div>
                      )}

                      {!row.skip && (
                        <div style={{ padding: '0 14px 12px', display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                          {/* Bill Electric — the ONLY charge-creating action; once a month, with confirm */}
                          {!row.sent ? (
                            <button onClick={() => setCampers(prev => { const u = [...prev]; u[i] = { ...u[i], showBillConfirm: true }; return u })}
                              disabled={row.sending || !row.finalAmount || blockedByAnomaly(row)}
                              style={{ background: '#2E6B8A', color: '#fff', border: 'none', borderRadius: 7, padding: '7px 16px', fontSize: 13, fontWeight: 600, cursor: (!row.finalAmount || blockedByAnomaly(row)) ? 'default' : 'pointer', opacity: (!row.finalAmount || blockedByAnomaly(row)) ? 0.5 : 1 }}>
                              {row.sending ? 'Billing...' : '⚡ Bill Electric'}
                            </button>
                          ) : (
                            <span style={{ fontSize: 13, color: '#15803d', fontWeight: 600 }}>✓ Billed</span>
                          )}

                          {/* Send Statement — always available, emails the live ledger, NEVER creates a charge */}
                          {!row.editEmailMode ? (
                            <button onClick={() => resendBill(i)}
                              disabled={row.sending || !row.guest.email}
                              style={{ background: '#e8f2f7', color: '#1d4ed8', border: '1px solid #bfdbfe', borderRadius: 7, padding: '7px 16px', fontSize: 13, fontWeight: 600, cursor: (row.sending || !row.guest.email) ? 'default' : 'pointer', opacity: (row.sending || !row.guest.email) ? 0.6 : 1 }}>
                              {row.sending ? 'Sending...' : '✉ Send Statement'}
                            </button>
                          ) : (
                            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                              <input type='email' value={row.editEmailValue}
                                onChange={e => setCampers(prev => { const u = [...prev]; u[i] = { ...u[i], editEmailValue: e.target.value }; return u })}
                                style={{ border: '1px solid #d1d5db', borderRadius: 6, padding: '5px 10px', fontSize: 13, width: 200 }}
                                placeholder='Email address' />
                              <button onClick={() => resendBill(i, row.editEmailValue)}
                                style={{ background: '#2E6B8A', color: '#fff', border: 'none', borderRadius: 7, padding: '5px 12px', fontSize: 12, fontWeight: 600, cursor: 'pointer' }}>
                                Send
                              </button>
                              <button onClick={() => setCampers(prev => { const u = [...prev]; u[i] = { ...u[i], editEmailMode: false }; return u })}
                                style={{ background: 'none', border: '1px solid #e5e7eb', borderRadius: 7, padding: '5px 10px', fontSize: 12, color: '#6b7280', cursor: 'pointer' }}>
                                Cancel
                              </button>
                            </div>
                          )}

                          {/* Secondary: send the statement to a corrected address */}
                          {!row.editEmailMode && (
                            <button onClick={() => setCampers(prev => { const u = [...prev]; u[i] = { ...u[i], editEmailMode: true, editEmailValue: row.guest.email }; return u })}
                              style={{ background: 'none', border: 'none', color: '#9ca3af', fontSize: 12, textDecoration: 'underline', cursor: 'pointer', padding: '0 2px' }}>
                              wrong email?
                            </button>
                          )}

                          {/* Opens on a settled or already-credited account too, so a camper can
                              pay ahead. It used to require a positive balance, which meant a
                              prepayment had nowhere to go on this screen. */}
                          {!row.showPayment && (
                            <button onClick={() => { updatePaymentField(i, 'showPayment', 'true'); updatePaymentField(i, 'paymentAmount', (Math.max(0, row.folioBalance) / 100).toFixed(2)) }}
                              style={{ background: '#f0fdf4', color: '#15803d', border: '1px solid #bbf7d0', borderRadius: 7, padding: '7px 16px', fontSize: 13, fontWeight: 600, cursor: 'pointer' }}>
                              💵 {row.folioBalance > 0 ? 'Record Payment' : 'Record Payment / Prepay'}
                            </button>
                          )}

                          {row.lastPaymentRecorded && !row.receiptSent && !row.showReceiptConfirm && (
                            <button onClick={() => setCampers(prev => { const u = [...prev]; u[i] = { ...u[i], showReceiptConfirm: true }; return u })}
                              style={{ background: '#fffbeb', color: '#92400e', border: '1px solid #fde68a', borderRadius: 7, padding: '7px 16px', fontSize: 13, fontWeight: 600, cursor: 'pointer' }}>
                              🧾 Send Receipt
                            </button>
                          )}
                          {row.receiptSent && <span style={{ fontSize: 12, color: '#15803d', fontWeight: 600 }}>✓ Receipt sent!</span>}

                          <button onClick={() => loadHistory(i)}
                            style={{ background: '#f3f4f6', color: '#374151', border: '1px solid #e5e7eb', borderRadius: 7, padding: '7px 16px', fontSize: 13, fontWeight: 600, cursor: 'pointer' }}>
                            {row.showHistory ? 'Hide History' : '📋 View History'}
                          </button>

                          {row.error && <span style={{ fontSize: 12, color: '#dc2626' }}>{row.error}</span>}
                          {!row.guest.email && <span style={{ fontSize: 12, color: '#9ca3af' }}>No email on file</span>}
                        </div>
                      )}

                      {row.showBillConfirm && (
                        <div style={{ margin: '0 14px 14px', background: '#eff6ff', border: '1px solid #bfdbfe', borderRadius: 10, padding: '14px' }}>
                          <div style={{ fontSize: 13, fontWeight: 700, color: '#1e40af', marginBottom: 8 }}>
                            Bill electric to {row.guest.name}?
                          </div>
                          <MonthHeadline lead={'Billing ' + row.guest.name + ' for'} billingMonth={billingMonth} />
                          <div style={{ fontSize: 13, color: '#1e3a8a', marginBottom: 12 }}>
                            This creates a <strong>{billingMonth} electric charge of ${row.finalAmount}</strong> on their account and emails their statement to <strong>{row.guest.email}</strong>.
                          </div>
                          <div style={{ display: 'flex', gap: 10 }}>
                            <button onClick={() => { setCampers(prev => { const u = [...prev]; u[i] = { ...u[i], showBillConfirm: false }; return u }); sendBill(i) }}
                              style={{ background: '#2E6B8A', color: '#fff', border: 'none', borderRadius: 7, padding: '7px 16px', fontSize: 13, fontWeight: 600, cursor: 'pointer' }}>
                              Yes, Bill Electric
                            </button>
                            <button onClick={() => setCampers(prev => { const u = [...prev]; u[i] = { ...u[i], showBillConfirm: false }; return u })}
                              style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 7, padding: '7px 16px', fontSize: 13, fontWeight: 600, color: '#6b7280', cursor: 'pointer' }}>
                              Cancel
                            </button>
                          </div>
                        </div>
                      )}

                      {row.showReceiptConfirm && row.lastPaymentRecorded && (
                        <div style={{ margin: '0 14px 14px', background: '#fffbeb', border: '1px solid #fde68a', borderRadius: 10, padding: '14px' }}>
                          <div style={{ fontSize: 13, fontWeight: 700, color: '#92400e', marginBottom: 6 }}>Send payment receipt to {row.guest.name}?</div>
                          <div style={{ fontSize: 13, color: '#78350f', marginBottom: 12 }}>
                            A receipt for <strong>${(row.lastPaymentRecorded.amount / 100).toFixed(2)}</strong> will be sent to <strong>{row.guest.email}</strong>
                          </div>
                          <div style={{ display: 'flex', gap: 10 }}>
                            <button onClick={() => sendReceipt(i)} disabled={row.sendingReceipt}
                              style={{ background: '#d97706', color: '#fff', border: 'none', borderRadius: 7, padding: '7px 18px', fontSize: 13, fontWeight: 600, cursor: 'pointer' }}>
                              {row.sendingReceipt ? 'Sending...' : 'Yes, Send Receipt'}
                            </button>
                            <button onClick={() => setCampers(prev => { const u = [...prev]; u[i] = { ...u[i], showReceiptConfirm: false }; return u })}
                              style={{ background: 'none', border: '1px solid #d1d5db', borderRadius: 7, padding: '7px 14px', fontSize: 13, cursor: 'pointer' }}>
                              Cancel
                            </button>
                          </div>
                        </div>
                      )}

                      {row.showPayment && (
                        <div style={{ margin: '0 14px 14px', background: '#f0fdf4', border: '1px solid #bbf7d0', borderRadius: 10, padding: '14px' }}>
                          <div style={{ fontSize: 13, fontWeight: 700, color: '#15803d', marginBottom: 10 }}>Record Payment — {row.guest.name}</div>
                          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'flex-end' }}>
                            <div>
                              <label style={{ ...lbl, marginTop: 0 }}>Amount ($)</label>
                              <input style={{ ...si, width: 110 }} type='number' step='0.01' value={row.paymentAmount} onChange={e => updatePaymentField(i, 'paymentAmount', e.target.value)} />
                            </div>
                            <div>
                              <label style={{ ...lbl, marginTop: 0 }}>Method</label>
                              <select style={{ ...si, width: 120 }} value={row.paymentMethod} onChange={e => updatePaymentField(i, 'paymentMethod', e.target.value)}>
                                {allPaymentMethods(customMethods).map(m => <option key={m} value={m}>{methodLabel(m)}</option>)}
                                <option value='other'>Other</option>
                              </select>
                              {row.paymentMethod === 'card' && (
                                <div style={{ fontSize: 11, color: '#15803d', marginTop: 4, fontStyle: 'italic' }}>
                                  → Will open guest folio to charge terminal
                                </div>
                              )}
                            </div>
                            <div style={{ flex: 1, minWidth: 120 }}>
                              <label style={{ ...lbl, marginTop: 0 }}>Note (optional)</label>
                              <input style={si} placeholder='e.g. Check #1042' value={row.paymentNote} onChange={e => updatePaymentField(i, 'paymentNote', e.target.value)} />
                            </div>
                            <button onClick={() => {
                              if (row.paymentMethod === 'card') {
                                window.location.href = `/admin/folio/guest/${row.guest.id}`;
                              } else {
                                recordPayment(i);
                              }
                            }} disabled={row.savingPayment || !row.paymentAmount}
                              style={{ background: '#15803d', color: '#fff', border: 'none', borderRadius: 7, padding: '7px 18px', fontSize: 13, fontWeight: 600, cursor: 'pointer', height: 34 }}>
                              {row.savingPayment ? 'Saving...' : 'Save Payment'}
                            </button>
                            <button onClick={() => updatePaymentField(i, 'showPayment', false as unknown as string)}
                              style={{ background: 'none', border: '1px solid #d1d5db', borderRadius: 7, padding: '7px 14px', fontSize: 13, cursor: 'pointer', height: 34 }}>
                              Cancel
                            </button>
                          </div>
                        </div>
                      )}

                      {row.showHistory && (
                        <div style={{ margin: '0 14px 14px', background: '#f8fafc', border: '1px solid #e5e7eb', borderRadius: 10, overflow: 'hidden' }}>
                          <div style={{ padding: '10px 14px', fontSize: 12, fontWeight: 700, color: '#374151', background: '#f1f5f9', borderBottom: '1px solid #e5e7eb' }}>
                            Billing History — {row.guest.name} · Site {row.guest.site_number}
                          </div>
                          {row.readings.length === 0 ? (
                            <div style={{ padding: '1rem', fontSize: 13, color: '#9ca3af' }}>No billing history yet.</div>
                          ) : (
                            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                              <thead>
                                <tr style={{ background: '#f9fafb' }}>
                                  {['Month', 'Prev', 'Curr', 'kWh', 'Rate', 'Billed', 'Date'].map(h => (
                                    <th key={h} style={{ padding: '7px 12px', textAlign: 'left', color: '#6b7280', fontWeight: 700, fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.04em', borderBottom: '1px solid #e5e7eb' }}>{h}</th>
                                  ))}
                                </tr>
                              </thead>
                              <tbody>
                                {row.readings.map((r, ri) => (
                                  <tr key={r.id} style={{ borderBottom: ri < row.readings.length - 1 ? '1px solid #f3f4f6' : 'none', background: ri % 2 === 0 ? '#fff' : '#fafafa' }}>
                                    <td style={{ padding: '8px 12px', fontWeight: 600, color: '#111827' }}>{r.billing_month}</td>
                                    <td style={{ padding: '8px 12px', color: '#6b7280' }}>{Number(r.previous_reading).toLocaleString()}</td>
                                    <td style={{ padding: '8px 12px', color: '#6b7280' }}>{Number(r.current_reading).toLocaleString()}</td>
                                    <td style={{ padding: '8px 12px', color: '#374151', fontWeight: 600 }}>{Number(r.kwh_used).toFixed(1)}</td>
                                    <td style={{ padding: '8px 12px', color: '#6b7280' }}>${Number(r.rate_per_kwh).toFixed(3)}</td>
                                    <td style={{ padding: '8px 12px', fontWeight: 700, color: '#15803d' }}>${(r.final_amount / 100).toFixed(2)}</td>
                                    <td style={{ padding: '8px 12px', color: '#9ca3af' }}>{new Date(r.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: '2-digit' })}</td>
                                  </tr>
                                ))}
                              </tbody>
                              <tfoot>
                                <tr style={{ background: '#f0fdf4', borderTop: '2px solid #bbf7d0' }}>
                                  <td colSpan={5} style={{ padding: '8px 12px', fontWeight: 700, fontSize: 12, color: '#15803d' }}>Total billed (all time)</td>
                                  <td style={{ padding: '8px 12px', fontWeight: 800, color: '#15803d' }}>${(row.readings.reduce((s, r) => s + r.final_amount, 0) / 100).toFixed(2)}</td>
                                  <td />
                                </tr>
                              </tfoot>
                            </table>
                          )}
                          {row.folioPayments.length > 0 && (
                            <div style={{ borderTop: '1px solid #e5e7eb' }}>
                              <div style={{ padding: '10px 14px', fontSize: 11, fontWeight: 700, color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.06em', background: '#f9fafb' }}>Payments received</div>
                              {row.folioPayments.map((p, pi) => (
                                <div key={p.id} style={{ borderBottom: pi < row.folioPayments.length - 1 ? '1px solid #f3f4f6' : 'none' }}>
                                  <div style={{ display: 'flex', justifyContent: 'space-between', padding: '7px 14px', fontSize: 12, alignItems: 'center' }}>
                                    <div>
                                      <span style={{ fontWeight: 600, color: '#374151', textTransform: 'capitalize' }}>{p.method}</span>
                                      {p.note && <span style={{ color: '#9ca3af', marginLeft: 8 }}>{p.note}</span>}
                                      <span style={{ color: '#9ca3af', marginLeft: 8 }}>{new Date(p.paid_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: '2-digit' })}</span>
                                      {p.receipt_sent_at
                                        ? <span style={{ marginLeft: 10, fontSize: 11, color: '#15803d' }}>🧾 Receipt sent {new Date(p.receipt_sent_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: '2-digit' })}</span>
                                        : <span style={{ marginLeft: 10, fontSize: 11, color: '#9ca3af' }}>No receipt sent</span>
                                      }
                                    </div>
                                    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                                      <span style={{ fontWeight: 700, color: '#15803d' }}>-${((p.amount - (p.surcharge_amount || 0)) / 100).toFixed(2)}</span>
                                      <button
                                        onClick={() => setCampers(prev => {
                                          const u = [...prev]
                                          u[i] = { ...u[i], lastPaymentRecorded: p, showReceiptConfirm: true, receiptSent: false }
                                          return u
                                        })}
                                        style={{ fontSize: 11, background: '#fffbeb', color: '#92400e', border: '1px solid #fde68a', borderRadius: 5, padding: '3px 8px', cursor: 'pointer', fontWeight: 600 }}>
                                        {p.receipt_sent_at ? '↩ Re-send' : '🧾 Send'}
                                      </button>
                                    </div>
                                  </div>
                                </div>
                              ))}
                            </div>
                          )}
                          {/* Balance due summary */}
                          <div style={{ padding: '10px 14px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderTop: '2px solid #e5e7eb', background: row.folioBalance < 0 ? '#f0fdf4' : row.folioBalance === 0 ? '#f0fdf4' : '#fef2f2' }}>
                            <span style={{ fontSize: 13, fontWeight: 700, color: row.folioBalance < 0 ? '#15803d' : row.folioBalance === 0 ? '#15803d' : '#dc2626' }}>
                              {row.folioBalance < 0 ? 'Credit on Account' : row.folioBalance === 0 ? '✓ Paid in Full' : 'Balance Due'}
                            </span>
                            <span style={{ fontSize: 15, fontWeight: 800, color: row.folioBalance < 0 ? '#15803d' : row.folioBalance === 0 ? '#15803d' : '#dc2626' }}>
                              {row.folioBalance < 0 ? '-$' + (Math.abs(row.folioBalance) / 100).toFixed(2) : '$' + (row.folioBalance / 100).toFixed(2)}
                            </span>
                          </div>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </div>

              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 12 }}>
                {/* The batch used to fire on one click. It now asks, and the ask leads with the
                    month, because this is the action that can mislabel every camper at once. */}
                {showSendAllConfirm && (
                  <div style={{ background: '#eff6ff', border: '1px solid #bfdbfe', borderRadius: 10, padding: 16, maxWidth: 520, textAlign: 'left', alignSelf: 'flex-end' }}>
                    <MonthHeadline lead='Billing everyone for' billingMonth={billingMonth} />
                    <div style={{ fontSize: 13, color: '#1e3a8a', marginBottom: 12 }}>
                      This creates a <strong>{billingMonth} electric charge</strong> on <strong>{readyToSend} camper account{readyToSend !== 1 ? 's' : ''}</strong> and emails each of them a statement. Campers already billed for this month, and any marked Skip, are left alone.
                    </div>
                    <div style={{ display: 'flex', gap: 10 }}>
                      <button onClick={() => { setShowSendAllConfirm(false); sendAllBills() }}
                        style={{ background: '#2E6B8A', color: '#fff', border: 'none', borderRadius: 7, padding: '8px 18px', fontSize: 13, fontWeight: 700, cursor: 'pointer' }}>
                        Yes, Bill {billingMonth}
                      </button>
                      <button onClick={() => setShowSendAllConfirm(false)}
                        style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 7, padding: '8px 16px', fontSize: 13, fontWeight: 600, color: '#6b7280', cursor: 'pointer' }}>
                        Cancel
                      </button>
                    </div>
                  </div>
                )}
                <div style={{ display: 'flex', justifyContent: 'flex-end', alignItems: 'center', gap: 16 }}>
                  <span style={{ fontSize: 14, color: '#6b7280' }}>{readyToSend} bill{readyToSend !== 1 ? 's' : ''} ready to send</span>
                  <button onClick={() => setShowSendAllConfirm(true)} disabled={sendingAll || readyToSend === 0}
                    style={{ background: readyToSend > 0 ? '#2E6B8A' : '#d1d5db', color: '#fff', border: 'none', borderRadius: 8, padding: '11px 28px', fontWeight: 700, fontSize: 15, cursor: readyToSend > 0 ? 'pointer' : 'default' }}>
                    {sendingAll ? 'Sending all...' : 'Send All Bills'}
                  </button>
                </div>
              </div>
            </>
          )}
        </>
      )}

      {activeTab === 'history' && (
        <div>
          {campers.length === 0 ? (
            <div style={{ textAlign: 'center', color: '#9ca3af', padding: '3rem 0' }}>No seasonal campers found.</div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
              {campers.map((row) => (
                <GuestAccountCard key={row.guest.id} guest={row.guest} folioBalance={row.folioBalance} />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function GuestAccountCard({ guest, folioBalance }: { guest: Guest; folioBalance: number }) {
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

const lbl: React.CSSProperties = { display: 'block', fontSize: 13, fontWeight: 600, color: '#374151', marginBottom: 4, marginTop: 8 }
const inp: React.CSSProperties = { width: '100%', border: '1px solid #d1d5db', borderRadius: 7, padding: '8px 10px', fontSize: 14, boxSizing: 'border-box' }
const si: React.CSSProperties = { width: '100%', border: '1px solid #d1d5db', borderRadius: 6, padding: '6px 8px', fontSize: 13, boxSizing: 'border-box' }
