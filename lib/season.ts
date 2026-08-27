// The season year the app should default to.
//
// new Date().getFullYear() returns the CURRENT calendar year, so once a season has
// closed it would point at the year that just ended — risking last year's agreement
// being sent for next year's renewals. So from a cutoff month onward we roll forward
// to the UPCOMING season.
//
// The cutoff is a constant here — with a per-call override for flexibility.
//
// DELIBERATELY NOT A SETTING, decided 2026-08-19. It only chooses which year the seasonals screen
// OPENS on; the screen's year picker can select any year at any time, so this never blocks or
// prevents anything. Making it configurable would mean a settings column, and the seasonal
// back-port otherwise needs no schema change at all — that is the best property this project has
// and it is not worth spending on a dropdown's default. Revisit if a real client renews on a
// materially different cycle. Upgrade path if a client wants it configurable
// without a deploy: read a settings column server-side and pass it as `cutoffMonth`
// (the client-side picker default would then need that value plumbed through).
const SEASON_YEAR_CUTOFF_MONTH = 7 // 0-indexed → August. On/after Aug 1, roll to next season.

/** The season year to default to: current calendar year before the cutoff month,
 *  next calendar year on/after it. Jan–Jul → this year; Aug–Dec → next year. */
export function currentSeasonYear(now: Date = new Date(), cutoffMonth: number = SEASON_YEAR_CUTOFF_MONTH): number {
  return now.getMonth() >= cutoffMonth ? now.getFullYear() + 1 : now.getFullYear()
}

// ── NAMED SEASONS (Phase 2c) ─────────────────────────────────────────────────────────────────
//
// Ordering and "which season is current" live HERE, pure and shared, rather than in the picker
// component — because the browser screens are not the only caller. /api/seasonals/unsigned-count
// powers a dashboard badge with no season chosen, and it has to resolve "the current season" the
// same way the picker's default does, or the badge counts a different season than the screen
// shows. One implementation, both sides.

/** A season row, as much of it as the ordering and default rules need. */
export type SeasonForPicker = {
  id: string
  name: string
  year: number
  opens?: string | null
  closes?: string | null
}

/**
 * Picker order: year DESCENDING, then open date ascending, then name.
 *
 * Newest year first, so the season an owner is most likely to want is at the top. Within a year,
 * open date ascending puts Spring above Fall — chronological within the year, which is how a park
 * thinks about its own seasons. Undated seasons sort after dated ones rather than jumping to the
 * top, and `name` is the final tiebreak so the order is TOTAL: two seasons that match on
 * everything else never swap places between renders.
 *
 * Returns a new array; does not mutate the input.
 */
export function sortSeasonsForPicker<T extends SeasonForPicker>(seasons: T[]): T[] {
  return [...(seasons || [])].sort((a, b) => {
    if (a.year !== b.year) return b.year - a.year
    // Undated last within the year. '' would sort before any real date, hence the explicit rank.
    const ao = a.opens || '', bo = b.opens || ''
    if (!ao !== !bo) return ao ? -1 : 1
    if (ao !== bo) return ao < bo ? -1 : 1
    const byName = (a.name || '').localeCompare(b.name || '')
    if (byName !== 0) return byName
    return (a.id || '').localeCompare(b.id || '')
  })
}

/** Is `today` (a 'YYYY-MM-DD' string) inside this season's window? Requires BOTH dates — a
 *  half-dated season has no window to be inside of. Inclusive at both ends. */
export function seasonContains(season: SeasonForPicker, today: string): boolean {
  const { opens, closes } = season
  if (!opens || !closes) return false
  return opens <= today && today <= closes
}

/**
 * The season a screen should open on: the one whose window includes TODAY, else the newest by the
 * picker order. Deterministic — never a guess, and never `undefined` when the park has seasons.
 *
 * Ties are impossible to hit ambiguously because sortSeasonsForPicker is a total order: if two
 * seasons both contain today, the earlier-opening one wins, and then the alphabetically first.
 */
export function pickCurrentSeason<T extends SeasonForPicker>(seasons: T[], today: string): T | null {
  const ordered = sortSeasonsForPicker(seasons)
  return ordered.find(s => seasonContains(s, today)) || ordered[0] || null
}

/** 'YYYY-MM-DD' for a Date, in LOCAL time — the same calendar day the park is having. */
export function todayISO(now: Date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`
}

/** "2027 Spring · May 1 – Jun 30", with the date half dropped when the season has no dates. */
export function seasonLabel(season: SeasonForPicker): string {
  const short = (d?: string | null) =>
    d ? new Date(d + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : ''
  const range = [short(season.opens), short(season.closes)].filter(Boolean).join(' – ')
  return range ? `${season.name} · ${range}` : season.name
}
