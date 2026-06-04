'use client'
import { useRouter } from 'next/navigation'
import { useEffect, useState } from 'react'
import { createClient } from '@supabase/supabase-js'

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
)

type Product = {
  id: string
  name: string
  description: string
  category: string
  price: number
  tax_class: string
  track_inventory: boolean
  stock_quantity: number | null
  active: boolean
  display_order: number
  variable_price: boolean
  priceDisplay?: string
}

type Category = {
  id: string
  name: string
  display_order: number
}

const blank = (): Omit<Product, 'id'> => ({
  name: '',
  description: '',
  category: 'Camping Supplies',
  price: 0,
  tax_class: 'standard',
  track_inventory: false,
  stock_quantity: null,
  active: true,
  display_order: 0,
  variable_price: false,
})

export default function ProductsPage() {
  const router = useRouter()

  // ── Plan/feature gate — redirect if not authorized ──────────────────────
  useEffect(() => {
    supabase.from('settings').select('plan, pos_enabled').single().then(({ data }) => {
      if (!data?.pos_enabled) router.replace('/admin')
    })
  }, [])
  const [products, setProducts] = useState<Product[]>([])
  const [categories, setCategories] = useState<Category[]>([])
  const [loading, setLoading] = useState(true)
  const [showForm, setShowForm] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [form, setForm] = useState(blank())
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState('')
  const [newCatName, setNewCatName] = useState('')
  const [addingCat, setAddingCat] = useState(false)
  const [showCatManager, setShowCatManager] = useState(false)

  useEffect(() => { fetchAll() }, [])

  async function fetchAll() {
    setLoading(true)
    const [{ data: prods }, { data: cats }] = await Promise.all([
      supabase.from('products').select('*').order('display_order', { ascending: true }),
      supabase.from('product_categories').select('*').order('display_order', { ascending: true }),
    ])
    setProducts(prods || [])
    setCategories(cats || [])
    setLoading(false)
  }

  function openNew() {
    setForm({ ...blank(), category: categories[0]?.name || 'General' })
    setEditingId(null)
    setShowForm(true)
    setMessage('')
  }

  function openEdit(p: Product) {
    setForm({
      name: p.name,
      description: p.description,
      category: p.category,
      price: p.price,
      tax_class: p.tax_class,
      track_inventory: p.track_inventory,
      stock_quantity: p.stock_quantity,
      active: p.active,
      display_order: p.display_order,
      variable_price: p.variable_price,
    })
    setEditingId(p.id)
    setShowForm(true)
    setMessage('')
  }

  async function save() {
    if (!form.name.trim()) { setMessage('Product name is required.'); return }
    setSaving(true)
    const payload = { ...form, price: Math.round(form.price) }
    if (editingId) {
      await supabase.from('products').update(payload).eq('id', editingId)
    } else {
      await supabase.from('products').insert(payload)
    }
    setSaving(false)
    setShowForm(false)
    setEditingId(null)
    fetchAll()
  }

  async function toggleActive(p: Product) {
    await supabase.from('products').update({ active: !p.active }).eq('id', p.id)
    fetchAll()
  }

  async function deleteProduct(id: string) {
    if (!confirm('Delete this product? This cannot be undone.')) return
    await supabase.from('products').delete().eq('id', id)
    fetchAll()
  }

  async function addCategory() {
    if (!newCatName.trim()) return
    setAddingCat(true)
    await supabase.from('product_categories').insert({
      name: newCatName.trim(),
      display_order: categories.length + 1,
    })
    setNewCatName('')
    setAddingCat(false)
    fetchAll()
  }

  async function deleteCategory(id: string, name: string) {
    const inUse = products.some(p => p.category === name)
    if (inUse) {
      alert('This category is in use by one or more products. Reassign those products before deleting this category.')
      return
    }
    if (!confirm('Delete category "' + name + '"?')) return
    await supabase.from('product_categories').delete().eq('id', id)
    fetchAll()
  }

  const categoryNames = categories.map(c => c.name)
  const grouped = categories.map(cat => ({
    cat: cat.name,
    items: products.filter(p => p.category === cat.name)
  })).filter(g => g.items.length > 0)
  const uncategorized = products.filter(p => !categoryNames.includes(p.category))

  return (
    <div style={{ padding: '2rem', maxWidth: 900, margin: '0 auto', fontFamily: 'sans-serif' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1.5rem' }}>
        <div>
          <h1 style={{ fontSize: 24, fontWeight: 700, margin: 0 }}>Products & Services</h1>
          <p style={{ color: '#6b7280', margin: '4px 0 0', fontSize: 14 }}>Items available for sale at the counter or added to a guest folio</p>
        </div>
        <button onClick={openNew} style={{ background: '#15803d', color: '#fff', border: 'none', borderRadius: 8, padding: '10px 20px', fontWeight: 600, cursor: 'pointer', fontSize: 14 }}>
          + Add Product
        </button>
      </div>

      {/* Product form modal */}
      {showForm && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', zIndex: 50, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <div style={{ background: '#fff', borderRadius: 12, padding: '2rem', width: '100%', maxWidth: 520, boxShadow: '0 8px 32px rgba(0,0,0,0.18)', maxHeight: '90vh', overflowY: 'auto' }}>
            <h2 style={{ margin: '0 0 1.25rem', fontSize: 18, fontWeight: 700 }}>{editingId ? 'Edit Product' : 'New Product'}</h2>
            {message && <p style={{ color: '#dc2626', marginBottom: 12, fontSize: 14 }}>{message}</p>}
            <label style={lbl}>Product name *</label>
            <input style={inp} value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} placeholder='e.g. Firewood Bundle' />
            <label style={lbl}>Description</label>
            <input style={inp} value={form.description} onChange={e => setForm({ ...form, description: e.target.value })} placeholder='Optional short description' />
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
              <div>
                <label style={lbl}>Category</label>
                <select style={inp} value={form.category} onChange={e => setForm({ ...form, category: e.target.value })}>
                  {categoryNames.map(c => <option key={c}>{c}</option>)}
                </select>
              </div>
              <div>
                <label style={lbl}>Price</label>
                <div style={{ position: 'relative' }}>
                  <span style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: '#6b7280' }}>$</span>
                  <input
                    style={{ ...inp, paddingLeft: 24 }}
                    type='number'
                    min='0'
                    step='0.01'
                    value={form.priceDisplay ?? (form.price / 100).toFixed(2)}
                    onChange={e => setForm({ ...form, priceDisplay: e.target.value, price: Math.round(parseFloat(e.target.value) * 100) || 0 })}
                    onBlur={() => setForm(f => ({ ...f, priceDisplay: undefined }))}
                  />
                </div>
              </div>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
              <div>
                <label style={lbl}>Tax class</label>
                <select style={inp} value={form.tax_class} onChange={e => setForm({ ...form, tax_class: e.target.value })}>
                  <option value='standard'>Standard (taxable)</option>
                  <option value='exempt'>Tax exempt</option>
                </select>
              </div>
              <div>
                <label style={lbl}>Display order</label>
                <input style={inp} type='number' min='0' value={form.display_order} onChange={e => setForm({ ...form, display_order: parseInt(e.target.value) || 0 })} />
              </div>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, margin: '12px 0' }}>
              <button type='button' onClick={() => setForm({ ...form, track_inventory: !form.track_inventory })} style={{ width: 40, height: 22, borderRadius: 11, border: 'none', cursor: 'pointer', backgroundColor: form.track_inventory ? '#15803d' : '#d1d5db', position: 'relative', flexShrink: 0 }}>
                <span style={{ position: 'absolute', top: 3, left: form.track_inventory ? 21 : 3, width: 16, height: 16, borderRadius: '50%', backgroundColor: 'white', transition: 'left 0.2s' }} />
              </button>
              <label style={{ fontSize: 14, color: '#374151' }}>Track inventory</label>
            </div>
            {form.track_inventory && (
              <div>
                <label style={lbl}>Current stock quantity</label>
                <input style={inp} type='number' min='0' value={form.stock_quantity ?? ''} onChange={e => setForm({ ...form, stock_quantity: parseInt(e.target.value) || 0 })} placeholder='0' />
              </div>
            )}
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, margin: '12px 0' }}>
              <button type='button' onClick={() => setForm({ ...form, variable_price: !form.variable_price })} style={{ width: 40, height: 22, borderRadius: 11, border: 'none', cursor: 'pointer', backgroundColor: form.variable_price ? '#15803d' : '#d1d5db', position: 'relative', flexShrink: 0 }}>
                <span style={{ position: 'absolute', top: 3, left: form.variable_price ? 21 : 3, width: 16, height: 16, borderRadius: '50%', backgroundColor: 'white', transition: 'left 0.2s' }} />
              </button>
              <label style={{ fontSize: 14, color: '#374151' }}>Variable price (staff enters amount at time of sale)</label>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, margin: '12px 0 20px' }}>
              <button type='button' onClick={() => setForm({ ...form, active: !form.active })} style={{ width: 40, height: 22, borderRadius: 11, border: 'none', cursor: 'pointer', backgroundColor: form.active ? '#15803d' : '#d1d5db', position: 'relative', flexShrink: 0 }}>
                <span style={{ position: 'absolute', top: 3, left: form.active ? 21 : 3, width: 16, height: 16, borderRadius: '50%', backgroundColor: 'white', transition: 'left 0.2s' }} />
              </button>
              <label style={{ fontSize: 14, color: '#374151' }}>Active (visible at POS)</label>
            </div>
            <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
              <button onClick={() => setShowForm(false)} style={{ background: 'none', border: '1px solid #d1d5db', borderRadius: 8, padding: '9px 18px', cursor: 'pointer', fontSize: 14 }}>Cancel</button>
              <button onClick={save} disabled={saving} style={{ background: '#15803d', color: '#fff', border: 'none', borderRadius: 8, padding: '9px 18px', fontWeight: 600, cursor: 'pointer', fontSize: 14 }}>
                {saving ? 'Saving...' : 'Save Product'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Product list */}
      {loading ? (
        <p style={{ color: '#6b7280' }}>Loading products...</p>
      ) : products.length === 0 ? (
        <p style={{ color: '#6b7280' }}>No products yet. Add your first item above.</p>
      ) : (
        <>
          {grouped.map(({ cat, items }) => (
            <div key={cat} style={{ marginBottom: '2rem' }}>
              <h3 style={{ fontSize: 13, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em', color: '#6b7280', margin: '0 0 8px' }}>{cat}</h3>
              <div style={{ border: '1px solid #e5e7eb', borderRadius: 10, overflow: 'hidden' }}>
                {items.map((p, i) => (
                  <div key={p.id} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 16px', borderBottom: i < items.length - 1 ? '1px solid #f3f4f6' : 'none', background: p.active ? '#fff' : '#f9fafb' }}>
                    <div style={{ flex: 1 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <span style={{ fontWeight: 600, fontSize: 14 }}>{p.name}</span>
                        {!p.active && <span style={{ fontSize: 11, background: '#f3f4f6', color: '#9ca3af', borderRadius: 4, padding: '2px 6px' }}>Inactive</span>}
                        {p.track_inventory && <span style={{ fontSize: 11, background: '#eff6ff', color: '#3b82f6', borderRadius: 4, padding: '2px 6px' }}>Stock: {p.stock_quantity ?? 0}</span>}
                      </div>
                      {p.description && <div style={{ fontSize: 12, color: '#6b7280', marginTop: 2 }}>{p.description}</div>}
                    </div>
                    <div style={{ fontWeight: 700, fontSize: 15, minWidth: 60, textAlign: 'right' }}>${(p.price / 100).toFixed(2)}</div>
                    <div style={{ fontSize: 12, color: '#9ca3af', minWidth: 50 }}>{p.tax_class === 'exempt' ? 'No tax' : 'Taxable'}</div>
                    <button onClick={() => toggleActive(p)} style={{ fontSize: 12, background: 'none', border: '1px solid #e5e7eb', borderRadius: 6, padding: '4px 10px', cursor: 'pointer', color: p.active ? '#15803d' : '#6b7280' }}>
                      {p.active ? 'Active' : 'Inactive'}
                    </button>
                    <button onClick={() => openEdit(p)} style={{ fontSize: 12, background: 'none', border: '1px solid #e5e7eb', borderRadius: 6, padding: '4px 10px', cursor: 'pointer' }}>Edit</button>
                    <button onClick={() => deleteProduct(p.id)} style={{ fontSize: 12, background: 'none', border: '1px solid #fee2e2', borderRadius: 6, padding: '4px 10px', cursor: 'pointer', color: '#dc2626' }}>Delete</button>
                  </div>
                ))}
              </div>
            </div>
          ))}
          {uncategorized.length > 0 && (
            <div style={{ marginBottom: '2rem' }}>
              <h3 style={{ fontSize: 13, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em', color: '#6b7280', margin: '0 0 8px' }}>Other</h3>
              <div style={{ border: '1px solid #e5e7eb', borderRadius: 10, overflow: 'hidden' }}>
                {uncategorized.map((p, i) => (
                  <div key={p.id} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 16px', borderBottom: i < uncategorized.length - 1 ? '1px solid #f3f4f6' : 'none' }}>
                    <div style={{ flex: 1 }}><span style={{ fontWeight: 600, fontSize: 14 }}>{p.name}</span></div>
                    <div style={{ fontWeight: 700, fontSize: 15 }}>${(p.price / 100).toFixed(2)}</div>
                    <button onClick={() => openEdit(p)} style={{ fontSize: 12, background: 'none', border: '1px solid #e5e7eb', borderRadius: 6, padding: '4px 10px', cursor: 'pointer' }}>Edit</button>
                    <button onClick={() => deleteProduct(p.id)} style={{ fontSize: 12, background: 'none', border: '1px solid #fee2e2', borderRadius: 6, padding: '4px 10px', cursor: 'pointer', color: '#dc2626' }}>Delete</button>
                  </div>
                ))}
              </div>
            </div>
          )}
        </>
      )}

      {/* Manage Categories */}
      <div style={{ marginTop: '3rem', borderTop: '1px solid #e5e7eb', paddingTop: '2rem' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
          <div>
            <h2 style={{ fontSize: 16, fontWeight: 700, margin: 0 }}>Manage Categories</h2>
            <p style={{ fontSize: 13, color: '#6b7280', margin: '4px 0 0' }}>Add or remove product categories</p>
          </div>
          <button onClick={() => setShowCatManager(!showCatManager)} style={{ fontSize: 13, background: 'none', border: '1px solid #e5e7eb', borderRadius: 7, padding: '6px 14px', cursor: 'pointer', color: '#6b7280' }}>
            {showCatManager ? 'Hide' : 'Show'}
          </button>
        </div>
        {showCatManager && (
          <div style={{ background: '#f9fafb', border: '1px solid #e5e7eb', borderRadius: 10, padding: '1.25rem' }}>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 16 }}>
              {categories.map(cat => (
                <div key={cat.id} style={{ display: 'flex', alignItems: 'center', gap: 6, background: '#fff', border: '1px solid #e5e7eb', borderRadius: 7, padding: '6px 12px', fontSize: 13 }}>
                  <span style={{ fontWeight: 500 }}>{cat.name}</span>
                  <button onClick={() => deleteCategory(cat.id, cat.name)} style={{ background: 'none', border: 'none', color: '#dc2626', cursor: 'pointer', fontSize: 16, lineHeight: 1, padding: '0 2px' }}>×</button>
                </div>
              ))}
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              <input
                style={{ ...inp, flex: 1 }}
                placeholder='New category name...'
                value={newCatName}
                onChange={e => setNewCatName(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && addCategory()}
              />
              <button onClick={addCategory} disabled={addingCat || !newCatName.trim()} style={{ background: '#15803d', color: '#fff', border: 'none', borderRadius: 7, padding: '8px 18px', fontWeight: 600, cursor: 'pointer', fontSize: 14, whiteSpace: 'nowrap' }}>
                {addingCat ? 'Adding...' : '+ Add'}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

const lbl: React.CSSProperties = { display: 'block', fontSize: 13, fontWeight: 600, color: '#374151', marginBottom: 4, marginTop: 12 }
const inp: React.CSSProperties = { width: '100%', border: '1px solid #d1d5db', borderRadius: 7, padding: '8px 10px', fontSize: 14, boxSizing: 'border-box', outline: 'none' }