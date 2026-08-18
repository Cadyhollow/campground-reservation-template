@AGENTS.md

# CLAUDE.md — campground-reservation-template

*This file is loaded automatically at the start of every Code session. Read it first. It is the per-repo briefing; the full picture lives in `resonation-ops/OPS.md`.*

## What this repo is
The **blueprint** every new ResoNation client is cloned from. It has no deployment of its own. Changes here define what all future clients run. It carries the full feature set (horizon, closed-season, Square self-serve, terminal recording).

## Never touch
- **Fee model:** `booking-quote.ts`, `pricing.ts`, `ledger.ts`. Any change must show an empty diff against these three.
- Don't hard-code client specifics into code — **customization lives in settings/data** so updates propagate cleanly.

## Rules that bite
- **Server-side is the guard.** Client graying/notices are UX; a crafted request must still be refused server-side. Prove new gates with a crafted-request test.
- **Double-booking is absolute** (never overridable). Overrides (horizon, season) are staff-only, date-bound, and waive only their own gate.
- Schema changes go in the **canonical schema** (`resonation-admin`) **and** a standalone `db/` migration, defined identically.

## Testing
- Route tests run against the **Test Sandbox** tenant (`odcbxxxjdijdwkdyxaeg`) via `.env.local`. Never point them at a production DB.
- Tests must be hermetic — pin the settings they depend on (see `withGates()`); don't rely on the tenant's ambient config.

## Gates (what needs Charissa — never do these autonomously)
- Merging to `main`, deleting anything, handling real secrets/passwords, real-money/hardware tests, product-scope calls. Build on a branch and stop for review.

## On every session
Confirm `pwd` + `git remote -v` + branch before acting. Branch off `main`; never commit to `main` directly.

Note this checkout has **two remotes**: `origin` → `campground-reservation-template` and `tenant` → a client repo. Read the remote name on every push; a push to `tenant` is a push to somebody's park.

---

## Code: the paths (filled 2026-08-18)

### Fee model — empty diff required
- `lib/booking-quote.ts` — `computeBookingQuote()`, `checkDiscount()`, `resolveNightlyRate()`, `cardOnlyFeeShare()`
- `lib/pricing.ts` — `cardSurchargeFor()` and the surcharge/fee arithmetic
- `lib/ledger.ts` — the money ledger
- Guard test: `lib/booking-quote.test.ts`

### Bookability composition chokepoint
- **`lib/bookability.ts`** — one file, and the only place a "can this be booked" answer is composed.
  - `checkBookability()` is the chokepoint: it composes `fetchDateFacts()` / `checkDateFacts()` (double-booking, blocked dates, min-nights via `resolveMinNights()`), the season gate, and the horizon gate.
  - Season: `checkSeasonSpan()` (whole stay, not just arrival), `isNightInSeason()`, `parseMonthDay()` / `monthDayKey()` (hardened parser — don't let it guess).
  - Horizon: `checkHorizon()`, `resolveMaxAdvanceDays()` (NULL ⇒ unlimited), `horizonLastArrival()`, `HORIZON_SERVER_SLACK_DAYS`.
- **Server callers (the real gates):** `app/api/payment/route.ts`, `app/api/manual-booking/route.ts`, `app/api/availability/route.ts`
- **Client callers (UX only — never a gate):** `app/HomeClient.tsx`, `app/book/BookingForm.tsx`, `app/admin/settings/page.tsx`, `app/components/SeasonOverride.tsx`, `app/components/HorizonOverride.tsx`

### The two reservation-insert routes
- `app/api/payment/route.ts` — public/guest path. Charges Square, then inserts. Calls `checkBookability()` **before** the charge.
- `app/api/manual-booking/route.ts` — staff path, gated by `requireRole(request, 'staff')` from `lib/require-role.ts`. Calls `checkHorizon()` + `checkSeasonSpan()` directly, and carries the staff override.
- Adding a date constraint means touching **both**, plus `app/api/availability/route.ts` so the calendar agrees.

### Settings save
- `app/admin/settings/page.tsx` — `handleSave()` (~line 413). This is a **client-side** Supabase write (`supabase.from('settings').update(payload).eq('id', settingsId)`, `.insert(payload)` when no row exists), not an API route — so its only server-side guard is **RLS** (settings: select=staff, insert/update/delete=owner). Validation added here is UX; anything that must hold has to hold in RLS or at the route that reads the setting.
- Read path: `lib/settings-server.ts` → `getSettings()` (cached, server-side).

### Square (self-serve OAuth model)
- Resolver: `lib/square-credentials.ts` → `getSquareCredentials()` — atomically resolves token/location/environment, connection-first with env fallback (`credentialsFromConnection()`, `credentialsFromEnv()`, `needsRefresh()`).
- OAuth/state: `lib/square-oauth.ts`, `lib/square-state.ts`. Terminal: `lib/square-terminal.ts`. Card form: `lib/square-card-client.ts`.
- Every money path goes through the resolver. Don't reintroduce a direct `process.env.SQUARE_ACCESS_TOKEN` read.

### Auth / roles
- `proxy.ts` (Next 16 renamed `middleware.ts` → `proxy.ts` — this repo diverges from Cady here), `lib/admin-auth.ts`, `lib/require-role.ts`, `lib/roles.ts`, `lib/admin-pages.ts`.
- `requireAdmin` is **async** — await it. A new `/api` route is public unless it gates itself.

### Tests
- Run: `npm test` → `node --conditions=react-server --test --test-concurrency=1 --test-timeout=180000 lib/*.test.ts`. **`--test-concurrency=1` is required, not a tuning knob** — two suites spawn `next dev` in this directory and collide otherwise.
- Route-level (spawn a real server, need `.env.local`): `lib/payment-route.test.ts`, `lib/manual-booking-route.test.ts`, `lib/api-auth.test.ts`. They skip themselves without a configured `.env.local` — a skip is not a pass.
- Pure/unit: `lib/bookability.test.ts`, `lib/booking-quote.test.ts`, `lib/cancellation-policy.test.ts`, `lib/refundable.test.ts`, `lib/square-*.test.ts`.
- Hermetic helpers: `withGates()` — `lib/manual-booking-route.test.ts` (~line 94); `withSeason()` — same file (~line 260) and `lib/payment-route.test.ts` (~line 428). These **write settings**, so they are safe only against a test tenant.

### Schema — note the divergence from the doc above
This repo has **no `db/` directory**. Standalone migrations currently live in **`resonation-admin/db/`** (e.g. `2026-08-17-booking-horizon.sql`), alongside the canonical schema in `resonation-admin/app/api/onboard/route.ts` (`DATABASE_SETUP_SQL`). So a schema change today means editing **two places in `resonation-admin`**, not one here. Flagged rather than silently "fixed" — where the standalone migrations should live is Charissa's call.
