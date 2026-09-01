// The Electric Billing card: what state a camper's row is in, and which actions it offers.
//
// ── WHY THIS IS A SEPARATE, PURE MODULE ──────────────────────────────────────────────────────
//
// The redesign moves most per-camper controls out of a row of eight buttons and into a "⋯" menu.
// That is a presentation change, and it must not quietly become a capability change: every action
// the old page could do, the new one must still do. Keeping the menu as DATA rather than as JSX
// makes that checkable — a test can assert the menu still offers every action, and which handler
// each one runs, without rendering anything.
//
// It is also the piece most likely to be re-tuned. Which actions are primary and which are in the
// menu is a judgement about how a park works, not a fact about the code, so it lives in one list
// that can be reordered without touching the page.
//
// ⚠ NOTHING HERE TOUCHES MONEY. This module decides what to SHOW and what to CALL. Every action
// dispatches to the page's existing handler, unchanged — see ACTION_HANDLER_NOTES below.

/** The four states a card can be in. Drives the left-edge status spine and the primary button. */
export type CardStatus = 'ready' | 'attention' | 'billed' | 'manual'

/** Only what the status and menu rules actually read. Deliberately not the whole CamperRow. */
export type CardRow = {
  /** A bill has been posted for this camper this month. */
  sent: boolean
  /** The owner marked them "don't bill this month". */
  skip: boolean
  hasEmail: boolean
  /** A payment has been recorded in this session, so a receipt can be sent for it. */
  hasRecordedPayment: boolean
  /** The reading looks off — the existing anomaly guard fired. */
  anomaly: boolean
  /** The owner has looked at the anomaly and chosen to proceed. */
  anomalyAcknowledged: boolean
  /** How many meter lines a walk staged. 0 = the amount was set by hand. */
  meterLines: number
  /** The amount as typed, '' when blank. */
  finalAmount: string
  /**
   * The camper's unpaid folio balance in cents, as the folio already holds it.
   *
   * ⚠ READ-ONLY, AND NOT RECOMPUTED HERE. This is the figure fetchCampers() already reads off the
   * folio (charges minus completed payments). Negative means a credit. It is DISTINCT from the
   * big number on the card, which is this month's charge — a camper can owe nothing this month
   * and still carry a balance from last.
   */
  balanceCents: number
}

/**
 * Which state this card is in.
 *
 * ⚠ ORDER IS THE POINT. Billed wins over everything — a posted bill is settled and its card
 * should recede whatever else is true of it. Attention comes next so an odd reading is never
 * hidden behind "manual". Manual then marks a bill whose amount was set by hand rather than
 * measured, which is how this park already handles a meter read by a separate device.
 */
export function cardStatus(row: CardRow): CardStatus {
  if (row.sent) return 'billed'
  if (row.anomaly && !row.anomalyAcknowledged) return 'attention'
  // No meter lines and an amount present means somebody typed the figure in. A row with no lines
  // AND no amount is simply not filled in yet, and is 'ready' (its Bill button stays disabled by
  // the page, exactly as before).
  if (row.meterLines === 0 && row.finalAmount.trim() !== '') return 'manual'
  return 'ready'
}

/** What the one primary button says, per state. */
export function primaryLabel(status: CardStatus): string {
  switch (status) {
    case 'billed':    return 'Billed'
    // ⚠ "Review", not "Bill". The anomaly guard already refuses to post this row in one click;
    // the button should say what it will actually do rather than promise a bill and then refuse.
    case 'attention': return 'Review'
    default:          return 'Bill'
  }
}

// ── THE MENU ─────────────────────────────────────────────────────────────────────────────────
//
// ⚠ EVERY ACTION THE OLD PAGE HAD IS IN THIS LIST OR IS THE PRIMARY BUTTON. The old page showed,
// in one row: Bill Electric · Send Statement · "wrong email?" · Record Payment / Prepay ·
// Send Receipt · View History · Skip. Nothing was dropped in the redesign — the loud ones stayed
// on the card and the rest moved here.

export type MenuActionId =
  | 'folio-receipt'
  | 'resend'
  | 'resend-other-email'
  | 'adjust'
  | 'payment'
  | 'history'
  | 'dont-bill'
  | 'do-bill'

export type MenuAction = {
  id: MenuActionId
  label: string
  /** A single glyph, kept out of the label so the label stays translatable. */
  icon: string
  /** 'warn' renders in the muted red the old Skip button used. */
  tone?: 'warn'
  /** Draw a separator above this item. */
  dividerBefore?: boolean
  /** Whether this action makes sense for this row right now. */
  available: (row: CardRow) => boolean
  /** Why it is hidden, for the test that proves nothing vanished by accident. */
  hiddenWhen?: string
}

