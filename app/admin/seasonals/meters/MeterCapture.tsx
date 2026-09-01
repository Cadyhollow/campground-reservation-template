'use client'
import { useCallback, useState } from 'react'
import { useRouter } from 'next/navigation'
import { computeMeterUsage, computeElectricCharge, type ElectricRate } from '@/lib/electric-billing'

// THE FIELD SCREEN. One meter at a time, on a phone, outdoors, one-handed.
//
// ── WHAT THE SHAPE IS FOR ────────────────────────────────────────────────────────────────────
//
// It is a full-viewport overlay (position: fixed, inset 0) rather than a page inside the admin
// chrome, and that is a functional decision rather than a cosmetic one: the admin's mobile top
// bar and hamburger are ~52px of target sitting directly above where a thumb reaches, and a
// mis-tap in a field navigates away from a half-finished walk. Covering them removes the target.
//
// ⚠ NOTHING HERE POSTS A CHARGE. Every save is a POST to /api/meter-readings, which records the
// reading and re-derives DRAFT bills. The money path is the Bill Electric button on the Electric
// Billing page and it is not reachable from this screen.
//
// ── WHY A CUSTOM PAD AND NOT <input type="number"> ───────────────────────────────────────────
//
// A numeric input pops the OS keyboard, whose keys are ~30px tall and which covers the usage
// preview — the one figure that tells the reader "that number is wrong" while they are still
// standing at the meter. The pad's keys are 60px+ and the preview stays visible. The value is
// also held as a STRING, so a trailing "." survives while it is being typed and a leading zero
// is not silently eaten.

export type CaptureMeter = {
  meter: { id: string; meter_number: string; label?: string | null; billable_override?: boolean | null }
  siteNumber: string
  camper: { id: string; name: string; site_number: string; email: string } | null
  billable: boolean
  reason: string
  reasonLabel: string
  previousValue: number | null
  previousReadAt: string | null
  reading: {
    id: string; reading_value: number; previous_value: number | null; read_at: string
    is_meter_reset: boolean; reset_start_value: number | null; notes: string
  } | null
}

