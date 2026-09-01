// The merge tokens an owner may drop into the ELECTRIC BILL email, and the renderer that fills
// them in.
//
// ⚠ WHY THIS EXISTS, AND WHY IT IS NOT lib/contract-tokens.ts.
//
// The contract catalog serves the seasonal agreement and the packet email: {{total_due}},
// {{season_name}}, {{party_names}}. An electric bill is a different letter about a different
// thing — this month's reading, this month's charge, what they owe now — and offering an owner
// {{payment_schedule}} in an electric bill would be offering a token that renders as nothing.
//
// So: a second, small catalog, built the same way and using the same pure insert helper, so the
// two editors behave identically under the owner's hands.
//
// ⚠ AND A RENDERER, BECAUSE THERE WAS NONE. Before this, the electric email inserted the owner's
// message RAW — `emailMessage.replace(/\n/g, "<br>")` and nothing else. Adding clickable chips
// without a renderer would have been worse than adding nothing: an owner clicks "Camper name",
// and the camper receives an email that says "Hi {{first_name}},". Chips and substitution are one
// feature; shipping half of it puts braces in a real bill.

import { insertAtCursor, tokenText } from './contract-tokens.ts'

export { insertAtCursor, tokenText }

/** One merge token for the electric bill email. */
export type ElectricToken = { key: string; label: string }

/**
 * Every token, in the order an owner reads them: who, where, when, then the money.
 *
 * ⚠ EVERY KEY HERE MUST BE FILLED BY buildElectricVars() BELOW. A token offered but not filled
 * renders as an empty space in a camper's bill, which is the exact silent failure the contract
 * catalog's own header warns about. lib/electric-bill-tokens.test.ts asserts the two agree.
 */
export const ELECTRIC_TOKENS: readonly ElectricToken[] = [
  { key: 'first_name',    label: 'First name' },
  { key: 'name',          label: 'Full name' },
  { key: 'site_number',   label: 'Site number' },
  { key: 'billing_month', label: 'Billing month' },
  { key: 'kwh',           label: 'kWh used' },
  { key: 'amount',        label: 'This charge' },
  { key: 'balance',       label: 'Balance owed' },
] as const

/** What the renderer needs. Everything the bill email already knows, plus kWh. */
export type ElectricVarInput = {
  guestName?: string | null
  siteNumber?: string | null
  billingMonth?: string | null
  kwhUsed?: number | null
  /** This month's electric charge, in cents. */
  amountCents?: number | null
  /** What they owe after it, in cents. */
  balanceCents?: number | null
}

const usd = (cents: number | null | undefined): string =>
  '$' + (Math.abs(Number(cents) || 0) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

/**
 * The values behind the tokens.
 *
 * `first_name` is the first word of the name — good enough for "Hi Ryan," and honest about it.
 * A blank name yields a blank token rather than the word "undefined" in somebody's bill.
 */
export function buildElectricVars(input: ElectricVarInput): Record<string, string> {
  const full = (input.guestName || '').trim()
  return {
    first_name:    full.split(/\s+/)[0] || '',
    name:          full,
    site_number:   (input.siteNumber || '').trim(),
    billing_month: (input.billingMonth || '').trim(),
    kwh:           input.kwhUsed == null ? '' : Number(input.kwhUsed).toLocaleString('en-US', { maximumFractionDigits: 2 }),
    amount:        input.amountCents == null ? '' : usd(input.amountCents),
    // A credit reads as a credit rather than as a negative number in a sentence.
    balance:       input.balanceCents == null ? ''
                   : Number(input.balanceCents) < 0 ? usd(input.balanceCents) + ' credit'
                   : usd(input.balanceCents),
  }
}

/**
 * Fill the owner's message.
 *
 * ⚠ AN UNKNOWN TOKEN IS LEFT ALONE, NOT BLANKED — and that is the one place this deliberately
 * differs from renderTemplate() in lib/contracts.ts. That renderer replaces anything it does not
 * recognise with '', which is right for a contract body the app fully controls. Here the input is
 * a free-text message a park may already have written, possibly years ago, possibly containing
 * braces for reasons of its own. Silently deleting a stretch of somebody's existing bill email on
 * the day this ships would be indefensible; leaving it visible is at worst untidy and is
 * immediately obvious to whoever reads the preview.
 */
export function renderElectricMessage(template: string, vars: Record<string, string>): string {
  if (!template) return ''
  return template.replace(/\{\{\s*([a-z0-9_]+)\s*\}\}/gi, (whole, key: string) => {
    const k = String(key).toLowerCase()
    return Object.prototype.hasOwnProperty.call(vars, k) ? vars[k] : whole
  })
}

/** Convenience: build the vars and render in one step. */
export function renderElectricMessageFor(template: string, input: ElectricVarInput): string {
  return renderElectricMessage(template, buildElectricVars(input))
}

/** Any token in the text that this catalog does not know — surfaced so an owner can see it. */
export function unknownTokensIn(template: string): string[] {
  const known = new Set(ELECTRIC_TOKENS.map(t => t.key))
  const found = new Set<string>()
  for (const m of (template || '').matchAll(/\{\{\s*([a-z0-9_]+)\s*\}\}/gi)) {
    const k = String(m[1]).toLowerCase()
    if (!known.has(k)) found.add(k)
  }
  return [...found]
}
