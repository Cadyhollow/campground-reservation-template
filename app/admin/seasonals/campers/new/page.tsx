'use client'
import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import toast, { Toaster } from 'react-hot-toast'
import { planAtLeast } from '@/lib/plan'
import { createBrowserSupabase } from '@/lib/supabase-browser'
import { emptyGuestForm, GUEST_FIELD_GROUPS, type GuestRecordForm, noAutofill } from '@/lib/guest-record'

const supabase = createBrowserSupabase()

// NEW CAMPER — THE PERSON, AND ONLY THE PERSON.
//
// ⚠ THIS DELIBERATELY DOES NOT CREATE A CONTRACT, and that is the difference between this form and
// /admin/seasonals/new, which is left exactly as it was.
//
//   this page                → creates the guests row. Full stop. They exist as a person.
//   /admin/seasonals/new     → the counter/kiosk intake: creates the person AND a draft contract
//                              AND walks straight into previewing and signing the packet.
//
// Both are wanted. A camper who telephones in February to say they are coming back is a PERSON;
// which season they end up in is a separate decision made on their page, possibly for two seasons,
// possibly not until the fee is set. Forcing a contract at creation time is what made "add a
// camper" and "enrol a camper" the same act, and left no way to have the first without the second.
//
// The fields come from lib/guest-record.ts — the same list and the same grouping the camper record
// edits — so a column added there appears here without this file being touched.
export default function NewCamperPage() {
  const router = useRouter()
  const [form, setForm] = useState<GuestRecordForm>(emptyGuestForm())
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    supabase.from('settings').select('plan').single().then(({ data }) => {
      if (!planAtLeast(data?.plan, 'summit')) router.replace('/admin')
    })
  }, [router])

  async function save() {
    if (!form.name.trim()) { toast.error('A name is required.'); return }
    setSaving(true)
    // POST /api/seasonals/guest is the single writer for seasonal guest data, and it always sets
    // is_seasonal = true — which is exactly right here, this IS seasonal intake.
    const res = await fetch('/api/seasonals/guest', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: form.name.trim(), email: form.email, phone: form.phone, site_number: form.site_number,
        home_street: form.home_street, home_city: form.home_city,
        home_state: form.home_state, home_zip: form.home_zip,
        camper_type: form.camper_type, camper_length: form.camper_length,
        camper_amperage: form.camper_amperage, camper_make: form.camper_make,
        camper_model: form.camper_model, camper_year: form.camper_year,
      }),
    })
    const d = await res.json()
    setSaving(false)
    if (!res.ok || !d.guest) { toast.error(d.error || 'Could not save the camper.'); return }
    // Straight to their page — which is where adding them to a season lives.
    router.push(`/admin/seasonals/${d.guest.id}`)
  }

  return (
    <div className="p-4 md:p-6 max-w-3xl">
      <Toaster />
      <Link href="/admin/seasonals/campers" className="text-sm text-muted hover:text-ink-soft">← Campers</Link>
      <h2 className="text-2xl font-bold text-ink">New camper</h2>
      <p className="text-sm text-muted mb-4">
        This adds the person. Adding them to a season — which creates their contract — is the next
        step, on their own page.
      </p>

      <div className="bg-card rounded-xl border border-line-soft p-5 mb-4">
        {GUEST_FIELD_GROUPS.map(grp => (
          <div key={grp.title} className="mb-4 last:mb-0">
            <p className="text-xs font-bold uppercase tracking-wide text-muted mb-2">{grp.title}</p>
            <div className="grid gap-3 sm:grid-cols-2">
              {grp.fields.map(f => (
                <div key={f.key} className={f.wide ? 'sm:col-span-2' : ''}>
                  <label className="block text-xs text-muted mb-1">
                    {f.label}{f.key === 'name' && <span className="text-danger"> *</span>}
                  </label>
                  <input
                    type={f.type === 'number' ? 'number' : 'text'}
                    {...noAutofill(f.key)}
                    value={form[f.key]}
                    onChange={e => setForm(prev => ({ ...prev, [f.key]: e.target.value }))}
                    className="w-full rounded-lg border border-line-strong bg-card px-3 py-2 text-sm text-ink"
                  />
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>

      <div className="flex items-center gap-2">
        <button onClick={save} disabled={saving || !form.name.trim()}
          className="px-5 py-2.5 rounded-xl text-sm font-bold text-on-forest disabled:opacity-50"
          style={{ background: 'var(--forest)' }}>
          {saving ? 'Saving…' : 'Create camper'}
        </button>
        <Link href="/admin/seasonals/campers"
          className="px-4 py-2 rounded-xl text-sm font-semibold border border-line text-ink-soft hover:bg-card-2">
          Cancel
        </Link>
        <span className="text-xs text-muted ml-2">
          Signing someone up at the counter, packet and all?{' '}
          <Link href="/admin/seasonals/new" className="font-semibold underline" style={{ color: 'var(--link)' }}>
            Use the full intake form
          </Link>.
        </span>
      </div>
    </div>
  )
}
