-- Seasonal Contracts, Phase 2a: NAMED, REUSABLE SEASONS.
--
-- ── WHAT THIS CHANGES, AND WHAT IT DELIBERATELY DOES NOT ─────────────────────────────────────
--
-- Today every seasonal contract hangs off a bare integer, `season_year`, and the rule "one
-- contract per camper per year" is enforced by
--     seasonal_contracts_guest_id_season_year_key UNIQUE (guest_id, season_year)
-- That rule is exactly what stops a park running a Spring and a Fall season in the same year: the
-- second contract for a camper collides with the first.
--
-- This migration introduces `seasons` as park-level config a park can actually manage, attaches
-- every existing contract to one, and RE-POINTS the uniqueness rule at the season instead of the
-- year. After it, a camper may hold a 2027 Spring AND a 2027 Fall.
--
-- ⚠ NO SCREEN CHANGES BEHAVIOUR ON THIS MIGRATION ALONE. `season_year` is KEPT, as a denormalised
-- mirror of the season's year, because many routes still read it — the list, the camper page, the
-- clone, the create. Phase 2b is what moves them onto seasons, adds the picker, the date
-- auto-fill and the {{season_name}} merge field. Applied on its own this file is invisible to a
-- park: every existing contract keeps its own frozen dates and its own year, and the app keeps
-- reading the column it has always read.
--
-- ── WHY THE BACKFILLED SEASONS HAVE NULL DATES ───────────────────────────────────────────────
--
-- A backfilled season is a container, not a claim about when that season ran. A contract that has
-- already been SENT carries its own frozen season_opens/season_closes — the dates the camper
-- actually signed — and nothing here touches them. Inventing dates for a historical season would
-- be guessing at a legal document's contents. Phase 2b is where a season's dates start seeding a
-- NEW contract, and by then an owner will have set them on the seasons they care about.
--
-- ── SAFE TO RUN ON A LIVE PARK MID-SEASON, AND SAFE TO RE-RUN ────────────────────────────────
--
-- Additive throughout. One new table, one new nullable-then-NOT-NULL column, one constraint swap.
-- No existing column is altered, dropped or rewritten. Every step is guarded:
--   · CREATE TABLE IF NOT EXISTS / ADD COLUMN IF NOT EXISTS / DROP POLICY IF EXISTS
--   · the season backfill inserts a year's season only WHERE NOT EXISTS one already
--   · the link backfill only fills rows still NULL
--   · SET NOT NULL is a no-op when already set — and if any row were somehow still NULL it fails
--     LOUDLY here rather than letting a half-linked table through
--   · the new constraint is added only if it is not already present
--
-- Order matters and is deliberate: table, then column, then backfill, then NOT NULL, then the
-- constraint swap. The old constraint is dropped only AFTER every row has a season_id, so there
-- is no window in which neither rule is protecting the table.

-- ── THE TABLE ────────────────────────────────────────────────────────────────────────────────
--
-- `name`  is the point of the whole feature: "2027 Spring", not "2027".
-- `year`  is kept alongside the name because everything downstream still groups and defaults by
--         year, and because "which year is this season in" should not be parsed out of a name.
-- dates   are NULLABLE. A season an owner has not dated yet is a normal, expected state — see the
--         backfill note above. A NOT NULL DEFAULT here would have invented dates for every
--         historical season, which is the same class of mistake as a defaulted booking horizon.
--
-- NO UNIQUE (year, name) CONSTRAINT, deliberately. It is tempting, but a park mid-rename would be
-- blocked by it for no safety gain, and two seasons that happen to share a name are confusing
-- rather than corrupt. The thing that actually must not collide — a camper twice in one season —
-- is enforced on seasonal_contracts below, where it belongs.
CREATE TABLE IF NOT EXISTS public.seasons (
  id          uuid DEFAULT gen_random_uuid() NOT NULL PRIMARY KEY,
  created_at  timestamptz DEFAULT now() NOT NULL,
  name        text NOT NULL,
  year        integer NOT NULL,
  opens       date,
  closes      date
);

ALTER TABLE public.seasons ENABLE ROW LEVEL SECURITY;

