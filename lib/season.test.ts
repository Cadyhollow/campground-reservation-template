import { test } from 'node:test'
import assert from 'node:assert/strict'
import { currentSeasonYear } from './season.ts'

// Which season year the seasonals screen OPENS on.
//
// This is a default, not a rule — the screen's year picker overrides it freely. But the default
// is the one that decides what a member of staff is looking at when they are not paying attention,
// and the failure it prevents is sending LAST season's agreement for NEXT season's stay. So the
// boundary is pinned here rather than left to a comment.
//
// `now` is a parameter on the function precisely so this can be tested without touching the clock.

test('January to July default to the CURRENT calendar year', () => {
  for (const month of [0, 1, 2, 3, 4, 5, 6]) {
    assert.equal(
      currentSeasonYear(new Date(2026, month, 15)), 2026,
      `month index ${month} should still be the current season`,
    )
  }
})

test('August to December roll forward to NEXT year', () => {
  // The whole point: renewals go out in late summer for the following season. In September you
  // are working on 2027, not on the 2026 season that has just ended.
  for (const month of [7, 8, 9, 10, 11]) {
    assert.equal(
      currentSeasonYear(new Date(2026, month, 15)), 2027,
      `month index ${month} should have rolled to the next season`,
    )
  }
})

test('the boundary is 1 August, exactly', () => {
  assert.equal(currentSeasonYear(new Date(2026, 6, 31)), 2026, '31 July is still this season')
  assert.equal(currentSeasonYear(new Date(2026, 7, 1)), 2027, '1 August rolls over')
})

test('the rollover crosses the calendar year correctly', () => {
  // 31 December 2026 is working on the 2027 season; 1 January 2027 is still the 2027 season.
  assert.equal(currentSeasonYear(new Date(2026, 11, 31)), 2027)
  assert.equal(currentSeasonYear(new Date(2027, 0, 1)), 2027)
})

test('the cutoff month can be overridden per call', () => {
  // The escape hatch, for a park that renews on a different cycle. October cutoff: September is
  // still the current season, October rolls forward.
  assert.equal(currentSeasonYear(new Date(2026, 8, 15), 9), 2026)
  assert.equal(currentSeasonYear(new Date(2026, 9, 1), 9), 2027)
})

test('a cutoff of 0 rolls forward all year, and 12 never rolls forward', () => {
  // The degenerate ends, pinned so a future "make it configurable" change cannot quietly
  // reinterpret them.
  assert.equal(currentSeasonYear(new Date(2026, 0, 1), 0), 2027, 'cutoff 0 = always next season')
  assert.equal(currentSeasonYear(new Date(2026, 11, 31), 12), 2026, 'cutoff 12 = never rolls')
})
