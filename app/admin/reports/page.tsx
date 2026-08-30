'use client'
import { useEffect, useState, useRef } from 'react'
import { createBrowserSupabase } from '@/lib/supabase-browser'

// Security PR 7-1: the admin browser talks to Supabase as the LOGGED-IN USER, not as `anon`.
// Same publishable key, but it travels with the session cookie, so PostgREST runs these queries
// as `authenticated` and the role-gated RLS policies apply. Safe at module scope:
// createBrowserClient returns a singleton in the browser and a no-op cookie store during
// prerender.
const supabase = createBrowserSupabase()
import { useRouter } from 'next/navigation'
import { fetchUnifiedTransactions, ymd, dayStartUTC, dayEndUTC, allPaymentMethods, methodLabel, methodColor, type UnifiedPayment } from '@/lib/transactions'
import RefundModal, { type RefundTarget } from '@/app/components/RefundModal'
import { folioPaymentRefundable, REFUNDABLE_STATUSES } from '@/lib/refundable'
// ── REPORTS R1: THE NUMBERS HAVE TO RECONCILE ────────────────────────────────────────────────
//
// Everything below is IMPORTED, never reimplemented here. `notVoided` is the app's one
// void-filter idiom; lib/ledger-lanes.ts is the classifier the folio, the receipt and the
// electric bill already use. A report that decides for itself what a charge is FOR, or which
// charges count, is a report that disagrees with the folio it was built from — which is the
// fastest way to lose an owner. lib/ledger.ts, booking-quote.ts and pricing.ts are untouched.
import { notVoided } from '@/lib/ledger'
import { laneBalances, LANES, type Lane, type LaneBalances } from '@/lib/ledger-lanes'
import { LANE_LABEL, LANE_COLOR, SEASONAL_CAMPER_LANES } from '@/lib/lane-display'
import {
  bucketGuestAccountCharges, rollUpLanes, segmentOf,
  type Segment, type GuestAccountBuckets,
} from '@/lib/report-buckets'
// ── REPORTS R2: THE MONEY VIEW ───────────────────────────────────────────────────────────────
//
// Same rule as R1 — imported, never reimplemented. The source colours for `seasonal`, `electric`
// and `store` are READ OUT OF R1's lane colours inside lib/report-sources.ts, so the dashboard
// and a camper's folio cannot drift into speaking different colour languages.
import {
  sumBySource, rankSources, barWidthPct, sourceOfPayment,
  SOURCE_LABEL, SOURCE_COLOR, SOURCE_BLURB,
  SOURCE_DESTINATION, type RevenueSource, type SourceFolio, type SourcePayment,
  type BookingPayment,
} from '@/lib/report-sources'
import {
  pickComparison, computeDelta, headlineRead, isRecordPeriod, monthKey,
  type MonthTotal, type Window,
} from '@/lib/report-periods'
// ── REPORTS R3: THE FORWARD LOOK ─────────────────────────────────────────────────────────────
//
// lib/occupancy.ts is an EXTRACTION, not a new idea: this page already counted occupancy two
// different ways, and the heat calendar cannot disagree with the dashboard about how full
// tonight is. Both now go through the same function.
import {
  occupiedOn, fillPercent, mondayOf, addDays, weekStartsFrom, sameWeekLastYear,
  type StayRow,
} from '@/lib/occupancy'
import {
  buildForwardLook, heatColor, HEAT_LEGEND, PACE_BASIS_LABEL, type WeekPace, type PaceBasis,
} from '@/lib/forward-look'

type Reservation = {
  id: string
  arrival_date: string
  departure_date: string
  total_price: number
  status: string
  site_id: string
  guest_name: string
  guest_email: string
  created_at: string
  sites: { site_number: string; site_type: string }
}
type PaymentRow = {
  id: string
  paid_at: string
  method: string
  amount: number
  surcharge_amount: number
  status: string
  folio_id: string
  square_payment_id?: string
  note?: string
  folios: { id: string; guest_name: string; folio_type: string; reservation_id: string | null; guest_email?: string }
}
type LineItemRow = {
  id: string
  folio_id: string
  category: string
  line_total: number
  description: string
  quantity: number
  unit_price: number
  tax_amount: number
  charged_at: string
  voided?: boolean
  product_id?: string | null
  lane?: string | null
}
type SeasonalCamper = {
  id: string
  name: string
  email: string
  site_number: string
  folioId: string
  /** The WHOLE-ACCOUNT balance — identical to what this camper's folio prints. Negative = credit. */
  balance: number
  /** The same money grouped by lane. Groups `balance`; never replaces or restates it. */
  lanes: LaneBalances
}
/** One lane's money collected inside the selected period, across seasonal campers. */
type LaneCollected = { byLane: Record<Lane, number>; untagged: number; total: number }
// The rows the R1 queries read. Named rather than `any` because the lane classifier's answer
// depends on exactly these columns being present — a select that quietly drops `voided`,
// `product_id` or `lane` is the shape of every bug this PR is fixing, and a type catches it.
type GaFolioRow = { id: string; guest_id: string | null }
type GaItemRow = {
  id: string; folio_id: string; line_total: number
  voided?: boolean | null; product_id?: string | null; lane?: string | null
}
type GaPaymentRow = {
  folio_id: string; amount: number; surcharge_amount?: number | null
  lane?: string | null; paid_at?: string | null
}
type SeasonalGuestRow = { id: string; name: string; email: string; site_number: string }
/** Named so the places that navigate BETWEEN tabs — the tab bar, the drill-downs R2 adds — can
 *  do it without an `as any` that would hide a typo in a tab name until someone clicked it. */
type TabKey = 'dashboard'|'forward'|'reservations'|'seasonal'|'transactions'|'store'
/** How many weeks the forward look covers. Eight is roughly the window a nudge can still fill. */
const WEEKS_AHEAD = 8
// ── R2 row shapes ────────────────────────────────────────────────────────────────────────────
// Carried ALL-TIME rather than per-window, because the money view has to answer three questions
// at once — this period, the comparison period, and "is this a record?" — and a park's payment
// history is a few narrow columns. One fetch beats three round trips that could disagree.
type SrcPaymentRow = SourcePayment & {
  id: string; method?: string | null
  folios?: { guest_name?: string | null } | null
}
type SrcBookingRow = BookingPayment & { id: string; guest_name?: string | null }

const COLORS = ['#2E6B8A','#12c9e5','#C4873C','#2D6A4F','#9B59B6','#E74C3C']