-- ------------------------------------------------------------
-- PERMISSIVE — what each role MAY do
-- ------------------------------------------------------------
-- seasons: select=staff insert=owner update=owner delete=owner
--
-- THE CONFIG POSTURE, copied from `taxes` and `addons`, because that is what a season is: park
-- configuration, not everyday operational work. Deliberately NOT the operational posture
-- (write=staff) that `tasks`, `guests` and `blocked_dates` carry — defining what seasons a park
-- runs is an owner decision, in the same category as defining its taxes.
--
-- Note the API routes that manage seasons run as SERVICE ROLE behind requireRole('manager'), so
-- RLS is the second, independent lock rather than the one the manager UI passes through. It is
-- what protects the table from anything reaching the database directly as `authenticated`.
DROP POLICY IF EXISTS "authenticated select seasons" ON public.seasons;
CREATE POLICY "authenticated select seasons" ON public.seasons
  FOR SELECT TO authenticated USING ((select app.at_least('staff')));
DROP POLICY IF EXISTS "authenticated insert seasons" ON public.seasons;
CREATE POLICY "authenticated insert seasons" ON public.seasons
  FOR INSERT TO authenticated WITH CHECK ((select app.at_least('owner')));
DROP POLICY IF EXISTS "authenticated update seasons" ON public.seasons;
CREATE POLICY "authenticated update seasons" ON public.seasons
  FOR UPDATE TO authenticated USING ((select app.at_least('owner'))) WITH CHECK ((select app.at_least('owner')));
DROP POLICY IF EXISTS "authenticated delete seasons" ON public.seasons;
CREATE POLICY "authenticated delete seasons" ON public.seasons
  FOR DELETE TO authenticated USING ((select app.at_least('owner')));

-- ------------------------------------------------------------
-- RESTRICTIVE — what makes the set above BITE
-- ------------------------------------------------------------
-- ⚠ THE PERMISSIVE AND RESTRICTIVE HALVES ARE NOT DUPLICATES. DO NOT "DEDUPLICATE" THEM. ⚠
-- The permissive half is what GRANTS access; drop it and the seasons list goes blank, loudly. The
-- restrictive half is what ENFORCES the role; drop it and NOTHING BREAKS and the ladder quietly
-- stops biting. The canonical schema carries the long version of this note; this file follows it.
DROP POLICY IF EXISTS "role gate select seasons" ON public.seasons;
CREATE POLICY "role gate select seasons" ON public.seasons
  AS RESTRICTIVE FOR SELECT TO authenticated USING ((select app.at_least('staff')));
DROP POLICY IF EXISTS "role gate insert seasons" ON public.seasons;
CREATE POLICY "role gate insert seasons" ON public.seasons
  AS RESTRICTIVE FOR INSERT TO authenticated WITH CHECK ((select app.at_least('owner')));
DROP POLICY IF EXISTS "role gate update seasons" ON public.seasons;
CREATE POLICY "role gate update seasons" ON public.seasons
  AS RESTRICTIVE FOR UPDATE TO authenticated USING ((select app.at_least('owner'))) WITH CHECK ((select app.at_least('owner')));
DROP POLICY IF EXISTS "role gate delete seasons" ON public.seasons;
CREATE POLICY "role gate delete seasons" ON public.seasons
  AS RESTRICTIVE FOR DELETE TO authenticated USING ((select app.at_least('owner')));

-- ------------------------------------------------------------
-- GRANTS
-- ------------------------------------------------------------
-- GRANTS AND POLICIES ARE INDEPENDENT GATES: a policy is only consulted if the role already holds
-- the table privilege. The canonical schema's schema-wide GRANT ALL ran once, at provisioning —
-- it does NOT reach a table created later by this file — so the grant is stated explicitly here.
GRANT SELECT, INSERT, UPDATE, DELETE ON public.seasons TO authenticated;

-- anon reaches nothing, on this table as on every other (PR 6). The canonical schema's
-- ALTER DEFAULT PRIVILEGES block should already prevent anon being granted anything on a newly
-- created table, but a tenant migrated by hand may predate it, and a grant nobody looked at is
-- exactly the failure that block exists to prevent. Explicit here so this file is correct alone.
REVOKE ALL ON public.seasons FROM anon;
REVOKE ALL ON public.seasons FROM PUBLIC;

