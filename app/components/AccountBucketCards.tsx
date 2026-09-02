'use client'
// THE TWO CARDS — a separated park's camper money, as the two accounts staff actually manage:
// the CAMP ACCOUNT (everyday: electric + store + other) and SEASONAL (fee, deposit,
// installments). One balance and one way to pay on each.
//
// ⚠ SEPARATED MODE ONLY. Nothing here is rendered for a combined park; callers gate on
// normalizeBillingMode(...) === 'separated' before reaching for this, and combined mode keeps
// the display it has always had, byte for byte.
//
// ⚠ IT DISPLAYS; IT DOES NOT DECIDE. Every figure comes from accountBuckets(), which re-groups
// laneBalances() and preserves the account total to the cent. This file sums nothing of its own,
// so the two cards can never disagree with the folio they sit above.
//
// ── WHY TWO CARDS AND NOT FOUR ROWS ──────────────────────────────────────────────────────────
//
// The per-lane rows this replaces showed Electric, Store and Seasonal each against their own
// tagged payments — but almost no payment carries a lane (~2% on the live park), so Electric and
// Store showed their full original charges as still owed. A camper who owed $903 read as owing
// thousands. The two-bucket split is exact precisely because it stops asking a question the data
// cannot answer: Seasonal is genuinely tagged, and everything else is the account remainder.
import Link from 'next/link'
import { accountBuckets, type AccountBuckets, type Bucket } from '@/lib/account-buckets'
import { BUCKET_LABEL_DEFAULT } from '@/lib/account-buckets'
import type { LaneBalances } from '@/lib/ledger-lanes'

const fmtMoney = (cents: number) =>
  '$' + (Math.abs(cents) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

/** Per-bucket accent. Camp is the everyday green; Seasonal is the gold this theme reserves for
 *  the season itself. Gold as TEXT uses --gold-ink, which is the contrast-checked variant —
 *  --gold is approved for rules, icons and accents only (see the note in app/globals.css). */
const ACCENT: Record<Bucket, { rule: string; ink: string; soft: string }> = {
  camp: { rule: 'var(--good)', ink: 'var(--good)', soft: 'var(--good-bg)' },
  seasonal: { rule: 'var(--gold)', ink: 'var(--gold-ink)', soft: 'var(--watch-bg)' },
}

export type BucketCardsLabels = Record<Bucket, string>

export type AccountBucketCardsProps = {
  /** Lane balances for this camper. Buckets are derived here so no caller can derive them
   *  differently. Pass null while loading — the cards render their own quiet placeholder. */
  lanes: LaneBalances | null
  /** Owner's wording, from bucketLabels(settings). Defaults when omitted. */
  labels?: BucketCardsLabels
  /** Where each bucket's "Take a payment" goes. Given a bucket so the caller can open the right
   *  door directly rather than dropping staff on a blended screen to choose again. */
  payHref?: (bucket: Bucket) => string
  /** Called instead of navigating, when the caller has the payment modal in the same page. */
  onTakePayment?: (bucket: Bucket) => void
  /** Optional link under the Camp card to its detail view (the folio). */
  folioHref?: string
  /** Compact rendering for the guest directory, where the cards sit inside a list row. */
  dense?: boolean
}

function balanceTone(bucket: Bucket, balance: number) {
  // A credit is good news in either bucket and reads green; an amount owed reads in the bucket's
  // own accent so the two cards stay tellable apart at a glance; settled reads quiet.
  if (balance < 0) return { color: 'var(--good)', text: 'Credit ' + fmtMoney(balance) }
  if (balance === 0) return { color: 'var(--muted)', text: fmtMoney(0) }
  return { color: ACCENT[bucket].ink, text: fmtMoney(balance) }
}

function BucketCard({
  bucket, label, totals, dense, payHref, onTakePayment, folioHref, sub,
}: {
  bucket: Bucket
  label: string
  totals: { charges: number; payments: number; balance: number }
  dense: boolean
  payHref?: (bucket: Bucket) => string
  onTakePayment?: (bucket: Bucket) => void
  folioHref?: string
  sub: string
}) {
  const accent = ACCENT[bucket]
  const tone = balanceTone(bucket, totals.balance)
  const settled = totals.balance === 0

  return (
    <div
      style={{
        background: 'var(--card)', border: '1px solid var(--line)', borderRadius: 16,
        borderTop: `3px solid ${accent.rule}`,
        padding: dense ? '12px 14px' : '16px 18px',
        display: 'flex', flexDirection: 'column', gap: dense ? 6 : 9, minWidth: 0,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 10 }}>
        <span style={{ fontSize: dense ? 12 : 13, fontWeight: 700, letterSpacing: '.04em', textTransform: 'uppercase', color: 'var(--ink-soft)' }}>
          {label}
        </span>
        {settled && (
          <span style={{ fontSize: 11, fontWeight: 700, borderRadius: 999, padding: '2px 8px', background: 'var(--good-bg)', color: 'var(--good)' }}>
            Paid up
          </span>
        )}
      </div>

      <div className="tnum" style={{ fontSize: dense ? 22 : 28, fontWeight: 600, letterSpacing: '-.02em', color: tone.color, lineHeight: 1.1 }}>
        {tone.text}
      </div>

      {!dense && (
        <div style={{ fontSize: 12.5, color: 'var(--muted)' }}>{sub}</div>
      )}

      {(payHref || onTakePayment) && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: dense ? 2 : 4, flexWrap: 'wrap' }}>
          {onTakePayment ? (
            <button
              type="button"
              onClick={() => onTakePayment(bucket)}
              style={{
                appearance: 'none', border: 'none', cursor: 'pointer', fontFamily: 'inherit',
                fontSize: dense ? 12.5 : 13.5, fontWeight: 700, borderRadius: 9,
                padding: dense ? '7px 12px' : '9px 15px',
                background: accent.rule, color: '#fff',
              }}
            >
              Take a payment
            </button>
          ) : (
            <Link
              href={payHref!(bucket)}
              style={{
                display: 'inline-block', textDecoration: 'none',
                fontSize: dense ? 12.5 : 13.5, fontWeight: 700, borderRadius: 9,
                padding: dense ? '7px 12px' : '9px 15px',
                background: accent.rule, color: '#fff',
              }}
            >
              Take a payment
            </Link>
          )}
          {folioHref && (
            <Link href={folioHref} style={{ fontSize: 13, fontWeight: 600, color: 'var(--link)' }}>
              Open folio →
            </Link>
          )}
        </div>
      )}
    </div>
  )
}

