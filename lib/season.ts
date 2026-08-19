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
