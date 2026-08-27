'use client'
// Read-only informational sections for a seasonal camper. Takes (data, mode) so a
// future camper-facing view can reuse it. mode='admin' shows staff deep-links;
// mode='camper' (not built yet) would hide/redirect them. This component performs
// NO writes — all editing (rig, notes, Send Packet) lives on the admin page.
import Link from 'next/link'
import type { SeasonalGuestData, SeasonalOccupant } from '@/lib/seasonal-types'

type Mode = 'admin' | 'camper'

const fmtMoney = (cents: number) => (cents < 0 ? '−$' : '$') + (Math.abs(cents) / 100).toFixed(2)
const fmtDate = (d: string | null | undefined) =>
  !d ? '—' : new Date(d.length <= 10 ? d + 'T12:00:00' : d).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })

function docBadge(status: string | null) {
  const map: Record<string, { bg: string; color: string; label: string }> = {
    signed: { bg: '#f0fdf4', color: '#15803d', label: '✓ Signed' },
    pending: { bg: '#fffbeb', color: '#b45309', label: 'Sent · unsigned' },
  }
  const s = (status && map[status]) || { bg: '#f3f4f6', color: '#6b7280', label: 'Not sent' }
  return <span style={{ background: s.bg, color: s.color, fontSize: 12, fontWeight: 600, padding: '2px 8px', borderRadius: 999 }}>{s.label}</span>
}

const Section = ({ title, right, children }: { title: string; right?: React.ReactNode; children: React.ReactNode }) => (
  <div className="bg-white rounded-xl border border-gray-100 p-5 mb-4">
    <div className="flex items-center justify-between mb-3">
      <h3 className="text-sm font-bold text-gray-400 uppercase tracking-wide">{title}</h3>
      {right}
    </div>
    {children}
  </div>
)

const Row = ({ label, value }: { label: string; value: React.ReactNode }) => (
  <div className="flex justify-between text-sm py-1"><span className="text-gray-500">{label}</span><span className="font-medium text-gray-900 text-right">{value}</span></div>
)

/** The lanes shown on the camper page, in the order an owner reads them. `other` is deliberately
 *  absent: it is the classifier's catch-all, not a bill a camper is sent, and giving it a line
 *  here would put a heading on money nobody meant to categorise. It still counts in the account
 *  balance below, which is the figure that must never change meaning. */
const LANE_ROWS = [
  { lane: 'electric' as const, label: 'Electric' },
  { lane: 'store' as const, label: 'Store' },
  { lane: 'seasonal' as const, label: 'Seasonal fee' },
]

