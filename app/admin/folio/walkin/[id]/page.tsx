'use client'
import { useEffect, useState } from 'react'
import { createClient } from '@supabase/supabase-js'
import { useParams, useRouter } from 'next/navigation'

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
)

const FALLBACK_CATEGORIES = ['Camping Supplies', 'Food & Drink', 'Rentals', 'Fees', 'General']

type LineItem = {
  id: string
  description: string
  quantity: number
  unit_price: number
  tax_amount: number
  line_total: number
  category: string
  charged_at: string
  product_id: string | null
  notes?: string | null
}

type Payment = {
  id: string
  method: string
  amount: number
  surcharge_amount: number
  status: string
  note: string
  paid_at: string
}

type Product = {
  id: string
  name: string
  category: string
  price: number
  tax_class: string
  active: boolean
  variable_price: boolean
}

type Folio = {
  id: string
  reservation_id: string | null
  guest_name: string
  guest_email: string
  folio_type: string
  status: string
  notes: string
}

export default function WalkUpFolioPage() {
  const params = useParams()
  const router = useRouter()
  const folioId = params.id as string

  const [folio, setFolio] = useState<Folio | null>(null)
  const [lineItems, setLineItems] = useState<LineItem[]>([])
  const [payments, setPayments] = useState<Payment[]>([])
  const [products, setProducts] = useState<Product[]>([])
  const [cardSurcharge, setCardSurcharge] = useState(0)
  const [loading, setLoading] = useState(true)
  const [activeCategory, setActiveCategory] = useState('')
  const [categories, setCategories] = useState<string[]>(FALLBACK_CATEGORIES)
  const [activeTab, setActiveTab] = useState<'tab'|'items'>('tab')
  const [showPayment, setShowPayment] = useState(false)
  const [paymentMethod, setPaymentMethod] = useState('cash')
  const [paymentAmount, setPaymentAmount] = useState('')
  const [paymentNote, setPaymentNote] = useState('')
  const [savingPayment, setSavingPayment] = useState(false)
  const [showCustomItem, setShowCustomItem] = useState(false)
  const [cashTendered, setCashTendered] = useState('')
  const [waiveFee, setWaiveFee] = useState(false)
  const [customDesc, setCustomDesc] = useState('')
  const [customPrice, setCustomPrice] = useState('')
  const [customQty, setCustomQty] = useState('1')

  useEffect(() => { init() }, [folioId])

  async function init() {
    setLoading(true)
    const [{ data: prods }, { data: settings }, { data: folioData }, { data: cats }] = await Promise.all([
      supabase.from('products').select('*').eq('active', true).order('display_order'),
      supabase.from('settings').select('card_surcharge_percent').single(),
      supabase.from('folios').select('*').eq('id', folioId).single(),
      supabase.from('product_categories').select('name').order('display_order'),
    ])
    setProducts(prods || [])
    if (settings?.card_surcharge_percent) setCardSurcharge(Number(settings.card_surcharge_percent))
    if (folioData) setFolio(folioData)
    if (cats && cats.length > 0) setCategories(cats.map((c: any) => c.name))
    await loadFolioData(folioId)
    setLoading(false)
  }

  async function loadFolioData(fId: string) {
    const [{ data: items }, { data: pmts }] = await Promise.all([
      supabase.from('folio_line_items').select('*').eq('folio_id', fId).order('charged_at'),
      supabase.from('folio_payments').select('*').eq('folio_id', fId).eq('status', 'completed').order('paid_at'),
    ])
    setLineItems(items || [])
    setPayments(pmts || [])
  }

  async function addProduct(product: Product, overridePrice?: number, qty: number = 1, notes: string = '') {
    if (!folio) return
    const price = overridePrice ?? product.price
    const taxAmount = product.tax_class === 'standard' ? Math.round(price * 0.06) : 0
    const lineTotal = (price + taxAmount) * qty
    await supabase.from('folio_line_items').insert({
      folio_id: folio.id,
      product_id: product.id,
      description: product.name,
      quantity: qty,
      unit_price: price,
      tax_amount: taxAmount,
      line_total: lineTotal,
      category: product.category,
      notes: notes.trim() || null,
    })
    await loadFolioData(folio.id)
    setActiveTab('tab')
    setActiveCategory('')
  }

  async function addCustomItem() {
    if (!folio || !customDesc.trim()) return
    const price = Math.round(parseFloat(customPrice) * 100) || 0
    const qty = parseInt(customQty) || 1
    const lineTotal = price * qty
    await supabase.from('folio_line_items').insert({
      folio_id: folio.id,
      product_id: null,
      description: customDesc.trim(),
      quantity: qty,
      unit_price: price,
      tax_amount: 0,
      line_total: lineTotal,
      category: 'General',
    })
    setCustomDesc('')
    setCustomPrice('')
    setCustomQty('1')
    setShowCustomItem(false)
    await loadFolioData(folio.id)
    setActiveTab('tab')
    setActiveCategory('')
  }

  async function removeLineItem(id: string) {
    if (!confirm('Remove this item?')) return
    await supabase.from('folio_line_items').delete().eq('id', id)
    await loadFolioData(folioId)
  }

  async function voidPayment(id: string) {
    if (!confirm('Void this payment?')) return
    await supabase.from('folio_payments').update({ status: 'voided' }).eq('id', id)
    await loadFolioData(folioId)
  }

  async function collectPayment() {
    if (!folio) return
    const baseAmount = paymentMethod === 'cash' && cashTendered !== '' ? Math.min(Math.round(parseFloat(cashTendered) * 100), Math.round(parseFloat(paymentAmount) * 100)) : Math.round(parseFloat(paymentAmount) * 100)
    if (!baseAmount || baseAmount <= 0) return
    const surchargeAmount = paymentMethod === 'card' && cardSurcharge > 0 && !waiveFee
      ? Math.round(baseAmount * (cardSurcharge / 100))
      : 0
    const totalAmount = baseAmount + surchargeAmount
    setSavingPayment(true)
    await supabase.from('folio_payments').insert({
      folio_id: folio.id,
      method: paymentMethod,
      amount: totalAmount,
      surcharge_amount: surchargeAmount,
      status: 'completed',
      note: paymentNote + (surchargeAmount > 0 ? ' (incl. ' + cardSurcharge + '% card fee: $' + (surchargeAmount/100).toFixed(2) + ')' : ''),
    })
    setSavingPayment(false)
    setShowPayment(false)
    setPaymentAmount('')
    setPaymentNote('')
    setPaymentMethod('cash')
    setCashTendered('')
    setWaiveFee(false)
    await loadFolioData(folio.id)
  }

  const itemsTotal = lineItems.reduce((sum, i) => sum + i.line_total, 0)
  const paymentsTotal = payments.reduce((sum, p) => sum + p.amount - (p.surcharge_amount || 0), 0)
  const totalDue = Math.max(0, itemsTotal - paymentsTotal)
  const overpaid = paymentsTotal > itemsTotal ? paymentsTotal - itemsTotal : 0
  const paymentAmountCents = Math.round(parseFloat(paymentAmount) * 100) || 0
  const surchargePreview = paymentMethod === 'card' && cardSurcharge > 0 && !waiveFee ? Math.round(paymentAmountCents * (cardSurcharge / 100)) : 0
  const totalWithSurcharge = paymentAmountCents + surchargePreview
  const filteredProducts = products.filter(p => p.category === activeCategory)

  if (loading) return <div style={{ padding: '3rem', textAlign: 'center', color: '#6b7280' }}>Loading folio...</div>
  if (!folio) return <div style={{ padding: '3rem', textAlign: 'center', color: '#6b7280' }}>Folio not found.</div>

  return (
    <div style={{ fontFamily: 'sans-serif', minHeight: '100vh', background: '#C9D2D9' }}>
      <div style={{ background: '#fff', borderBottom: '1px solid #b8c4cc', padding: '0.875rem 1.25rem', display: 'flex', alignItems: 'center', gap: 12, boxShadow: '0 1px 4px rgba(0,0,0,0.08)' }}>
        <button onClick={() => router.back()} style={{ background: 'none', border: 'none', color: '#6b7280', cursor: 'pointer', fontSize: 14, whiteSpace: 'nowrap' }}>← Back</button>
        <div style={{ flex: 1, minWidth: 0 }}>
          <h1 style={{ margin: 0, fontSize: 17, fontWeight: 700 }}>{folio.guest_name}</h1>
          <p style={{ margin: 0, fontSize: 12, color: '#6b7280' }}>Walk-up sale</p>
        </div>
        <div style={{ textAlign: 'right', flexShrink: 0 }}>
          <div style={{ fontSize: 20, fontWeight: 800, color: overpaid > 0 ? '#6b7280' : totalDue > 0 ? '#dc2626' : '#15803d' }}>
            {overpaid > 0 ? 'Change: $' + (overpaid/100).toFixed(2) : '$' + (totalDue/100).toFixed(2)}
          </div>
          <div style={{ fontSize: 11, color: '#6b7280' }}>
            {overpaid > 0 ? 'give change' : totalDue > 0 ? 'balance due' : '✓ paid in full'}
          </div>
        </div>
      </div>

      <div style={{ display: 'flex', borderBottom: '1px solid #b8c4cc', background: '#fff', boxShadow: '0 1px 3px rgba(0,0,0,0.06)' }}>
        <button onClick={() => setActiveTab('tab')} style={{ flex: 1, padding: '12px', fontSize: 14, fontWeight: 600, border: 'none', background: 'none', cursor: 'pointer', borderBottom: activeTab === 'tab' ? '2px solid #15803d' : '2px solid transparent', color: activeTab === 'tab' ? '#15803d' : '#6b7280' }}>Guest Tab</button>
        <button onClick={() => { setActiveTab('items'); setActiveCategory('') }} style={{ flex: 1, padding: '12px', fontSize: 14, fontWeight: 600, border: 'none', background: 'none', cursor: 'pointer', borderBottom: activeTab === 'items' ? '2px solid #15803d' : '2px solid transparent', color: activeTab === 'items' ? '#15803d' : '#6b7280' }}>Add Items</button>
      </div>

      <div style={{ display: 'flex', minHeight: 'calc(100vh - 120px)' }}>
        <div style={{ flex: 1, padding: '1.25rem', overflowY: 'auto', display: activeTab === 'tab' ? 'block' : 'none', background: '#C9D2D9' }}>
          {lineItems.length > 0 && (
            <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 10, marginBottom: 12, overflow: 'hidden' }}>
              <div style={{ padding: '0.625rem 1rem', borderBottom: '1px solid #f3f4f6', fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', color: '#6b7280' }}>Charges</div>
              {lineItems.map((item, i) => (
                <div key={item.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 14px', borderBottom: i < lineItems.length - 1 ? '1px solid #f9fafb' : 'none' }}>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: 14, fontWeight: 500 }}>{item.description}{item.quantity > 1 ? ` ×${item.quantity}` : ''}</div>
                    {item.notes && <div style={{ fontSize: 11, color: '#6b7280', fontStyle: 'italic', marginTop: 2 }}>{item.notes}</div>}
                    {item.tax_amount > 0 && <div style={{ fontSize: 11, color: '#9ca3af' }}>incl. ${(item.tax_amount/100).toFixed(2)} tax</div>}
                  </div>
                  <div style={{ fontWeight: 600, fontSize: 14 }}>${(item.line_total/100).toFixed(2)}</div>
                  <button onClick={() => removeLineItem(item.id)} style={{ background: 'none', border: 'none', color: '#dc2626', cursor: 'pointer', fontSize: 18, padding: '0 2px', lineHeight: '1' }}>×</button>
                </div>
              ))}
              <div style={{ display: 'flex', justifyContent: 'space-between', padding: '10px 14px', borderTop: '1px solid #f3f4f6', fontWeight: 700, fontSize: 14 }}>
                <span>Total</span>
                <span>${(itemsTotal/100).toFixed(2)}</span>
              </div>
            </div>
          )}

          {payments.length > 0 && (
            <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 10, marginBottom: 12, overflow: 'hidden' }}>
              <div style={{ padding: '0.625rem 1rem', borderBottom: '1px solid #f3f4f6', fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', color: '#6b7280' }}>Payments</div>
              {payments.map((p, i) => (
                <div key={p.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 14px', borderBottom: i < payments.length - 1 ? '1px solid #f9fafb' : 'none' }}>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: 14, fontWeight: 500, textTransform: 'capitalize' }}>{p.method}</div>
                    {p.note && <div style={{ fontSize: 11, color: '#9ca3af' }}>{p.note}</div>}
                  </div>
                  <div style={{ fontWeight: 600, fontSize: 14, color: '#15803d' }}>-${(p.amount/100).toFixed(2)}</div>
                  <button onClick={() => voidPayment(p.id)} style={{ background: 'none', border: 'none', color: '#dc2626', cursor: 'pointer', fontSize: 18, padding: '0 2px', lineHeight: '1' }}>×</button>
                </div>
              ))}
            </div>
          )}

          {lineItems.length === 0 && (
            <div style={{ textAlign: 'center', color: '#9ca3af', padding: '3rem 0', fontSize: 14 }}>No charges yet. Tap Add Items to get started.</div>
          )}

          {totalDue > 0 && (
            <button onClick={() => { setPaymentAmount((totalDue/100).toFixed(2)); setShowPayment(true) }} style={{ width: '100%', background: '#2E6B8A', color: '#fff', border: 'none', borderRadius: 10, padding: '14px', fontWeight: 700, fontSize: 16, cursor: 'pointer', marginTop: 8 }}>
              Collect Payment · ${(totalDue/100).toFixed(2)}
            </button>
          )}

          {overpaid > 0 && (
            <div style={{ background: '#f0fdf4', border: '1px solid #bbf7d0', borderRadius: 10, padding: '1rem', marginTop: 8, textAlign: 'center' }}>
              <div style={{ fontSize: 16, fontWeight: 700, color: '#15803d' }}>Give change: ${(overpaid/100).toFixed(2)}</div>
              <div style={{ fontSize: 12, color: '#6b7280', marginTop: 4 }}>Folio complete</div>
            </div>
          )}

          {(lineItems.length > 0 || payments.length > 0) && (
            <ReceiptButtons folioId={folio?.id || ''} guestEmail={folio?.guest_email || ''} receiptType='walkup' />
          )}
        </div>

        <div style={{ width: 'min(420px, 100%)', background: '#C9D2D9', borderLeft: '1px solid #b8c4cc', display: activeTab === 'items' ? 'flex' : 'none', flexDirection: 'column' }}>
          {activeCategory === '' ? (
            <div style={{ flex: 1, overflowY: 'auto', padding: '1rem', display: 'flex', flexDirection: 'column', gap: 10 }}>
              <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em', color: '#4a6275', marginBottom: 4 }}>Select a category</div>
              {categories.map(cat => (
                <button
                  key={cat}
                  onClick={() => setActiveCategory(cat)}
                  style={{ background: '#2E6B8A', color: '#fff', border: 'none', borderRadius: 12, padding: '18px 20px', fontSize: 16, fontWeight: 700, cursor: 'pointer', textAlign: 'left', display: 'flex', alignItems: 'center', justifyContent: 'space-between', boxShadow: '0 2px 6px rgba(46,107,138,0.3)' }}
                  onMouseEnter={e => (e.currentTarget.style.background = '#245875')}
                  onMouseLeave={e => (e.currentTarget.style.background = '#2E6B8A')}
                >
                  <span>{cat}</span>
                  <span style={{ fontSize: 20, opacity: 0.7 }}>›</span>
                </button>
              ))}
            </div>
          ) : (
            <>
              <div style={{ padding: '0.75rem 1rem', borderBottom: '1px solid #b8c4cc', background: 'rgba(255,255,255,0.5)', display: 'flex', alignItems: 'center', gap: 10 }}>
                <button
                  onClick={() => setActiveCategory('')}
                  style={{ background: '#2E6B8A', color: '#fff', border: 'none', borderRadius: 8, padding: '6px 14px', fontSize: 13, fontWeight: 600, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 6 }}
                >
                  ‹ Back
                </button>
                <span style={{ fontWeight: 700, fontSize: 14, color: '#1e3f52' }}>{activeCategory}</span>
              </div>
              <div style={{ flex: 1, overflowY: 'auto', padding: '0.875rem', display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, alignContent: 'start' }}>
                {filteredProducts.map(product => (
                  <VariableProductTile key={product.id} product={product} onAdd={addProduct} />
                ))}
                {filteredProducts.length === 0 && (
                  <div style={{ gridColumn: '1/-1', textAlign: 'center', color: '#4a6275', fontSize: 13, padding: '2rem 0' }}>
                    No products in this category
                  </div>
                )}
              </div>
            </>
          )}

          <div style={{ borderTop: '1px solid #e5e7eb', padding: '0.875rem' }}>
            {!showCustomItem ? (
              <button onClick={() => setShowCustomItem(true)} style={{ width: '100%', background: 'none', border: '1px dashed #d1d5db', borderRadius: 8, padding: '10px', fontSize: 13, color: '#6b7280', cursor: 'pointer' }}>+ Custom charge</button>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                <input style={si} placeholder='Description' value={customDesc} onChange={e => setCustomDesc(e.target.value)} />
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                  <input style={si} placeholder='Price $' value={customPrice} onChange={e => setCustomPrice(e.target.value)} />
                  <input style={si} placeholder='Qty' value={customQty} onChange={e => setCustomQty(e.target.value)} />
                </div>
                <div style={{ display: 'flex', gap: 8 }}>
                  <button onClick={() => setShowCustomItem(false)} style={{ flex: 1, background: 'none', border: '1px solid #e5e7eb', borderRadius: 7, padding: '8px', fontSize: 13, cursor: 'pointer' }}>Cancel</button>
                  <button onClick={addCustomItem} style={{ flex: 1, background: '#2E6B8A', color: '#fff', border: 'none', borderRadius: 7, padding: '8px', fontSize: 13, fontWeight: 600, cursor: 'pointer' }}>Add</button>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>

      {showPayment && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 50, display: 'flex', alignItems: 'flex-end', justifyContent: 'center' }}>
          <div style={{ background: '#fff', borderRadius: '16px 16px 0 0', padding: '1.5rem', width: '100%', maxWidth: 520 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1.25rem' }}>
              <h2 style={{ margin: 0, fontSize: 18, fontWeight: 700 }}>Collect Payment</h2>
              <button onClick={() => setShowPayment(false)} style={{ background: 'none', border: 'none', fontSize: 22, cursor: 'pointer', color: '#6b7280' }}>×</button>
            </div>
            <label style={ml}>Payment method</label>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8, marginBottom: 16 }}>
              {['cash', 'card', 'check'].map(m => (
                <button key={m} onClick={() => setPaymentMethod(m)} style={{ padding: '12px', border: '2px solid ' + (paymentMethod === m ? '#15803d' : '#e5e7eb'), borderRadius: 8, background: paymentMethod === m ? '#e8f2f7' : '#fff', fontWeight: 600, fontSize: 14, cursor: 'pointer', textTransform: 'capitalize', color: paymentMethod === m ? '#2E6B8A' : '#374151' }}>
                  {m}
                </button>
              ))}
            </div>
            {paymentMethod === 'card' && cardSurcharge > 0 && (
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14, padding: '10px 14px', background: waiveFee ? '#f0fdf4' : '#fffbeb', border: '1px solid', borderColor: waiveFee ? '#bbf7d0' : '#fde68a', borderRadius: 8 }}>
                <div>
                  <div style={{ fontSize: 13, fontWeight: 600, color: '#374151' }}>Card fee ({cardSurcharge}%)</div>
                  <div style={{ fontSize: 12, color: '#6b7280' }}>{waiveFee ? 'Fee waived for this payment' : 'Applied to card payments'}</div>
                </div>
                <button
                  type='button'
                  onClick={() => setWaiveFee(!waiveFee)}
                  style={{ width: 40, height: 22, borderRadius: 11, border: 'none', cursor: 'pointer', backgroundColor: waiveFee ? '#15803d' : '#d1d5db', position: 'relative', flexShrink: 0 }}
                >
                  <span style={{ position: 'absolute', top: 3, left: waiveFee ? 21 : 3, width: 16, height: 16, borderRadius: '50%', backgroundColor: 'white', transition: 'left 0.2s' }} />
                </button>
              </div>
            )}
            <label style={ml}>{paymentMethod === 'cash' ? 'Amount due' : 'Amount'}</label>
            <div style={{ position: 'relative', marginBottom: 8 }}>
              <span style={{ position: 'absolute', left: 14, top: '50%', transform: 'translateY(-50%)', color: '#6b7280', fontSize: 18 }}>$</span>
              <input style={{ ...si, paddingLeft: 30, fontSize: 24, fontWeight: 700, height: 56, background: paymentMethod === 'cash' ? '#f9fafb' : '#fff', color: paymentMethod === 'cash' ? '#6b7280' : '#111827' }} type='number' step='0.01' value={paymentAmount} readOnly={paymentMethod === 'cash'} onChange={e => setPaymentAmount(e.target.value)} />
            </div>
            {paymentMethod === 'cash' && (
              <>
                <label style={ml}>Cash tendered</label>
                <div style={{ position: 'relative', marginBottom: 8 }}>
                  <span style={{ position: 'absolute', left: 14, top: '50%', transform: 'translateY(-50%)', color: '#6b7280', fontSize: 18 }}>$</span>
                  <input style={{ ...si, paddingLeft: 30, fontSize: 24, fontWeight: 700, height: 56 }} type='number' step='0.01' value={cashTendered} onChange={e => setCashTendered(e.target.value)} placeholder='0.00' autoFocus />
                </div>
                {parseFloat(cashTendered) > 0 && (
                  <div style={{ background: parseFloat(cashTendered) >= parseFloat(paymentAmount) ? '#f0fdf4' : '#fef2f2', border: '1px solid', borderColor: parseFloat(cashTendered) >= parseFloat(paymentAmount) ? '#bbf7d0' : '#fecaca', borderRadius: 8, padding: '10px 14px', marginBottom: 12, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <span style={{ fontWeight: 600, fontSize: 14, color: parseFloat(cashTendered) >= parseFloat(paymentAmount) ? '#15803d' : '#dc2626' }}>
                      {parseFloat(cashTendered) >= parseFloat(paymentAmount) ? 'Change due' : 'Amount short'}
                    </span>
                    <span style={{ fontWeight: 800, fontSize: 18, color: parseFloat(cashTendered) >= parseFloat(paymentAmount) ? '#15803d' : '#dc2626' }}>
                      ${Math.abs(parseFloat(cashTendered) - parseFloat(paymentAmount)).toFixed(2)}
                    </span>
                  </div>
                )}
              </>
            )}
            {paymentMethod === 'card' && cardSurcharge > 0 && paymentAmountCents > 0 && (
              <div style={{ background: '#fffbeb', border: '1px solid #fde68a', borderRadius: 8, padding: '10px 14px', marginBottom: 12, fontSize: 13 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                  <span style={{ color: '#92400e' }}>{cardSurcharge}% card fee</span>
                  <span style={{ color: '#92400e', fontWeight: 600 }}>+${(surchargePreview/100).toFixed(2)}</span>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 4, fontWeight: 700 }}>
                  <span style={{ color: '#92400e' }}>Total charged to card</span>
                  <span style={{ color: '#92400e' }}>${(totalWithSurcharge/100).toFixed(2)}</span>
                </div>
              </div>
            )}
            <label style={ml}>Note (optional)</label>
            <input style={{ ...si, marginBottom: 16 }} placeholder='e.g. check #1042' value={paymentNote} onChange={e => setPaymentNote(e.target.value)} />
            <button onClick={collectPayment} disabled={savingPayment} style={{ width: '100%', background: '#2E6B8A', color: '#fff', border: 'none', borderRadius: 10, padding: '14px', fontWeight: 700, fontSize: 16, cursor: 'pointer' }}>
              {savingPayment ? 'Recording...' : paymentMethod === 'card' && surchargePreview > 0 ? 'Charge card · $' + (totalWithSurcharge/100).toFixed(2) : paymentMethod === 'cash' && cashTendered !== '' ? 'Record cash · $' + Math.min(parseFloat(cashTendered), parseFloat(paymentAmount)).toFixed(2) : 'Record ' + paymentMethod + ' · $' + paymentAmount}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

function VariableProductTile({ product, onAdd }: { product: any, onAdd: (p: any, price?: number, qty?: number, notes?: string) => void }) {
  const [customPrice, setCustomPrice] = useState('')
  const [qty, setQty] = useState(1)
  const [notes, setNotes] = useState('')

  function handleAdd(overridePrice?: number) {
    onAdd(product, overridePrice, qty, notes)
    setQty(1)
    setNotes('')
    setCustomPrice('')
  }

  const tileStyle: React.CSSProperties = { background: '#f9fafb', border: '1px solid #e5e7eb', borderRadius: 12, padding: '14px', display: 'flex', flexDirection: 'column', gap: 10 }

  const qtyRow = (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      <button
        onClick={() => setQty(q => Math.max(1, q - 1))}
        style={{ width: 40, height: 40, borderRadius: 8, border: '1px solid #d1d5db', background: '#fff', fontSize: 20, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#374151', flexShrink: 0 }}
      >−</button>
      <span style={{ minWidth: 28, textAlign: 'center', fontWeight: 700, fontSize: 18 }}>{qty}</span>
      <button
        onClick={() => setQty(q => q + 1)}
        style={{ width: 40, height: 40, borderRadius: 8, border: '1px solid #d1d5db', background: '#fff', fontSize: 20, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#374151', flexShrink: 0 }}
      >+</button>
    </div>
  )

  if (!product.variable_price) {
    return (
      <div style={tileStyle}>
        <div style={{ fontWeight: 700, fontSize: 15 }}>{product.name}</div>
        <div style={{ fontSize: 18, color: '#15803d', fontWeight: 700 }}>${(product.price/100).toFixed(2)}{product.tax_class === 'standard' && <span style={{ fontSize: 11, color: '#9ca3af', fontWeight: 400 }}> + tax</span>}</div>
        {qtyRow}
        <input
          placeholder="Note (optional)"
          value={notes}
          onChange={e => setNotes(e.target.value)}
          style={{ width: '100%', border: '1px solid #d1d5db', borderRadius: 8, padding: '10px 12px', fontSize: 13, color: '#374151', boxSizing: 'border-box' }}
        />
        <button
          onClick={() => handleAdd()}
          style={{ width: '100%', background: '#2E6B8A', color: '#fff', border: 'none', borderRadius: 8, padding: '12px', fontSize: 15, fontWeight: 700, cursor: 'pointer' }}
        >
          Add to Tab
        </button>
      </div>
    )
  }

  return (
    <div style={tileStyle}>
      <div style={{ fontWeight: 700, fontSize: 15 }}>{product.name}</div>
      <div style={{ position: 'relative' }}>
        <span style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: '#6b7280', fontSize: 16 }}>$</span>
        <input
          type='number'
          min='0'
          step='0.01'
          placeholder='0.00'
          value={customPrice}
          onChange={e => setCustomPrice(e.target.value)}
          style={{ width: '100%', border: '1px solid #d1d5db', borderRadius: 8, padding: '10px 10px 10px 26px', fontSize: 16, boxSizing: 'border-box' }}
        />
      </div>
      {qtyRow}
      <input
        placeholder="Note (optional)"
        value={notes}
        onChange={e => setNotes(e.target.value)}
        style={{ width: '100%', border: '1px solid #d1d5db', borderRadius: 8, padding: '10px 12px', fontSize: 13, color: '#374151', boxSizing: 'border-box' }}
      />
      <button
        onClick={() => { if (customPrice) handleAdd(Math.round(parseFloat(customPrice) * 100)) }}
        disabled={!customPrice || parseFloat(customPrice) <= 0}
        style={{ width: '100%', background: customPrice && parseFloat(customPrice) > 0 ? '#2E6B8A' : '#d1d5db', color: '#fff', border: 'none', borderRadius: 8, padding: '12px', fontSize: 15, fontWeight: 700, cursor: customPrice ? 'pointer' : 'default' }}
      >
        Add to Tab
      </button>
    </div>
  )
}

function ReceiptButtons({ folioId, guestEmail, receiptType }: { folioId: string, guestEmail: string, receiptType: string }) {
  const [sending, setSending] = useState(false)
  const [sent, setSent] = useState(false)
  const [error, setError] = useState('')

  async function sendReceipt() {
    if (!guestEmail) { setError('No email on file for this guest'); return }
    setSending(true)
    setError('')
    const res = await fetch('/api/receipt', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ folioId, receiptType }),
    })
    const data = await res.json()
    setSending(false)
    if (data.success) { setSent(true); setTimeout(() => setSent(false), 3000) }
    else setError(data.error || 'Failed to send receipt')
  }

  return (
    <div style={{ marginTop: 12, display: 'flex', gap: 8, flexDirection: 'column' }}>
      <div style={{ display: 'flex', gap: 8 }}>
        <button
          onClick={sendReceipt}
          disabled={sending}
          style={{ flex: 1, background: sent ? '#15803d' : '#fff', color: sent ? '#fff' : '#2E6B8A', border: '1px solid #2E6B8A', borderRadius: 8, padding: '10px', fontSize: 13, fontWeight: 600, cursor: 'pointer' }}
        >
          {sending ? 'Sending...' : sent ? '✓ Receipt sent!' : '✉ Send Receipt'}
        </button>
        <button
          onClick={() => window.print()}
          style={{ flex: 1, background: '#fff', color: '#6b7280', border: '1px solid #d1d5db', borderRadius: 8, padding: '10px', fontSize: 13, fontWeight: 600, cursor: 'pointer' }}
        >
          🖨 Print
        </button>
      </div>
      {!guestEmail && <p style={{ fontSize: 12, color: '#9ca3af', margin: 0, textAlign: 'center' }}>No email on file — print only</p>}
      {error && <p style={{ fontSize: 12, color: '#dc2626', margin: 0 }}>{error}</p>}
    </div>
  )
}

const si: React.CSSProperties = { width: '100%', border: '1px solid #d1d5db', borderRadius: 7, padding: '8px 10px', fontSize: 14, boxSizing: 'border-box' }
const ml: React.CSSProperties = { display: 'block', fontSize: 13, fontWeight: 600, color: '#374151', marginBottom: 6 }