-- ── THE LINK ─────────────────────────────────────────────────────────────────────────────────
-- Nullable at first, on purpose: the backfill below is what fills it, and only then is NOT NULL
-- asserted. Adding it NOT NULL up front would fail instantly on any park that has contracts.
ALTER TABLE public.seasonal_contracts
  ADD COLUMN IF NOT EXISTS season_id uuid REFERENCES public.seasons(id);

-- ── BACKFILL, STEP 1: one season per distinct year already in use ────────────────────────────
-- WHERE NOT EXISTS is the re-run guard: a second run of this file finds the year's season already
-- there and inserts nothing. Name matches the auto-default the create/clone routes use, so a
-- season made by the backfill and one made by the app are indistinguishable.
INSERT INTO public.seasons (name, year, opens, closes)
SELECT DISTINCT sc.season_year::text || ' Season', sc.season_year, NULL::date, NULL::date
FROM public.seasonal_contracts sc
WHERE NOT EXISTS (
  SELECT 1 FROM public.seasons s WHERE s.year = sc.season_year
);

-- ── BACKFILL, STEP 2: attach every contract to its year's season ─────────────────────────────
-- `WHERE season_id IS NULL` is the re-run guard AND the safety property: a contract that has
-- already been attached — including one Phase 2b later moves to a different season on purpose —
-- is never re-pointed by a second run of this file.
--
-- ORDER BY created_at, id LIMIT 1 picks the EARLIEST-CREATED season for the year, which is the
-- same "year's default season" rule the create and clone routes apply until Phase 2b's picker
-- replaces it. The id tiebreak makes it deterministic even if two seasons share a timestamp.
UPDATE public.seasonal_contracts sc
SET season_id = (
  SELECT s.id FROM public.seasons s
  WHERE s.year = sc.season_year
  ORDER BY s.created_at, s.id
  LIMIT 1
)
WHERE sc.season_id IS NULL;

-- ── LOCK IT IN ───────────────────────────────────────────────────────────────────────────────
-- A no-op when already set. If any row were somehow still NULL this FAILS HERE, which is the
-- correct outcome: better a migration that stops than a table half-linked to seasons.
ALTER TABLE public.seasonal_contracts
  ALTER COLUMN season_id SET NOT NULL;

-- Postgres does not index a foreign key automatically, and the unique constraint below leads with
-- guest_id, so it cannot serve "every contract in this season" — the query Phase 2b's list is
-- built on. Additive and cheap.
CREATE INDEX IF NOT EXISTS seasonal_contracts_season_id_idx
  ON public.seasonal_contracts (season_id);

-- ── THE CONSTRAINT SWAP — the point of the whole migration ───────────────────────────────────
--
-- Old: UNIQUE (guest_id, season_year) — one contract per camper per YEAR.
-- New: UNIQUE (guest_id, season_id)   — one contract per camper per SEASON.
--
-- This is what lets a camper hold a Spring and a Fall in the same year. Note the new rule is
-- STRICTLY WEAKER than the old one only when a park defines more than one season in a year; for
-- a park with one season per year the two are equivalent, which is why this is safe to apply
-- everywhere and changes nothing until an owner actually defines a second season.
--
-- Dropped only AFTER the backfill, so the table is never unprotected: at every instant either the
-- year rule or the season rule is enforcing "no duplicate contract for this camper".
--
-- The create and clone routes already treat 23505 on this table as "someone else won the race,
-- skip" rather than as an error, so the swap needs no code change to stay correct.
ALTER TABLE public.seasonal_contracts
  DROP CONSTRAINT IF EXISTS seasonal_contracts_guest_id_season_year_key;

-- Guarded rather than DROP-then-ADD: re-running should not rebuild a live unique index for no
-- reason. pg_constraint is the authority on whether it is already there.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.seasonal_contracts'::regclass
      AND conname  = 'seasonal_contracts_guest_id_season_id_key'
  ) THEN
    ALTER TABLE public.seasonal_contracts
      ADD CONSTRAINT seasonal_contracts_guest_id_season_id_key UNIQUE (guest_id, season_id);
  END IF;
END $$;

COMMENT ON TABLE public.seasons IS
  'Park-level named seasons ("2027 Spring"). seasonal_contracts.season_id points here; season_year is kept as a denormalised mirror of seasons.year.';
COMMENT ON COLUMN public.seasonal_contracts.season_id IS
  'The season this contract belongs to. Uniqueness is (guest_id, season_id) — a camper may hold one contract per season, so several in one year.';
