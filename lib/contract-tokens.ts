// THE MERGE-TOKEN CATALOG — one list, read everywhere a token is offered or explained.
//
// ⚠ WHY THIS FILE EXISTS AT ALL.
//
// The authoritative set of tokens is the keys of `buildContractVars` in lib/contracts.ts. Before
// this, the Settings page ALSO listed them, by hand, as a row of <code> elements. Two lists, one
// truth — and the copy nobody remembers to update is the one an owner reads.
//
// The drift is silent in the worst possible way: `renderTemplate` replaces an unknown token with
// '' and never with the literal text. So a token the catalog forgot, or a token an owner typed
// with a typo, does not error, does not warn, and does not show up in review — it renders as
// nothing at all, in a camper's email, and the first anybody knows is a confused phone call.
//
// So: one exported array, and lib/contract-tokens.test.ts asserts it matches buildContractVars
// key-for-key. Add a var there without adding a label here and the test fails.
//
// Deliberately NOT a framework — an array of {key, label} is the whole thing.

/** One merge token an owner can drop into the contract body or the packet email. */
export type ContractToken = {
  /** The token name, WITHOUT braces. Must be a key of buildContractVars(). */
  key: string
  /** Plain language, for a button an owner clicks. Never the raw key. */
  label: string
}

/**
 * Every token, in the order an owner reads them: who, where, when, money, then the extras.
 *
 * Labels are what a park owner would call the thing, not what the code calls it — the whole
 * point of click-to-insert is that nobody has to know the key exists.
 */
export const CONTRACT_TOKENS: readonly ContractToken[] = [
  { key: 'name',             label: 'Camper name' },
  { key: 'party_names',      label: 'Party members' },
  { key: 'home_address',     label: 'Home address' },
  { key: 'site_number',      label: 'Site number' },
  { key: 'camper_make_year', label: 'Camper make & year' },
  { key: 'season_name',      label: 'Season name' },
  { key: 'year',             label: 'Season year' },
  { key: 'opens',            label: 'Season opens' },
  { key: 'closes',           label: 'Season closes' },
  { key: 'total_due',        label: 'Total due' },
  { key: 'total_due_by',     label: 'Total due by' },
  { key: 'deposit_due',      label: 'Deposit due' },
  { key: 'deposit_due_by',   label: 'Deposit due by' },
  { key: 'charge_note',      label: 'Charge note' },
] as const

/** '{{deposit_due}}' — the text actually inserted into a box. One place builds the braces. */
export const tokenText = (key: string): string => `{{${key}}}`

/**
 * Insert `insert` into `value` at the cursor, returning the new text and where the cursor should
 * land. Pure so it can be tested without a DOM.
 *
 * Spacing is handled so clicking two chips in a row does not produce "{{a}}{{b}}" jammed
 * together, and so a token dropped mid-sentence does not glue itself to the previous word.
 */
export function insertAtCursor(
  value: string,
  selectionStart: number,
  selectionEnd: number,
  insert: string,
): { value: string; cursor: number } {
  const start = Math.max(0, Math.min(selectionStart, value.length))
  const end = Math.max(start, Math.min(selectionEnd, value.length))
  const before = value.slice(0, start)
  const after = value.slice(end)
  // A space before, unless we are at the very start or already after whitespace or an opening
  // bracket. Nothing is added after: the owner is usually mid-sentence and will keep typing.
  const needsSpace = before.length > 0 && !/[\s(\[]$/.test(before)
  const text = (needsSpace ? ' ' : '') + insert
  return { value: before + text + after, cursor: start + text.length }
}

/**
 * The built-in default rendered for display in a placeholder.
 *
 * ⚠ THE DEFAULT CARRIES <strong> TAGS because it is trusted code that goes straight into the
 * email body — a park's own text is HTML-ESCAPED instead (see packetEmailHtml). Showing the raw
 * tags in a placeholder would tell an owner to write HTML, which is exactly what they must not
 * do and what the escaping would turn into literal angle brackets. So the tags are stripped for
 * display only; nothing about the actual default or the escaping changes.
 */
export const stripTagsForDisplay = (html: string): string =>
  html.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim()
