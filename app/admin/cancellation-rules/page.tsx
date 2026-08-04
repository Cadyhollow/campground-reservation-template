'use client'

import { useEffect, useState } from 'react'
import { supabase } from '@/lib/supabase'
import toast, { Toaster } from 'react-hot-toast'
import {
  CATCH_ALL_START, CATCH_ALL_END, isCatchAllRule,
  DEFAULT_REFUND_PERCENT, DEFAULT_DEADLINE_DAYS, DEFAULT_DEPOSIT_REFUNDABLE,
} from '@/lib/cancellation-policy'

type CancellationRule = {
  id: string
  name: string
  start_date: string
  end_date: string
  deposit_refundable: boolean
  refund_percent: number
  cancellation_deadline_days: number
  policy_text: string
  is_active: boolean
}

// Prefills a NEW rule with the neutral default rather than 90/7. A form that opens already
// filled in with someone else's cancellation fee is how that fee spreads: the numbers look
// authoritative, so they get saved unread. Starting at "full refund" means a park that clicks
// through without thinking has configured nothing surprising.
const emptyRule = {
  name: '',
  start_date: '',
  end_date: '',
  all_dates: false,
  deposit_refundable: DEFAULT_DEPOSIT_REFUNDABLE,
  refund_percent: DEFAULT_REFUND_PERCENT,
  cancellation_deadline_days: DEFAULT_DEADLINE_DAYS,
  policy_text: '',
  is_active: true,
}