/**
 * The menu, in order.
 *
 * ⚠ THE PREDICATES MIRROR THE OLD PAGE'S CONDITIONS EXACTLY — they hide the same things the old
 * buttons hid, and nothing more. "Send another copy" was disabled without an email; "Open folio &
 * send receipt" only appeared once a payment had been recorded; Skip was hidden on a billed row.
 * Where the old page merely disabled a control, this hides it, which is the one presentational
 * liberty taken — a menu of greyed-out items is harder to read than a shorter menu.
 */
export const CARD_MENU: readonly MenuAction[] = [
  {
    id: 'folio-receipt',
    label: 'Open folio & send receipt',
    icon: '◫',
    // The receipt is sent from the folio, as it is today — this opens that screen.
    available: () => true,
  },
  {
    id: 'resend',
    label: 'Send another copy',
    icon: '⇢',
    available: r => r.hasEmail,
    hiddenWhen: 'the camper has no email on file',
  },
  {
    id: 'resend-other-email',
    label: 'Send to a different email…',
    icon: '✉',
    // The old page's "wrong email?" link. Kept because a statement that bounced is exactly when
    // somebody needs it, and it was the only way to reach a corrected address.
    available: () => true,
  },
  {
    id: 'adjust',
    label: 'Adjust & re-bill',
    icon: '✎',
    dividerBefore: true,
    available: r => r.sent,
    hiddenWhen: 'the bill has not been posted yet — edit it in place instead',
  },
  {
    id: 'payment',
    label: 'Take a payment',
    icon: '＄',
    available: () => true,
  },
  {
    id: 'history',
    label: 'View billing history',
    icon: '▤',
    // The old "View History" button: past readings, payments, and the per-payment receipt resend.
    available: () => true,
  },
  {
    id: 'dont-bill',
    label: "Don't bill this month",
    icon: '⊘',
    tone: 'warn',
    dividerBefore: true,
    available: r => !r.sent && !r.skip,
    hiddenWhen: 'already billed, or already set to not bill',
  },
  {
    id: 'do-bill',
    label: 'Bill this month after all',
    icon: '↺',
    dividerBefore: true,
    available: r => !r.sent && r.skip,
    hiddenWhen: 'the row is not currently set to skip',
  },
]

/** The menu for one row. */
export function menuFor(row: CardRow): MenuAction[] {
  return CARD_MENU.filter(a => a.available(row))
}

/**
 * WHICH EXISTING HANDLER EACH MENU ITEM RUNS.
 *
 * Kept next to the menu so the mapping is reviewable in one place, and asserted by a test. The
 * redesign relocates controls; it reimplements none of them.
 */
export const ACTION_HANDLER_NOTES: Record<MenuActionId, string> = {
  'folio-receipt':     'navigates to /admin/folio/guest/<id> — where receipts are sent, as today',
  'resend':            'resendBill(i) — the existing resend, never creates a charge',
  'resend-other-email':'resendBill(i, address) — the old "wrong email?" path',
  'adjust':            'reopens the inline edit panel on a billed row (the existing edit path)',
  'payment':           'the existing payment panel → recordPayment(i), or the folio for a card',
  'history':           'loadHistory(i) — the existing per-camper history',
  'dont-bill':         'toggleSkip(i) — the existing skip control',
  'do-bill':           'toggleSkip(i) — the same control, toggled back',
}

/** The counts behind the filter tabs and the summary line. */
export function tallyCards(rows: CardRow[]): { ready: number; attention: number; billed: number; owing: number; everyone: number } {
  let ready = 0, attention = 0, billed = 0, owing = 0
  for (const r of rows) {
    const s = cardStatus(r)
    if (s === 'billed') billed++
    else if (s === 'attention') attention++
    else ready++   // 'ready' and 'manual' are both awaiting a decision
    // Counted separately, not instead: owing overlaps every status by design.
    if (owesBalance(r)) owing++
  }
  return { ready, attention, billed, owing, everyone: rows.length }
}

export type CardFilter = 'ready' | 'attention' | 'billed' | 'owing' | 'everyone'

/** Does this camper owe money right now? A credit or a zero balance is not owing. */
export const owesBalance = (row: CardRow): boolean => row.balanceCents > 0

/** ⚠ A PURE VIEW FILTER. It hides cards; it never changes what Send All posts. */
export function matchesFilter(row: CardRow, filter: CardFilter): boolean {
  if (filter === 'everyone') return true
  const s = cardStatus(row)
  if (filter === 'billed') return s === 'billed'
  if (filter === 'attention') return s === 'attention'
  // ⚠ 'owing' CUTS ACROSS THE OTHERS. A camper who owes may be ready, billed or flagged — the
  // question "who owes me money" is not the same question as "what is left to send", so this tab
  // deliberately ignores the card's status.
  if (filter === 'owing') return owesBalance(row)
  return s === 'ready' || s === 'manual'
}