export default function AccountBucketCards({
  lanes, labels, payHref, onTakePayment, folioHref, dense = false,
}: AccountBucketCardsProps) {
  const l: BucketCardsLabels = labels ?? BUCKET_LABEL_DEFAULT

  if (!lanes) {
    return (
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 12 }}>
        {(['camp', 'seasonal'] as Bucket[]).map(b => (
          <div key={b} style={{ background: 'var(--card-2)', border: '1px solid var(--line)', borderRadius: 16, padding: '16px 18px', color: 'var(--muted)', fontSize: 13 }}>
            {l[b]} …
          </div>
        ))}
      </div>
    )
  }

  const b: AccountBuckets = accountBuckets(lanes)

  return (
    <div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 12, alignItems: 'stretch' }}>
        <BucketCard
          bucket="camp" label={l.camp} totals={b.camp} dense={dense}
          payHref={payHref} onTakePayment={onTakePayment} folioHref={folioHref}
          sub="Electric, store and everything else"
        />
        <BucketCard
          bucket="seasonal" label={l.seasonal} totals={b.seasonal} dense={dense}
          payHref={payHref} onTakePayment={onTakePayment}
          sub="Season fee, deposit and installments"
        />
      </div>
      {/* ⚠ THE RECONCILIATION, STATED. The two cards always sum to the account balance the folio
          shows — that is the invariant accountBuckets() preserves and account-buckets.test.ts
          pins. Printing it here means a member of staff can check it rather than trust it. */}
      {!dense && (
        <div style={{ marginTop: 10, fontSize: 12.5, color: 'var(--muted)', display: 'flex', justifyContent: 'flex-end', gap: 6 }}>
          <span>Account balance</span>
          <span className="tnum" style={{ fontWeight: 700, color: b.accountBalance > 0 ? 'var(--ink-soft)' : 'var(--good)' }}>
            {b.accountBalance < 0 ? 'Credit ' + fmtMoney(b.accountBalance) : fmtMoney(b.accountBalance)}
          </span>
        </div>
      )}
    </div>
  )
}