export default function CancellationRulesPage() {
  const [rules, setRules] = useState<CancellationRule[]>([])
  const [loading, setLoading] = useState(true)
  const [showForm, setShowForm] = useState(false)
  const [editingRule, setEditingRule] = useState<CancellationRule | null>(null)
  const [form, setForm] = useState(emptyRule)
  const [saving, setSaving] = useState(false)

  const catchAllRule = rules.find(isCatchAllRule) || null
  const hasCatchAll = catchAllRule !== null

  useEffect(() => { fetchRules() }, [])

  async function fetchRules() {
    const { data } = await supabase.from('cancellation_rules').select('*').order('start_date')
    setRules(data || [])
    setLoading(false)
  }

  function openAddForm() { setEditingRule(null); setForm(emptyRule); setShowForm(true) }

  function openEditForm(rule: CancellationRule) {
    setEditingRule(rule)
    setForm({
      name: rule.name,
      // A catch-all reopens with the toggle on and its sentinel dates out of sight, so editing
      // one cannot accidentally turn it back into a rule that expires in the year 2999.
      start_date: isCatchAllRule(rule) ? '' : rule.start_date,
      end_date: isCatchAllRule(rule) ? '' : rule.end_date,
      all_dates: isCatchAllRule(rule),
      deposit_refundable: rule.deposit_refundable,
      refund_percent: rule.refund_percent,
      cancellation_deadline_days: rule.cancellation_deadline_days,
      policy_text: rule.policy_text,
      is_active: rule.is_active,
    })
    setShowForm(true)
  }

  async function handleSave() {
    // Dates are required only for a date-range rule. A catch-all has no dates to ask for —
    // which is exactly why one could not be created here before, and why a park had no way to
    // state its standard policy at all.
    if (!form.name || !form.policy_text || (!form.all_dates && (!form.start_date || !form.end_date))) {
      toast.error('Please fill in all required fields.'); return
    }
    if (!form.all_dates && form.end_date < form.start_date) {
      toast.error('The end date is before the start date.'); return
    }
    // Only one catch-all makes sense: two would resolve by start_date and the loser would be
    // silently dead. Caught here rather than by a constraint so the message can say why.
    const existingCatchAll = rules.find(r => isCatchAllRule(r) && r.id !== editingRule?.id)
    if (form.all_dates && existingCatchAll) {
      toast.error(`"${existingCatchAll.name}" already covers all dates. Edit that rule instead.`); return
    }
    setSaving(true)
    const payload = {
      name: form.name,
      start_date: form.all_dates ? CATCH_ALL_START : form.start_date,
      end_date: form.all_dates ? CATCH_ALL_END : form.end_date,
      deposit_refundable: form.deposit_refundable,
      refund_percent: form.refund_percent,
      cancellation_deadline_days: form.cancellation_deadline_days,
      policy_text: form.policy_text,
      is_active: form.is_active,
    }
    if (editingRule) {
      const { error } = await supabase.from('cancellation_rules').update(payload).eq('id', editingRule.id)
      if (error) { toast.error('Error updating rule.'); setSaving(false); return }
      toast.success('Cancellation rule updated!')
    } else {
      const { error } = await supabase.from('cancellation_rules').insert(payload)
      if (error) { toast.error('Error adding rule.'); setSaving(false); return }
      toast.success('Cancellation rule added!')
    }
    setSaving(false); setShowForm(false); fetchRules()
  }

  async function handleDelete(rule: CancellationRule) {
    if (!confirm(`Delete "${rule.name}"?`)) return
    await supabase.from('cancellation_rules').delete().eq('id', rule.id)
    toast.success('Rule deleted.'); fetchRules()
  }

  async function toggleActive(rule: CancellationRule) {
    await supabase.from('cancellation_rules').update({ is_active: !rule.is_active }).eq('id', rule.id)
    toast.success(`Rule ${!rule.is_active ? 'activated' : 'deactivated'}`); fetchRules()
  }

  return (
    <div className="p-4 md:p-6 max-w-7xl mx-auto">
      <Toaster />
      <div className="flex items-center justify-between mb-6">
        <div>
          <h2 className="text-2xl font-bold text-gray-900">Cancellation Rules</h2>
          <p className="text-sm text-gray-500 mt-1">Set your standard policy once, then add date-specific rules for holidays and peak weekends. A date-specific rule always wins inside its own range.</p>
        </div>
        <button onClick={openAddForm} className="bg-green-700 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-green-800 shrink-0">
          + Add Rule
        </button>
      </div>

      {/* What a booking falls back to when nothing matches. This was invisible: the software
          applied a refund percentage nobody could see, and the page said "higher specificity
          rules override the default" without ever naming the default. A park cannot agree to
          terms it has not been shown. */}
      {!loading && (
        hasCatchAll ? (
          <div className="bg-blue-50 border border-blue-200 rounded-xl px-4 py-3 mb-6 text-sm text-blue-900">
            <span className="font-semibold">Your standard policy is set.</span>{' '}
            &ldquo;{catchAllRule!.name}&rdquo; applies to every booking not covered by a date-specific
            rule{catchAllRule!.is_active ? '' : ' — but it is currently deactivated, so bookings fall back to the built-in default below'}.
          </div>
        ) : (
          <div className="bg-amber-50 border border-amber-200 rounded-xl px-4 py-3 mb-6 text-sm text-amber-900">
            <span className="font-semibold">No standard policy set.</span> Bookings outside every rule
            below currently use the built-in default:{' '}
            <span className="font-medium">
              {DEFAULT_REFUND_PERCENT}% refund
              {DEFAULT_DEADLINE_DAYS > 0 ? ` if cancelled ${DEFAULT_DEADLINE_DAYS}+ days before arrival` : ' up to the arrival date'},
              {' '}deposit {DEFAULT_DEPOSIT_REFUNDABLE ? 'refundable' : 'non-refundable'}
            </span>
            . To set your own, add a rule with &ldquo;Applies to all dates&rdquo; turned on.
          </div>
        )
      )}

      {showForm && (
        <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-6 mb-6">
          <h3 className="text-lg font-semibold text-gray-900 mb-4">{editingRule ? 'Edit Cancellation Rule' : 'Add Cancellation Rule'}</h3>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            <div className="md:col-span-2 lg:col-span-3">
              <label className="block text-sm font-medium text-gray-700 mb-1">Rule Name *</label>
              <input className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm" placeholder="e.g. Holiday Non-Refundable, Standard Policy" value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} />
            </div>
            {/* The catch-all switch. A park's STANDARD policy is not a date range, and until
                this existed the only way to express one was to invent a range wide enough to
                swallow every booking — which nobody would guess to do. */}
            <div className="md:col-span-2 lg:col-span-3 flex items-start gap-3 bg-gray-50 border border-gray-200 rounded-lg px-3 py-2.5">
              <button
                type="button"
                onClick={() => setForm({ ...form, all_dates: !form.all_dates })}
                className="relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 mt-0.5"
                style={{ backgroundColor: form.all_dates ? '#15803d' : '#d1d5db' }}
              >
                <span className="pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow-md transition duration-200"
                  style={{ transform: form.all_dates ? 'translateX(20px)' : 'translateX(0px)' }} />
              </button>
              <div>
                <span className="text-sm font-medium text-gray-700">Applies to all dates (your standard policy)</span>
                <p className="text-xs text-gray-500 mt-0.5">
                  Covers every booking a date-specific rule below doesn&apos;t. Holiday and seasonal
                  rules still take precedence inside their own date ranges.
                </p>
              </div>
            </div>

            {!form.all_dates && (
              <>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Start Date *</label>
                  <input className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm" type="date" value={form.start_date} onChange={e => setForm({ ...form, start_date: e.target.value })} />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">End Date *</label>
                  <input className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm" type="date" value={form.end_date} onChange={e => setForm({ ...form, end_date: e.target.value })} />
                </div>
              </>
            )}
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Cancellation Deadline (days before arrival)</label>
              <input className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm" type="number" min="0" value={form.cancellation_deadline_days} onChange={e => setForm({ ...form, cancellation_deadline_days: parseInt(e.target.value) })} />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Refund Percentage (%)</label>
              <input className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm" type="number" min="0" max="100" value={form.refund_percent} onChange={e => setForm({ ...form, refund_percent: parseInt(e.target.value) })} />
            </div>
            <div className="flex flex-col gap-3 pt-2">
              <div className="flex items-center gap-3">
                <button
                  type="button"
                  onClick={() => setForm({ ...form, deposit_refundable: !form.deposit_refundable })}
                  className="relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200"
                  style={{ backgroundColor: form.deposit_refundable ? '#15803d' : '#d1d5db' }}
                >
                  <span className="pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow-md transition duration-200"
                    style={{ transform: form.deposit_refundable ? 'translateX(20px)' : 'translateX(0px)' }} />
                </button>
                <span className="text-sm font-medium text-gray-700">Deposit is refundable</span>
              </div>
              <div className="flex items-center gap-3">
                <button
                  type="button"
                  onClick={() => setForm({ ...form, is_active: !form.is_active })}
                  className="relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200"
                  style={{ backgroundColor: form.is_active ? '#15803d' : '#d1d5db' }}
                >
                  <span className="pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow-md transition duration-200"
                    style={{ transform: form.is_active ? 'translateX(20px)' : 'translateX(0px)' }} />
                </button>
                <span className="text-sm font-medium text-gray-700">Active</span>
              </div>
            </div>
            <div className="md:col-span-2 lg:col-span-3">
              <label className="block text-sm font-medium text-gray-700 mb-1">Policy Text (shown to customers at checkout) *</label>
              <textarea className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm" rows={3} placeholder="Describe the cancellation policy as customers will see it..." value={form.policy_text} onChange={e => setForm({ ...form, policy_text: e.target.value })} />
            </div>
          </div>
          <div className="flex gap-3 mt-4">
            <button onClick={handleSave} disabled={saving} className="bg-green-700 text-white px-6 py-2 rounded-lg text-sm font-medium hover:bg-green-800 disabled:opacity-50">{saving ? 'Saving...' : editingRule ? 'Save Changes' : 'Add Rule'}</button>
            <button onClick={() => setShowForm(false)} className="bg-gray-100 text-gray-700 px-6 py-2 rounded-lg text-sm font-medium hover:bg-gray-200">Cancel</button>
          </div>
        </div>
      )}

      {loading ? (
        <div className="text-center py-12 text-gray-400">Loading cancellation rules...</div>
      ) : rules.length === 0 ? (
        <div className="bg-white rounded-xl shadow-sm border border-gray-100 px-6 py-12 text-center text-gray-400">
          No cancellation rules yet. Start with your standard policy: click &ldquo;+ Add Rule&rdquo; and turn on &ldquo;Applies to all dates&rdquo;.
        </div>
      ) : (
        <div className="bg-white rounded-xl shadow-sm border border-gray-100 divide-y divide-gray-50">
          {rules.map((rule) => (
            <div key={rule.id} className="px-4 md:px-6 py-4 flex flex-col sm:flex-row sm:items-start gap-3">
              <div className="flex items-start gap-3 flex-1 min-w-0">
                <div className={`w-3 h-3 rounded-full mt-1 shrink-0 ${rule.is_active ? 'bg-green-500' : 'bg-gray-300'}`} />
                <div className="min-w-0">
                  <p className="font-semibold text-gray-900">
                    {rule.name}
                    {isCatchAllRule(rule) && (
                      <span className="ml-2 text-xs font-medium bg-blue-50 text-blue-700 border border-blue-200 rounded-full px-2 py-0.5 align-middle">Default</span>
                    )}
                  </p>
                  <p className="text-sm text-gray-500 mt-0.5">
                    {/* The sentinel range is an implementation detail. Printing "1900-01-01 →
                        2999-12-31" reads like a data-entry accident, not a standard policy. */}
                    {isCatchAllRule(rule) ? 'All dates · applies when no other rule matches' : `${rule.start_date} → ${rule.end_date}`}
                    {' · '}
                    {rule.cancellation_deadline_days > 0
                      ? `Cancel ${rule.cancellation_deadline_days}+ days out for ${rule.refund_percent}% refund`
                      : `${rule.refund_percent}% refund up to the arrival date`}
                    {' · '}Deposit {rule.deposit_refundable ? 'refundable' : 'non-refundable'}
                  </p>
                  <p className="text-sm text-gray-400 mt-1 italic">"{rule.policy_text}"</p>
                </div>
              </div>
              <div className="flex items-center gap-2 flex-wrap shrink-0">
                <button onClick={() => toggleActive(rule)} className={`text-xs px-3 py-1 rounded-full font-medium ${rule.is_active ? 'bg-yellow-100 text-yellow-700 hover:bg-yellow-200' : 'bg-green-100 text-green-700 hover:bg-green-200'}`}>
                  {rule.is_active ? 'Deactivate' : 'Activate'}
                </button>
                <button onClick={() => openEditForm(rule)} className="text-xs px-3 py-1 rounded-full bg-gray-100 text-gray-600 hover:bg-gray-200 font-medium">Edit</button>
                <button onClick={() => handleDelete(rule)} className="text-xs px-3 py-1 rounded-full bg-red-50 text-red-600 hover:bg-red-100 font-medium">Delete</button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