export default function SeasonalSections({ data, mode }: { data: SeasonalGuestData; mode: Mode }) {
  const lanes = data.lanes || null
  // One rendering of an amount, so a lane line and the account line cannot disagree about what a
  // credit looks like.
  const money = (cents: number) => (
    <span style={{ color: cents > 0 ? '#d97706' : '#15803d' }}>
      {cents < 0 ? 'Credit ' + fmtMoney(-cents) : fmtMoney(cents)}
    </span>
  )
  const g = data.guest || {}
  // Single-line home address, gap-safe (no stray commas): "Street, City, ST ZIP".
  const homeAddressLine = [
    g.home_street,
    [[g.home_city, g.home_state].filter(Boolean).join(', '), g.home_zip].filter(Boolean).join(' '),
  ].filter(Boolean).join(', ')
  const admin = mode === 'admin'
  const current = data.currentContract
  const prior = (data.contracts || []).filter(c => c !== current)
  // Party comes from the most recent SIGNED contract, then this year's contract, and only if
  // there is no contract at all from the guest's STANDING ROSTER (guests.party). A signed
  // contract's party is what was actually agreed, so it keeps winning; the roster is here so a
  // camper who has been entered but never sent a packet does not show an empty Party section.
  const signed = (data.contracts || []).find(c => c.status === 'signed')
  const roster: SeasonalOccupant[] = Array.isArray(g.party) ? g.party : []
  const fromContract: SeasonalOccupant[] | null = signed?.occupants || current?.occupants || null
  const occupants: SeasonalOccupant[] = fromContract ?? roster
  const partyIsRoster = fromContract == null && roster.length > 0
  const rig = current || g // prefer the frozen contract's rig if present, else live guest

  return (
    <div>
      <Section title="Identity">
        <Row label="Name" value={g.name || '—'} />
        <Row label="Email" value={g.email || '—'} />
        <Row label="Phone" value={g.phone || '—'} />
        <Row label="Site" value={g.site_number || '—'} />
        <Row label="Home address" value={homeAddressLine || '—'} />
        <Row label="Seasonal since" value={fmtDate(g.season_start)} />
      </Section>

      <Section title={`Documents · ${data.year}`}>
        {current ? (
          <>
            <Row label="Seasonal agreement" value={docBadge(current.contract_signature?.status ?? (current.status === 'draft' ? null : 'pending'))} />
            <Row label="Liability waiver" value={docBadge(current.waiver_signature?.status ?? (current.status === 'draft' ? null : 'pending'))} />
            {current.packet_id && (
              <div className="mt-2">
                <Link href={`/packet/${current.packet_id}`} target="_blank" className="text-sm font-semibold" style={{ color: 'var(--accent-color, #2E6B8A)' }}>
                  View packet {current.status === 'signed' ? '(signed copy)' : ''} →
                </Link>
              </div>
            )}
          </>
        ) : (
          <p className="text-sm text-gray-500">No {data.year} packet yet.</p>
        )}
        {prior.length > 0 && (
          <div className="mt-3 pt-3 border-t border-gray-100">
            <p className="text-xs font-semibold text-gray-400 uppercase mb-1">Prior years</p>
            {prior.map(c => (
              <div key={c.id} className="flex items-center justify-between text-sm py-1">
                <span className="text-gray-600">{c.season_year}</span>
                <span className="flex items-center gap-2">
                  {docBadge(c.status === 'signed' ? 'signed' : c.status === 'sent' ? 'pending' : null)}
                  {c.packet_id && <Link href={`/packet/${c.packet_id}`} target="_blank" className="text-xs" style={{ color: 'var(--accent-color, #2E6B8A)' }}>view →</Link>}
                </span>
              </div>
            ))}
          </div>
        )}
      </Section>

      <Section title="Money">
        {/* ── PHASE 4 PR 2 ─────────────────────────────────────────────────────────────────
            THE MODE CHANGES THE PRESENTATION, NOT WHAT IS TRACKED. The seasonal fee is posted to
            the folio in BOTH modes, so:
              separated → `data.lanes` is present; show the lanes, with the whole-account total.
              combined  → `data.lanes` is NULL; render the single blended balance exactly as
                          before, which now simply INCLUDES the seasonal charge along with
                          everything else. No special-casing: it is just another line item in the
                          one folio, which is what "everything together" should mean.
            The lane breakdown is purely additive and only a separated park ever sees it. */}
        {lanes ? (
          <>
            {LANE_ROWS.map(({ lane, label }) => (
              <Row key={lane} label={label} value={money(lanes.byLane[lane].balance)} />
            ))}
            {/* Shown HONESTLY rather than folded into a lane. Until the checkout screen lands,
                every payment is recorded against the whole account rather than against one lane,
                so a camper will normally have some sitting here. Silently spreading it across
                the lanes would make each lane's figure a guess. */}
            {lanes.untaggedPayments !== 0 && (
              <Row
                label="Payments not yet assigned"
                value={<span style={{ color: '#15803d' }}>−{fmtMoney(lanes.untaggedPayments)}</span>}
              />
            )}
            <div className="mt-2 pt-2 border-t border-gray-100">
              <Row label="Account balance" value={money(data.balance_cents)} />
            </div>
          </>
        ) : (
          <Row label="Account balance" value={<span style={{ color: data.balance_cents > 0 ? '#d97706' : '#15803d' }}>{data.balance_cents < 0 ? 'Credit ' + fmtMoney(-data.balance_cents) : fmtMoney(data.balance_cents)}</span>} />
        )}
        <Row label="Last payment" value={data.lastPayment ? `${fmtMoney(data.lastPayment.amount - (data.lastPayment.surcharge_amount || 0))} · ${fmtDate(data.lastPayment.paid_at)}` : '—'} />
        {admin && data.folioId && (
          <div className="mt-2"><Link href={`/admin/folio/guest/${g.id}`} className="text-sm font-semibold" style={{ color: 'var(--accent-color, #2E6B8A)' }}>Open folio →</Link></div>
        )}
      </Section>

      <Section title="Rig">
        <Row label="Type" value={rig.camper_type || '—'} />
        <Row label="Length" value={rig.camper_length ? `${rig.camper_length} ft` : '—'} />
        <Row label="Amperage" value={rig.camper_amperage || '—'} />
        <Row label="Make / Model / Year" value={[rig.camper_year, rig.camper_make, rig.camper_model].filter(Boolean).join(' ') || '—'} />
      </Section>

      <Section title="Party">
        {occupants.length > 0 ? (
          <ul className="text-sm text-gray-800 space-y-1">
            {occupants.map((o, i) => (
              <li key={i} className="flex justify-between"><span>{o.name || '—'}</span><span className="text-gray-400 capitalize">{o.kind || ''}</span></li>
            ))}
          </ul>
        ) : <p className="text-sm text-gray-500">No party recorded yet.</p>}
        {partyIsRoster && <p className="text-xs text-gray-400 mt-2">From the camper&rsquo;s standing party — no packet has been sent yet.</p>}
      </Section>

      <Section title="Electric" right={admin ? <Link href="/admin/electric-billing" className="text-xs font-semibold" style={{ color: 'var(--accent-color, #2E6B8A)' }}>Electric billing →</Link> : undefined}>
        {(() => {
          // Phase C2 — voided readings: admin sees them MARKED (audit trail); the
          // camper view hides them entirely (Decision 2d). Component is shared
          // (Mode admin|camper), so branch on `admin` rather than assume the surface.
          const electricRows = (data.electric || []).filter(r => admin || r.voided !== true)
          return electricRows.length > 0 ? (
          <div className="text-sm">
            {electricRows.slice(0, 4).map(r => {
              const isVoided = r.voided === true
              return (
              <div key={r.id} className="flex justify-between py-1 border-b border-gray-50 last:border-0" style={{ opacity: isVoided ? 0.6 : 1 }}>
                <span className="text-gray-600" style={{ textDecoration: isVoided ? 'line-through' : 'none' }}>{r.billing_month || fmtDate(r.created_at)}</span>
                <span className="font-medium text-gray-900" style={{ textDecoration: isVoided ? 'line-through' : 'none' }}>
                  {r.kwh_used != null ? `${r.kwh_used} kWh` : ''}{r.final_amount != null ? ` · ${fmtMoney(r.final_amount)}` : ''}
                  {isVoided && <span style={{ marginLeft: 6, fontSize: 9, fontWeight: 700, letterSpacing: '0.05em', color: '#b91c1c', background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 4, padding: '1px 4px' }}>VOIDED</span>}
                </span>
              </div>
              )
            })}
          </div>
        ) : <p className="text-sm text-gray-500">No electric readings yet.</p>
        })()}
      </Section>

      <Section title="Notes">
        {(data.notes || []).length > 0 ? (
          <div className="space-y-2">
            {(data.notes || []).map(n => (
              <div key={n.id} className="text-sm border-l-2 border-gray-100 pl-3">
                <div className="text-gray-800">{n.body}</div>
                <div className="text-xs text-gray-400">{n.author} · {fmtDate(n.created_at)}</div>
              </div>
            ))}
          </div>
        ) : <p className="text-sm text-gray-500">No notes yet.</p>}
      </Section>
    </div>
  )
}
