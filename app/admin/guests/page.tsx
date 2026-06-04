'use client'
import { useEffect, useState } from 'react'
import { createClient } from '@supabase/supabase-js'
import { useRouter } from 'next/navigation'

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
)

type Guest = {
  id: string
  name: string
  email: string
  phone: string
  site_number: string
  is_seasonal: boolean
  season_start: string | null
  season_end: string | null
  notes: string
  last_visit: string | null
}

const blank = (): Omit<Guest, 'id'> => ({
  name: '',
  email: '',
  phone: '',
  site_number: '',
  is_seasonal: false,
  season_start: null,
  season_end: null,
  notes: '',
  last_visit: null,
})

export default function GuestsPage() {
  const router = useRouter()
  const [guests, setGuests] = useState<Guest[]>([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [filter, setFilter] = useState<'all' | 'seasonal'>('all')
  const [showForm, setShowForm] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [form, setForm] = useState(blank())
  const [saving, setSaving] = useState(false)
  const [syncing, setSyncing] = useState(false)
  const [syncResult, setSyncResult] = useState<{ added: number; updated: number } | null>(null)

  useEffect(() => { fetchGuests() }, [])

  async function fetchGuests() {
    setLoading(true)
    const { data } = await supabase
      .from('guests')
      .select('*')
      .order('name', { ascending: true })
    setGuests(data || [])
    setLoading(false)
  }

  async function syncFromReservations() {
    setSyncing(true)
    setSyncResult(null)
    try {
      const res = await fetch('/api/sync-guests', { method: 'POST' })
      const data = await res.json()
      if (data.success) {
        setSyncResult({ added: data.added, updated: data.updated })
        fetchGuests()
      }
    } catch (e) {
      console.error(e)
    }
    setSyncing(false)
    // Clear result message after 5 seconds
    setTimeout(() => setSyncResult(null), 5000)
  }

  async function save() {
    if (!form.name.trim()) return
    setSaving(true)
    if (editingId) {
      await supabase.from('guests').update(form).eq('id', editingId)
    } else {
      await supabase.from('guests').insert(form)
    }
    setSaving(false)
    setShowForm(false)
    setEditingId(null)
    setForm(blank())
    fetchGuests()
  }

  async function deleteGuest(id: string, name: string) {
    if (!confirm('Remove ' + name + ' from the guest directory?')) return
    await supabase.from('guests').delete().eq('id', id)
    fetchGuests()
  }

  function openEdit(g: Guest) {
    setForm({
      name: g.name,
      email: g.email,
      phone: g.phone,
      site_number: g.site_number,
      is_seasonal: g.is_seasonal,
      season_start: g.season_start,
      season_end: g.season_end,
      notes: g.notes,
      last_visit: g.last_visit,
    })
    setEditingId(g.id)
    setShowForm(true)
  }

  const filtered = guests.filter(g => {
    const matchesSearch = search === '' ||
      g.name.toLowerCase().includes(search.toLowerCase()) ||
      g.email.toLowerCase().includes(search.toLowerCase()) ||
      g.phone.includes(search) ||
      g.site_number.toLowerCase().includes(search.toLowerCase())
    const matchesFilter = filter === 'all' || (filter === 'seasonal' && g.is_seasonal)
    return matchesSearch && matchesFilter
  })

  const seasonalCount = guests.filter(g => g.is_seasonal).length

  return (
    <div style={{ padding: '2rem', maxWidth: 1000, margin: '0 auto', fontFamily: 'sans-serif' }}>

      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '1.5rem', flexWrap: 'wrap', gap: 12 }}>
        <div>
          <h1 style={{ fontSize: 24, fontWeight: 700, margin: 0 }}>Guest Directory</h1>
          <p style={{ color: '#6b7280', margin: '4px 0 0', fontSize: 14 }}>
            {guests.length} guests · {seasonalCount} seasonal
          </p>
        </div>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
          {/* Sync button */}
          <button
            onClick={syncFromReservations}
            disabled={syncing}
            style={{
              background: syncing ? '#e5e7eb' : '#f0fdf4',
              color: syncing ? '#9ca3af' : '#166534',
              border: '1px solid',
              borderColor: syncing ? '#e5e7eb' : '#bbf7d0',
              borderRadius: 8,
              padding: '10px 16px',
              fontWeight: 600,
              cursor: syncing ? 'not-allowed' : 'pointer',
              fontSize: 14,
              display: 'flex',
              alignItems: 'center',
              gap: 6,
            }}
          >
            {syncing ? (
              <>⏳ Syncing...</>
            ) : (
              <>↻ Sync from Reservations</>
            )}
          </button>

          {/* Add Guest button */}
          <button
            onClick={() => { setForm(blank()); setEditingId(null); setShowForm(true) }}
            style={{ background: '#2E6B8A', color: '#fff', border: 'none', borderRadius: 8, padding: '10px 20px', fontWeight: 600, cursor: 'pointer', fontSize: 14 }}
          >
            + Add Guest
          </button>
        </div>
      </div>

      {/* Sync result banner */}
      {syncResult && (
        <div style={{
          background: '#f0fdf4',
          border: '1px solid #bbf7d0',
          borderRadius: 8,
          padding: '12px 16px',
          marginBottom: 16,
          fontSize: 14,
          color: '#166534',
          display: 'flex',
          alignItems: 'center',
          gap: 8,
        }}>
          ✅ Sync complete —
          {syncResult.added > 0 && <strong> {syncResult.added} new guest{syncResult.added !== 1 ? 's' : ''} added</strong>}
          {syncResult.added > 0 && syncResult.updated > 0 && ','}
          {syncResult.updated > 0 && <strong> {syncResult.updated} guest{syncResult.updated !== 1 ? 's' : ''} updated</strong>}
          {syncResult.added === 0 && syncResult.updated === 0 && <strong> already up to date</strong>}
        </div>
      )}

      {/* Search and filter */}
      <div style={{ display: 'flex', gap: 12, marginBottom: 20, flexWrap: 'wrap' }}>
        <input
          style={{ flex: 1, minWidth: 200, border: '1px solid #d1d5db', borderRadius: 8, padding: '9px 14px', fontSize: 14 }}
          placeholder="Search by name, email, phone, or site..."
          value={search}
          onChange={e => setSearch(e.target.value)}
        />
        <div style={{ display: 'flex', gap: 8 }}>
          <button
            onClick={() => setFilter('all')}
            style={{ padding: '9px 18px', fontSize: 13, fontWeight: 600, border: '1px solid', borderColor: filter === 'all' ? '#2E6B8A' : '#e5e7eb', borderRadius: 8, background: filter === 'all' ? '#e8f2f7' : '#fff', color: filter === 'all' ? '#2E6B8A' : '#6b7280', cursor: 'pointer' }}
          >
            All ({guests.length})
          </button>
          <button
            onClick={() => setFilter('seasonal')}
            style={{ padding: '9px 18px', fontSize: 13, fontWeight: 600, border: '1px solid', borderColor: filter === 'seasonal' ? '#2E6B8A' : '#e5e7eb', borderRadius: 8, background: filter === 'seasonal' ? '#e8f2f7' : '#fff', color: filter === 'seasonal' ? '#2E6B8A' : '#6b7280', cursor: 'pointer' }}
          >
            🏡 Seasonal ({seasonalCount})
          </button>
        </div>
      </div>

      {/* Guest form modal */}
      {showForm && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', zIndex: 50, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <div style={{ background: '#fff', borderRadius: 12, padding: '2rem', width: '100%', maxWidth: 520, maxHeight: '90vh', overflowY: 'auto' }}>
            <h2 style={{ margin: '0 0 1.25rem', fontSize: 18, fontWeight: 700 }}>{editingId ? 'Edit Guest' : 'Add Guest'}</h2>

            <label style={lbl}>Name *</label>
            <input style={inp} value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} placeholder="Full name" />

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
              <div>
                <label style={lbl}>Email</label>
                <input style={inp} value={form.email} onChange={e => setForm({ ...form, email: e.target.value })} placeholder="email@example.com" />
              </div>
              <div>
                <label style={lbl}>Phone</label>
                <input style={inp} value={form.phone} onChange={e => setForm({ ...form, phone: e.target.value })} placeholder="(555) 555-5555" />
              </div>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
              <div>
                <label style={lbl}>Site number</label>
                <input style={inp} value={form.site_number} onChange={e => setForm({ ...form, site_number: e.target.value })} placeholder="e.g. 14, C3" />
              </div>
              <div>
                <label style={lbl}>Last visit</label>
                <input style={inp} type="date" value={form.last_visit || ''} onChange={e => setForm({ ...form, last_visit: e.target.value || null })} />
              </div>
            </div>

            <div style={{ display: 'flex', alignItems: 'center', gap: 10, margin: '14px 0 4px' }}>
              <button
                type="button"
                onClick={() => setForm({ ...form, is_seasonal: !form.is_seasonal })}
                style={{ width: 40, height: 22, borderRadius: 11, border: 'none', cursor: 'pointer', backgroundColor: form.is_seasonal ? '#2E6B8A' : '#d1d5db', position: 'relative', flexShrink: 0 }}
              >
                <span style={{ position: 'absolute', top: 3, left: form.is_seasonal ? 21 : 3, width: 16, height: 16, borderRadius: '50%', backgroundColor: 'white', transition: 'left 0.2s' }} />
              </button>
              <label style={{ fontSize: 14, color: '#374151', fontWeight: 500 }}>Seasonal camper</label>
            </div>

            {form.is_seasonal && (
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginTop: 12 }}>
                <div>
                  <label style={lbl}>Season start</label>
                  <input style={inp} type="date" value={form.season_start || ''} onChange={e => setForm({ ...form, season_start: e.target.value || null })} />
                </div>
                <div>
                  <label style={lbl}>Season end</label>
                  <input style={inp} type="date" value={form.season_end || ''} onChange={e => setForm({ ...form, season_end: e.target.value || null })} />
                </div>
              </div>
            )}

            <label style={lbl}>Notes</label>
            <textarea style={{ ...inp, height: 72, resize: 'vertical' }} value={form.notes} onChange={e => setForm({ ...form, notes: e.target.value })} placeholder="Any notes about this guest..." />

            <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', marginTop: 20 }}>
              <button onClick={() => { setShowForm(false); setEditingId(null) }} style={{ background: 'none', border: '1px solid #d1d5db', borderRadius: 8, padding: '9px 18px', cursor: 'pointer', fontSize: 14 }}>Cancel</button>
              <button onClick={save} disabled={saving} style={{ background: '#2E6B8A', color: '#fff', border: 'none', borderRadius: 8, padding: '9px 18px', fontWeight: 600, cursor: 'pointer', fontSize: 14 }}>
                {saving ? 'Saving...' : 'Save Guest'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Guest list */}
      {loading ? (
        <p style={{ color: '#6b7280' }}>Loading guests...</p>
      ) : filtered.length === 0 ? (
        <div style={{ textAlign: 'center', color: '#9ca3af', padding: '3rem 0', fontSize: 14 }}>
          {search ? 'No guests match your search.' : filter === 'seasonal' ? 'No seasonal guests yet.' : 'No guests yet. Click "Sync from Reservations" to auto-populate.'}
        </div>
      ) : (
        <div style={{ border: '1px solid #e5e7eb', borderRadius: 10, overflow: 'hidden', background: '#fff' }}>
          {filtered.map((g, i) => (
            <div
              key={g.id}
              style={{ display: 'flex', alignItems: 'center', gap: 16, padding: '14px 20px', borderBottom: i < filtered.length - 1 ? '1px solid #f3f4f6' : 'none', background: '#fff' }}
              onMouseEnter={e => (e.currentTarget.style.background = '#f9fafb')}
              onMouseLeave={e => (e.currentTarget.style.background = '#fff')}
            >
              {/* Avatar */}
              <div style={{ width: 40, height: 40, borderRadius: '50%', background: g.is_seasonal ? '#e8f2f7' : '#f3f4f6', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 700, fontSize: 15, color: g.is_seasonal ? '#2E6B8A' : '#6b7280', flexShrink: 0 }}>
                {g.name.charAt(0).toUpperCase()}
              </div>

              {/* Info */}
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 2, flexWrap: 'wrap' }}>
                  <span style={{ fontWeight: 600, fontSize: 15 }}>{g.name}</span>
                  {g.is_seasonal && (
                    <span style={{ fontSize: 11, background: '#e8f2f7', color: '#2E6B8A', borderRadius: 4, padding: '2px 7px', fontWeight: 600 }}>🏡 Seasonal</span>
                  )}
                  {g.site_number && (
                    <span style={{ fontSize: 11, background: '#f3f4f6', color: '#6b7280', borderRadius: 4, padding: '2px 7px' }}>Site {g.site_number}</span>
                  )}
                </div>
                <div style={{ fontSize: 12, color: '#6b7280', display: 'flex', gap: 12, flexWrap: 'wrap' }}>
                  {g.email && <span>{g.email}</span>}
                  {g.phone && <span>{g.phone}</span>}
                  {g.last_visit && <span>Last visit: {g.last_visit}</span>}
                  {g.is_seasonal && g.season_start && g.season_end && <span>{g.season_start} → {g.season_end}</span>}
                </div>
                {g.notes && <div style={{ fontSize: 12, color: '#9ca3af', marginTop: 2, fontStyle: 'italic' }}>{g.notes}</div>}
              </div>

              {/* Actions */}
              <div style={{ display: 'flex', gap: 8, flexShrink: 0 }}>
                <button
                  onClick={() => router.push('/admin/folio/guest/' + g.id)}
                  style={{ background: '#2E6B8A', color: '#fff', border: 'none', borderRadius: 7, padding: '6px 14px', fontSize: 13, fontWeight: 600, cursor: 'pointer' }}
                >
                  Account
                </button>
                <button
                  onClick={() => openEdit(g)}
                  style={{ background: 'none', border: '1px solid #e5e7eb', borderRadius: 7, padding: '6px 14px', fontSize: 13, cursor: 'pointer' }}
                >
                  Edit
                </button>
                <button
                  onClick={() => deleteGuest(g.id, g.name)}
                  style={{ background: 'none', border: '1px solid #fee2e2', borderRadius: 7, padding: '6px 14px', fontSize: 13, cursor: 'pointer', color: '#dc2626' }}
                >
                  Remove
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

const lbl: React.CSSProperties = { display: 'block', fontSize: 13, fontWeight: 600, color: '#374151', marginBottom: 4, marginTop: 12 }
const inp: React.CSSProperties = { width: '100%', border: '1px solid #d1d5db', borderRadius: 7, padding: '8px 10px', fontSize: 14, boxSizing: 'border-box' }