export default function ReportsPage() {
  const router = useRouter()

  useEffect(() => {
    supabase.from('settings').select('plan, pos_enabled').single().then(({ data }) => {
      if (data?.plan && !['ridgeline','summit'].includes(data.plan)) router.replace('/admin')
      if (data?.pos_enabled) setPosEnabled(true)
      // Seasonal reporting is a Summit feature (governed by plan, not a separate flag)
      if (data?.plan === 'summit') setSeasonalEnabled(true)
    })
  }, [])

  const [activeTab, setActiveTab] = useState<TabKey>('dashboard')
  const [posEnabled, setPosEnabled] = useState(false)
  const [seasonalEnabled, setSeasonalEnabled] = useState(false)
  const [reportBy, setReportBy] = useState<'payment_date'|'stay_date'>('payment_date')
  const [dateRange, setDateRange] = useState('this_year')
  const [customStart, setCustomStart] = useState('')
  const [customEnd, setCustomEnd] = useState('')
  const [loading, setLoading] = useState(true)

  // Data
  const [reservations, setReservations] = useState<Reservation[]>([])
  const [cancelledCount, setCancelledCount] = useState(0)
  const [cancelledReservations, setCancelledReservations] = useState<Reservation[]>([])
  const [resPayments, setResPayments] = useState<PaymentRow[]>([])
  const [transactions, setTransactions] = useState<PaymentRow[]>([])
  const [unifiedTx, setUnifiedTx] = useState<UnifiedPayment[]>([])
  const [customMethods, setCustomMethods] = useState<string[]>([])
  const [lineItems, setLineItems] = useState<LineItemRow[]>([])
  const [guestAccountPayments, setGuestAccountPayments] = useState<PaymentRow[]>([])
  // Booking payments recorded on reservations (deposits / online), keyed by created_at.
  // Disjoint from folio_payments, so safe to add to payment-date revenue.
  const [bookingPaymentsTotal, setBookingPaymentsTotal] = useState(0)
  const [bookingSurchargeTotal, setBookingSurchargeTotal] = useState(0)
  const [seasonalCampers, setSeasonalCampers] = useState<SeasonalCamper[]>([])
  // Every guest-account charge in the period, partitioned into disjoint buckets — seasonal
  // (split by lane), long-term/monthly, and everything else. Replaces the old `monthlyRevenue`
  // number, which overlapped the seasonal figure and was in no total. See lib/report-buckets.ts.
  const [gaBuckets, setGaBuckets] = useState<GuestAccountBuckets>({
    bySegment: { seasonal: 0, long_term: 0, other: 0 },
    seasonalByLane: { electric: 0, store: 0, seasonal: 0, other: 0 },
    total: 0, unattributed: 0,
  })
  // ── R2 money-view data ─────────────────────────────────────────────────────
  const [srcPayments, setSrcPayments] = useState<SrcPaymentRow[]>([])
  const [srcBookings, setSrcBookings] = useState<SrcBookingRow[]>([])
  const [srcFolios, setSrcFolios] = useState<Map<string, SourceFolio>>(new Map())
  /** The park's very first dollar. Decides whether a last-year comparison is even possible. */
  const [firstRevenueISO, setFirstRevenueISO] = useState<string|null>(null)
  /** The selected window, kept in state so the comparison maths can reach it outside fetchAll. */
  const [win, setWin] = useState<Window>({ startISO: '', endISO: '' })
  // ── R3 forward-look data ───────────────────────────────────────────────────
  /** Stays covering the next 8 weeks, and the equivalent 8 weeks a year earlier. */
  const [fwdRows, setFwdRows] = useState<StayRow[]>([])
  const [fwdPriorRows, setFwdPriorRows] = useState<StayRow[]>([])
  const [todayYmd, setTodayYmd] = useState('')
  /**
   * The owner's fill target. ⚠ NULL IS THE DEFAULT AND MEANS NO GOAL LINE AND NO GOAL JUDGMENT.
   * Some owners find a target motivating and others find it a stick, so it is theirs to opt into.
   */
  const [goalPct, setGoalPct] = useState<number|null>(null)
  /** False on a tenant that has not run the R3 migration — the control then explains itself
   *  rather than offering a save that would fail. Same guarded-select pattern as billing_mode. */
  const [hasGoalColumn, setHasGoalColumn] = useState(false)
  const [settingsId, setSettingsId] = useState<string|null>(null)
  const [goalEditing, setGoalEditing] = useState(false)
  const [goalDraft, setGoalDraft] = useState('')
  const [goalSaving, setGoalSaving] = useState(false)

  /** Which source row is expanded for drill-down. */
  const [openSource, setOpenSource] = useState<RevenueSource|null>(null)
  const [showBilledDetail, setShowBilledDetail] = useState(false)

  // Payments taken from seasonal campers INSIDE the period, by the lane they were filed against.
  const [laneCollected, setLaneCollected] = useState<LaneCollected>({
    byLane: { electric: 0, store: 0, seasonal: 0, other: 0 }, untagged: 0, total: 0,
  })
  const [totalSites, setTotalSites] = useState(84)
  const [totalCabins, setTotalCabins] = useState(3)
  const [tonightCount, setTonightCount] = useState(0)
  const [tonightCabins, setTonightCabins] = useState(0)
  const [seasonalCount, setSeasonalCount] = useState(0)
  const [futureCount, setFutureCount] = useState(0)
  const [monthlyOccupancy, setMonthlyOccupancy] = useState<{label:string;sites:number;cabins:number}[]>([])

  // Occupancy detail panel
  const [showOccupancyDetail, setShowOccupancyDetail] = useState(false)
  // Cancelled reservation detail panel
  const [selectedCancelled, setSelectedCancelled] = useState<Reservation|null>(null)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [deleting, setDeleting] = useState(false)

  // Transaction slide-out
  const [selectedTx, setSelectedTx] = useState<PaymentRow|null>(null)
  const [txFolioItems, setTxFolioItems] = useState<LineItemRow[]>([])
  const [txFolioPayments, setTxFolioPayments] = useState<PaymentRow[]>([])
  const [txFolioLoading, setTxFolioLoading] = useState(false)
  // Replaces seven pieces of local refund state — this drawer kept its own copy of the same
  // modal the folio page and the reservations panel each also had.
  const [refundTarget, setRefundTarget] = useState<RefundTarget | null>(null)

  // Transactions filters
  const [txSearch, setTxSearch] = useState('')
  const [txMethodFilter, setTxMethodFilter] = useState('all')
  const [txTypeFilter, setTxTypeFilter] = useState('all')
  const [txDateFrom, setTxDateFrom] = useState('')
  const [txDateTo, setTxDateTo] = useState('')

  useEffect(() => { fetchAll() }, [dateRange, reportBy])
  useEffect(() => { if (dateRange !== 'custom') fetchAll() }, [dateRange])

  function getDateBounds(range: string, customS: string, customE: string) {
    const now = new Date()
    if (range === 'custom' && customS && customE) return { start: customS, end: customE }
    if (range === 'today') { const d = ymd(now); return { start: d, end: d } }
    if (range === 'this_week') {
      const day = now.getDay()
      const mon = new Date(now); mon.setDate(now.getDate() - day + (day === 0 ? -6 : 1))
      return { start: ymd(mon), end: ymd(now) }
    }
    if (range === 'this_month') return { start: ymd(new Date(now.getFullYear(), now.getMonth(), 1)), end: ymd(now) }
    if (range === 'last_month') {
      const first = new Date(now.getFullYear(), now.getMonth() - 1, 1)
      const last = new Date(now.getFullYear(), now.getMonth(), 0)
      return { start: ymd(first), end: ymd(last) }
    }
    if (range === 'last_year') return { start: ymd(new Date(now.getFullYear()-1,0,1)), end: ymd(new Date(now.getFullYear()-1,11,31)) }
    return { start: ymd(new Date(now.getFullYear(),0,1)), end: ymd(now) }
  }

  function getStayDateEnd(range: string, customE: string) {
    const now = new Date()
    if (range === 'custom' && customE) return customE
    if (range === 'this_month') return ymd(new Date(now.getFullYear(), now.getMonth()+1, 0))
    if (range === 'last_month') return ymd(new Date(now.getFullYear(), now.getMonth(), 0))
    if (range === 'this_year') return ymd(new Date(now.getFullYear(), 11, 31))
    if (range === 'last_year') return ymd(new Date(now.getFullYear()-1, 11, 31))
    if (range === 'this_week') {
      const day = now.getDay(); const sun = new Date(now); sun.setDate(now.getDate() + (day===0?0:7-day))
      return ymd(sun)
    }
    return ymd(now)
  }

  async function fetchAll() {
    setLoading(true)
    const { start, end } = getDateBounds(dateRange, customStart, customEnd)
    const startISO = dayStartUTC(start)
    const endISO = dayEndUTC(end)
    const stayEnd = getStayDateEnd(dateRange, customEnd)
    const today = ymd(new Date())

    // Load settings for total_sites and total_cabins
    const { data: settingsData } = await supabase.from('settings').select('total_sites, total_cabins, custom_payment_methods').single()
    setCustomMethods(settingsData?.custom_payment_methods || [])
    const configuredSites = settingsData?.total_sites || 84
    const configuredCabins = settingsData?.total_cabins || 3
    setTotalSites(configuredSites)
    setTotalCabins(configuredCabins)

    // Seasonal count (live)
    const { count: seasonalCount } = await supabase.from('guests').select('id', { count: 'exact', head: true }).eq('is_seasonal', true)
    setSeasonalCount(seasonalCount || 0)

    // Tonight occupancy — split cabins vs sites.
    //
    // ⚠ `gt('departure_date')`, NOT `gte`, AND THE COUNT NOW GOES THROUGH occupiedOn().
    //
    // This query used to match `departure_date >= today`, which counts a guest who checked out
    // this morning as still occupying a site tonight. That site is empty and sellable. It also
    // disagreed with this page's OWN monthly occupancy trend, which has always walked
    // `arrival <= night < departure`.
    //
    // R3 draws a calendar of nights, and its cell for today has to equal the figure the dashboard
    // prints — so there is now exactly one definition of "occupied on this night", in
    // lib/occupancy.ts, and both callers use it. The dashboard's number can move by the number of
    // guests departing today; that is the correction, not a regression.
    const { data: tonightRes } = await supabase.from('reservations')
      .select('id, arrival_date, departure_date, status, sites(site_type)')
      .neq('status','cancelled').lte('arrival_date', today).gt('departure_date', today)
    const tonight = occupiedOn((tonightRes||[]) as unknown as StayRow[], today)
    setTonightCount(tonight.sites)
    setTonightCabins(tonight.cabins)

    // Future bookings
    const { count: futureRes } = await supabase.from('reservations').select('id', { count: 'exact', head: true }).neq('status','cancelled').gt('arrival_date', today)
    setFutureCount(futureRes || 0)

    // Monthly occupancy trend
    const { data: allRes } = await supabase.from('reservations').select('arrival_date, departure_date, sites(site_type)').neq('status','cancelled').gte('arrival_date', ymd(new Date(new Date().getFullYear(),0,1))).lte('arrival_date', ymd(new Date(new Date().getFullYear(),11,31)))
    const monthOcc: {[key:string]:{label:string;sites:number;cabins:number;days:number}} = {}
    const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']
    for (let m=0; m<12; m++) {
      const key = String(m).padStart(2,'0')
      monthOcc[key] = { label: months[m], sites: 0, cabins: 0, days: new Date(new Date().getFullYear(), m+1, 0).getDate() }
    }
    ;(allRes||[]).forEach((r:any) => {
      const arrival = new Date(r.arrival_date+'T12:00:00')
      const departure = new Date(r.departure_date+'T12:00:00')
      const isCabin = r.sites?.site_type === 'cabin'
      let d = new Date(arrival)
      while (d < departure) {
        const mKey = String(d.getMonth()).padStart(2,'0')
        if (monthOcc[mKey]) {
          if (isCabin) monthOcc[mKey].cabins++
          else monthOcc[mKey].sites++
        }
        d.setDate(d.getDate()+1)
      }
    })
    // Add seasonal to each month (they occupy sites all season May-Oct)
    const sc = seasonalCount || 0
    for (let m=4; m<=9; m++) {
      const mKey = String(m).padStart(2,'0')
      if (monthOcc[mKey]) monthOcc[mKey].sites += sc * monthOcc[mKey].days
    }
    const occData = Object.entries(monthOcc).map(([,v]) => ({
      label: v.label,
      sites: v.days > 0 ? Math.min(100, Math.round((v.sites / v.days / configuredSites) * 100)) : 0,
      cabins: v.days > 0 ? Math.min(100, Math.round((v.cabins / v.days / configuredCabins) * 100)) : 0,
    }))
    setMonthlyOccupancy(occData)

    // Reservations
    const { data: resData } = await supabase.from('reservations').select('id, arrival_date, departure_date, total_price, status, site_id, guest_name, guest_email, created_at, sites(site_number, site_type)').neq('status','cancelled').gte('arrival_date', start).lte('arrival_date', stayEnd).order('arrival_date')
    const { data: cancelledData, count: cancelCount } = await supabase
      .from('reservations')
      .select('id, arrival_date, departure_date, total_price, status, site_id, guest_name, guest_email, sites(site_number, site_type)')
      .eq('status','cancelled')
      .gte('arrival_date', start)
      .lte('arrival_date', stayEnd)
      .order('arrival_date')

    // Every guest_account folio in the park. `guest_id` comes along now because the reporting
    // buckets below need to know WHOSE account each folio is — see lib/report-buckets.ts.
    const { data: allGaFolios } = await supabase.from('folios').select('id, guest_id').eq('folio_type','guest_account')
    const allGaFolioRows = (allGaFolios||[]) as GaFolioRow[]
    const allGaFolioIds = allGaFolioRows.map(f=>f.id)

    // Fetch ALL payments (including guest_account) for complete picture
    const { data: allPmtData } = await supabase
      .from('folio_payments')
      .select('id, paid_at, method, amount, surcharge_amount, status, folio_id, square_payment_id, note, folios(id, guest_name, folio_type, reservation_id, guest_email)')
      // Refund rows are counted, not filtered out. /api/refund leaves the original payment in
      // place, flips its status to 'refunded' or 'partially_refunded', and inserts a negative
      // row. Counting only 'completed' therefore dropped BOTH rows, so a partial refund erased
      // the whole original payment from revenue instead of just the part handed back — the kept
      // portion vanished. Counting all three lets them net: an untouched payment stands alone, a
      // full refund cancels to zero, a partial refund leaves exactly what was kept.
      // Listed explicitly rather than 'not voided' so any future status is excluded until
      // someone decides it counts. 'voided' stays out — a voided payment never happened.
      .in('status', ['completed', 'refunded', 'partially_refunded'])
      .gte('paid_at', startISO)
      .lte('paid_at', endISO)
      .order('paid_at', { ascending: false })
    const pmtData = allPmtData || []

    // Reservation booking payments (deposits / online) within the window.
    // Dated by created_at, not a payment timestamp — reservations have no paid_at. It is
    // a close proxy: amount_paid is written in the request that creates the row, so
    // creation is the payment moment. See the note on the dashboard's revenue query.
    // Cancelled bookings are NOT filtered out — the negative refund row does the netting,
    // exactly as it does for folio payments above. Excluding them double-counted the
    // reduction: a cancelled $500 booking refunded $450 lost the +$500 here AND still landed
    // the −$450 row in pmtData, reading as −$450 revenue instead of the +$50 retained fee.
    // A booking cancelled without a refund correctly stays as revenue — the business kept it.
    const { data: bookingPmts } = await supabase
      .from('reservations')
      .select('amount_paid, surcharge_amount, created_at')
      .gt('amount_paid', 0)
      .gte('created_at', startISO)
      .lte('created_at', endISO)
    setBookingPaymentsTotal((bookingPmts || []).reduce((sum: number, r: any) => sum + (r.amount_paid || 0), 0))
    setBookingSurchargeTotal((bookingPmts || []).reduce((sum: number, r: any) => sum + (r.surcharge_amount || 0), 0))

    // Store line items — fetch ALL line items in date range, exclude guest_account folios
    const guestAccountFolioIdSet = new Set(allGaFolioIds)
    const { data: allLiData } = await supabase
      .from('folio_line_items')
      // ⚠ `voided` IS NOW SELECTED. It was absent from this column list, so every row read as
      // un-voided no matter what the database said, and a canceled sale still counted in Sales by
      // Category and Top Products. `product_id` and `lane` come along so this ONE query can also
      // feed the guest-account buckets below — the lane classifier needs both, and splitting the
      // work into a second `.in(…every folio id…)` query would only risk an over-long URL.
      .select('id, folio_id, category, line_total, description, quantity, unit_price, tax_amount, charged_at, voided, product_id, lane')
      .gte('charged_at', startISO)
      .lte('charged_at', endISO)
    const allPeriodItems = (allLiData||[]) as (GaItemRow & LineItemRow)[]
    // Exclude electric billing and seasonal account charges — keep all real store/POS items.
    // `notVoided` is applied at the SUM step everywhere else in this app; here the rows exist
    // only to be summed, so it is applied as they arrive.
    const storeItems = allPeriodItems.filter(notVoided).filter(li => {
      if (guestAccountFolioIdSet.has(li.folio_id)) return false
      // Exclude electric billing line items
      if (li.description && li.description.toLowerCase().includes('electric')) return false
      return true
    })
    setLineItems(storeItems as any)

    // ── SEASONAL CAMPERS: balances that reconcile to the folio, split into lanes ────────────
    //
    // Rewritten from a pair of queries PER CAMPER into three batched reads. Speed is a side
    // effect; the reason is that the lane classifier needs `id`, `product_id`, `lane` AND the
    // electric_readings link, and the old `select('line_total')` could not give it any of them.
    const { data: seasonalGuestsRaw } = await supabase.from('guests').select('id, name, email, site_number').eq('is_seasonal', true)
    const seasonalGuests = (seasonalGuestsRaw||[]) as SeasonalGuestRow[]
    const seasonalGuestIds = seasonalGuests.map(g=>g.id)
    // Hoisted: the same electric signal classifies the camper balances below AND the period
    // charges further down, so both must be resolved against one set of readings.
    let laneCtx = { electricLineItemIds: new Set<string>() as ReadonlySet<string> }
    // Seasonal campers' payments, ALL TIME. The period figure is a filter over these rather than
    // a second round trip for rows already in hand.
    let seasonalPmtRows: GaPaymentRow[] = []

    if (seasonalGuestIds.length > 0) {
      const { data: gaFoliosRaw } = await supabase.from('folios').select('id, guest_id').eq('folio_type','guest_account').in('guest_id', seasonalGuestIds)
      const gaFolios = (gaFoliosRaw||[]) as GaFolioRow[]
      const gaFolioIds = gaFolios.map(f=>f.id)

      // ALL-TIME, deliberately not date-ranged: a balance is what a camper owes TODAY — the same
      // figure their folio prints. The period-scoped figures are computed separately, below.
      const [{ data: allItems }, { data: allPmts }] = gaFolioIds.length ? await Promise.all([
        supabase.from('folio_line_items').select('id, folio_id, line_total, voided, product_id, lane').in('folio_id', gaFolioIds),
        // REFUNDABLE_STATUSES, not 'completed' — the same widening app/admin/folio/guest/[id]
        // and this page's own main payment query already made, and the reason this list can
        // finally match the folio. Filtering to 'completed' dropped BOTH halves of a refund: the
        // negative row AND the original, whose status flips to 'refunded'/'partially_refunded'.
        // A refunded camper therefore read as having paid less than they had, and owing more.
        // The arithmetic is signed, so including these rows SUBTRACTS them.
        supabase.from('folio_payments').select('folio_id, amount, surcharge_amount, lane, paid_at, status').in('folio_id', gaFolioIds).in('status', REFUNDABLE_STATUSES),
      ]) : [{ data: [] }, { data: [] }]
      const allItemRows = (allItems||[]) as GaItemRow[]
      seasonalPmtRows = (allPmts||[]) as GaPaymentRow[]

      // The electric signal, exactly as the folio, the receipt and the electric bill resolve it:
      // the readings that point at these charges. NOT the category — a store item filed under
      // "Fees" is indistinguishable from an electric charge by category. See lib/ledger-lanes.ts.
      //
      // ⚠ KEYED ON guest_id, NOT on the line-item ids. The single-camper callers ask
      // `.in('folio_line_item_id', …)` because they hold a handful of ids; asking that here would
      // put EVERY seasonal charge the park has ever written into one URL, which is how a
      // park-wide report turns into a 414. A reading names its camper, so the same set comes back
      // keyed on the campers instead. Ids for charges outside this set are simply never looked
      // up — membership is only ever tested for items we are already classifying.
      const { data: readings } = await supabase.from('electric_readings')
        .select('folio_line_item_id').in('guest_id', seasonalGuestIds)
      laneCtx = { electricLineItemIds: new Set(((readings||[]) as { folio_line_item_id: string | null }[])
        .map(r=>r.folio_line_item_id).filter(Boolean) as string[]) }

      const itemsByFolio = new Map<string, GaItemRow[]>()
      for (const i of allItemRows) { const a = itemsByFolio.get(i.folio_id); if (a) a.push(i); else itemsByFolio.set(i.folio_id, [i]) }
      const pmtsByFolio = new Map<string, GaPaymentRow[]>()
      for (const pm of seasonalPmtRows) { const a = pmtsByFolio.get(pm.folio_id); if (a) a.push(pm); else pmtsByFolio.set(pm.folio_id, [pm]) }

      const camperList: SeasonalCamper[] = seasonalGuests.map(guest => {
        const folioId = gaFolios.find(f=>f.guest_id===guest.id)?.id || ''
        // laneBalances() applies `notVoided` itself, at the sum step — the same idiom the folio
        // uses. That single call is the whole Part A fix for this list: a camper with a canceled
        // packet used to read too high here and disagree with their own account.
        const lanes = laneBalances(itemsByFolio.get(folioId) || [], pmtsByFolio.get(folioId) || [], laneCtx)
        return {
          id: guest.id, name: guest.name, email: guest.email, site_number: guest.site_number, folioId,
          // ⚠ NO Math.max(0, …). The old clamp floored every balance at zero, so a camper holding
          // a credit read as "✓ Current" and this page's own Credit figures were dead code that
          // could never fire. A credit is real money the park is holding, and the folio shows it.
          balance: lanes.accountBalance,
          lanes,
        }
      })
      setSeasonalCampers(camperList)
    } else {
      // Previously omitted, so a park that unflagged its last seasonal kept the stale list.
      setSeasonalCampers([])
    }

    // ── EVERY GUEST-ACCOUNT DOLLAR IN THE PERIOD, PARTITIONED ──────────────────────────────
    //
    // EXACTLY ONE bucket per folio, replacing the two overlapping questions this page used to ask
    // ("what did seasonal campers spend?" and "what did monthly campers spend?"). Those two
    // dropped or mis-bucketed real money three different ways; lib/report-buckets.ts documents
    // each one. The buckets are summed independently of the total they must equal, which is what
    // proves nothing is lost or counted twice.
    //
    // The tie-break — a guest flagged BOTH counts once, as seasonal — is `segmentOf`, so the
    // rule this page reports by is the one lib/report-buckets.test.ts pins.
    const { data: monthlyGuestsRaw } = await supabase.from('guests').select('id').eq('is_monthly', true)
    const monthlyGuestIds = new Set(((monthlyGuestsRaw||[]) as { id: string }[]).map(g=>g.id))
    const seasonalGuestIdSet = new Set(seasonalGuestIds)
    const segmentByFolio = new Map<string, Segment>()
    for (const f of allGaFolioRows) segmentByFolio.set(f.id, segmentOf({
      is_seasonal: !!f.guest_id && seasonalGuestIdSet.has(f.guest_id),
      is_monthly: !!f.guest_id && monthlyGuestIds.has(f.guest_id),
    }))

    // The guest-account half of the period's charges — the same rows `storeItems` above dropped,
    // picked out of the one query rather than fetched again. Together the two are an exact
    // partition of every line item charged in the window.
    const gaItemRows = allPeriodItems.filter(li => guestAccountFolioIdSet.has(li.folio_id))
    // bucketGuestAccountCharges applies `notVoided` — a canceled packet counts in no bucket.
    setGaBuckets(bucketGuestAccountCharges(gaItemRows, segmentByFolio, laneCtx))

    // Payments taken from seasonal campers inside the period, by the lane they were filed
    // against. Untagged payments are reported as their own figure and never spread across the
    // lanes — every payment predating Phase 4 is untagged, and inventing a lane for them would
    // rewrite a park's financial history. Same rule as lib/ledger-lanes.ts.
    const periodPmts = seasonalPmtRows.filter(pm => !!pm.paid_at && pm.paid_at >= startISO && pm.paid_at <= endISO)
    // laneBalances() with NO items — it IS the module's own payment-by-lane arithmetic, so
    // "collected per lane" here is netted of the card surcharge and normalises a lane tag by
    // exactly the same rule the folio applies. Reusing it beats a second loop that could drift.
    const collectedLanes = laneBalances([], periodPmts, laneCtx)
    setLaneCollected({
      byLane: Object.fromEntries(LANES.map(l=>[l, collectedLanes.byLane[l].payments])) as Record<Lane, number>,
      untagged: collectedLanes.untaggedPayments,
      total: collectedLanes.totalPayments,
    })

    // ── R3: THE NEXT EIGHT WEEKS, AND THE SAME EIGHT WEEKS A YEAR AGO ──────────────────────
    //
    // Two narrow queries rather than one clever one. The window starts at the MONDAY OF THE
    // CURRENT WEEK, not next Monday: it puts today on the calendar, which is what lets an owner
    // (and a reviewer) check the view against the dashboard's occupancy at a glance.
    setTodayYmd(today)
    const fwdFirst = mondayOf(today)
    const fwdLast = addDays(fwdFirst, WEEKS_AHEAD * 7 - 1)
    // `gt('departure_date', fwdFirst)` is the night rule expressed in SQL — a stay that departs on
    // the first night of the window occupies none of it. occupiedOn() re-applies it per night, so
    // this is only a cheap server-side narrowing, never the definition.
    const [{ data: fwdData }, { data: fwdPriorData }] = await Promise.all([
      supabase.from('reservations').select('arrival_date, departure_date, status, created_at, sites(site_type)')
        .neq('status','cancelled').lte('arrival_date', fwdLast).gt('departure_date', fwdFirst),
      supabase.from('reservations').select('arrival_date, departure_date, status, created_at, sites(site_type)')
        .neq('status','cancelled')
        .lte('arrival_date', sameWeekLastYear(fwdLast)).gt('departure_date', sameWeekLastYear(fwdFirst)),
    ])
    setFwdRows((fwdData||[]) as unknown as StayRow[])
    setFwdPriorRows((fwdPriorData||[]) as unknown as StayRow[])

    // The goal, in its OWN guarded select. A tenant that has not run the R3 migration has no
    // `occupancy_goal_percent` column, and widening the settings select above would make that
    // whole query fail — taking every figure on this page down with it. Same shape as the
    // billing_mode reads in app/admin/folio/guest/[id] and /api/electric-bill-email.
    try {
      const { data: goalRow, error: goalErr } = await supabase.from('settings')
        .select('id, occupancy_goal_percent').limit(1).single()
      if (!goalErr && goalRow) {
        setHasGoalColumn(true)
        setSettingsId(goalRow.id)
        const raw = Number(goalRow.occupancy_goal_percent)
        // 0 and NULL both read as "no goal": off by default has to mean off, and a stray 0 must
        // not become a target every week clears.
        setGoalPct(Number.isFinite(raw) && raw > 0 ? Math.min(100, Math.round(raw)) : null)
      } else {
        setHasGoalColumn(false)
      }
    } catch { setHasGoalColumn(false) }

    // ── R2: EVERYTHING THE MONEY VIEW NEEDS, ALL TIME ──────────────────────────────────────
    //
    // Deliberately NOT scoped to the selected window. The dashboard answers three questions at
    // once — what came in this period, what came in over the comparison period, and whether this
    // is the park's best month yet — and the last one is only answerable from the whole history.
    // Three windowed queries could also disagree with each other at a boundary; one history that
    // is sliced in memory cannot.
    //
    // The columns are narrow on purpose (no line items, no notes), so this stays a small read
    // even for a park with years of payments behind it.
    setWin({ startISO, endISO })
    const [{ data: allFolioRows }, { data: allPayRows }, { data: allBookingRows }] = await Promise.all([
      supabase.from('folios').select('id, folio_type, reservation_id, guest_id'),
      // Same status set as every R1 balance: a refund is a negative row plus a flipped status,
      // and counting only 'completed' would drop both halves.
      supabase.from('folio_payments')
        .select('id, folio_id, amount, surcharge_amount, lane, paid_at, method, folios(guest_name)')
        .in('status', REFUNDABLE_STATUSES).order('paid_at', { ascending: false }),
      // Booking payments live on the reservation, not on any folio, so they are disjoint from the
      // rows above and are ADDED rather than de-duplicated. Cancelled bookings stay in: a refund
      // nets itself out, so what remains is what the business kept.
      supabase.from('reservations').select('id, guest_name, amount_paid, surcharge_amount, created_at').gt('amount_paid', 0),
    ])

    // `segmentByFolio` above already knows which guest-account belongs to a seasonal camper and
    // which to a long-term one. Reused rather than re-derived, so the dashboard's idea of "whose
    // account is this" is the same one the buckets and the Seasonal tab use.
    const folioSourceMap = new Map<string, SourceFolio>()
    for (const f of ((allFolioRows||[]) as { id: string; folio_type: string|null; reservation_id: string|null }[])) {
      folioSourceMap.set(f.id, {
        folio_type: f.folio_type, reservation_id: f.reservation_id,
        segment: segmentByFolio.get(f.id) ?? null,
      })
    }
    const payRows = (allPayRows||[]) as unknown as SrcPaymentRow[]
    const bookRows = (allBookingRows||[]) as unknown as SrcBookingRow[]
    setSrcFolios(folioSourceMap)
    setSrcPayments(payRows)
    setSrcBookings(bookRows)

    // The park's first dollar, from either tender. This is the whole basis of the last-year vs
    // last-month decision — see pickComparison(): the question is whether last-year data COULD
    // exist, not whether it happens to be zero.
    const stamps = [
      ...payRows.map(r => r.paid_at || ''),
      ...bookRows.map(r => r.created_at || ''),
    ].filter(Boolean).sort()
    setFirstRevenueISO(stamps[0] || null)

    if (resData) setReservations(resData as any)
    setCancelledCount(cancelledData?.length || 0)
    setCancelledReservations(cancelledData as any || [])
    // Split payments by type
    const typedPmtData = pmtData as any[]
    setResPayments(typedPmtData.filter((p:any)=>p.folios?.reservation_id!==null&&p.folios?.folio_type!=='guest_account'))
    setTransactions(typedPmtData)
    // Unified transaction log (folio + booking payments) — same source as /admin/transactions
    const uni = await fetchUnifiedTransactions(startISO, endISO)
    setUnifiedTx(uni)
    setGuestAccountPayments(typedPmtData.filter((p:any)=>p.folios?.folio_type==='guest_account'))
    setLoading(false)
  }

  async function openTransaction(tx: PaymentRow) {
    setSelectedTx(tx)
    setTxFolioLoading(true)
    setRefundTarget(null)
    const [{ data: items }, { data: pmts }] = await Promise.all([
      // `voided` added. The drawer below already reads `i.voided` to decide what to show — but
      // the column was never in this select, so it was always `undefined` and the filter passed
      // every row. The drill-down LOOKED like it excluded voided charges and did not.
      supabase.from('folio_line_items').select('id, folio_id, description, quantity, unit_price, tax_amount, line_total, category, charged_at, voided').eq('folio_id', tx.folio_id).order('charged_at'),
      supabase.from('folio_payments').select('*').eq('folio_id', tx.folio_id).order('paid_at'),
    ])
    setTxFolioItems(items as any || [])
    setTxFolioPayments(pmts as any || [])
    setTxFolioLoading(false)
  }

  // Refunds are GROSS — the card is credited what it was charged, surcharge included and
  // prorated, matching the folio page and the reservation panel. folio_payments.amount is
  // stored gross and /api/refund already caps at it.
  //
  // txFolioPayments is fetched without a status filter here (voided rows included), which is
  // why folioPaymentRefundable does its own filtering: this drawer and the folio page have to
  // agree on what a payment can return, whatever each happened to select.
  function openRefund(payment: any) {
    if (!selectedTx) return
    const { remainingCents } = folioPaymentRefundable(payment, txFolioPayments)
    setRefundTarget({
      kind: 'folio-payment',
      paymentId: payment.id,
      folioId: selectedTx.folio_id,
      method: payment.method,
      squarePaymentId: payment.square_payment_id,
      originalCents: payment.amount,
      remainingCents,
      note: payment.note,
    })
  }

  async function reloadTxFolioPayments() {
    if (!selectedTx) return
    const { data: pmts } = await supabase.from('folio_payments').select('*').eq('folio_id', selectedTx.folio_id).order('paid_at')
    setTxFolioPayments(pmts as any || [])
  }

  // ── Computed values ────────────────────────────────────────────────────────
  const stayDateRevenue = reservations.reduce((s,r)=>s+(r.total_price||0),0)/100
  // reservation payments only (non-guest-account, non-walkup)
  const paymentDateResRevenue = (resPayments.reduce((s,p)=>s+(p.amount||0),0) + bookingPaymentsTotal + bookingSurchargeTotal)/100
  const resRevenue = reportBy==='payment_date' ? paymentDateResRevenue : stayDateRevenue
  // POS = walkin + walkup folios only
  const posPayments = transactions.filter(t=>{const ft=(t.folios as any)?.folio_type; return ft==='walkin'||ft==='walkup'})
  const posRevenue = posPayments.reduce((s,p)=>s+(p.amount||0),0)/100
  // Revenue sums every row so refunds reduce it, but a refund is not a SALE: counting the
  // negative row would inflate the transaction count and drag the average ticket down.
  const posSales = posPayments.filter(p=>(p.amount||0)>0)
  // ── GUEST-ACCOUNT MONEY, IN DISJOINT BUCKETS ───────────────────────────────
  //
  // Charges in the selected period, each landing in exactly one bucket. The seasonal slice is
  // split by LANE using the same classifier the folio uses, so "Electric Revenue" here and the
  // Electric section of a camper's folio are the same number. Previously these two figures were
  // split on `description.includes('electric')` — a substring match on free text, which
  // lib/ledger-lanes.ts documents as the wrong signal: an electric charge is written with
  // category 'Fees' and no keyword guarantee, while a store item can be described anything.
  // Charges land in exactly one bucket; the per-lane slice of the seasonal bucket is what the
  // Seasonal tab reports against, and it comes from the classifier rather than from a keyword.
  const seasonalRevenue = gaBuckets.bySegment.seasonal/100
  const longTermRevenue = gaBuckets.bySegment.long_term/100
  const otherAccountRevenue = gaBuckets.bySegment.other/100
  const seasonalPaymentsRevenue = guestAccountPayments.reduce((s,p)=>s+(p.amount||0),0)/100
  // Total = reservations + store + EVERY guest-account bucket.
  //
  // ⚠ THE LONG-TERM AND HOUSE-TAB BUCKETS ARE NEW TO THIS SUM. A monthly camper's charges used
  // to appear only on a "Monthly Revenue" card that was never added to anything, and a plain
  // guest's house tab appeared nowhere at all — guest_account folios are excluded from store
  // revenue, and neither the seasonal nor the monthly query matched them. Both were real money
  // on a real folio that no total on this page contained. By construction this now equals
  //     resRevenue + posRevenue + gaBuckets.total/100
  // with no charge counted twice, which is the property lib/report-buckets.test.ts pins.
  const totalCombined = resRevenue + (posEnabled?posRevenue:0) + seasonalRevenue + longTermRevenue + otherAccountRevenue
  // All payments for method breakdown
  const allPayments = [...transactions]
  const methods = allPaymentMethods(customMethods)
  // Method breakdown from the UNIFIED list (folio + booking payments) — gross amounts
  const methodTotals = methods.map(m => ({
    method: m,
    value: unifiedTx.filter(t => t.method === m).reduce((s, t) => s + t.amount, 0) / 100,
  }))
  // Nets refunded surcharge out on its own: allPayments carries the refund rows (the fetch
  // above counts 'refunded'/'partially_refunded'), and /api/refund records their
  // surcharge_amount negative, so a refunded surcharge cancels its original here rather than
  // still reading as collected.
  const totalSurcharge = (allPayments.reduce((s,t)=>s+(t.surcharge_amount||0),0) + bookingSurchargeTotal)/100
  // What campers OWE and what they hold in CREDIT, kept apart so neither hides the other. Both
  // now actually fire: the per-camper balance used to be clamped at zero, which made every
  // credit figure on this page unreachable.
  const outstandingBalance = seasonalCampers.reduce((s,c)=>s+Math.max(0,c.balance),0)/100
  const creditBalance = seasonalCampers.reduce((s,c)=>s+Math.abs(Math.min(0,c.balance)),0)/100
  const overdueCampers = seasonalCampers.filter(c=>c.balance>0)
  const creditCampers = seasonalCampers.filter(c=>c.balance<0)

  // ── THE LANE ROLL-UP — Part B ──────────────────────────────────────────────
  //
  // Every camper's own lane split, added up. It GROUPS the balances above; it never restates
  // them. The invariant lib/report-buckets.test.ts pins is what makes the view safe to publish:
  //     sum of lane balances − payments applied to the whole account = netBalance
  // and `netBalance` is, by construction, the sum of the campers' folio balances. So the split
  // can never imply more or less money than the folios it came from.
  const laneRollup = rollUpLanes(seasonalCampers.map(c=>c.lanes))
  const netSeasonalBalance = laneRollup.netBalance/100
  // The three lanes a seasonal camper is billed for, plus `other` ONLY when it has money in it.
  // `other` is the classifier's catch-all — a heading over an empty catch-all reads as a lane a
  // park is supposed to manage, and a hidden non-empty one loses money from the reconciliation.
  const laneRollupHasOther = laneRollup.byLane.other.charges!==0||laneRollup.byLane.other.payments!==0
  const shownLanes: Lane[] = [...SEASONAL_CAMPER_LANES, ...(laneRollupHasOther?['other' as Lane]:[])]

  // ── R2: THE MONEY VIEW ─────────────────────────────────────────────────────
  //
  // ⚠ ONE BASIS, ALL THE WAY DOWN: MONEY RECEIVED. Every source below is payments in the window,
  // gross of the card surcharge — the convention every revenue figure on this page has always
  // used, and the reason "Transaction fees collected" describes itself as a breakout rather than
  // an addition. Because the sources and the headline come from the SAME call, the breakdown
  // sums to the headline exactly; a dashboard whose parts do not add up to its own total is the
  // failure R1 existed to fix.
  //
  // This is NOT the same figure as `totalCombined` below, and deliberately so — that one mixes
  // payments (reservations, store) with charges (guest accounts). It is kept, unchanged, as
  // "billed this period" in the secondary stats, so nothing was silently redefined.
  const comparison = pickComparison(win, firstRevenueISO)
  const currentSources = sumBySource(srcPayments, srcFolios, srcBookings, win)
  const priorSources = sumBySource(srcPayments, srcFolios, srcBookings, comparison.window)
  const rankedSources = rankSources(currentSources, priorSources)
  const moneyIn = currentSources.total
  const moneyDelta = computeDelta(currentSources.total, priorSources.total)

  // Revenue per calendar month, ALL TIME — the record check's evidence, and the reason it can be
  // trusted: "best month yet" is measured against every month the park has, not the chart window.
  const monthTotals: MonthTotal[] = (() => {
    const byKey = new Map<string, number>()
    // monthKey(), not a string slice: the window boundaries are LOCAL days, so a payment taken at
    // 10pm on 31 August must be filed under August and not under the September it already is in
    // UTC — otherwise the record check compares two different months and never finds a record.
    const add = (iso: string|null|undefined, cents: number) => {
      const key = iso ? monthKey(iso) : ''
      if (!key) return
      byKey.set(key, (byKey.get(key) || 0) + cents)
    }
    for (const p of srcPayments) add(p.paid_at, p.amount || 0)
    for (const b of srcBookings) add(b.created_at, (b.amount_paid || 0) + (b.surcharge_amount || 0))
    return [...byKey.entries()].sort((a,b)=>a[0].localeCompare(b[0])).map(([key, cents]) => ({
      key, cents,
      label: new Date(Number(key.slice(0,4)), Number(key.slice(5,7))-1, 1).toLocaleDateString('en-US', { month: 'short', year: '2-digit' }),
    }))
  })()
  const isRecord = isRecordPeriod(win, monthTotals)
  const headline = headlineRead(moneyDelta, comparison.label, isRecord)

  // The payments behind ONE source, newest first — what a drilled-open row shows. Recomputed on
  // expand rather than precomputed for all seven, because only one is ever open.
  const paymentsForSource = (src: RevenueSource) => srcPayments
    .filter(p => p.paid_at && p.paid_at >= win.startISO && p.paid_at <= win.endISO)
    .filter(p => sourceOfPayment(srcFolios.get(p.folio_id || ''), p) === src)
    .map(p => ({ id: p.id, who: p.folios?.guest_name || 'Walk-up', when: p.paid_at || '', cents: p.amount || 0, method: p.method || '' }))
    .concat(src !== 'nightly' ? [] : srcBookings
      .filter(b => b.created_at && b.created_at >= win.startISO && b.created_at <= win.endISO)
      .map(b => ({ id: 'b-'+b.id, who: b.guest_name || 'Booking', when: b.created_at || '',
                   cents: (b.amount_paid||0)+(b.surcharge_amount||0), method: 'booking' })))
    .sort((a,b) => b.when.localeCompare(a.when))

  // ── R3: THE FORWARD LOOK ───────────────────────────────────────────────────
  //
  // The comparison honours the owner's priority order, and lib/forward-look.ts decides it once
  // for the whole board: a GOAL wins because they chose it; failing that, the same weeks LAST
  // YEAR at the same lead time; failing that, NO JUDGMENT AT ALL. A park in its first season is
  // shown its fill levels and left alone.
  //
  // `priorAsOfDate` is today minus 364. A week L days out is compared against last year's
  // equivalent week as it stood L days before ITS start — and because both the week and the
  // observation slide back by the same 364 days, that date is the same for every week on the
  // board. Comparing an in-progress week against last year's FINISHED week would mark almost
  // everything behind, which is the fastest way to make this view ignorable.
  const forwardLook = buildForwardLook(
    todayYmd ? weekStartsFrom(todayYmd, WEEKS_AHEAD) : [],
    fwdRows, fwdPriorRows,
    {
      seasonalSites: seasonalCount,
      totalSites,
      today: todayYmd,
      goalPct,
      priorAsOfDate: todayYmd ? sameWeekLastYear(todayYmd) : null,
    },
  )

  /**
   * The ONE write in this PR, and it moves no money — it records a preference.
   *
   * Client-side against `settings`, guarded by RLS, exactly like the Settings page's own save.
   * Clearing the field removes the goal entirely rather than storing 0, so "off" stays off.
   */
  async function saveGoal(next: number|null) {
    if (!settingsId) return
    setGoalSaving(true)
    const { error } = await supabase.from('settings').update({ occupancy_goal_percent: next }).eq('id', settingsId)
    if (!error) { setGoalPct(next); setGoalEditing(false) }
    setGoalSaving(false)
  }

  /**
   * ⚠ NEVER RED. Same rule as R2: a soft week is amber and matter-of-fact, because an owner
   * trained to see alarm red for ordinary seasonality stops seeing red at all. Red on this page
   * belongs to overdue money and nothing else.
   *
   * `unknown` — a first-season park with no goal — still CELEBRATES a full week and stays neutral
   * on an open one, rather than painting the whole board the same flat grey. Being unable to
   * judge pace is not a reason to be joyless about a week that is nearly sold out.
   */
  function paceColor(w: WeekPace): string {
    if (w.verdict === 'ahead') return '#059669'
    if (w.verdict === 'behind') return '#D97706'
    if (w.verdict === 'level') return '#9CA3AF'
    return w.fill >= 70 ? '#059669' : '#94A3B8'
  }

  /** 'Sep 7' — how a week is named everywhere in this view. */
  const weekLabel = (ymdStr: string) => {
    const [y,m,d] = ymdStr.split('-').map(Number)
    return new Date(y, m-1, d).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
  }

  // Today's revenue — from the UNIFIED list (folio + online booking payments) so online
  // reservations count, bucketed by LOCAL day (not the UTC calendar day). Gross of the card
  // surcharge, like every other revenue figure here: unifiedTx already carries booking
  // payments as amount_paid + surcharge_amount, so the raw amount IS the gross.
  const todayStr = ymd(new Date())
  const todayRevenue = unifiedTx.filter(t=>t.paid_at && ymd(new Date(t.paid_at))===todayStr).reduce((s,t)=>s+(t.amount||0),0)/100

  // Monthly chart
  const monthlyMap: { [key: string]: { label: string; value: number } } = {}
  if (reportBy==='stay_date') {
    reservations.forEach(r => {
      const d = new Date(r.arrival_date+'T12:00:00')
      const key = d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')
      const label = d.toLocaleDateString('en-US',{month:'short',year:'2-digit'})
      if (!monthlyMap[key]) monthlyMap[key]={label,value:0}
      monthlyMap[key].value += (r.total_price||0)/100
    })
  } else {
    transactions.forEach(t => {
      if (!t.paid_at) return
      const d = new Date(t.paid_at)
      const key = d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')
      const label = d.toLocaleDateString('en-US',{month:'short',year:'2-digit'})
      if (!monthlyMap[key]) monthlyMap[key]={label,value:0}
      monthlyMap[key].value += (t.amount||0)/100
    })
  }
  const monthlyData = Object.entries(monthlyMap).sort((a,b)=>a[0].localeCompare(b[0])).map(([,v])=>v)

  const siteTypeMap: { [key: string]: number } = {}
  reservations.forEach(r => {
    const type = (r.sites as any)?.site_type||'unknown'
    const label = ({rv_site:'RV Sites',cabin:'Cabins',tent:'Tent Sites'} as any)[type]||type
    siteTypeMap[label] = (siteTypeMap[label]||0)+(r.total_price||0)/100
  })
  const siteTypeData = Object.entries(siteTypeMap).map(([name,value])=>({name,value}))

  const siteMap: { [key: string]: { name: string; revenue: number; bookings: number } } = {}
  reservations.forEach(r => {
    const n = (r.sites as any)?.site_number||'Unknown'
    if (!siteMap[n]) siteMap[n]={name:n,revenue:0,bookings:0}
    siteMap[n].revenue += (r.total_price||0)/100
    siteMap[n].bookings += 1
  })
  const topSites = Object.values(siteMap).sort((a,b)=>b.revenue-a.revenue).slice(0,5)
  const avgStay = reservations.length>0 ? reservations.reduce((sum,r)=>{ const nights=Math.round((new Date(r.departure_date).getTime()-new Date(r.arrival_date).getTime())/86400000); return sum+nights },0)/reservations.length : 0
  // Average days between when a booking was made (created_at) and arrival — booking lead time.
  const avgLeadTime = reservations.length>0 ? reservations.reduce((sum,r)=>{ const days=Math.round((new Date(r.arrival_date+'T12:00:00').getTime()-new Date(r.created_at).getTime())/86400000); return sum+Math.max(0,days) },0)/reservations.length : 0

  // Transactions filtering — unified source (folio + booking payments)
  const filteredTransactions = unifiedTx.filter(t => {
    const matchSearch = txSearch===''||t.guest_name.toLowerCase().includes(txSearch.toLowerCase())
    const matchMethod = txMethodFilter==='all'||t.method===txMethodFilter
    const matchType = txTypeFilter==='all'
      ||(txTypeFilter==='reservation'&&(t.folio_type==='reservation'||t.is_reservation_payment))
      ||(txTypeFilter==='walkin'&&(t.folio_type==='walkin'||t.folio_type==='walkup'))
    const matchDateFrom = !txDateFrom || (t.paid_at && t.paid_at >= txDateFrom)
    const matchDateTo = !txDateTo || (t.paid_at && t.paid_at <= txDateTo+'T23:59:59')
    return matchSearch&&matchMethod&&matchType&&matchDateFrom&&matchDateTo
  })
  const txByDay: { [day: string]: UnifiedPayment[] } = {}
  filteredTransactions.forEach(t => {
    if (!t.paid_at) return
    const day = new Date(t.paid_at).toLocaleDateString('en-US',{weekday:'short',month:'short',day:'numeric',year:'numeric'})
    if (!txByDay[day]) txByDay[day]=[]
    txByDay[day].push(t)
  })

  // Store data
  const categoryMap: { [key: string]: number } = {}
  lineItems.forEach(li => { const cat=li.category||'Uncategorized'; categoryMap[cat]=(categoryMap[cat]||0)+(li.line_total||0)/100 })
  const categoryData = Object.entries(categoryMap).map(([name,value])=>({name,value})).sort((a,b)=>b.value-a.value)
  const productMap: { [key: string]: { name: string; revenue: number; qty: number } } = {}
  lineItems.forEach(li => { const name=li.description||'Unknown'; if (!productMap[name]) productMap[name]={name,revenue:0,qty:0}; productMap[name].revenue+=(li.line_total||0)/100; productMap[name].qty+=li.quantity||0 })
  const topProducts = Object.values(productMap).sort((a,b)=>b.revenue-a.revenue).slice(0,8)
  // Seasonal campers' CHARGES in the period, by lane — the same classification their folio uses,
  // in place of the old `description.includes('electric')` guess. Every lane is drawn in the
  // shared lane colour and labelled, so the same three words and three colours mean the same
  // three things on every screen. `other` appears only when it has money in it: it is the
  // classifier's catch-all, not a lane a park manages.
  const seasonalLaneChargeData = LANES
    .map(l => ({ name: LANE_LABEL[l], value: gaBuckets.seasonalByLane[l]/100, color: LANE_COLOR[l] }))
    .filter(d => d.value !== 0)

  // ── Chart Components ───────────────────────────────────────────────────────
  function BarChart({ data, color = '#2E6B8A' }: { data: { label: string; value: number }[]; color?: string }) {
    if (data.length===0) return <p className="text-gray-400 text-center py-8">No data for selected period</p>
    const max = Math.max(...data.map(d=>d.value),1)
    const chartH=180, barW=32, gap=8, leftPad=48
    const totalW = leftPad+data.length*(barW+gap)+16
    return (
      <div style={{width:'100%',overflowX:'auto'}}>
        <svg width={totalW} height={chartH+40} style={{display:'block'}}>
          {[0,0.5,1].map((pct,i)=>{
            const y=8+(1-pct)*chartH
            const val=max*pct
            return <g key={i}><line x1={leftPad-4} y1={y} x2={totalW-8} y2={y} stroke="#e5e7eb" strokeWidth={1}/><text x={leftPad-6} y={y+4} textAnchor="end" fontSize={10} fill="#9CA3AF">${val>=1000?(val/1000).toFixed(1)+'k':val.toFixed(0)}</text></g>
          })}
          {data.map((d,i)=>{
            const barH=Math.max(3,(d.value/max)*chartH)
            const x=leftPad+i*(barW+gap)
            const y=8+chartH-barH
            return <g key={i}><rect x={x} y={y} width={barW} height={barH} fill={color} rx={4}/><text x={x+barW/2} y={chartH+22} textAnchor="middle" fontSize={10} fill="#6B7280">{d.label}</text><text x={x+barW/2} y={y-4} textAnchor="middle" fontSize={9} fill="#374151">${d.value>=1000?(d.value/1000).toFixed(1)+'k':d.value.toFixed(0)}</text></g>
          })}
        </svg>
      </div>
    )
  }

  // `color` is optional: a slice that knows what it represents (a money lane) brings the shared
  // lane colour with it, so the same lane is the same colour on every screen. Anything else
  // falls back to the house palette exactly as before.
  function DonutChart({ data }: { data: { name: string; value: number; color?: string }[] }) {
    if (data.length===0) return <p className="text-gray-400 text-center py-8">No data</p>
    const total=data.reduce((s,d)=>s+d.value,0)
    const cx=80,cy=80,r=65,inner=38
    let angle=-Math.PI/2
    const slices=data.map((d,i)=>{
      const sweep=(d.value/total)*2*Math.PI
      const x1=cx+r*Math.cos(angle),y1=cy+r*Math.sin(angle)
      angle+=sweep
      const x2=cx+r*Math.cos(angle),y2=cy+r*Math.sin(angle)
      const ix1=cx+inner*Math.cos(angle-sweep),iy1=cy+inner*Math.sin(angle-sweep)
      const ix2=cx+inner*Math.cos(angle),iy2=cy+inner*Math.sin(angle)
      const large=sweep>Math.PI?1:0
      return { path:`M ${x1} ${y1} A ${r} ${r} 0 ${large} 1 ${x2} ${y2} L ${ix2} ${iy2} A ${inner} ${inner} 0 ${large} 0 ${ix1} ${iy1} Z`, ...d, color:d.color||COLORS[i%COLORS.length] }
    })
    return (
      <div className="flex flex-col sm:flex-row items-center gap-6">
        <svg width={160} height={160} style={{flexShrink:0}}>
          {slices.map((s,i)=><path key={i} d={s.path} fill={s.color}/>)}
          <text x={cx} y={cy-4} textAnchor="middle" fontSize={11} fill="#374151" fontWeight="bold">Total</text>
          <text x={cx} y={cy+12} textAnchor="middle" fontSize={11} fill="#6B7280">${total>=1000?(total/1000).toFixed(1)+'k':total.toFixed(0)}</text>
        </svg>
        <div className="space-y-2 flex-1 w-full">
          {slices.map((s,i)=>(
            <div key={i} className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2 min-w-0">
                <div className="w-3 h-3 rounded-sm shrink-0" style={{backgroundColor:s.color}}/>
                <span className="text-sm text-gray-700 truncate">{s.name}</span>
              </div>
              <span className="text-sm font-medium text-gray-900 shrink-0">${s.value.toFixed(0)} ({((s.value/total)*100).toFixed(0)}%)</span>
            </div>
          ))}
        </div>
      </div>
    )
  }

  function KPICard({ label, value, sub, color, onClick, highlight }: { label: string; value: string; sub?: string; color?: string; onClick?: ()=>void; highlight?: boolean }) {
    return (
      <div onClick={onClick} className={`bg-white rounded-2xl border p-4 md:p-5 transition-all ${onClick?'cursor-pointer hover:shadow-md hover:border-blue-200':''} ${highlight?'border-red-200 bg-red-50':'border-gray-200'}`}>
        <p className="text-xs font-medium text-gray-500 uppercase tracking-wide mb-2">{label}</p>
        <p className={`text-2xl md:text-3xl font-bold ${color||'text-gray-900'}`}>{value}</p>
        {sub&&<p className="text-xs text-gray-400 mt-1">{sub}</p>}
        {onClick&&<p className="text-xs text-blue-500 mt-2 font-medium">Click to view →</p>}
      </div>
    )
  }

  // ── R2 PRESENTATION ────────────────────────────────────────────────────────
  //
  // Money is printed with thousands separators here, not with .toFixed(2) alone: the headline
  // figure is the single most-read number on the page, and "$1099099" vs "$10,990.99" is the
  // difference between an answer and a puzzle.
  const usd = (cents: number) =>
    (cents < 0 ? '−$' : '$') + (Math.abs(cents)/100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

  /**
   * ⚠ THE TONE PALETTE — a requirement, not styling. See lib/report-periods.ts.
   *
   * `win` celebrates. `watch` is AMBER and matter-of-fact, never alarm red: a slow month is
   * information, and an owner trained to see red for ordinary seasonality stops seeing red at
   * all. RED APPEARS EXACTLY ONCE ON THIS DASHBOARD — on money that should be there and is not,
   * in "Still to collect" — and that is the whole point of withholding it here.
   */
  const TONE: Record<'win'|'flat'|'watch', { fg: string; bg: string; ring: string; arrow: string }> = {
    win:   { fg: 'text-emerald-700', bg: 'bg-emerald-50', ring: 'ring-emerald-200', arrow: '▲' },
    flat:  { fg: 'text-gray-600',    bg: 'bg-gray-50',    ring: 'ring-gray-200',    arrow: '•' },
    watch: { fg: 'text-amber-700',   bg: 'bg-amber-50',   ring: 'ring-amber-200',   arrow: '▼' },
  }

  /**
   * PART C: the tabs speak the dashboard's colour language.
   *
   * A small labelled chip, not a bare coloured rule — the point is that an owner who clicks
   * "Nightly reservations" on the dashboard lands somewhere that visibly IS that source. Colour
   * alone would not say so, hence the label, and the wording repeats SOURCE_LABEL verbatim so
   * the two can never drift.
   */
  const SourceChip = ({ source, note }: { source: RevenueSource; note: string }) => (
    <div className="flex items-center gap-2 mb-1">
      <span className="w-2.5 h-2.5 rounded-sm shrink-0" style={{backgroundColor:SOURCE_COLOR[source]}} aria-hidden="true"/>
      <span className="text-xs font-semibold uppercase tracking-wide" style={{color:SOURCE_COLOR[source]}}>{SOURCE_LABEL[source]}</span>
      <span className="text-xs text-gray-400">· {note}</span>
    </div>
  )

  /** A source row, a KPI or a bar can send you to the page that produced the number. */
  function drillTo(dest: string) {
    if (dest.startsWith('tab:')) setActiveTab(dest.slice(4) as TabKey)
    else router.push(dest)
  }

  const rangeLabel = (() => {
    if (!win.startISO) return ''
    const f = (iso: string) => new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
    return f(win.startISO) === f(win.endISO) ? f(win.startISO) : `${f(win.startISO)} – ${f(win.endISO)}`
  })()

  /** The comparison chip: arrow, absolute change, and either a percentage or a multiple. */
  function DeltaChip({ delta, label, size = 'lg' }: { delta: ReturnType<typeof computeDelta>; label: string; size?: 'lg'|'sm' }) {
    const t = TONE[delta.tone]
    const pct = delta.multiple
      ? `${delta.multiple.toFixed(delta.multiple >= 10 ? 0 : 1)}×`
      : delta.changeFraction !== null
        ? `${delta.changeFraction >= 0 ? '+' : ''}${Math.round(delta.changeFraction*100)}%`
        : null
    return (
      <span className={`inline-flex items-center gap-1.5 rounded-full ring-1 ${t.bg} ${t.ring} ${t.fg} ${size==='lg'?'px-3 py-1.5 text-sm':'px-2 py-0.5 text-xs'} font-semibold`}>
        <span aria-hidden="true">{t.arrow}</span>
        <span>
          {delta.changeCents === 0 ? 'level with' : `${usd(Math.abs(delta.changeCents))} ${delta.changeCents>0?'more than':'less than'}`} {label}
        </span>
        {pct && <span className="font-bold opacity-80">· {pct}</span>}
      </span>
    )
  }

  // ── LANE PRESENTATION — Part B ─────────────────────────────────────────────
  //
  // ⚠ COLOUR IS NEVER THE ONLY SIGNAL. Every swatch is drawn beside LANE_LABEL, so the split
  // reads correctly with no colour perception at all; the colours are the Okabe–Ito
  // colourblind-safe set and live in lib/lane-display.ts so the R2 dashboard reuses them and the
  // language a park learns here holds on every other screen.
  const LaneSwatch = ({ lane }: { lane: Lane }) => (
    <span className="inline-flex items-center gap-2 min-w-0">
      <span className="w-3 h-3 rounded-sm shrink-0" style={{backgroundColor:LANE_COLOR[lane]}} aria-hidden="true"/>
      <span className="truncate">{LANE_LABEL[lane]}</span>
    </span>
  )
  // ONE rendering of an amount, so a lane line and the account line it rolls up to cannot
  // disagree about what a credit looks like. Mirrors `money()` on the camper page. `money` keeps
  // the sign — a refund row can make a "charged" or "paid" column negative, and a figure that
  // silently dropped its minus would make the column stop adding up.
  const money = (cents: number) => (cents<0?'−':'')+'$'+(Math.abs(cents)/100).toFixed(2)
  const balanceText = (cents: number) => cents<0 ? 'Credit '+money(cents) : money(cents)
  const balanceClass = (cents: number) => cents>0 ? 'text-red-600' : cents<0 ? 'text-blue-600' : 'text-emerald-600'

  const dateControls = (
    <div className="flex flex-wrap gap-2 items-center">
      <select className="border border-gray-200 rounded-lg px-3 py-2 text-sm bg-white" value={dateRange} onChange={e=>setDateRange(e.target.value)}>
        <option value="today">Today</option>
        <option value="this_week">This Week</option>
        <option value="this_month">This Month</option>
        <option value="last_month">Last Month</option>
        <option value="this_year">This Year</option>
        <option value="last_year">Last Year</option>
        <option value="custom">Custom Range</option>
      </select>
      {dateRange==='custom'&&(<>
        <input type="date" className="border border-gray-200 rounded-lg px-3 py-2 text-sm" value={customStart} onChange={e=>setCustomStart(e.target.value)}/>
        <span className="text-gray-400">to</span>
        <input type="date" className="border border-gray-200 rounded-lg px-3 py-2 text-sm" value={customEnd} onChange={e=>setCustomEnd(e.target.value)}/>
        <button onClick={fetchAll} className="px-3 py-2 rounded-lg text-white text-sm font-semibold" style={{backgroundColor:'#2E6B8A'}}>Go</button>
      </>)}
    </div>
  )

  const reportByToggle = (
    <div className="flex items-center gap-2 text-sm">
      <span className="text-gray-500 font-medium whitespace-nowrap">Report by:</span>
      <div className="flex rounded-lg border border-gray-200 overflow-hidden">
        {(['payment_date','stay_date'] as const).map(mode=>(
          <button key={mode} onClick={()=>setReportBy(mode)} className="px-3 py-1.5 text-xs font-medium transition-colors"
            style={reportBy===mode?{background:'#2E6B8A',color:'#fff'}:{background:'#fff',color:'#6b7280'}}>
            {mode==='payment_date'?'Payment Date':'Stay Date'}
          </button>
        ))}
      </div>
    </div>
  )

  async function deleteCancelledReservation(id: string) {
    setDeleting(true)
    await supabase.from('reservations').delete().eq('id', id)
    setCancelledReservations(prev => prev.filter(r => r.id !== id))
    setCancelledCount(prev => prev - 1)
    setSelectedCancelled(null)
    setConfirmDelete(false)
    setDeleting(false)
  }

  const occupancyPct = totalSites>0?Math.min(100,Math.round(((tonightCount+seasonalCount)/totalSites)*100)):0

  return (
    <div className="p-4 md:p-6 max-w-7xl mx-auto">

      {/* Header */}
      <div className="flex flex-col gap-3 mb-6 md:flex-row md:items-center md:justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Reports</h1>
          <p className="text-sm text-gray-500 mt-0.5">Business intelligence for {new Date().toLocaleDateString('en-US',{month:'long',year:'numeric'})}</p>
        </div>
        <div className="flex flex-wrap gap-3 items-center">
          {reportByToggle}
          {dateControls}
        </div>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 mb-6 border-b border-gray-200 overflow-x-auto">
        {([
          {key:'dashboard',label:'📊 Dashboard'},
          {key:'forward',label:'📅 Weeks Ahead'},
          {key:'reservations',label:'🏕️ Reservations'},
          ...(seasonalEnabled ? [{key:'seasonal',label:'⛺ Seasonal'}] : []),
          {key:'transactions',label:'💳 Transactions'},
          ...(posEnabled?[{key:'store',label:'🛒 Store'}]:[]),
        ] as {key:TabKey,label:string}[]).map(tab=>(
          <button key={tab.key} onClick={()=>setActiveTab(tab.key)}
            className="px-4 py-2.5 text-sm font-semibold whitespace-nowrap transition-colors rounded-t-lg"
            style={activeTab===tab.key?{backgroundColor:'#2E6B8A',color:'#fff',borderBottom:'2px solid #2E6B8A'}:{color:'#6B7280'}}>
            {tab.label}
          </button>
        ))}
      </div>

      {loading?<div className="p-12 text-center text-gray-400 text-lg">Loading reports...</div>:(
        <>

        {/* ── DASHBOARD TAB — the money view (R2) ── */}
        {activeTab==='dashboard'&&(
          <div className="space-y-6">

            {/* ─────────────── THE ANSWER, FIRST ───────────────
                No grid of cards above this. An owner opening Reports is asking one question —
                "how is my park doing?" — and it is answered in one number, one comparison and
                one sentence before anything else competes for the eye. */}
            <div className="bg-white rounded-2xl border border-gray-200 p-6 md:p-8">
              {isRecord && (
                <div className="inline-flex items-center gap-2 mb-3 rounded-full bg-emerald-600 text-white px-3 py-1 text-xs font-bold tracking-wide">
                  <span aria-hidden="true">🏆</span> BEST MONTH YET
                </div>
              )}
              <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide">
                Money received{rangeLabel && <span className="text-gray-400 font-medium normal-case tracking-normal"> · {rangeLabel}</span>}
              </p>
              <p className="text-4xl md:text-6xl font-bold text-gray-900 mt-1 tracking-tight">{usd(moneyIn)}</p>
              <div className="mt-3 flex flex-wrap items-center gap-3">
                <DeltaChip delta={moneyDelta} label={comparison.label}/>
                <span className="text-xs text-gray-400">
                  compared with {usd(priorSources.total)} over {comparison.label}
                </span>
              </div>
              <p className="text-sm md:text-base text-gray-600 mt-3">{headline}</p>
              <p className="text-xs text-gray-400 mt-3">
                Every payment taken in this period, gross of card fees. Canceled charges and refunds
                are already netted out, so this agrees with the folios it came from.
              </p>
            </div>

            {/* ─────────────── WHERE THE MONEY CAME FROM ───────────────
                Ranked, full-width rows rather than a pie. Seasonal fees can be ~85% of a park's
                revenue, which makes every other slice unreadable in a circle — and the small
                sources are exactly the ones an owner is trying to grow. See rankSources(). */}
            <div className="bg-white rounded-2xl border border-gray-200 p-5 md:p-6">
              <div className="flex items-baseline justify-between gap-3 flex-wrap mb-1">
                <h2 className="text-lg font-semibold text-gray-900">Where the money came from</h2>
                <span className="text-xs text-gray-400">Click any source to see the payments behind it</span>
              </div>
              <p className="text-xs text-gray-400 mb-4">Each source compared with {comparison.label}.</p>

              {rankedSources.length===0?(
                <p className="text-gray-400 text-sm py-8 text-center">No money came in during this period.</p>
              ):(
                <div className="divide-y divide-gray-50">
                  {rankedSources.map(r=>{
                    const open = openSource===r.source
                    const d = r.priorAmount===null?null:computeDelta(r.amount, r.priorAmount)
                    const dest = SOURCE_DESTINATION[r.source]
                    return (
                      <div key={r.source} className="py-3">
                        <button onClick={()=>setOpenSource(open?null:r.source)}
                          className="w-full text-left group" aria-expanded={open}>
                          <div className="flex items-center justify-between gap-3">
                            <div className="flex items-center gap-2.5 min-w-0">
                              {/* ⚠ Colour is never the only signal — the label is always printed. */}
                              <span className="w-3 h-3 rounded-sm shrink-0" style={{backgroundColor:SOURCE_COLOR[r.source]}} aria-hidden="true"/>
                              <span className="font-semibold text-gray-900 text-sm md:text-base truncate group-hover:underline">{SOURCE_LABEL[r.source]}</span>
                              <span className="text-gray-300 text-xs shrink-0" aria-hidden="true">{open?'▾':'▸'}</span>
                            </div>
                            <div className="flex items-center gap-3 shrink-0">
                              {d && <DeltaChip delta={d} label={comparison.label} size="sm"/>}
                              <span className="font-bold text-gray-900 text-sm md:text-base tabular-nums">{usd(r.amount)}</span>
                            </div>
                          </div>
                          <div className="flex items-center gap-3 mt-1.5">
                            {/* The share bar. Floored so a $47.99 store month against an $11k
                                seasonal month is still visibly there — the printed percentage
                                beside it stays truthful. */}
                            <div className="h-2.5 bg-gray-100 rounded-full overflow-hidden flex-1">
                              <div className="h-full rounded-full" style={{width:barWidthPct(r.share)+'%',backgroundColor:SOURCE_COLOR[r.source]}}/>
                            </div>
                            <span className="text-xs text-gray-500 tabular-nums w-12 text-right shrink-0">
                              {r.share>0&&r.share<0.005?'<1':Math.round(r.share*100)}%
                            </span>
                          </div>
                          <p className="text-xs text-gray-400 mt-1">{SOURCE_BLURB[r.source]}</p>
                        </button>

                        {open && (
                          <div className="mt-3 ml-5 border-l-2 pl-4 space-y-1" style={{borderColor:SOURCE_COLOR[r.source]}}>
                            {paymentsForSource(r.source).length===0?(
                              <p className="text-xs text-gray-400 py-2">No individual payments to show.</p>
                            ):paymentsForSource(r.source).slice(0,8).map(pm=>(
                              <div key={pm.id} className="flex items-center justify-between gap-3 text-xs py-1">
                                <span className="text-gray-600 truncate">{pm.who}</span>
                                <span className="text-gray-400 shrink-0">
                                  {pm.when?new Date(pm.when).toLocaleDateString('en-US',{month:'short',day:'numeric'}):''} · {pm.method}
                                </span>
                                <span className="font-semibold text-gray-900 tabular-nums shrink-0">{usd(pm.cents)}</span>
                              </div>
                            ))}
                            {paymentsForSource(r.source).length>8&&(
                              <p className="text-xs text-gray-400 pt-1">+{paymentsForSource(r.source).length-8} more</p>
                            )}
                            <button onClick={()=>drillTo(dest)}
                              className="text-xs font-semibold pt-2 hover:underline" style={{color:SOURCE_COLOR[r.source]}}>
                              {r.source==='electric'?'Open electric billing →'
                                :r.source==='long_term'?'Open guests →'
                                :r.source==='nightly'?'See all reservations →'
                                :r.source==='seasonal'?'See the seasonal lane view →'
                                :r.source==='store'?'See store sales →'
                                :'See all transactions →'}
                            </button>
                          </div>
                        )}
                      </div>
                    )
                  })}
                  <div className="pt-3 flex items-center justify-between">
                    <span className="font-bold text-gray-900">Total received</span>
                    <span className="font-bold text-gray-900 text-lg tabular-nums">{usd(currentSources.total)}</span>
                  </div>
                </div>
              )}
            </div>

            {/* ─────────────── HOW FULL YOU ARE ─────────────── */}
            <div className="bg-white rounded-2xl border border-gray-200 p-5 md:p-6">
              <div className="flex items-baseline justify-between gap-3 flex-wrap">
                <h2 className="text-lg font-semibold text-gray-900">How full you are</h2>
                <div className="flex items-center gap-4">
                  <button onClick={()=>setActiveTab('forward')} className="text-xs font-semibold text-blue-600 hover:underline">
                    Weeks ahead →
                  </button>
                  <button onClick={()=>setShowOccupancyDetail(true)} className="text-xs font-semibold text-blue-600 hover:underline">
                    Month by month →
                  </button>
                </div>
              </div>
              <p className="text-3xl md:text-4xl font-bold text-gray-900 mt-2">
                {occupancyPct}%
                <span className="text-base md:text-lg font-semibold text-gray-500 ml-3">
                  {tonightCount+seasonalCount} of {totalSites} sites tonight
                </span>
              </p>
              <p className="text-sm text-gray-600 mt-1">
                <span className="font-semibold">{seasonalCount} seasonal</span> + <span className="font-semibold">{tonightCount} nightly</span>
                {totalCabins>0&&<> · cabins {tonightCabins} of {totalCabins}</>}
              </p>
              <p className="text-xs text-gray-400 mt-1">
                {seasonalCount>0&&tonightCount+seasonalCount>0
                  ? `Seasonal campers hold ${Math.round((seasonalCount/(tonightCount+seasonalCount))*100)}% of the sites you have filled — steady income that does not turn over.`
                  : 'Every occupied site tonight is a nightly booking.'}
              </p>

              {/* R3's headline, carried onto the dashboard so the forward look is one click away
                  rather than buried behind a tab nobody thinks to open. */}
              {forwardLook.weeks.length>0 && (
                <button onClick={()=>setActiveTab('forward')}
                  className="mt-4 w-full text-left rounded-xl px-4 py-3 ring-1 hover:brightness-[0.98] transition"
                  style={ forwardLook.behind.length>0
                    ? {background:'#FFFBEB',boxShadow:'inset 0 0 0 1px #FDE68A'}
                    : {background:'#ECFDF5',boxShadow:'inset 0 0 0 1px #A7F3D0'} }>
                  <span className={`text-sm font-semibold ${forwardLook.behind.length>0?'text-amber-800':'text-emerald-800'}`}>
                    {forwardLook.behind.length>0
                      ? `👀 ${forwardLook.behind.length} of the next ${WEEKS_AHEAD} weeks ${forwardLook.behind.length!==1?'are':'is'} pacing behind`
                      : forwardLook.best && forwardLook.best.fill>0
                        ? `🎉 Your fullest week ahead is ${weekLabel(forwardLook.best.weekStart)} at ${forwardLook.best.fill}%`
                        : `📅 The next ${WEEKS_AHEAD} weeks, night by night`}
                  </span>
                  <span className="block text-xs text-gray-500 mt-0.5">Open Weeks Ahead to see which nights are open →</span>
                </button>
              )}

              <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wide mt-6 mb-2">Occupancy trend</h3>
              <div style={{width:'100%',overflowX:'auto'}}>
                <svg width={Math.max(600, monthlyOccupancy.length*60+60)} height={200} style={{display:'block'}}>
                  {[0,50,100].map((pct,i)=>{
                    const y=10+(1-pct/100)*150
                    return <g key={i}><line x1={40} y1={y} x2={monthlyOccupancy.length*60+40} y2={y} stroke="#e5e7eb" strokeWidth={1}/><text x={36} y={y+4} textAnchor="end" fontSize={10} fill="#9CA3AF">{pct}%</text></g>
                  })}
                  {monthlyOccupancy.map((m,i)=>{
                    const x=50+i*60
                    const siteH=Math.max(2,(m.sites/100)*150)
                    const cabinH=Math.max(2,(m.cabins/100)*150)
                    return <g key={i}>
                      <rect x={x-14} y={10+(1-m.sites/100)*150} width={12} height={siteH} fill={SOURCE_COLOR.seasonal} rx={3}/>
                      <rect x={x+2} y={10+(1-m.cabins/100)*150} width={12} height={cabinH} fill={SOURCE_COLOR.nightly} rx={3}/>
                      <text x={x} y={175} textAnchor="middle" fontSize={10} fill="#6B7280">{m.label}</text>
                    </g>
                  })}
                </svg>
                <div className="flex items-center gap-6 mt-2 justify-center">
                  <div className="flex items-center gap-1.5"><div className="w-3 h-3 rounded-sm" style={{background:SOURCE_COLOR.seasonal}}/><span className="text-xs text-gray-500">Sites ({totalSites})</span></div>
                  <div className="flex items-center gap-1.5"><div className="w-3 h-3 rounded-sm" style={{background:SOURCE_COLOR.nightly}}/><span className="text-xs text-gray-500">Cabins ({totalCabins})</span></div>
                </div>
              </div>
            </div>

            {/* ─────────────── STILL TO COLLECT ───────────────
                ⚠ THE ONE PLACE RED IS ALLOWED. This is money that should be here and is not,
                which is the only thing on this dashboard that warrants alarm. A credit is shown
                in blue beside it rather than netted away, because post-R1 a camper who is paid
                ahead is real and must not be hidden inside an "outstanding" figure. */}
            {seasonalEnabled && (
              <div className="bg-white rounded-2xl border border-gray-200 p-5 md:p-6">
                <div className="flex items-baseline justify-between gap-3 flex-wrap mb-3">
                  <h2 className="text-lg font-semibold text-gray-900">Still to collect</h2>
                  <button onClick={()=>setActiveTab('seasonal')} className="text-xs font-semibold text-blue-600 hover:underline">
                    Full lane breakdown →
                  </button>
                </div>
                <div className="flex flex-wrap items-baseline gap-x-8 gap-y-2">
                  <div>
                    <p className={`text-3xl font-bold ${outstandingBalance>0?'text-red-600':'text-emerald-600'}`}>${outstandingBalance.toFixed(2)}</p>
                    <p className="text-xs text-gray-500 mt-0.5">
                      owed by {overdueCampers.length} camper{overdueCampers.length!==1?'s':''}
                    </p>
                  </div>
                  {creditBalance>0&&(
                    <div>
                      <p className="text-3xl font-bold text-blue-600">${creditBalance.toFixed(2)}</p>
                      <p className="text-xs text-gray-500 mt-0.5">
                        held in credit for {creditCampers.length} camper{creditCampers.length!==1?'s':''}
                      </p>
                    </div>
                  )}
                </div>

                {seasonalCampers.length===0?(
                  <p className="text-gray-400 text-sm mt-4">No seasonal campers found.</p>
                ):(
                  <div className="mt-4 divide-y divide-gray-50">
                    {[...seasonalCampers].filter(c=>c.balance!==0).sort((a,b)=>b.balance-a.balance).map(c=>(
                      <button key={c.id} onClick={()=>c.folioId&&router.push(`/admin/folio/guest/${c.id}`)}
                        className="w-full flex items-center justify-between gap-3 py-2 text-left hover:bg-gray-50 rounded px-1 -mx-1">
                        <span className="min-w-0">
                          <span className="text-sm font-medium text-gray-900 truncate">{c.name}</span>
                          {c.site_number&&<span className="text-xs text-gray-400 ml-2">Site {c.site_number}</span>}
                        </span>
                        <span className={`text-sm font-bold shrink-0 ${c.balance>0?'text-red-600':'text-blue-600'}`}>
                          {c.balance<0?'Credit '+usd(-c.balance):usd(c.balance)}
                        </span>
                      </button>
                    ))}
                    {seasonalCampers.every(c=>c.balance===0)&&(
                      <p className="text-sm text-emerald-600 font-medium py-2">✓ Every seasonal camper is settled up.</p>
                    )}
                  </div>
                )}
              </div>
            )}

            {/* ─────────────── THE SMALLER NUMBERS, KEPT ───────────────
                Everything that does not headline but that an owner still relies on. Reorganised
                out of the old card grid, never removed: this section is the tidy secondary home
                the redesign owes them. */}
            <div className="bg-white rounded-2xl border border-gray-200 p-5 md:p-6">
              <h2 className="text-lg font-semibold text-gray-900 mb-1">The smaller numbers</h2>
              <p className="text-xs text-gray-400 mb-4">Still here, just not shouting. Click any of them to see what is behind it.</p>
              <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
                <KPICard label="Today's Revenue" value={'$'+todayRevenue.toFixed(2)} sub="all payments today" color="text-emerald-600" onClick={()=>setActiveTab('transactions')}/>
                <KPICard label="Future Bookings" value={futureCount.toString()} sub="confirmed ahead" onClick={()=>setActiveTab('reservations')}/>
                <KPICard label="Avg Booking Lead Time" value={avgLeadTime.toFixed(1)+' days'} sub="booked in advance" onClick={()=>setActiveTab('reservations')}/>
                <KPICard label="Avg Stay" value={avgStay.toFixed(1)+' nights'} sub="per booking" onClick={()=>setActiveTab('reservations')}/>
                {/* Gross revenue, so this is a BREAKOUT of money already counted above — not an
                    extra amount to add on. */}
                <KPICard label="Transaction Fees Collected" value={'$'+totalSurcharge.toFixed(2)} sub="included in revenue above" onClick={()=>setActiveTab('transactions')}/>
                {/* ⚠ NOT the headline figure, and deliberately labelled so. `totalCombined` mixes
                    payments (reservations, store) with CHARGES (guest accounts) — the definition
                    this card has always had. It is kept exactly as it was rather than quietly
                    restated onto the money-received basis, and it follows the Payment/Stay date
                    toggle as it always has. */}
                <div onClick={()=>setShowBilledDetail(v=>!v)}
                  className="bg-white rounded-2xl border border-gray-200 p-4 md:p-5 cursor-pointer hover:shadow-md hover:border-blue-200 transition-all">
                  <p className="text-xs font-medium text-gray-500 uppercase tracking-wide mb-2">Total Revenue (billed)</p>
                  <p className="text-2xl md:text-3xl font-bold text-gray-900">${totalCombined.toFixed(2)}</p>
                  <p className="text-xs text-gray-400 mt-1">{reportBy==='payment_date'?'bookings paid + charges raised':'stay dates + charges raised'}</p>
                  <p className="text-xs text-blue-500 mt-2 font-medium">{showBilledDetail?'Hide breakdown ▾':'Click to view →'}</p>
                </div>
              </div>

              {showBilledDetail && (
                <div className="mt-4 rounded-xl bg-gray-50 border border-gray-100 p-4">
                  <p className="text-xs text-gray-500 mb-3">
                    What was <span className="font-semibold">billed</span> this period, rather than what was received.
                    Reservations and store count their payments; guest accounts count their charges — which is why
                    this figure differs from the headline above.
                  </p>
                  {[
                    { label: 'Reservation revenue', value: resRevenue, tab: 'reservations' as TabKey, color: SOURCE_COLOR.nightly, sub: reservations.length+' bookings' },
                    ...(posEnabled?[{ label: 'Store revenue', value: posRevenue, tab: 'store' as TabKey, color: SOURCE_COLOR.store, sub: posSales.length+' transactions' }]:[]),
                    { label: 'Seasonal charges', value: seasonalRevenue, tab: 'seasonal' as TabKey, color: SOURCE_COLOR.seasonal, sub: 'all lanes' },
                    { label: 'Long-term / monthly', value: longTermRevenue, tab: 'seasonal' as TabKey, color: SOURCE_COLOR.long_term, sub: 'weekly & monthly stays' },
                    ...(otherAccountRevenue!==0?[{ label: 'Other guest accounts', value: otherAccountRevenue, tab: 'transactions' as TabKey, color: SOURCE_COLOR.other, sub: 'house tabs' }]:[]),
                  ].map(row=>(
                    <button key={row.label} onClick={()=>setActiveTab(row.tab)}
                      className="w-full flex items-center justify-between gap-3 py-1.5 text-left hover:underline">
                      <span className="flex items-center gap-2 min-w-0">
                        <span className="w-2.5 h-2.5 rounded-sm shrink-0" style={{backgroundColor:row.color}} aria-hidden="true"/>
                        <span className="text-sm text-gray-700 truncate">{row.label}</span>
                        <span className="text-xs text-gray-400 shrink-0 hidden sm:inline">{row.sub}</span>
                      </span>
                      <span className="text-sm font-semibold text-gray-900 tabular-nums shrink-0">${row.value.toFixed(2)}</span>
                    </button>
                  ))}
                </div>
              )}

              {/* Payment methods — kept, and now click-through: picking one drops you into the
                  Transactions log already filtered to it. */}
              <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wide mt-6 mb-3">Payment methods</h3>
              <div className="space-y-3">
                {methodTotals.map(mt=>{
                  const m={label:methodLabel(mt.method),value:mt.value,color:methodColor(mt.method,customMethods)}
                  const total=methodTotals.reduce((s,x)=>s+x.value,0)
                  const pct=total>0?Math.round((m.value/total)*100):0
                  return (
                    <button key={m.label} onClick={()=>{setTxMethodFilter(mt.method);setActiveTab('transactions')}} className="w-full text-left group">
                      <div className="flex justify-between text-sm mb-1">
                        <span className="font-medium text-gray-700 group-hover:underline">{m.label}</span>
                        <span className="font-semibold text-gray-900">${m.value.toFixed(2)} <span className="text-gray-400 font-normal">({pct}%)</span></span>
                      </div>
                      <div className="h-2 bg-gray-100 rounded-full overflow-hidden">
                        <div className="h-full rounded-full transition-all" style={{width:pct+'%',backgroundColor:m.color}}/>
                      </div>
                    </button>
                  )
                })}
              </div>

              {/* Revenue trend — kept, and still driven by the Payment/Stay date toggle. */}
              <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wide mt-6 mb-1">
                {reportBy==='payment_date'?'Revenue by payment date':'Revenue by stay date'}
              </h3>
              <p className="text-xs text-gray-400 mb-3">{reportBy==='payment_date'?'When payments were received':'Attributed to arrival month'}</p>
              <BarChart data={monthlyData}/>
            </div>
          </div>
        )}

        {/* ── WEEKS AHEAD TAB — the forward look (R3) ── */}
        {activeTab==='forward'&&(
          <div className="space-y-6">

            {/* ─────────────── THE SIGNAL STRIP ───────────────
                Wins first, deliberately. This view exists to direct attention, and an owner who
                only ever sees what is wrong stops opening it. */}
            <div className="bg-white rounded-2xl border border-gray-200 p-5 md:p-6">
              <div className="flex items-start justify-between gap-4 flex-wrap">
                <div className="min-w-0">
                  <h2 className="text-lg font-semibold text-gray-900">The next {WEEKS_AHEAD} weeks</h2>
                  <p className="text-xs text-gray-400 mt-0.5">
                    {forwardLook.basis==='none'
                      ? 'Showing how full each week is. No comparison yet.'
                      : <>Pace measured against <span className="font-semibold text-gray-500">{forwardLook.basisLabel}</span>.</>}
                  </p>
                </div>

                {/* ── ADD A GOAL — opt-in, and off by default ── */}
                <div className="shrink-0">
                  {!hasGoalColumn ? (
                    <span className="text-xs text-gray-400">Goals need the R3 database update.</span>
                  ) : goalEditing ? (
                    <div className="flex items-center gap-2">
                      <input type="number" min={1} max={100} autoFocus value={goalDraft}
                        onChange={e=>setGoalDraft(e.target.value)}
                        placeholder="70"
                        className="w-20 border border-gray-200 rounded-lg px-2 py-1.5 text-sm"/>
                      <span className="text-sm text-gray-500">% full</span>
                      <button disabled={goalSaving}
                        onClick={()=>{const n=Math.round(Number(goalDraft)); saveGoal(Number.isFinite(n)&&n>0?Math.min(100,n):null)}}
                        className="px-3 py-1.5 rounded-lg text-white text-xs font-bold" style={{background:'#059669'}}>
                        {goalSaving?'Saving…':'Save'}
                      </button>
                      {goalPct!==null&&(
                        <button disabled={goalSaving} onClick={()=>saveGoal(null)}
                          className="text-xs text-gray-500 hover:underline">Remove</button>
                      )}
                      <button onClick={()=>setGoalEditing(false)} className="text-xs text-gray-400 hover:underline">Cancel</button>
                    </div>
                  ) : goalPct===null ? (
                    <button onClick={()=>{setGoalDraft('');setGoalEditing(true)}}
                      className="text-xs font-semibold px-3 py-1.5 rounded-lg border border-gray-200 text-gray-600 hover:bg-gray-50">
                      + Add a goal
                    </button>
                  ) : (
                    <button onClick={()=>{setGoalDraft(String(goalPct));setGoalEditing(true)}}
                      className="text-xs font-semibold px-3 py-1.5 rounded-lg border border-emerald-200 bg-emerald-50 text-emerald-700 hover:bg-emerald-100">
                      Goal: {goalPct}% full · Edit
                    </button>
                  )}
                </div>
              </div>

              <div className="mt-4 space-y-2">
                {forwardLook.best && forwardLook.best.fill > 0 && (
                  <p className="text-sm md:text-base rounded-xl bg-emerald-50 ring-1 ring-emerald-200 text-emerald-800 px-4 py-2.5">
                    🎉 <span className="font-semibold">The week of {weekLabel(forwardLook.best.weekStart)} is {forwardLook.best.fill}% full</span>
                    {forwardLook.best.verdict==='ahead'?' — nicely ahead.'
                      : forwardLook.best.fill>=70?' — your strongest week on the board.'
                      : ' — your fullest week ahead.'}
                  </p>
                )}
                {forwardLook.ahead.length>0 && (
                  <p className="text-sm rounded-xl bg-emerald-50 ring-1 ring-emerald-200 text-emerald-800 px-4 py-2.5">
                    ✅ <span className="font-semibold">{forwardLook.ahead.length} week{forwardLook.ahead.length!==1?'s are':' is'} ahead of {forwardLook.basisLabel}</span> — whatever you did there, do it again.
                  </p>
                )}
                {/* ⚠ AMBER, AND WORDED AS AN OPPORTUNITY. These are the weeks a nudge can still
                    fill, which is the whole point of looking eight weeks out. */}
                {forwardLook.behind.length>0 && (
                  <p className="text-sm rounded-xl bg-amber-50 ring-1 ring-amber-200 text-amber-800 px-4 py-2.5">
                    👀 <span className="font-semibold">{forwardLook.behind.length} week{forwardLook.behind.length!==1?'s are':' is'} pacing behind</span> — a nudge now fills {forwardLook.behind.length!==1?'them':'it'}:{' '}
                    {forwardLook.behind.map(w=>weekLabel(w.weekStart)).join(' · ')}
                  </p>
                )}
                {/* The first-season state: useful, and pointedly not nagging. */}
                {forwardLook.basis==='none' && (
                  <p className="text-sm rounded-xl bg-gray-50 ring-1 ring-gray-200 text-gray-600 px-4 py-2.5">
                    We&rsquo;ll compare to last year once you have one — or add a goal anytime.
                  </p>
                )}
              </div>
            </div>

            {/* ─────────────── PACE BARS ─────────────── */}
            <div className="bg-white rounded-2xl border border-gray-200 p-5 md:p-6">
              <h2 className="text-lg font-semibold text-gray-900 mb-1">How each week is pacing</h2>
              <p className="text-xs text-gray-400 mb-4">
                How full each week is. {forwardLook.basis==='goal'
                  ? 'The dashed line is your goal.'
                  : forwardLook.basis==='none'
                    ? 'No comparison line yet — this is simply where each week stands.'
                    : 'The grey tick on each bar is where ' + forwardLook.basisLabel + ' stood.'}
              </p>
              <div style={{width:'100%',overflowX:'auto'}}>
                {(() => {
                  const W = forwardLook.weeks, chartH = 170, barW = 44, gap = 22, left = 34
                  const totalW = left + W.length*(barW+gap) + 16
                  const y = (pct: number) => 10 + (1 - pct/100)*chartH
                  return (
                    <svg width={Math.max(totalW, 320)} height={chartH+58} style={{display:'block'}}>
                      {[0,50,100].map(pct=>(
                        <g key={pct}>
                          <line x1={left-6} y1={y(pct)} x2={totalW-8} y2={y(pct)} stroke="#e5e7eb" strokeWidth={1}/>
                          <text x={left-9} y={y(pct)+4} textAnchor="end" fontSize={10} fill="#9CA3AF">{pct}%</text>
                        </g>
                      ))}
                      {/* The goal line — drawn ONLY when the owner opted in. */}
                      {forwardLook.basis==='goal' && goalPct!==null && (
                        <g>
                          <line x1={left-6} y1={y(goalPct)} x2={totalW-8} y2={y(goalPct)}
                            stroke="#059669" strokeWidth={2} strokeDasharray="6 4"/>
                          <text x={totalW-10} y={y(goalPct)-5} textAnchor="end" fontSize={10} fill="#059669" fontWeight="bold">
                            goal {goalPct}%
                          </text>
                        </g>
                      )}
                      {W.map((w,i)=>{
                        const x = left + i*(barW+gap)
                        const h = Math.max(2, (w.fill/100)*chartH)
                        const c = paceColor(w)
                        return (
                          <g key={w.weekStart}>
                            <rect x={x} y={10+chartH-h} width={barW} height={h} fill={c} rx={5}/>
                            <text x={x+barW/2} y={10+chartH-h-6} textAnchor="middle" fontSize={11} fill="#374151" fontWeight="bold">{w.fill}%</text>
                            {/* Last year's mark, where there is one. A tick rather than a second
                                bar: it is a reference point, not a competing quantity. */}
                            {forwardLook.basis!=='goal' && w.priorFill!==null && (
                              <g>
                                <line x1={x-3} y1={y(w.priorFill)} x2={x+barW+3} y2={y(w.priorFill)}
                                  stroke="#6B7280" strokeWidth={2}/>
                                <title>{forwardLook.basisLabel}: {w.priorFill}%</title>
                              </g>
                            )}
                            <text x={x+barW/2} y={chartH+30} textAnchor="middle" fontSize={10} fill="#6B7280">{weekLabel(w.weekStart)}</text>
                            {w.days.some(d=>d.isToday)&&(
                              <text x={x+barW/2} y={chartH+44} textAnchor="middle" fontSize={9} fill="#9CA3AF">this week</text>
                            )}
                          </g>
                        )
                      })}
                    </svg>
                  )
                })()}
              </div>
              {/* Colour is never the only signal — the verdict is spelled out. */}
              <div className="flex flex-wrap items-center gap-4 mt-3">
                {[
                  { c:'#059669', t: forwardLook.basis==='none' ? 'Filling nicely' : 'Ahead' },
                  ...(forwardLook.basis==='none' ? [] : [{ c:'#9CA3AF', t:'About level' }]),
                  ...(forwardLook.basis==='none' ? [{ c:'#94A3B8', t:'Room to fill' }] : [{ c:'#D97706', t:'Worth a nudge' }]),
                ].map(l=>(
                  <span key={l.t} className="flex items-center gap-1.5">
                    <span className="w-3 h-3 rounded-sm" style={{background:l.c}} aria-hidden="true"/>
                    <span className="text-xs text-gray-500">{l.t}</span>
                  </span>
                ))}
              </div>
            </div>

            {/* ─────────────── HEAT CALENDAR ───────────────
                ⚠ ALWAYS VISIBLE, never behind a click. The bars say WHICH week needs attention;
                only the calendar says WHICH NIGHTS are open, and that is the thing an owner acts
                on when they write the post or send the email. */}
            <div className="bg-white rounded-2xl border border-gray-200 p-5 md:p-6">
              <div className="flex items-baseline justify-between gap-3 flex-wrap mb-1">
                <h2 className="text-lg font-semibold text-gray-900">Which nights are open</h2>
                <button onClick={()=>setActiveTab('reservations')} className="text-xs font-semibold text-blue-600 hover:underline">
                  See the bookings →
                </button>
              </div>
              <p className="text-xs text-gray-400 mb-4">
                Every night of the next {WEEKS_AHEAD} weeks. Darker means fuller. Seasonal campers are included, the same way
                tonight&rsquo;s occupancy counts them.
              </p>

              <div style={{width:'100%',overflowX:'auto'}}>
                <div style={{minWidth:'520px'}}>
                  <div className="grid gap-1 mb-1" style={{gridTemplateColumns:'72px repeat(7, minmax(0,1fr))'}}>
                    <div/>
                    {['Mon','Tue','Wed','Thu','Fri','Sat','Sun'].map(d=>(
                      <div key={d} className="text-center text-xs font-semibold text-gray-400 uppercase tracking-wide">{d}</div>
                    ))}
                  </div>
                  {forwardLook.weeks.map(w=>(
                    <div key={w.weekStart} className="grid gap-1 mb-1 items-stretch" style={{gridTemplateColumns:'72px repeat(7, minmax(0,1fr))'}}>
                      <div className="flex flex-col justify-center pr-2">
                        <span className="text-xs font-semibold text-gray-700">{weekLabel(w.weekStart)}</span>
                        <span className="text-xs" style={{color:paceColor(w)}}>{w.fill}%</span>
                      </div>
                      {w.days.map(d=>{
                        const { bg, fg } = heatColor(d.fill)
                        return (
                          <div key={d.date}
                            title={`${d.date} · ${d.fill}% full · ${d.sites} site${d.sites!==1?'s':''}${d.cabins?` · ${d.cabins} cabin${d.cabins!==1?'s':''}`:''}`}
                            className={`rounded-md py-2 text-center ${d.isToday?'ring-2 ring-offset-1 ring-blue-500':''}`}
                            style={{background:bg}}>
                            <div className="text-[10px] leading-none opacity-80" style={{color:fg}}>{Number(d.date.slice(8,10))}</div>
                            {/* The percentage is PRINTED in every cell: the shade is the pattern,
                                the number is the answer. */}
                            <div className="text-xs font-bold leading-tight mt-0.5" style={{color:fg}}>{d.fill}%</div>
                          </div>
                        )
                      })}
                    </div>
                  ))}
                </div>
              </div>

              <div className="flex items-center gap-2 mt-4 flex-wrap">
                <span className="text-xs text-gray-500">Empty</span>
                {HEAT_LEGEND.map(l=>(
                  <span key={l.bg} className="w-7 h-4 rounded-sm border border-gray-100" style={{background:l.bg}} aria-hidden="true"/>
                ))}
                <span className="text-xs text-gray-500">Full</span>
                <span className="text-xs text-gray-400 ml-2">· today is outlined in blue</span>
              </div>
            </div>
          </div>
        )}

        {/* ── RESERVATIONS TAB ── */}
        {activeTab==='reservations'&&(
          <div className="space-y-6">
            <SourceChip source="nightly" note="the detail behind the dashboard's nightly line"/>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              <KPICard label="Reservation Revenue" value={'$'+resRevenue.toFixed(2)} sub={reportBy==='payment_date'?'payments received':'based on stay dates'}/>
              <KPICard label="Total Bookings" value={reservations.length.toString()} sub="active reservations"/>
              <KPICard label="Avg Stay" value={avgStay.toFixed(1)+' nights'} sub="per booking"/>
              <KPICard label="Cancelled" value={cancelledCount.toString()} sub="in this period"/>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              <div className="bg-white rounded-2xl border border-gray-200 p-5">
                <h2 className="text-lg font-semibold text-gray-900 mb-4">Revenue by Site Type</h2>
                <DonutChart data={siteTypeData}/>
              </div>
              <div className="bg-white rounded-2xl border border-gray-200 p-5">
                <h2 className="text-lg font-semibold text-gray-900 mb-4">Top Earning Sites</h2>
                {topSites.length===0?<p className="text-gray-400 text-center py-8">No data</p>:(
                  <div className="space-y-3">
                    {topSites.map((site,i)=>(
                      <div key={i} className="flex items-center justify-between">
                        <div className="flex items-center gap-3">
                          <span className="w-6 h-6 rounded-full bg-gray-100 text-gray-600 text-xs flex items-center justify-center font-medium">{i+1}</span>
                          <span className="text-sm font-medium text-gray-900">Site {site.name}</span>
                        </div>
                        <div className="text-right">
                          <p className="text-sm font-semibold text-gray-900">${site.revenue.toFixed(2)}</p>
                          <p className="text-xs text-gray-400">{site.bookings} booking{site.bookings!==1?'s':''}</p>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>

            {cancelledReservations.length > 0 && (
              <div className="bg-white rounded-2xl border border-amber-200 p-5">
                <div className="flex items-center justify-between mb-4">
                  <div>
                    <h2 className="text-lg font-semibold text-gray-900">Cancellations</h2>
                    <p className="text-xs text-gray-400 mt-0.5">Cancelled reservations in this period · not included in revenue</p>
                  </div>
                  <div className="text-right">
                    <p className="text-sm font-bold text-amber-600">{cancelledReservations.length} cancelled</p>
                    <p className="text-xs text-gray-400">${(cancelledReservations.reduce((s,r)=>s+(r.total_price||0),0)/100).toFixed(2)} total value</p>
                  </div>
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full text-sm" style={{minWidth:'520px'}}>
                    <thead>
                      <tr className="border-b border-gray-100">
                        {['Guest','Site','Arrival','Departure','Nights','Value'].map(h=>(
                          <th key={h} className={`py-2 text-gray-500 font-semibold text-xs uppercase tracking-wide ${h==='Value'?'text-right':'text-left'}`}>{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {cancelledReservations.map(r=>{
                        const nights=Math.round((new Date(r.departure_date).getTime()-new Date(r.arrival_date).getTime())/86400000)
                        return (
                          <tr key={r.id} className="border-b border-gray-50 hover:bg-amber-50 cursor-pointer" onClick={()=>{setSelectedCancelled(r);setConfirmDelete(false)}}>
                            <td className="py-2.5 font-medium text-gray-700">{r.guest_name||'—'}</td>
                            <td className="py-2.5 text-gray-500">{(r.sites as any)?.site_number||'—'}</td>
                            <td className="py-2.5 text-gray-500">{r.arrival_date}</td>
                            <td className="py-2.5 text-gray-500">{r.departure_date}</td>
                            <td className="py-2.5 text-gray-500">{nights}</td>
                            <td className="py-2.5 text-right font-semibold text-amber-600">${((r.total_price||0)/100).toFixed(2)}</td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            <div className="bg-white rounded-2xl border border-gray-200 p-5">
              <h2 className="text-lg font-semibold text-gray-900 mb-4">Reservations</h2>
              <div className="overflow-x-auto">
                <table className="w-full text-sm" style={{minWidth:'520px'}}>
                  <thead>
                    <tr className="border-b border-gray-100">
                      {['Guest','Site','Arrival','Departure','Nights','Total'].map(h=>(
                        <th key={h} className={`py-2 text-gray-500 font-semibold text-xs uppercase tracking-wide ${h==='Total'?'text-right':'text-left'}`}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {reservations.map(r=>{
                      const nights=Math.round((new Date(r.departure_date).getTime()-new Date(r.arrival_date).getTime())/86400000)
                      return (
                        <tr key={r.id} className="border-b border-gray-50 hover:bg-gray-50 cursor-pointer" onClick={()=>router.push(`/admin/reservations/${r.id}`)}>
                          <td className="py-2.5 font-medium text-gray-900">{r.guest_name||'—'}</td>
                          <td className="py-2.5 text-gray-600">{(r.sites as any)?.site_number||'—'}</td>
                          <td className="py-2.5 text-gray-600">{r.arrival_date}</td>
                          <td className="py-2.5 text-gray-600">{r.departure_date}</td>
                          <td className="py-2.5 text-gray-600">{nights}</td>
                          <td className="py-2.5 text-right font-semibold text-gray-900">${((r.total_price||0)/100).toFixed(2)}</td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        )}

        {/* ── SEASONAL TAB ── */}
        {activeTab==='seasonal'&&(
          <div className="space-y-6">
            <SourceChip source="seasonal" note="seasonal campers, split into their money lanes"/>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              <KPICard label="Active Seasonals" value={seasonalCampers.length.toString()} sub="registered this season"/>
              <KPICard label="Campers Owe" value={'$'+outstandingBalance.toFixed(2)} sub={overdueCampers.length+' with a balance'} color={outstandingBalance>0?'text-red-600':'text-emerald-600'} highlight={outstandingBalance>0}/>
              {/* Newly reachable. The per-camper balance used to be clamped at zero, so a camper
                  holding a credit read as "current" and this figure was permanently $0.00. */}
              <KPICard label="Credit on Account" value={'$'+creditBalance.toFixed(2)} sub={creditCampers.length+' paid ahead'} color={creditBalance>0?'text-blue-600':undefined}/>
              <KPICard label="Charges This Period" value={'$'+seasonalRevenue.toFixed(2)} sub="all lanes"/>
            </div>

            {/* ── WHERE THE MONEY SITS — the lane view, answer first ──────────────────────── */}
            <div className="bg-white rounded-2xl border border-gray-200 p-5">
              <h2 className="text-lg font-semibold text-gray-900">Where seasonal campers&rsquo; money sits</h2>
              <p className="text-2xl md:text-3xl font-bold mt-2 text-gray-900">
                {outstandingBalance>0
                  ? <>Campers owe <span className="text-red-600">${outstandingBalance.toFixed(2)}</span>.</>
                  : <span className="text-emerald-600">Every seasonal camper is paid up.</span>}
              </p>
              <p className="text-sm text-gray-500 mt-1">
                {overdueCampers.length} of {seasonalCampers.length} account{seasonalCampers.length!==1?'s':''} {overdueCampers.length===1?'has':'have'} a balance
                {creditBalance>0&&<> · {creditCampers.length} {creditCampers.length===1?'is':'are'} paid ahead by <span className="text-blue-600 font-semibold">${creditBalance.toFixed(2)}</span></>}
              </p>

              {seasonalCampers.length===0?(
                <p className="text-gray-400 text-sm py-6">No seasonal campers found</p>
              ):(<>
                <p className="text-sm text-gray-500 mt-5 mb-2">Broken down by what the money is <span className="font-semibold text-gray-700">for</span> — the same three lanes a camper sees on their own account:</p>
                <div className="overflow-x-auto">
                  <table className="w-full text-sm" style={{minWidth:'480px'}}>
                    <thead>
                      <tr className="border-b border-gray-100">
                        <th className="py-2 text-left text-gray-500 font-semibold text-xs uppercase tracking-wide">Lane</th>
                        <th className="py-2 text-right text-gray-500 font-semibold text-xs uppercase tracking-wide">Charged</th>
                        <th className="py-2 text-right text-gray-500 font-semibold text-xs uppercase tracking-wide">Paid to this lane</th>
                        <th className="py-2 text-right text-gray-500 font-semibold text-xs uppercase tracking-wide">Still owed</th>
                      </tr>
                    </thead>
                    <tbody>
                      {shownLanes.map(lane=>{
                        const t = laneRollup.byLane[lane]
                        return (
                          <tr key={lane} className="border-b border-gray-50">
                            <td className="py-2.5 font-medium text-gray-900"><LaneSwatch lane={lane}/></td>
                            <td className="py-2.5 text-right text-gray-700">{money(t.charges)}</td>
                            <td className="py-2.5 text-right text-gray-700">{money(t.payments)}</td>
                            <td className={`py-2.5 text-right font-semibold ${balanceClass(t.balance)}`}>{balanceText(t.balance)}</td>
                          </tr>
                        )
                      })}
                      {/* ⚠ THE HONEST LINE, AND THE REASON THE TABLE ADDS UP. A payment taken
                          before lanes existed names no lane, and this app never guesses one for
                          it — doing so would rewrite a park's financial history. It pays down
                          the ACCOUNT, so it is subtracted once, here, rather than spread across
                          lanes that did not receive it. */}
                      {laneRollup.untaggedPayments!==0&&(
                        <tr className="border-b border-gray-50">
                          <td className="py-2.5 text-gray-500">
                            <span className="inline-flex items-center gap-2">
                              <span className="w-3 h-3 rounded-sm shrink-0 border border-gray-300" aria-hidden="true"/>
                              Paid against the account, not one lane
                            </span>
                          </td>
                          <td className="py-2.5 text-right text-gray-400">—</td>
                          <td className="py-2.5 text-right text-gray-700">{money(laneRollup.untaggedPayments)}</td>
                          <td className={`py-2.5 text-right font-semibold ${balanceClass(-laneRollup.untaggedPayments)}`}>{balanceText(-laneRollup.untaggedPayments)}</td>
                        </tr>
                      )}
                      <tr className="border-t-2 border-gray-200">
                        <td className="py-2.5 font-bold text-gray-900">Net across all seasonal accounts</td>
                        <td className="py-2.5 text-right font-bold text-gray-900">{money(laneRollup.totalCharges)}</td>
                        <td className="py-2.5 text-right font-bold text-gray-900">{money(laneRollup.totalPayments)}</td>
                        <td className={`py-2.5 text-right font-bold ${balanceClass(laneRollup.netBalance)}`}>{balanceText(laneRollup.netBalance)}</td>
                      </tr>
                    </tbody>
                  </table>
                </div>
                <p className="text-xs text-gray-400 mt-3">
                  The net figure is the sum of every seasonal camper&rsquo;s folio balance, to the cent — canceled charges
                  excluded, exactly as their folio excludes them. It is <span className="font-semibold text-gray-500">${netSeasonalBalance.toFixed(2)}</span>, which is
                  what is owed (${outstandingBalance.toFixed(2)}) less what is held in credit (${creditBalance.toFixed(2)}).
                </p>
              </>)}
            </div>

            {/* ── COLLECTED IN THE PERIOD, BY LANE ────────────────────────────────────────── */}
            {laneCollected.total!==0&&(
              <div className="bg-white rounded-2xl border border-gray-200 p-5">
                <h2 className="text-lg font-semibold text-gray-900">Collected from seasonal campers this period</h2>
                <p className="text-2xl md:text-3xl font-bold mt-2 text-emerald-600">${(laneCollected.total/100).toFixed(2)}</p>
                <p className="text-sm text-gray-500 mt-1">Net of the card surcharge, the same way a folio counts a payment.</p>
                <div className="space-y-3 mt-4">
                  {LANES.filter(l=>laneCollected.byLane[l]!==0).map(l=>{
                    const pct = laneCollected.total>0?Math.round((laneCollected.byLane[l]/laneCollected.total)*100):0
                    return (
                      <div key={l}>
                        <div className="flex justify-between text-sm mb-1">
                          <span className="font-medium text-gray-700"><LaneSwatch lane={l}/></span>
                          <span className="font-semibold text-gray-900">{money(laneCollected.byLane[l])} <span className="text-gray-400 font-normal">({pct}%)</span></span>
                        </div>
                        <div className="h-2 bg-gray-100 rounded-full overflow-hidden">
                          <div className="h-full rounded-full" style={{width:pct+'%',backgroundColor:LANE_COLOR[l]}}/>
                        </div>
                      </div>
                    )
                  })}
                  {laneCollected.untagged!==0&&(
                    <div>
                      <div className="flex justify-between text-sm mb-1">
                        <span className="font-medium text-gray-500">Not filed against a lane</span>
                        <span className="font-semibold text-gray-900">{money(laneCollected.untagged)} <span className="text-gray-400 font-normal">({laneCollected.total>0?Math.round((laneCollected.untagged/laneCollected.total)*100):0}%)</span></span>
                      </div>
                      <div className="h-2 bg-gray-100 rounded-full overflow-hidden">
                        <div className="h-full rounded-full bg-gray-300" style={{width:(laneCollected.total>0?Math.round((laneCollected.untagged/laneCollected.total)*100):0)+'%'}}/>
                      </div>
                      <p className="text-xs text-gray-400 mt-1">These paid down the whole account. A payment can be filed to a lane from the camper&rsquo;s folio.</p>
                    </div>
                  )}
                </div>
              </div>
            )}

            {seasonalLaneChargeData.length>0&&(
              <div className="bg-white rounded-2xl border border-gray-200 p-5">
                <h2 className="text-lg font-semibold text-gray-900 mb-1">Charges this period, by lane</h2>
                <p className="text-xs text-gray-400 mb-4">What was billed to seasonal campers between {getDateBounds(dateRange,customStart,customEnd).start} and {getDateBounds(dateRange,customStart,customEnd).end}</p>
                <DonutChart data={seasonalLaneChargeData}/>
              </div>
            )}

            <div className="bg-white rounded-2xl border border-gray-200 overflow-hidden">
              <div className="px-5 py-4 border-b border-gray-100 flex items-center justify-between">
                <h2 className="text-lg font-semibold text-gray-900">Seasonal Campers</h2>
                <span className="text-sm text-gray-400">{overdueCampers.length} with balance · {seasonalCampers.length-overdueCampers.length} current</span>
              </div>
              {seasonalCampers.length===0?(
                <div className="p-8 text-center text-gray-400">No seasonal campers found</div>
              ):(
                <div>
                  <div className="grid grid-cols-12 gap-2 px-5 py-2 bg-gray-50 border-b border-gray-100 text-xs font-semibold text-gray-500 uppercase tracking-wide">
                    <div className="col-span-5">Camper</div>
                    <div className="col-span-2">Site</div>
                    <div className="col-span-3">Email</div>
                    <div className="col-span-2 text-right">Balance</div>
                  </div>
                  {[...seasonalCampers].sort((a,b)=>b.balance-a.balance).map(c=>(
                    <div key={c.id} onClick={()=>c.folioId&&router.push(`/admin/folio/${c.folioId}`)}
                      className={`grid grid-cols-12 gap-2 px-5 py-3 border-b border-gray-50 hover:bg-gray-50 cursor-pointer items-center ${c.balance>0?'bg-red-50/30':''}`}>
                      <div className="col-span-5 min-w-0">
                        <div className="font-medium text-gray-900 text-sm truncate">{c.name}</div>
                        {/* This camper's own three-lane split. Same classifier, same colours and
                            same words as the roll-up above and as their folio — so an owner can
                            read one row and open the folio without re-learning anything. Lanes
                            with no activity are left out rather than printed as $0.00. */}
                        <div className="flex flex-wrap gap-x-3 gap-y-1 mt-1">
                          {SEASONAL_CAMPER_LANES.filter(l=>c.lanes.byLane[l].charges!==0||c.lanes.byLane[l].payments!==0).map(l=>(
                            <span key={l} className="inline-flex items-center gap-1.5 text-xs text-gray-500">
                              <span className="w-2 h-2 rounded-sm shrink-0" style={{backgroundColor:LANE_COLOR[l]}} aria-hidden="true"/>
                              {LANE_LABEL[l]} <span className={`font-semibold ${balanceClass(c.lanes.byLane[l].balance)}`}>{balanceText(c.lanes.byLane[l].balance)}</span>
                            </span>
                          ))}
                          {c.lanes.untaggedPayments!==0&&(
                            <span className="inline-flex items-center gap-1.5 text-xs text-gray-400">
                              <span className="w-2 h-2 rounded-sm shrink-0 border border-gray-300" aria-hidden="true"/>
                              On account <span className={`font-semibold ${balanceClass(-c.lanes.untaggedPayments)}`}>{balanceText(-c.lanes.untaggedPayments)}</span>
                            </span>
                          )}
                        </div>
                      </div>
                      <div className="col-span-2 text-gray-600 text-sm">{c.site_number}</div>
                      <div className="col-span-3 text-gray-400 text-xs truncate">{c.email}</div>
                      <div className="col-span-2 text-right">
                        <span className={`text-sm font-bold ${balanceClass(c.balance)}`}>
                          {c.balance===0?'✓ Current':balanceText(c.balance)}
                        </span>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}

        {/* ── TRANSACTIONS TAB ── */}
        {activeTab==='transactions'&&(
          <div className="space-y-4">
            {/* Search bar */}
            <div className="bg-white rounded-2xl border border-gray-200 p-4">
              <div className="flex flex-wrap gap-3 items-center">
                <input type="text" placeholder="Search guest name..." className="border border-gray-200 rounded-lg px-3 py-2 text-sm flex-1 min-w-40" value={txSearch} onChange={e=>setTxSearch(e.target.value)}/>
                <select className="border border-gray-200 rounded-lg px-3 py-2 text-sm bg-white" value={txMethodFilter} onChange={e=>setTxMethodFilter(e.target.value)}>
                  <option value="all">All Methods</option>
                  {methods.map(m=><option key={m} value={m}>{methodLabel(m)}</option>)}
                </select>
                <select className="border border-gray-200 rounded-lg px-3 py-2 text-sm bg-white" value={txTypeFilter} onChange={e=>setTxTypeFilter(e.target.value)}>
                  <option value="all">All Types</option>
                  <option value="reservation">Reservation</option>
                  <option value="walkin">Walk-Up</option>
                </select>
                <input type="date" className="border border-gray-200 rounded-lg px-3 py-2 text-sm" value={txDateFrom} onChange={e=>setTxDateFrom(e.target.value)}/>
                <span className="text-gray-400 text-sm">to</span>
                <input type="date" className="border border-gray-200 rounded-lg px-3 py-2 text-sm" value={txDateTo} onChange={e=>setTxDateTo(e.target.value)}/>
                <span className="text-sm text-gray-400 whitespace-nowrap">{filteredTransactions.length} result{filteredTransactions.length!==1?'s':''}</span>
              </div>
            </div>

            {/* Summary */}
            <div className="grid grid-cols-2 gap-4" data-txcards>
              <style>{`@media (min-width: 768px) { [data-txcards] { grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)) !important; } }`}</style>
              <KPICard label="Total Collected" value={'$'+(filteredTransactions.reduce((s,t)=>s+t.amount,0)/100).toFixed(2)} sub="all methods"/>
              {methods.map(m=>(
                <KPICard key={m} label={methodLabel(m)} value={'$'+(filteredTransactions.filter(t=>t.method===m).reduce((s,t)=>s+t.amount,0)/100).toFixed(2)}/>
              ))}
            </div>

            {/* Transaction log */}
            <div className="bg-white rounded-2xl border border-gray-200 p-5">
              <h2 className="text-lg font-semibold text-gray-900 mb-4">Transaction Log</h2>
              {filteredTransactions.length===0?(
                <p className="text-gray-400 text-center py-8">No transactions found</p>
              ):(
                <div className="space-y-6">
                  {Object.entries(txByDay).map(([day,dayTx])=>{
                    const dayTotal=dayTx.reduce((s,t)=>s+t.amount,0)/100
                    return (
                      <div key={day}>
                        <div className="flex items-center justify-between mb-2 pb-1 border-b border-gray-100">
                          <span className="text-xs font-bold text-gray-500 uppercase tracking-wide">{day}</span>
                          <span className="text-xs font-semibold text-gray-700">${dayTotal.toFixed(2)}</span>
                        </div>
                        <div className="space-y-1">
                          {dayTx.map(t=>{
                            const timeStr=t.paid_at?new Date(t.paid_at).toLocaleTimeString('en-US',{hour:'numeric',minute:'2-digit'}):''
                            const isWalkup=t.folio_type==='walkin'||t.folio_type==='walkup'
                            const isBooking=t.is_reservation_payment
                            return (
                              <div key={t.id} onClick={()=>isBooking?router.push('/admin/reservations?id='+t.reservation_id):openTransaction(t as any)}
                                className="flex items-center justify-between py-2.5 px-3 rounded-xl hover:bg-blue-50 cursor-pointer border border-transparent hover:border-blue-100 transition-all">
                                <div className="flex items-center gap-3 min-w-0">
                                  <div className="w-2.5 h-2.5 rounded-full flex-shrink-0" style={{background:methodColor(t.method,customMethods)}}/>
                                  <div className="min-w-0">
                                    <div className="text-sm font-medium text-gray-900 truncate">
                                      {t.guest_name||'Walk-up Guest'}
                                      {isWalkup&&<span className="ml-2 text-xs text-blue-600 font-normal bg-blue-50 px-1.5 py-0.5 rounded">Walk-up</span>}
                                      {isBooking&&<span className="ml-2 text-xs text-emerald-600 font-normal bg-emerald-50 px-1.5 py-0.5 rounded">Online</span>}
                                    </div>
                                    <div className="text-xs text-gray-400">{timeStr} · {t.method}</div>
                                  </div>
                                </div>
                                <div className="flex items-center gap-3 flex-shrink-0 ml-3">
                                  <span className="text-sm font-semibold text-gray-900">${(t.amount/100).toFixed(2)}</span>
                                  <span className="text-xs text-blue-400">Details →</span>
                                </div>
                              </div>
                            )
                          })}
                        </div>
                      </div>
                    )
                  })}
                </div>
              )}
            </div>
          </div>
        )}

        {/* ── STORE TAB ── */}
        {activeTab==='store'&&posEnabled&&(
          <div className="space-y-6">
            <SourceChip source="store" note="walk-up sales; campers' store tabs sit on their folios"/>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              <KPICard label="Store Revenue" value={'$'+posRevenue.toFixed(2)} sub={posSales.length+' transactions'}/>
              <KPICard label="Avg Ticket" value={posSales.length>0?'$'+(posRevenue/posSales.length).toFixed(2):'—'} sub="per transaction"/>
              <KPICard label="Cash Sales" value={'$'+(posPayments.filter(t=>t.method==='cash').reduce((s,t)=>s+t.amount,0)/100).toFixed(2)}/>
              <KPICard label="Card Sales" value={'$'+(posPayments.filter(t=>t.method==='card').reduce((s,t)=>s+t.amount,0)/100).toFixed(2)}/>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              <div className="bg-white rounded-2xl border border-gray-200 p-5">
                <h2 className="text-lg font-semibold text-gray-900 mb-4">Sales by Category</h2>
                <DonutChart data={categoryData}/>
              </div>
              <div className="bg-white rounded-2xl border border-gray-200 p-5">
                <h2 className="text-lg font-semibold text-gray-900 mb-4">Top Products</h2>
                {topProducts.length===0?<p className="text-gray-400 text-center py-8">No data</p>:(
                  <div className="space-y-2">
                    {topProducts.map((p,i)=>(
                      <div key={i} className="flex items-center justify-between py-1">
                        <div className="flex items-center gap-3">
                          <span className="w-6 h-6 rounded-full bg-gray-100 text-gray-600 text-xs flex items-center justify-center font-medium">{i+1}</span>
                          <span className="text-sm font-medium text-gray-900">{p.name}</span>
                        </div>
                        <div className="text-right">
                          <p className="text-sm font-semibold text-gray-900">${p.revenue.toFixed(2)}</p>
                          <p className="text-xs text-gray-400">qty {p.qty}</p>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </div>
        )}

        </>
      )}

      {/* ── CANCELLED RESERVATION DETAIL PANEL ── */}
      {selectedCancelled&&(
        <>
          <div className="fixed inset-0 bg-black/40 z-40" onClick={()=>{setSelectedCancelled(null);setConfirmDelete(false)}}/>
          <div className="fixed right-0 top-0 h-full w-full max-w-md bg-white z-50 shadow-2xl flex flex-col overflow-hidden">
            <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100">
              <div>
                <h2 className="text-lg font-bold text-gray-900">Reservation Details</h2>
                <span className="inline-block mt-1 text-xs font-semibold bg-red-100 text-red-600 px-2 py-0.5 rounded-full">Cancelled</span>
              </div>
              <button onClick={()=>{setSelectedCancelled(null);setConfirmDelete(false)}} className="w-8 h-8 rounded-full bg-gray-100 flex items-center justify-center text-gray-500 hover:bg-gray-200 font-bold text-lg">×</button>
            </div>
            <div className="flex-1 overflow-y-auto p-6 space-y-4">
              {[
                {label:'Guest', value:selectedCancelled.guest_name},
                {label:'Email', value:selectedCancelled.guest_email||'—'},
                {label:'Site', value:(selectedCancelled.sites as any)?.site_number||'—'},
                {label:'Dates', value:selectedCancelled.arrival_date+' → '+selectedCancelled.departure_date+' ('+Math.round((new Date(selectedCancelled.departure_date).getTime()-new Date(selectedCancelled.arrival_date).getTime())/86400000)+' nights)'},
                {label:'Total Value', value:'$'+((selectedCancelled.total_price||0)/100).toFixed(2)},
              ].map(({label,value})=>(
                <div key={label} className="border-b border-gray-50 pb-3">
                  <p className="text-xs text-gray-500 mb-0.5">{label}</p>
                  <p className="text-sm font-medium text-gray-900">{value}</p>
                </div>
              ))}

              <div className="bg-amber-50 border border-amber-200 rounded-xl p-4">
                <p className="text-xs font-semibold text-amber-700 uppercase tracking-wide mb-1">Status</p>
                {/* The stay is excluded from occupancy, but its MONEY is not excluded from
                    revenue — revenue follows the payment rows, so anything refunded nets
                    itself out and anything kept stays counted. Saying it was "not included in
                    revenue totals" was true only while cancelled bookings were filtered out,
                    which double-counted every refund. */}
                <p className="text-sm text-amber-800">
                  This reservation was cancelled and is excluded from occupancy. Any payment
                  taken on it still counts as revenue until it is refunded — a refund nets
                  itself out, so what remains in revenue is what the business kept.
                </p>
              </div>

              {!confirmDelete ? (
                <button onClick={()=>setConfirmDelete(true)}
                  className="w-full py-3 rounded-xl border-2 border-red-200 text-red-600 font-semibold text-sm hover:bg-red-50 transition-colors">
                  🗑 Permanently Delete This Reservation
                </button>
              ) : (
                <div className="bg-red-50 border border-red-200 rounded-xl p-4">
                  <p className="text-sm font-bold text-red-700 mb-1">Are you sure?</p>
                  <p className="text-xs text-red-600 mb-4">This cannot be undone. The reservation will be permanently removed from the database.</p>
                  <div className="flex gap-3">
                    <button onClick={()=>deleteCancelledReservation(selectedCancelled.id)} disabled={deleting}
                      className="flex-1 py-2.5 rounded-lg bg-red-600 text-white font-bold text-sm hover:bg-red-700 transition-colors">
                      {deleting?'Deleting...':'Yes, Delete Permanently'}
                    </button>
                    <button onClick={()=>setConfirmDelete(false)}
                      className="flex-1 py-2.5 rounded-lg border border-gray-200 text-gray-600 font-semibold text-sm hover:bg-gray-50 transition-colors">
                      Cancel
                    </button>
                  </div>
                </div>
              )}
            </div>
          </div>
        </>
      )}

      {/* ── OCCUPANCY DETAIL PANEL ── */}
      {showOccupancyDetail&&(
        <>
          <div className="fixed inset-0 bg-black/40 z-40" onClick={()=>setShowOccupancyDetail(false)}/>
          <div className="fixed right-0 top-0 h-full w-full max-w-2xl bg-white z-50 shadow-2xl flex flex-col overflow-hidden">
            <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100">
              <div>
                <h2 className="text-lg font-bold text-gray-900">Occupancy Detail</h2>
                <p className="text-xs text-gray-400 mt-0.5">Monthly breakdown — sites & cabins</p>
              </div>
              <button onClick={()=>setShowOccupancyDetail(false)} className="w-8 h-8 rounded-full bg-gray-100 flex items-center justify-center text-gray-500 hover:bg-gray-200 font-bold text-lg">×</button>
            </div>
            <div className="flex-1 overflow-y-auto p-6">
              {/* Tonight summary */}
              <div className="grid grid-cols-3 gap-4 mb-6">
                <div className="bg-blue-50 rounded-xl p-4 text-center">
                  <p className="text-xs text-blue-600 font-semibold uppercase tracking-wide mb-1">Tonight — Sites</p>
                  <p className="text-2xl font-bold text-blue-700">{Math.min(100,Math.round(((tonightCount+seasonalCount)/totalSites)*100))}%</p>
                  <p className="text-xs text-blue-500 mt-1">{tonightCount+seasonalCount} of {totalSites}</p>
                  <p className="text-xs text-blue-400">{seasonalCount} seasonal · {tonightCount} transient</p>
                </div>
                <div className="bg-amber-50 rounded-xl p-4 text-center">
                  <p className="text-xs text-amber-600 font-semibold uppercase tracking-wide mb-1">Tonight — Cabins</p>
                  <p className="text-2xl font-bold text-amber-700">{totalCabins>0?Math.round((tonightCabins/totalCabins)*100):0}%</p>
                  <p className="text-xs text-amber-500 mt-1">{tonightCabins} of {totalCabins}</p>
                </div>
                <div className="bg-emerald-50 rounded-xl p-4 text-center">
                  <p className="text-xs text-emerald-600 font-semibold uppercase tracking-wide mb-1">Combined</p>
                  <p className="text-2xl font-bold text-emerald-700">{Math.round(((tonightCount+seasonalCount+tonightCabins)/(totalSites+totalCabins))*100)}%</p>
                  <p className="text-xs text-emerald-500 mt-1">{tonightCount+seasonalCount+tonightCabins} of {totalSites+totalCabins}</p>
                </div>
              </div>

              {/* Monthly breakdown table */}
              <h3 className="text-sm font-bold text-gray-700 uppercase tracking-wide mb-3">Monthly Breakdown ({new Date().getFullYear()})</h3>
              <div className="bg-white border border-gray-200 rounded-xl overflow-hidden mb-6">
                <div className="grid grid-cols-5 gap-2 px-4 py-2 bg-gray-50 border-b border-gray-100 text-xs font-bold text-gray-500 uppercase tracking-wide">
                  <div>Month</div>
                  <div className="text-right">Site Occ%</div>
                  <div className="text-right">Cabin Occ%</div>
                  <div className="text-right">Seasonal</div>
                  <div className="text-right">Combined</div>
                </div>
                {monthlyOccupancy.map((m,i)=>{
                  const combined = Math.round(((m.sites/100*totalSites + m.cabins/100*totalCabins)/(totalSites+totalCabins))*100)
                  const isFuture = i > new Date().getMonth()
                  return (
                    <div key={i} className={`grid grid-cols-5 gap-2 px-4 py-3 border-b border-gray-50 ${isFuture?'bg-blue-50/30':''}`}>
                      <div className="text-sm font-semibold text-gray-900 flex items-center gap-2">
                        {m.label}
                        {isFuture&&<span className="text-xs text-blue-400 font-normal">future</span>}
                      </div>
                      <div className="text-right">
                        <span className={`text-sm font-bold ${m.sites>80?'text-emerald-600':m.sites>50?'text-amber-600':'text-gray-700'}`}>{m.sites}%</span>
                        <div className="h-1.5 bg-gray-100 rounded-full mt-1 overflow-hidden"><div className="h-full bg-blue-400 rounded-full" style={{width:m.sites+'%'}}/></div>
                      </div>
                      <div className="text-right">
                        <span className={`text-sm font-bold ${m.cabins>80?'text-emerald-600':m.cabins>50?'text-amber-600':'text-gray-700'}`}>{m.cabins}%</span>
                        <div className="h-1.5 bg-gray-100 rounded-full mt-1 overflow-hidden"><div className="h-full bg-amber-400 rounded-full" style={{width:m.cabins+'%'}}/></div>
                      </div>
                      <div className="text-right text-sm text-gray-500">{i>=4&&i<=9?seasonalCount:0}</div>
                      <div className="text-right">
                        <span className={`text-sm font-bold ${combined>80?'text-emerald-600':combined>50?'text-amber-600':'text-gray-700'}`}>{combined}%</span>
                      </div>
                    </div>
                  )
                })}
              </div>

              <p className="text-xs text-gray-400 text-center">Future months show projected occupancy based on confirmed bookings already in the system.</p>
            </div>
          </div>
        </>
      )}

      {/* ── TRANSACTION SLIDE-OUT PANEL ── */}
      {selectedTx&&(
        <>
          <div className="fixed inset-0 bg-black/40 z-40" onClick={()=>{setSelectedTx(null);setRefundTarget(null)}}/>
          <div className="fixed right-0 top-0 h-full w-full max-w-lg bg-white z-50 shadow-2xl flex flex-col overflow-hidden">
            {/* Panel header */}
            <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100 bg-white">
              <div>
                <h2 className="text-lg font-bold text-gray-900">{(selectedTx as any).guest_name||(selectedTx.folios as any)?.guest_name||'Walk-up Guest'}</h2>
                <p className="text-xs text-gray-400 mt-0.5">
                  {selectedTx.paid_at?new Date(selectedTx.paid_at).toLocaleDateString('en-US',{weekday:'short',month:'short',day:'numeric',year:'numeric',hour:'numeric',minute:'2-digit'}):''} · {selectedTx.method}
                </p>
              </div>
              <div className="flex items-center gap-3">
                <button onClick={()=>router.push(`/admin/folio/${selectedTx.folio_id}`)} className="text-xs text-blue-600 font-semibold hover:underline">Open Full Folio →</button>
                <button onClick={()=>{setSelectedTx(null);setRefundTarget(null)}} className="w-8 h-8 rounded-full bg-gray-100 flex items-center justify-center text-gray-500 hover:bg-gray-200 font-bold text-lg">×</button>
              </div>
            </div>

            <div className="flex-1 overflow-y-auto p-6 space-y-5">
              {txFolioLoading?(
                <div className="text-center text-gray-400 py-12">Loading details...</div>
              ):(
                <>
                  {/* Line items */}
                  <div>
                    <h3 className="text-xs font-bold text-gray-500 uppercase tracking-wide mb-3">Charges</h3>
                    <div className="bg-gray-50 rounded-xl overflow-hidden border border-gray-100">
                      {txFolioItems.filter(notVoided).length===0?(
                        <p className="text-gray-400 text-sm p-4">No line items</p>
                      ):(
                        <>
                          {txFolioItems.filter(notVoided).map((item,i,arr)=>(
                            <div key={item.id} className={`flex items-center justify-between px-4 py-3 ${i<arr.length-1?'border-b border-gray-100':''}`}>
                              <div>
                                <p className="text-sm font-medium text-gray-900">{item.description}{item.quantity>1?` ×${item.quantity}`:''}</p>
                                {item.tax_amount>0&&<p className="text-xs text-gray-400">incl. ${(item.tax_amount/100).toFixed(2)} tax</p>}
                                <p className="text-xs text-gray-400">{item.charged_at?new Date(item.charged_at).toLocaleDateString('en-US',{month:'short',day:'numeric'}):''}</p>
                              </div>
                              <span className="text-sm font-semibold text-gray-900">${(item.line_total/100).toFixed(2)}</span>
                            </div>
                          ))}
                          <div className="flex justify-between px-4 py-3 border-t border-gray-200 bg-white">
                            <span className="text-sm font-bold text-gray-900">Subtotal</span>
                            <span className="text-sm font-bold text-gray-900">${(txFolioItems.filter(notVoided).reduce((s,i)=>s+i.line_total,0)/100).toFixed(2)}</span>
                          </div>
                        </>
                      )}
                    </div>
                  </div>

                  {/* Payments */}
                  <div>
                    <h3 className="text-xs font-bold text-gray-500 uppercase tracking-wide mb-3">Payments</h3>
                    <div className="bg-gray-50 rounded-xl overflow-hidden border border-gray-100">
                      {txFolioPayments.length===0?(
                        <p className="text-gray-400 text-sm p-4">No payments</p>
                      ):(
                        txFolioPayments.map((p:any,i,arr)=>(
                          <div key={p.id} className={`px-4 py-3 ${i<arr.length-1?'border-b border-gray-100':''}`}>
                            <div className="flex items-center justify-between">
                              <div>
                                <div className="flex items-center gap-2">
                                  <div className="w-2 h-2 rounded-full" style={{background:methodColor(p.method,customMethods)}}/>
                                  <span className="text-sm font-medium text-gray-900 capitalize">{p.method}</span>
                                  {p.status==='refunded'&&<span className="text-xs bg-red-100 text-red-600 px-1.5 py-0.5 rounded font-semibold">Refunded</span>}
                                  {p.status==='partially_refunded'&&<span className="text-xs bg-amber-100 text-amber-600 px-1.5 py-0.5 rounded font-semibold">Partial Refund</span>}
                                </div>
                                {p.note&&<p className="text-xs text-gray-400 mt-0.5 ml-4">{p.note}</p>}
                                <p className="text-xs text-gray-400 ml-4">{p.paid_at?new Date(p.paid_at).toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'}):''}</p>
                              </div>
                              <div className="flex items-center gap-2">
                                <span className={`text-sm font-bold ${p.status==='refunded'?'text-red-500':'text-emerald-600'}`}>
                                  {p.status==='refunded'?'':'-'}${(Math.abs(p.amount)/100).toFixed(2)}
                                </span>
                                {/* Gated on what is still refundable, not on the row reading
                                    'completed' — the same swap the folio ledger got, so a
                                    partially-refunded payment stops losing its button here too. */}
                                {folioPaymentRefundable(p, txFolioPayments).remainingCents>0&&(
                                  <button onClick={()=>openRefund(p)} className="text-xs border border-gray-200 rounded-lg px-2 py-1 text-gray-500 hover:bg-red-50 hover:text-red-600 hover:border-red-200 transition-colors font-semibold">
                                    Refund
                                  </button>
                                )}
                              </div>
                            </div>
                          </div>
                        ))
                      )}
                    </div>
                  </div>

                  {/* Balance summary */}
                  {(() => {
                    // `notVoided`, matching the charge list and subtotal directly above it and
                    // the folio this drawer is a window onto. Without it the drawer showed a
                    // list of charges and, underneath, a balance that included a charge the list
                    // had just excluded.
                    const chargesTotal = txFolioItems.filter(notVoided).reduce((s,i)=>s+i.line_total,0)
                    // REFUNDABLE_STATUSES, matching the folio: 'completed' alone dropped both
                    // halves of a refund and overstated what was still due.
                    const paymentsTotal = txFolioPayments.filter((p:any)=>REFUNDABLE_STATUSES.includes(p.status)).reduce((s,p)=>s+p.amount-(p.surcharge_amount||0),0)
                    const balance = chargesTotal - paymentsTotal
                    return (
                      <div className={`rounded-xl p-4 flex items-center justify-between ${balance>0?'bg-red-50 border border-red-200':'bg-emerald-50 border border-emerald-200'}`}>
                        <span className={`font-bold text-sm ${balance>0?'text-red-700':'text-emerald-700'}`}>
                          {balance>0?'Balance Due':'✓ Paid in Full'}
                        </span>
                        <span className={`font-bold text-lg ${balance>0?'text-red-700':'text-emerald-700'}`}>
                          {balance>0?'$'+(balance/100).toFixed(2):balance<0?'Credit: $'+(Math.abs(balance)/100).toFixed(2):'$0.00'}
                        </span>
                      </div>
                    )
                  })()}

                </>
              )}
            </div>
          </div>
        </>
      )}

      {/* The shared modal, in place of the inline panel this drawer used to carry. Mounted at
          the page root rather than inside the drawer so its overlay is not clipped by the
          drawer's own stacking context. */}
      <RefundModal
        target={refundTarget}
        onClose={() => setRefundTarget(null)}
        onRefunded={reloadTxFolioPayments}
      />
    </div>
  )
}