const fmtMoney = (c: number) => '$' + (c / 100).toFixed(2)
const fmtDate = (d: string | null) =>
  d ? new Date(d + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : null
const fmtNum = (n: number) => n.toLocaleString('en-US', { maximumFractionDigits: 2 })

export default function MeterCapture({
  meters, sessionId, rate, title, subtitle, exitHref, onSaved,
}: {
  meters: CaptureMeter[]
  sessionId: string | null
  rate: ElectricRate
  title: string
  subtitle: string
  exitHref: string
  onSaved?: () => void
}) {
  const router = useRouter()
  const [queue, setQueue] = useState<CaptureMeter[]>(meters)
  // Open on the first meter with no reading yet — resuming a walk should not make somebody tap
  // through the twelve they already did.
  const [index, setIndex] = useState(() => {
    const i = meters.findIndex(m => m.reading === null)
    return i === -1 ? 0 : i
  })
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [skipped, setSkipped] = useState<Set<string>>(new Set())

  const current = queue[index]
  const total = queue.length
  const readCount = queue.filter(m => m.reading !== null).length

  // ── WHAT IS TYPED, KEYED BY METER ────────────────────────────────────────────────────────
  //
  // Entry state is held PER METER rather than as one set of fields reset on navigation. Two
  // reasons, and the second is the one that matters in a field:
  //   · There is no effect syncing fields to the current index, so no cascading render and no
  //     window in which the box shows the previous meter's number.
  //   · A half-typed reading SURVIVES Prev/Next. Tapping Prev to check the last meter and coming
  //     back finds the digits still there, instead of an empty box to re-type from memory.
  //
  // A meter with nothing typed falls back to whatever is already saved for it, so a resumed walk
  // shows the number that was entered before the phone was put away.
  type Entry = { value: string; isReset: boolean; resetStart: string; showReset: boolean }
  const [entries, setEntries] = useState<Record<string, Entry>>({})

  const entryFor = (m: CaptureMeter): Entry => entries[m.meter.id] ?? {
    value: m.reading ? String(m.reading.reading_value) : '',
    isReset: m.reading?.is_meter_reset === true,
    resetStart: m.reading?.reset_start_value != null ? String(m.reading.reset_start_value) : '0',
    showReset: m.reading?.is_meter_reset === true,
  }
  const entry = current ? entryFor(current) : { value: '', isReset: false, resetStart: '0', showReset: false }
  const { value, isReset, resetStart, showReset } = entry

  const setEntry = useCallback((meterId: string, patch: Partial<Entry>, base: Entry) => {
    setEntries(e => ({ ...e, [meterId]: { ...base, ...patch } }))
  }, [])

  const setIsReset = (v: boolean) => current && setEntry(current.meter.id, { isReset: v }, entry)
  const setResetStart = (v: string) => current && setEntry(current.meter.id, { resetStart: v }, entry)
  const setShowReset = (v: boolean) => current && setEntry(current.meter.id, { showReset: v }, entry)

  const parsed = parseFloat(value)
  const hasValue = value !== '' && Number.isFinite(parsed)

  // The live preview, from the SAME engine that computes the bill — see lib/electric-billing.ts.
  // For a camper on two sites this is this meter's share priced alone; the real bill sums their
  // meters and meets the minimum once, which is why the label says "approx".
  //
  // Computed plainly rather than in a useMemo: it is two arithmetic operations, and the manual
  // memo blocked the React Compiler from optimising the component at all.
  const preview = hasValue && current
    ? (() => {
        const kwh = computeMeterUsage(
          current.previousValue ?? 0, parsed,
          { isReset, resetStartValue: parseFloat(resetStart) || 0 }
        )
        return { kwh, amount: computeElectricCharge(kwh, rate).calculatedAmountCents }
      })()
    : null

  function nextValue(v: string, key: string): string {
    if (key === 'del') return v.slice(0, -1)
    if (key === '.') return v.includes('.') ? v : (v === '' ? '0.' : v + '.')
    // A leading zero followed by a digit is a typo, not a number: "0" then "5" is 5.
    if (v === '0') return key
    // A meter face is six or eight digits; a longer string is a stuck key, not a reading.
    if (v.replace('.', '').length >= 12) return v
    return v + key
  }

  function press(key: string) {
    // ⚠ THE PAD IS DEAD WHILE A SAVE IS IN FLIGHT, and this was found on a real slow save rather
    // than reasoned about. A save posts the reading AND re-derives the walk's draft bills, so on a
    // poor signal in a field it can take seconds. Without this guard, digits tapped for the NEXT
    // meter land on the CURRENT one: the screen showed "1300800" for a meter that had saved 1300,
    // and the reader had no way to know which number went to the database.
    if (!current || saving) return
    setError('')
    setEntry(current.meter.id, { value: nextValue(entry.value, key) }, entry)
  }

  async function save(advance: boolean) {
    if (!current || !hasValue) { setError('Enter the number on the meter.'); return }
    setSaving(true); setError('')
    try {
      const res = await fetch('/api/meter-readings', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          meter_id: current.meter.id,
          session_id: sessionId,
          reading_value: parsed,
          is_meter_reset: isReset,
          reset_start_value: isReset ? (parseFloat(resetStart) || 0) : undefined,
        }),
      })
      const data = await res.json()
      if (!res.ok) { setError(data.error || 'Could not save that reading.'); setSaving(false); return }

      // Fold the saved reading back into the queue so the count, the Prev view and the resume
      // point are all correct without a round trip for the whole list.
      setQueue(q => q.map((m, i) => i === index ? { ...m, reading: {
        id: data.reading.id, reading_value: parsed, previous_value: current.previousValue,
        read_at: data.reading.read_at, is_meter_reset: isReset,
        reset_start_value: isReset ? (parseFloat(resetStart) || 0) : null, notes: '',
      } } : m))
      setSkipped(s => { const n = new Set(s); n.delete(current.meter.id); return n })
      onSaved?.()
      setSaving(false)
      if (advance) advanceToNext()
      else router.push(exitHref)
    } catch {
      setError('Could not reach the server. Your reading was not saved — try again.')
      setSaving(false)
    }
  }

  function goTo(i: number) { setError(''); setIndex(i) }

  function advanceToNext() {
    // Prefer the next UNREAD meter after this one, so a resumed walk does not stop on every
    // meter that is already done; fall back to simply the next one at the end of the list.
    const nextUnread = queue.findIndex((m, i) => i > index && m.reading === null && !skipped.has(m.meter.id))
    if (nextUnread !== -1) { goTo(nextUnread); return }
    if (index + 1 < total) { goTo(index + 1); return }
    router.push(exitHref)
  }

  function skip() {
    if (current) setSkipped(s => new Set(s).add(current.meter.id))
    advanceToNext()
  }

  if (!current) {
    return (
      <div style={wrap}>
        <div style={{ margin: 'auto', textAlign: 'center', padding: 24, color: 'var(--muted)' }}>
          <p style={{ fontSize: 16 }}>There are no active meters to read.</p>
          <a href={exitHref} style={linkBtn}>Back</a>
        </div>
      </div>
    )
  }

  const prevLabel = current.previousValue === null
    ? 'No previous reading'
    : `${fmtNum(current.previousValue)}${current.previousReadAt ? ' · ' + fmtDate(current.previousReadAt) : ''}`

  return (
    <div style={wrap}>
      {/* ── Header: where am I, and how do I get out ── */}
      <div style={{ padding: '10px 14px', borderBottom: '1px solid var(--line)', background: 'var(--card)', flexShrink: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
          <a href={exitHref} aria-label="Close and go back" style={{
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            width: 44, height: 44, borderRadius: 10, flexShrink: 0,
            border: '1px solid var(--line-strong)', color: 'var(--ink)', textDecoration: 'none', fontSize: 20,
          }}>✕</a>
          <div style={{ textAlign: 'center', minWidth: 0, flex: 1 }}>
            <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--ink)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{title}</div>
            <div style={{ fontSize: 11, color: 'var(--muted)' }}>{subtitle}</div>
          </div>
          <div className="tnum" style={{ fontSize: 15, fontWeight: 700, color: 'var(--forest)', flexShrink: 0, minWidth: 62, textAlign: 'right' }}>
            {readCount} / {total}
          </div>
        </div>
        <div style={{ height: 4, background: 'var(--line-soft)', borderRadius: 999, marginTop: 8, overflow: 'hidden' }}>
          <div style={{ height: '100%', width: `${total ? (readCount / total) * 100 : 0}%`, background: 'var(--forest)', transition: 'width .2s' }} />
        </div>
      </div>

      {/* ── The meter ── */}
      <div style={{ flex: 1, overflowY: 'auto', padding: '14px 16px', minHeight: 0 }}>
        <div style={{ textAlign: 'center' }}>
          <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: '.09em', textTransform: 'uppercase', color: 'var(--muted)' }}>
            {current.meter.label ? 'Meter' : 'Meter · Site'}
          </div>
          <div className="font-display" style={{ fontSize: 52, fontWeight: 700, lineHeight: 1.05, color: 'var(--ink)' }}>
            {current.meter.meter_number}
          </div>
          {current.meter.label ? (
            <div style={{ fontSize: 15, color: 'var(--ink-soft)', marginTop: 2 }}>{current.meter.label}</div>
          ) : null}

          {/* Whose meter — the fact that decides whether this reading becomes money. */}
          <div style={{
            marginTop: 10, display: 'inline-block', maxWidth: '100%',
            background: current.billable ? 'var(--good-bg)' : 'var(--card-2)',
            color: current.billable ? 'var(--good)' : 'var(--muted)',
            border: '1px solid ' + (current.billable ? 'var(--good)' : 'var(--line)'),
            borderRadius: 999, padding: '5px 13px', fontSize: 13, fontWeight: 600,
          }}>
            {current.camper ? current.camper.name : 'No seasonal camper'}
          </div>
          <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 5 }}>{current.reasonLabel}</div>
        </div>

        {/* Previous reading — what this one carries from. */}
        <div style={{
          marginTop: 14, background: 'var(--card)', border: '1px solid var(--line)',
          borderRadius: 12, padding: '10px 14px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10,
        }}>
          <span style={{ fontSize: 12, fontWeight: 700, letterSpacing: '.06em', textTransform: 'uppercase', color: 'var(--muted)' }}>Previous</span>
          <span className="tnum" style={{ fontSize: 14, fontWeight: 600, color: 'var(--ink-soft)', textAlign: 'right' }}>{prevLabel}</span>
        </div>

        {/* This reading. */}
        <div style={{
          marginTop: 10, background: 'var(--card)', border: '2px solid var(--forest)',
          borderRadius: 12, padding: '12px 16px', textAlign: 'center',
        }}>
          <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: '.08em', textTransform: 'uppercase', color: 'var(--muted)' }}>
            Reading now
          </div>
          <div className="tnum" aria-live="polite" style={{
            fontSize: 42, fontWeight: 700, lineHeight: 1.15, minHeight: 50,
            color: hasValue ? 'var(--ink)' : 'var(--muted)',
          }}>
            {value === '' ? '—' : value}
          </div>
        </div>

        {/* Meter replacement. Folded away, because it is rare and its controls must not compete
            with the number pad — but reachable in one tap when a meter has actually been swapped. */}
        <div style={{ marginTop: 12 }}>
          {!showReset ? (
            <button type="button" onClick={() => setShowReset(true)} style={{
              width: '100%', minHeight: 44, background: 'none', border: '1px dashed var(--line-strong)',
              borderRadius: 10, color: 'var(--link)', fontSize: 13, fontWeight: 600, cursor: 'pointer',
            }}>
              This meter was replaced
            </button>
          ) : (
            <div style={{ background: 'var(--card)', border: '1px solid var(--watch)', borderRadius: 12, padding: 12 }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer', minHeight: 44 }}>
                <input type="checkbox" checked={isReset} onChange={e => setIsReset(e.target.checked)}
                  style={{ width: 22, height: 22, flexShrink: 0 }} />
                <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--ink)' }}>The physical meter was swapped</span>
              </label>
              {isReset ? (
                <div style={{ marginTop: 10 }}>
                  <label style={{ display: 'block', fontSize: 12, fontWeight: 600, color: 'var(--ink-soft)', marginBottom: 4 }}>
                    What the NEW meter read when it went in
                  </label>
                  <input inputMode="decimal" value={resetStart} onChange={e => setResetStart(e.target.value.replace(/[^\d.]/g, ''))}
                    style={{ width: '100%', minHeight: 48, borderRadius: 10, border: '1px solid var(--line-strong)', padding: '0 12px', fontSize: 17 }} />
                  <p style={{ fontSize: 11, color: 'var(--muted)', margin: '7px 0 0', lineHeight: 1.45 }}>
                    Usage is measured on the new meter alone, so the swap does not read as a huge jump.
                    Power used on the OLD meter since its last reading is not captured here — add it on the
                    Electric Billing page if you noted it down.
                  </p>
                </div>
              ) : (
                <button type="button" onClick={() => setShowReset(false)} style={{
                  marginTop: 8, background: 'none', border: 'none', color: 'var(--link)', fontSize: 13, fontWeight: 600, cursor: 'pointer', padding: '8px 0',
                }}>Never mind</button>
              )}
            </div>
          )}
        </div>

        {error ? (
          <div role="alert" style={{
            marginTop: 12, background: 'var(--danger-bg)', border: '1px solid var(--danger)',
            color: 'var(--danger)', borderRadius: 10, padding: '10px 12px', fontSize: 13, fontWeight: 600,
          }}>{error}</div>
        ) : null}
      </div>

      {/* ── The pad, pinned to the bottom where a thumb is ── */}
      <div style={{ flexShrink: 0, borderTop: '1px solid var(--line)', background: 'var(--card)', padding: '8px 8px calc(8px + env(safe-area-inset-bottom))' }}>
        {/* ── THE LIVE USAGE PREVIEW, PINNED ─────────────────────────────────────────────────
            ⚠ THIS SITS IN THE FIXED FOOTER, NOT IN THE SCROLLING AREA ABOVE, and that placement
            is the whole point of it. It is the figure that says "you typed a digit wrong" while
            the reader is still standing at the meter. In the scrolling region it was pushed under
            the pad on a short viewport and had to be scrolled to — which is the same as not being
            there, because nobody scrolls to check a number they think they typed correctly.
            Here it is directly above the keys, in view on every screen size. */}
        <div style={{ minHeight: 40, marginBottom: 7, textAlign: 'center' }}>
          {current.billable && preview ? (
            <div style={{ background: 'var(--watch-bg)', border: '1px solid var(--watch)', borderRadius: 10, padding: '7px 12px' }}>
              <span className="tnum" style={{ fontSize: 17, fontWeight: 700, color: 'var(--ink)' }}>{fmtNum(preview.kwh)} kWh</span>
              <span style={{ color: 'var(--muted)', margin: '0 7px' }}>·</span>
              <span className="tnum" style={{ fontSize: 17, fontWeight: 700, color: 'var(--watch)' }}>{'\u2248'} {fmtMoney(preview.amount)}</span>
              {current.camper && (current.camper.site_number || '').includes(',') ? (
                <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 2, lineHeight: 1.35 }}>
                  This meter alone — {current.camper.name} has more than one, and the bill sums them.
                </div>
              ) : null}
            </div>
          ) : current.billable ? (
            <div style={{ fontSize: 13, color: 'var(--muted)', paddingTop: 10 }}>Enter the reading to see usage.</div>
          ) : (
            <div style={{ background: 'var(--card-2)', border: '1px solid var(--line)', borderRadius: 10, padding: '7px 12px', fontSize: 13, color: 'var(--muted)' }}>
              Record only · kept in history
            </div>
          )}
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 7 }}>
          {['1','2','3','4','5','6','7','8','9','.','0','del'].map(k => (
            <button key={k} type="button" onClick={() => press(k)} disabled={saving}
              aria-label={k === 'del' ? 'Delete last digit' : k}
              style={{
                minHeight: 60, borderRadius: 12, border: '1px solid var(--line-strong)',
                background: k === 'del' ? 'var(--card-2)' : 'var(--card)', color: 'var(--ink)',
                fontSize: 24, fontWeight: 600, cursor: saving ? 'default' : 'pointer',
                touchAction: 'manipulation', fontVariantNumeric: 'tabular-nums',
                // Dimmed rather than merely inert, so a pad that ignores a tap looks busy
                // rather than broken.
                opacity: saving ? 0.45 : 1,
              }}>
              {k === 'del' ? '⌫' : k}
            </button>
          ))}
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1.6fr', gap: 7, marginTop: 7 }}>
          <button type="button" onClick={() => goTo(Math.max(0, index - 1))} disabled={index === 0 || saving}
            style={{ ...secondaryBtn, opacity: index === 0 ? 0.45 : 1 }}>
            Prev
          </button>
          <button type="button" onClick={skip} disabled={saving} style={secondaryBtn}>Skip</button>
          <button type="button" onClick={() => save(true)} disabled={!hasValue || saving}
            style={{
              minHeight: 56, borderRadius: 12, border: 'none', cursor: hasValue && !saving ? 'pointer' : 'default',
              background: 'var(--forest)', color: 'var(--on-forest)', fontSize: 16, fontWeight: 700,
              opacity: !hasValue || saving ? 0.5 : 1, touchAction: 'manipulation',
            }}>
            {saving ? 'Saving…' : 'Save & next'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ⚠ FIXED AND FULL-VIEWPORT ON PURPOSE — see the note at the top of this file. `100dvh` rather
// than `100vh` so mobile Safari's collapsing address bar does not push the pad off-screen.
const wrap: React.CSSProperties = {
  position: 'fixed', inset: 0, zIndex: 60,
  display: 'flex', flexDirection: 'column',
  height: '100dvh', background: 'var(--paper)', color: 'var(--ink)',
  overscrollBehavior: 'contain',
}

const secondaryBtn: React.CSSProperties = {
  minHeight: 56, borderRadius: 12, border: '1px solid var(--line-strong)',
  background: 'var(--card)', color: 'var(--ink)', fontSize: 15, fontWeight: 600,
  cursor: 'pointer', touchAction: 'manipulation',
}

const linkBtn: React.CSSProperties = {
  display: 'inline-block', marginTop: 14, padding: '12px 22px', borderRadius: 10,
  background: 'var(--forest)', color: 'var(--on-forest)', textDecoration: 'none', fontWeight: 700,
}
