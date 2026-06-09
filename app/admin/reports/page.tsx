'use client'
import { useEffect, useState, useRef } from 'react'
import { supabase } from '@/lib/supabase'
import { useRouter } from 'next/navigation'

type Reservation = {
  id: string
  arrival_date: string
  departure_date: string
  total_price: number
  status: string
  site_id: string
  guest_name: string
  guest_email: string
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
}
type SeasonalCamper = {
  id: string
  name: string
  email: string
  site_number: string
  folioId: string
  balance: number
}

const COLORS = ['#2E6B8A','#12c9e5','#C4873C','#2D6A4F','#9B59B6','#E74C3C']

export default function ReportsPage() {
  const router = useRouter()

  useEffect(() => {
    supabase.from('settings').select('plan, pos_enabled, seasonal_enabled').single().then(({ data }) => {
      if (data?.plan && !['ridgeline','summit'].includes(data.plan)) router.replace('/admin')
      if (data?.pos_enabled) setPosEnabled(true)
      if (data?.seasonal_enabled) setSeasonalEnabled(true)
    })
  }, [])

  const [activeTab, setActiveTab] = useState<'dashboard'|'reservations'|'seasonal'|'transactions'|'store'>('dashboard')
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
  const [lineItems, setLineItems] = useState<LineItemRow[]>([])
  const [guestAccountPayments, setGuestAccountPayments] = useState<PaymentRow[]>([])
  // Booking payments recorded on reservations (deposits / online), keyed by created_at.
  // Disjoint from folio_payments, so safe to add to payment-date revenue.
  const [bookingPaymentsTotal, setBookingPaymentsTotal] = useState(0)
  const [guestAccountLineItems, setGuestAccountLineItems] = useState<LineItemRow[]>([])
  const [seasonalCampers, setSeasonalCampers] = useState<SeasonalCamper[]>([])
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
  const [showRefund, setShowRefund] = useState(false)
  const [refundPayment, setRefundPayment] = useState<any>(null)
  const [refundAmount, setRefundAmount] = useState('')
  const [refundReason, setRefundReason] = useState('')
  const [refundError, setRefundError] = useState('')
  const [refundSuccess, setRefundSuccess] = useState(false)
  const [processingRefund, setProcessingRefund] = useState(false)

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
    if (range === 'today') { const d = now.toISOString().split('T')[0]; return { start: d, end: d } }
    if (range === 'this_week') {
      const day = now.getDay()
      const mon = new Date(now); mon.setDate(now.getDate() - day + (day === 0 ? -6 : 1))
      return { start: mon.toISOString().split('T')[0], end: now.toISOString().split('T')[0] }
    }
    if (range === 'this_month') return { start: new Date(now.getFullYear(), now.getMonth(), 1).toISOString().split('T')[0], end: now.toISOString().split('T')[0] }
    if (range === 'last_month') {
      const first = new Date(now.getFullYear(), now.getMonth() - 1, 1)
      const last = new Date(now.getFullYear(), now.getMonth(), 0)
      return { start: first.toISOString().split('T')[0], end: last.toISOString().split('T')[0] }
    }
    if (range === 'last_year') return { start: new Date(now.getFullYear()-1,0,1).toISOString().split('T')[0], end: new Date(now.getFullYear()-1,11,31).toISOString().split('T')[0] }
    return { start: new Date(now.getFullYear(),0,1).toISOString().split('T')[0], end: now.toISOString().split('T')[0] }
  }

  function getStayDateEnd(range: string, customE: string) {
    const now = new Date()
    if (range === 'custom' && customE) return customE
    if (range === 'this_month') return new Date(now.getFullYear(), now.getMonth()+1, 0).toISOString().split('T')[0]
    if (range === 'last_month') return new Date(now.getFullYear(), now.getMonth(), 0).toISOString().split('T')[0]
    if (range === 'this_year') return new Date(now.getFullYear(), 11, 31).toISOString().split('T')[0]
    if (range === 'last_year') return new Date(now.getFullYear()-1, 11, 31).toISOString().split('T')[0]
    if (range === 'this_week') {
      const day = now.getDay(); const sun = new Date(now); sun.setDate(now.getDate() + (day===0?0:7-day))
      return sun.toISOString().split('T')[0]
    }
    return now.toISOString().split('T')[0]
  }

  async function fetchAll() {
    setLoading(true)
    const { start, end } = getDateBounds(dateRange, customStart, customEnd)
    const startISO = start + 'T00:00:00.000Z'
    const endISO = end + 'T23:59:59.999Z'
    const stayEnd = getStayDateEnd(dateRange, customEnd)
    const today = new Date().toISOString().split('T')[0]

    // Load settings for total_sites and total_cabins
    const { data: settingsData } = await supabase.from('settings').select('total_sites, total_cabins').single()
    const configuredSites = settingsData?.total_sites || 84
    const configuredCabins = settingsData?.total_cabins || 3
    setTotalSites(configuredSites)
    setTotalCabins(configuredCabins)

    // Seasonal count (live)
    const { count: seasonalCount } = await supabase.from('guests').select('id', { count: 'exact', head: true }).eq('is_seasonal', true)
    setSeasonalCount(seasonalCount || 0)

    // Tonight occupancy — split cabins vs sites
    const { data: tonightRes } = await supabase.from('reservations').select('id, sites(site_type)').neq('status','cancelled').lte('arrival_date', today).gte('departure_date', today)
    const tonightCabinCount = (tonightRes||[]).filter((r:any)=>r.sites?.site_type==='cabin').length
    const tonightSiteCount = (tonightRes||[]).filter((r:any)=>r.sites?.site_type!=='cabin').length
    setTonightCount(tonightSiteCount)
    setTonightCabins(tonightCabinCount)

    // Future bookings
    const { count: futureRes } = await supabase.from('reservations').select('id', { count: 'exact', head: true }).neq('status','cancelled').gt('arrival_date', today)
    setFutureCount(futureRes || 0)

    // Monthly occupancy trend
    const { data: allRes } = await supabase.from('reservations').select('arrival_date, departure_date, sites(site_type)').neq('status','cancelled').gte('arrival_date', new Date(new Date().getFullYear(),0,1).toISOString().split('T')[0]).lte('arrival_date', new Date(new Date().getFullYear(),11,31).toISOString().split('T')[0])
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
    const { data: resData } = await supabase.from('reservations').select('id, arrival_date, departure_date, total_price, status, site_id, guest_name, guest_email, sites(site_number, site_type)').neq('status','cancelled').gte('arrival_date', start).lte('arrival_date', stayEnd).order('arrival_date')
    const { data: cancelledData, count: cancelCount } = await supabase
      .from('reservations')
      .select('id, arrival_date, departure_date, total_price, status, site_id, guest_name, guest_email, sites(site_number, site_type)')
      .eq('status','cancelled')
      .gte('arrival_date', start)
      .lte('arrival_date', stayEnd)
      .order('arrival_date')

    // Exclude guest_account folios
    const { data: allGaFolios } = await supabase.from('folios').select('id').eq('folio_type','guest_account')
    const allGaFolioIds = (allGaFolios||[]).map((f:any)=>f.id)

    // Fetch ALL payments (including guest_account) for complete picture
    const { data: allPmtData } = await supabase
      .from('folio_payments')
      .select('id, paid_at, method, amount, surcharge_amount, status, folio_id, square_payment_id, note, folios(id, guest_name, folio_type, reservation_id, guest_email)')
      .eq('status','completed')
      .gte('paid_at', startISO)
      .lte('paid_at', endISO)
      .order('paid_at', { ascending: false })
    const pmtData = allPmtData || []

    // Reservation booking payments (deposits / online) within the payment window.
    const { data: bookingPmts } = await supabase
      .from('reservations')
      .select('amount_paid, created_at')
      .gt('amount_paid', 0)
      .neq('status', 'cancelled')
      .gte('created_at', startISO)
      .lte('created_at', endISO)
    setBookingPaymentsTotal((bookingPmts || []).reduce((sum: number, r: any) => sum + (r.amount_paid || 0), 0))

    // Store line items — fetch ALL line items in date range, exclude guest_account folios
    const guestAccountFolioIdSet = new Set(allGaFolioIds)
    const { data: allLiData } = await supabase
      .from('folio_line_items')
      .select('id, folio_id, category, line_total, description, quantity, unit_price, tax_amount, charged_at')
      .gte('charged_at', start + 'T00:00:00')
      .lte('charged_at', end + 'T23:59:59')
    // Exclude electric billing and seasonal account charges — keep all real store/POS items
    const storeItems = (allLiData || []).filter((li: any) => {
      if (guestAccountFolioIdSet.has(li.folio_id)) return false
      // Exclude electric billing line items
      if (li.description && li.description.toLowerCase().includes('electric')) return false
      return true
    })
    setLineItems(storeItems as any)

    // Seasonal campers
    const { data: seasonalGuests } = await supabase.from('guests').select('id, name, email, site_number').eq('is_seasonal', true)
    const seasonalGuestIds = (seasonalGuests||[]).map((g:any)=>g.id)
    let gaFolioIds: string[] = []
    if (seasonalGuestIds.length > 0) {
      const { data: gaFolios } = await supabase.from('folios').select('id, guest_id').eq('folio_type','guest_account').in('guest_id', seasonalGuestIds)
      gaFolioIds = (gaFolios||[]).map((f:any)=>f.id)

      // Build seasonal camper balance list
      const camperList: SeasonalCamper[] = []
      for (const guest of (seasonalGuests||[])) {
        const guestFolios = (gaFolios||[]).filter((f:any)=>f.guest_id===guest.id)
        if (guestFolios.length === 0) { camperList.push({ id: guest.id, name: guest.name, email: guest.email, site_number: guest.site_number, folioId: '', balance: 0 }); continue }
        const folioId = guestFolios[0].id
        const [{ data: items }, { data: pmts }] = await Promise.all([
          supabase.from('folio_line_items').select('line_total').eq('folio_id', folioId),
          supabase.from('folio_payments').select('amount, surcharge_amount').eq('folio_id', folioId).eq('status','completed'),
        ])
        const itemsTotal = (items||[]).reduce((s:number,i:any)=>s+i.line_total,0)
        const paymentsTotal = (pmts||[]).reduce((s:number,p:any)=>s+p.amount-(p.surcharge_amount||0),0)
        const balance = Math.max(0, itemsTotal - paymentsTotal)
        camperList.push({ id: guest.id, name: guest.name, email: guest.email, site_number: guest.site_number, folioId, balance })
      }
      setSeasonalCampers(camperList)
    }

    let gaPmtData: any[] = []
    if (gaFolioIds.length > 0) {
      const { data: gaPmts } = await supabase.from('folio_payments').select('id, paid_at, method, amount, surcharge_amount, status, folio_id').eq('status','completed').gte('paid_at', startISO).lte('paid_at', endISO).in('folio_id', gaFolioIds)
      gaPmtData = gaPmts || []
      const { data: gaLiData } = await supabase.from('folio_line_items').select('id, folio_id, category, line_total, description, quantity, unit_price, tax_amount, charged_at').in('folio_id', gaFolioIds).gte('charged_at', startISO).lte('charged_at', endISO)
      setGuestAccountLineItems(gaLiData as any || [])
    } else { setGuestAccountLineItems([]) }

    if (resData) setReservations(resData as any)
    setCancelledCount(cancelledData?.length || 0)
    setCancelledReservations(cancelledData as any || [])
    // Split payments by type
    const typedPmtData = pmtData as any[]
    setResPayments(typedPmtData.filter((p:any)=>p.folios?.reservation_id!==null&&p.folios?.folio_type!=='guest_account'))
    setTransactions(typedPmtData)
    setGuestAccountPayments(typedPmtData.filter((p:any)=>p.folios?.folio_type==='guest_account'))
    setLoading(false)
  }

  async function openTransaction(tx: PaymentRow) {
    setSelectedTx(tx)
    setTxFolioLoading(true)
    setShowRefund(false)
    const [{ data: items }, { data: pmts }] = await Promise.all([
      supabase.from('folio_line_items').select('id, folio_id, description, quantity, unit_price, tax_amount, line_total, category, charged_at').eq('folio_id', tx.folio_id).order('charged_at'),
      supabase.from('folio_payments').select('*').eq('folio_id', tx.folio_id).order('paid_at'),
    ])
    setTxFolioItems(items as any || [])
    setTxFolioPayments(pmts as any || [])
    setTxFolioLoading(false)
  }

  function openRefund(payment: any) {
    const suggested = ((payment.amount - (payment.surcharge_amount||0)) / 100).toFixed(2)
    setRefundPayment(payment)
    setRefundAmount(suggested)
    setRefundReason('')
    setRefundError('')
    setRefundSuccess(false)
    setShowRefund(true)
  }

  async function processRefund() {
    if (!refundPayment || !refundAmount || !selectedTx) return
    setProcessingRefund(true)
    setRefundError('')
    const res = await fetch('/api/refund', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ paymentId: refundPayment.id, refundAmount: parseFloat(refundAmount), reason: refundReason, folioId: selectedTx.folio_id }),
    })
    const data = await res.json()
    setProcessingRefund(false)
    if (data.success) {
      setRefundSuccess(true)
      const { data: pmts } = await supabase.from('folio_payments').select('*').eq('folio_id', selectedTx.folio_id).order('paid_at')
      setTxFolioPayments(pmts as any || [])
      setTimeout(() => { setShowRefund(false); setRefundPayment(null); setRefundSuccess(false) }, 3000)
    } else { setRefundError(data.error || 'Refund failed. Please try again.') }
  }

  // ── Computed values ────────────────────────────────────────────────────────
  const stayDateRevenue = reservations.reduce((s,r)=>s+(r.total_price||0),0)/100
  // reservation payments only (non-guest-account, non-walkup)
  const paymentDateResRevenue = (resPayments.reduce((s,p)=>s+(p.amount||0)-(p.surcharge_amount||0),0) + bookingPaymentsTotal)/100
  const resRevenue = reportBy==='payment_date' ? paymentDateResRevenue : stayDateRevenue
  // POS = walkin + walkup folios only
  const posPayments = transactions.filter(t=>{const ft=(t.folios as any)?.folio_type; return ft==='walkin'||ft==='walkup'})
  const posRevenue = posPayments.reduce((s,p)=>s+(p.amount||0)-(p.surcharge_amount||0),0)/100
  // Seasonal = guest_account folios
  const electricLineItems = guestAccountLineItems.filter(li=>li.description.toLowerCase().includes('electric'))
  const otherGuestLineItems = guestAccountLineItems.filter(li=>!li.description.toLowerCase().includes('electric'))
  const electricRevenue = electricLineItems.reduce((s,li)=>s+(li.line_total||0),0)/100
  const otherGuestRevenue = otherGuestLineItems.reduce((s,li)=>s+(li.line_total||0),0)/100
  const seasonalPaymentsRevenue = guestAccountPayments.reduce((s,p)=>s+(p.amount||0)-(p.surcharge_amount||0),0)/100
  // Total = res + pos + seasonal (no double counting)
  const totalCombined = resRevenue + (posEnabled?posRevenue:0) + electricRevenue + otherGuestRevenue
  // All payments for method breakdown
  const allPayments = [...transactions]
  const totalCash = allPayments.filter(t=>t.method==='cash').reduce((s,t)=>s+t.amount,0)/100
  const totalCard = allPayments.filter(t=>t.method==='card').reduce((s,t)=>s+t.amount,0)/100
  const totalCheck = allPayments.filter(t=>t.method==='check').reduce((s,t)=>s+t.amount,0)/100
  const totalSurcharge = allPayments.reduce((s,t)=>s+(t.surcharge_amount||0),0)/100
  const outstandingBalance = seasonalCampers.reduce((s,c)=>s+Math.max(0,c.balance),0)/100
  const creditBalance = seasonalCampers.reduce((s,c)=>s+Math.abs(Math.min(0,c.balance)),0)/100
  const overdueCampers = seasonalCampers.filter(c=>c.balance>0)
  const creditCampers = seasonalCampers.filter(c=>c.balance<0)

  // Today's revenue
  const todayStr = new Date().toISOString().split('T')[0]
  const todayRevenue = allPayments.filter(t=>t.paid_at?.startsWith(todayStr)).reduce((s,t)=>s+(t.amount||0)-(t.surcharge_amount||0),0)/100

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
      monthlyMap[key].value += ((t.amount||0)-(t.surcharge_amount||0))/100
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

  // Transactions filtering
  const filteredTransactions = transactions.filter(t => {
    const folio = t.folios as any
    const matchSearch = txSearch===''||((folio?.guest_name||'').toLowerCase().includes(txSearch.toLowerCase()))
    const matchMethod = txMethodFilter==='all'||t.method===txMethodFilter
    const matchType = txTypeFilter==='all'||(txTypeFilter==='reservation'&&folio?.reservation_id!==null)||(txTypeFilter==='walkin'&&folio?.reservation_id===null)
    const matchDateFrom = !txDateFrom || (t.paid_at && t.paid_at >= txDateFrom)
    const matchDateTo = !txDateTo || (t.paid_at && t.paid_at <= txDateTo+'T23:59:59')
    return matchSearch&&matchMethod&&matchType&&matchDateFrom&&matchDateTo
  })
  const txByDay: { [day: string]: PaymentRow[] } = {}
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
  const guestCategoryMap: { [key: string]: number } = {}
  guestAccountLineItems.forEach(li => { const cat=li.description.toLowerCase().includes('electric')?'Electric':(li.category||'Other'); guestCategoryMap[cat]=(guestCategoryMap[cat]||0)+(li.line_total||0)/100 })
  const guestCategoryData = Object.entries(guestCategoryMap).map(([name,value])=>({name,value})).sort((a,b)=>b.value-a.value)

  // ── Chart Components ───────────────────────────────────────────────────────
  function BarChart({ data }: { data: { label: string; value: number }[] }) {
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
            return <g key={i}><rect x={x} y={y} width={barW} height={barH} fill="#2E6B8A" rx={4}/><text x={x+barW/2} y={chartH+22} textAnchor="middle" fontSize={10} fill="#6B7280">{d.label}</text><text x={x+barW/2} y={y-4} textAnchor="middle" fontSize={9} fill="#374151">${d.value>=1000?(d.value/1000).toFixed(1)+'k':d.value.toFixed(0)}</text></g>
          })}
        </svg>
      </div>
    )
  }

  function DonutChart({ data }: { data: { name: string; value: number }[] }) {
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
      return { path:`M ${x1} ${y1} A ${r} ${r} 0 ${large} 1 ${x2} ${y2} L ${ix2} ${iy2} A ${inner} ${inner} 0 ${large} 0 ${ix1} ${iy1} Z`, color:COLORS[i%COLORS.length], ...d }
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
          {key:'reservations',label:'🏕️ Reservations'},
          ...(seasonalEnabled ? [{key:'seasonal',label:'⛺ Seasonal'}] : []),
          {key:'transactions',label:'💳 Transactions'},
          ...(posEnabled?[{key:'store',label:'🛒 Store'}]:[]),
        ] as {key:string,label:string}[]).map(tab=>(
          <button key={tab.key} onClick={()=>setActiveTab(tab.key as any)}
            className="px-4 py-2.5 text-sm font-semibold whitespace-nowrap transition-colors rounded-t-lg"
            style={activeTab===tab.key?{backgroundColor:'#2E6B8A',color:'#fff',borderBottom:'2px solid #2E6B8A'}:{color:'#6B7280'}}>
            {tab.label}
          </button>
        ))}
      </div>

      {loading?<div className="p-12 text-center text-gray-400 text-lg">Loading reports...</div>:(
        <>

        {/* ── DASHBOARD TAB ── */}
        {activeTab==='dashboard'&&(
          <div className="space-y-6">
            {/* Hero KPIs */}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              <KPICard label="Today's Revenue" value={'$'+todayRevenue.toFixed(2)} sub="all payments today" color="text-emerald-600"/>
              <KPICard label="Total Revenue" value={'$'+totalCombined.toFixed(2)} sub={reportBy==='payment_date'?'payments received':'reservations + charges'}/>
              <KPICard label="Tonight's Occupancy" value={Math.min(100,Math.round(((tonightCount+seasonalCount)/totalSites)*100))+'%'} sub={(tonightCount+seasonalCount)+' of '+totalSites+' sites · '+tonightCabins+'/'+totalCabins+' cabins'} color={Math.round(((tonightCount+seasonalCount)/totalSites)*100)>80?'text-emerald-600':Math.round(((tonightCount+seasonalCount)/totalSites)*100)>50?'text-amber-600':'text-gray-900'} onClick={()=>setShowOccupancyDetail(true)}/>
              <KPICard label="Future Bookings" value={futureCount.toString()} sub="confirmed ahead" onClick={()=>setActiveTab('reservations')}/>
            </div>

            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              <KPICard label="Reservation Revenue" value={'$'+resRevenue.toFixed(2)} sub={reservations.length+' bookings'}/>
              {posEnabled&&<KPICard label="Store Revenue" value={'$'+posRevenue.toFixed(2)} sub={posPayments.length+' transactions'} onClick={()=>setActiveTab('store')}/>}
              <KPICard label="Seasonal Revenue" value={'$'+(electricRevenue+otherGuestRevenue).toFixed(2)} sub="electric + other charges"/>
              <KPICard label="Outstanding Balances" value={'$'+outstandingBalance.toFixed(2)} sub={overdueCampers.length+' camper'+(overdueCampers.length!==1?'s':'')+' with balance'} color={outstandingBalance>0?'text-red-600':'text-emerald-600'} highlight={outstandingBalance>0} onClick={()=>setActiveTab('seasonal')}/>
              <KPICard label="Card Surcharges" value={'$'+totalSurcharge.toFixed(2)} sub="collected this period"/>
            </div>

            {/* Revenue trend */}
            <div className="bg-white rounded-2xl border border-gray-200 p-5">
              <div className="flex items-center justify-between mb-4">
                <div>
                  <h2 className="text-lg font-semibold text-gray-900">{reportBy==='payment_date'?'Revenue by Payment Date':'Revenue by Stay Date'}</h2>
                  <p className="text-xs text-gray-400">{reportBy==='payment_date'?'When payments were received':'Attributed to arrival month'}</p>
                </div>
              </div>
              <BarChart data={monthlyData}/>
            </div>

            {/* Occupancy trend */}
            <div className="bg-white rounded-2xl border border-gray-200 p-5">
              <h2 className="text-lg font-semibold text-gray-900 mb-1">Occupancy Trend</h2>
              <p className="text-xs text-gray-400 mb-4">Monthly average occupancy % · Sites vs Cabins</p>
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
                      <rect x={x-14} y={10+(1-m.sites/100)*150} width={12} height={siteH} fill="#2E6B8A" rx={3}/>
                      <rect x={x+2} y={10+(1-m.cabins/100)*150} width={12} height={cabinH} fill="#C4873C" rx={3}/>
                      <text x={x} y={175} textAnchor="middle" fontSize={10} fill="#6B7280">{m.label}</text>
                    </g>
                  })}
                </svg>
                <div className="flex items-center gap-6 mt-2 justify-center">
                  <div className="flex items-center gap-1.5"><div className="w-3 h-3 rounded-sm" style={{background:'#2E6B8A'}}/><span className="text-xs text-gray-500">Sites ({totalSites})</span></div>
                  <div className="flex items-center gap-1.5"><div className="w-3 h-3 rounded-sm" style={{background:'#C4873C'}}/><span className="text-xs text-gray-500">Cabins ({totalCabins})</span></div>
                </div>
              </div>
            </div>

            {/* Payment methods + seasonal snapshot */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              <div className="bg-white rounded-2xl border border-gray-200 p-5">
                <h2 className="text-lg font-semibold text-gray-900 mb-4">Payment Methods</h2>
                <div className="space-y-3">
                  {[{label:'Cash',value:totalCash,color:'#f59e0b'},{label:'Card',value:totalCard,color:'#8b5cf6'},{label:'Check',value:totalCheck,color:'#6b7280'}].map(m=>{
                    const total=totalCash+totalCard+totalCheck
                    const pct=total>0?Math.round((m.value/total)*100):0
                    return (
                      <div key={m.label}>
                        <div className="flex justify-between text-sm mb-1">
                          <span className="font-medium text-gray-700">{m.label}</span>
                          <span className="font-semibold text-gray-900">${m.value.toFixed(2)} <span className="text-gray-400 font-normal">({pct}%)</span></span>
                        </div>
                        <div className="h-2 bg-gray-100 rounded-full overflow-hidden">
                          <div className="h-full rounded-full transition-all" style={{width:pct+'%',backgroundColor:m.color}}/>
                        </div>
                      </div>
                    )
                  })}
                </div>
              </div>

              {seasonalEnabled && <div className="bg-white rounded-2xl border border-gray-200 p-5">
                <div className="flex items-center justify-between mb-4">
                  <h2 className="text-lg font-semibold text-gray-900">Seasonal Snapshot</h2>
                  <button onClick={()=>setActiveTab('seasonal')} className="text-xs text-blue-500 font-semibold hover:underline">View all →</button>
                </div>
                {seasonalCampers.length===0?(
                  <p className="text-gray-400 text-sm text-center py-6">No seasonal campers found</p>
                ):(
                  <div className="space-y-2">
                    <div className="flex justify-between text-xs text-gray-500 font-semibold uppercase tracking-wide pb-1 border-b border-gray-100">
                      <span>Camper</span><span>Balance</span>
                    </div>
                    {seasonalCampers.slice(0,5).map(c=>(
                      <div key={c.id} onClick={()=>c.folioId&&router.push('/admin/guests')} className="flex items-center justify-between py-1 cursor-pointer hover:bg-gray-50 rounded px-1">
                        <div>
                          <span className="text-sm font-medium text-gray-900">{c.name}</span>
                          <span className="text-xs text-gray-400 ml-2">Site {c.site_number}</span>
                        </div>
                        <span className={`text-sm font-bold ${c.balance>0?'text-red-600':c.balance<0?'text-blue-600':'text-emerald-600'}`}>
                          {c.balance>0?'$'+(c.balance/100).toFixed(2):c.balance<0?'Credit: $'+(Math.abs(c.balance)/100).toFixed(2):'✓ Current'}
                        </span>
                      </div>
                    ))}
                    {seasonalCampers.length>5&&<p className="text-xs text-gray-400 text-center pt-1">+{seasonalCampers.length-5} more</p>}
                  </div>
                )}
              </div>}
            </div>
          </div>
        )}

        {/* ── RESERVATIONS TAB ── */}
        {activeTab==='reservations'&&(
          <div className="space-y-6">
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
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              <KPICard label="Active Seasonals" value={seasonalCampers.length.toString()} sub="registered this season"/>
              <KPICard label="Outstanding Balances" value={'$'+outstandingBalance.toFixed(2)} sub={overdueCampers.length+' with balance due'} color={outstandingBalance>0?'text-red-600':'text-emerald-600'} highlight={outstandingBalance>0}/>
              <KPICard label="Electric Revenue" value={'$'+electricRevenue.toFixed(2)} sub="this period"/>
              <KPICard label="Other Charges" value={'$'+otherGuestRevenue.toFixed(2)} sub="store + misc"/>
            </div>

            {guestCategoryData.length>0&&(
              <div className="bg-white rounded-2xl border border-gray-200 p-5">
                <h2 className="text-lg font-semibold text-gray-900 mb-4">Guest Account Revenue Breakdown</h2>
                <DonutChart data={guestCategoryData}/>
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
                      <div className="col-span-5 font-medium text-gray-900 text-sm">{c.name}</div>
                      <div className="col-span-2 text-gray-600 text-sm">{c.site_number}</div>
                      <div className="col-span-3 text-gray-400 text-xs truncate">{c.email}</div>
                      <div className="col-span-2 text-right">
                        <span className={`text-sm font-bold ${c.balance>0?'text-red-600':c.balance<0?'text-blue-600':'text-emerald-600'}`}>
                          {c.balance>0?'$'+(c.balance/100).toFixed(2):c.balance<0?'Credit: $'+(Math.abs(c.balance)/100).toFixed(2):'✓ Current'}
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
                  <option value="cash">Cash</option>
                  <option value="card">Card</option>
                  <option value="check">Check</option>
                  <option value="venmo">Venmo</option>
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
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              <KPICard label="Total Collected" value={'$'+(filteredTransactions.reduce((s,t)=>s+t.amount,0)/100).toFixed(2)} sub="all methods"/>
              <KPICard label="Cash" value={'$'+(filteredTransactions.filter(t=>t.method==='cash').reduce((s,t)=>s+t.amount,0)/100).toFixed(2)}/>
              <KPICard label="Card" value={'$'+(filteredTransactions.filter(t=>t.method==='card').reduce((s,t)=>s+t.amount,0)/100).toFixed(2)}/>
              <KPICard label="Check" value={'$'+(filteredTransactions.filter(t=>t.method==='check').reduce((s,t)=>s+t.amount,0)/100).toFixed(2)}/>
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
                            const folio=t.folios as any
                            const timeStr=t.paid_at?new Date(t.paid_at).toLocaleTimeString('en-US',{hour:'numeric',minute:'2-digit'}):''
                            const isWalkup=folio?.reservation_id===null
                            return (
                              <div key={t.id} onClick={()=>openTransaction(t)}
                                className="flex items-center justify-between py-2.5 px-3 rounded-xl hover:bg-blue-50 cursor-pointer border border-transparent hover:border-blue-100 transition-all">
                                <div className="flex items-center gap-3 min-w-0">
                                  <div className={`w-2.5 h-2.5 rounded-full flex-shrink-0 ${t.method==='cash'?'bg-amber-400':t.method==='card'?'bg-purple-400':t.method==='venmo'?'bg-blue-400':'bg-gray-400'}`}/>
                                  <div className="min-w-0">
                                    <div className="text-sm font-medium text-gray-900 truncate">
                                      {folio?.guest_name||'Walk-up Guest'}
                                      {isWalkup&&<span className="ml-2 text-xs text-blue-600 font-normal bg-blue-50 px-1.5 py-0.5 rounded">Walk-up</span>}
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
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              <KPICard label="Store Revenue" value={'$'+posRevenue.toFixed(2)} sub={posPayments.length+' transactions'}/>
              <KPICard label="Avg Ticket" value={posPayments.length>0?'$'+(posRevenue/posPayments.length).toFixed(2):'—'} sub="per transaction"/>
              <KPICard label="Cash Sales" value={'$'+(posPayments.filter(t=>t.method==='cash').reduce((s,t)=>s+(t.amount-(t.surcharge_amount||0)),0)/100).toFixed(2)}/>
              <KPICard label="Card Sales" value={'$'+(posPayments.filter(t=>t.method==='card').reduce((s,t)=>s+(t.amount-(t.surcharge_amount||0)),0)/100).toFixed(2)}/>
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
                <p className="text-sm text-amber-800">This reservation was cancelled and is not included in revenue totals.</p>
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
          <div className="fixed inset-0 bg-black/40 z-40" onClick={()=>{setSelectedTx(null);setShowRefund(false)}}/>
          <div className="fixed right-0 top-0 h-full w-full max-w-lg bg-white z-50 shadow-2xl flex flex-col overflow-hidden">
            {/* Panel header */}
            <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100 bg-white">
              <div>
                <h2 className="text-lg font-bold text-gray-900">{(selectedTx.folios as any)?.guest_name||'Walk-up Guest'}</h2>
                <p className="text-xs text-gray-400 mt-0.5">
                  {selectedTx.paid_at?new Date(selectedTx.paid_at).toLocaleDateString('en-US',{weekday:'short',month:'short',day:'numeric',year:'numeric',hour:'numeric',minute:'2-digit'}):''} · {selectedTx.method}
                </p>
              </div>
              <div className="flex items-center gap-3">
                <button onClick={()=>router.push(`/admin/folio/${selectedTx.folio_id}`)} className="text-xs text-blue-600 font-semibold hover:underline">Open Full Folio →</button>
                <button onClick={()=>{setSelectedTx(null);setShowRefund(false)}} className="w-8 h-8 rounded-full bg-gray-100 flex items-center justify-center text-gray-500 hover:bg-gray-200 font-bold text-lg">×</button>
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
                      {txFolioItems.filter(i=>!i.voided).length===0?(
                        <p className="text-gray-400 text-sm p-4">No line items</p>
                      ):(
                        <>
                          {txFolioItems.filter(i=>!i.voided).map((item,i,arr)=>(
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
                            <span className="text-sm font-bold text-gray-900">${(txFolioItems.filter(i=>!i.voided).reduce((s,i)=>s+i.line_total,0)/100).toFixed(2)}</span>
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
                                  <div className={`w-2 h-2 rounded-full ${p.method==='cash'?'bg-amber-400':p.method==='card'?'bg-purple-400':'bg-gray-400'}`}/>
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
                                {p.status==='completed'&&(
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
                    const chargesTotal = txFolioItems.reduce((s,i)=>s+i.line_total,0)
                    const paymentsTotal = txFolioPayments.filter((p:any)=>p.status==='completed').reduce((s,p)=>s+p.amount-(p.surcharge_amount||0),0)
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

                  {/* Refund panel */}
                  {showRefund&&refundPayment&&(
                    <div className="bg-red-50 border border-red-200 rounded-xl p-5">
                      <div className="flex items-center justify-between mb-4">
                        <h3 className="font-bold text-gray-900">Issue Refund</h3>
                        <button onClick={()=>setShowRefund(false)} className="text-gray-400 hover:text-gray-600 text-xl font-bold">×</button>
                      </div>
                      <div className="bg-white rounded-lg p-3 mb-4 border border-red-100">
                        <p className="text-xs text-gray-500">Original payment</p>
                        <p className="text-sm font-bold text-gray-900 mt-0.5">
                          ${((refundPayment.amount-(refundPayment.surcharge_amount||0))/100).toFixed(2)} · {refundPayment.method}
                          {refundPayment.method==='card'&&refundPayment.square_payment_id
                            ?<span className="text-xs text-emerald-600 ml-2">✓ Will refund to card</span>
                            :refundPayment.method==='card'
                            ?<span className="text-xs text-amber-600 ml-2">⚠ No Square ID</span>
                            :<span className="text-xs text-gray-400 ml-2">Cash — return manually</span>
                          }
                        </p>
                      </div>
                      <label className="block text-xs font-semibold text-gray-700 mb-1">Refund amount ($)</label>
                      <input type="number" step="0.01" min="0" max={((refundPayment.amount-(refundPayment.surcharge_amount||0))/100).toFixed(2)}
                        value={refundAmount} onChange={e=>setRefundAmount(e.target.value)}
                        className="w-full border border-gray-200 rounded-lg px-3 py-2 text-xl font-bold mb-3"/>
                      <div className="flex gap-2 mb-3">
                        {[100,90,50].map(pct=>(
                          <button key={pct} onClick={()=>setRefundAmount(((refundPayment.amount-(refundPayment.surcharge_amount||0))*pct/10000).toFixed(2))}
                            className="flex-1 bg-white border border-gray-200 rounded-lg py-1.5 text-sm font-semibold text-gray-700 hover:bg-gray-50">
                            {pct}%
                          </button>
                        ))}
                      </div>
                      <label className="block text-xs font-semibold text-gray-700 mb-1">Reason</label>
                      <input type="text" placeholder="e.g. Cancellation" value={refundReason} onChange={e=>setRefundReason(e.target.value)}
                        className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm mb-3"/>
                      {refundError&&<div className="bg-red-100 text-red-700 rounded-lg px-3 py-2 text-sm mb-3">{refundError}</div>}
                      {refundSuccess?(
                        <div className="text-center py-4">
                          <div className="text-4xl mb-2">✅</div>
                          <p className="font-bold text-emerald-600">Refund Successful!</p>
                          <p className="text-sm text-gray-500">${refundAmount} refunded{refundPayment.method==='card'?' to card':' — return cash to guest'}</p>
                        </div>
                      ):(
                        <button onClick={processRefund} disabled={processingRefund||!refundAmount||parseFloat(refundAmount)<=0}
                          className="w-full py-3 rounded-xl font-bold text-white transition-colors"
                          style={{background:processingRefund||!refundAmount?'#d1d5db':'#dc2626'}}>
                          {processingRefund?'Processing...':'Issue Refund · $'+(refundAmount||'0.00')}
                        </button>
                      )}
                    </div>
                  )}
                </>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  )
}
