-- Seasonal redesign PR 2: tell an ACTIVE seasonal camper from one who has left the program.
--
-- ONE COLUMN ON guests. Strictly additive, IF NOT EXISTS, NOT NULL DEFAULT true — which is
-- today's behaviour exactly: before this migration every seasonal camper was, in effect,
-- active, because nothing distinguished them.
--
-- ── WHY A FLAG AND NOT A DELETION ────────────────────────────────────────────────────────────
--
-- A camper who leaves the program is not a camper who never existed. Their signed contracts,
-- their folio, their electric history and their payments all remain true and must stay
-- reachable — an owner asked "did the Nguyens ever settle 2026?" needs to find them. Clearing
-- `is_seasonal` was the only existing way to say "they left", and it is destructive in exactly
-- the wrong way: it removes them from every seasonal screen at once, so the record you need is
-- the record that disappears.
--
-- So: inactive campers stay seasonal, stay listed, and are simply marked. Nothing is deleted.
--
-- ── WHY NOT INFER IT FROM "HAS NO CONTRACT THIS SEASON" ──────────────────────────────────────
--
-- Because that is the other thing this release is fixing. A camper with no contract for the
-- current season is overwhelmingly a camper nobody has enrolled YET — the vanishing-camper bug
-- — not a camper who left. Inferring "inactive" from a missing contract would quietly file the
-- bug's victims under "gone", which is the opposite of surfacing them. The two states are
-- independent and both are shown: an ACTIVE camper who is NOT YET ENROLLED is the one an owner
-- most needs to see.
--
-- ── PROPAGATION ──────────────────────────────────────────────────────────────────────────────
--
-- Existing parks: this file, run per park like every other migration in this directory.
-- Newly-provisioned parks: `database-setup.sql` is the source for DATABASE_SETUP_SQL and is
-- KNOWN-STALE with a standing do-not-propagate note, so it is deliberately NOT touched here.
-- `guests.seasonal_active` therefore joins `settings.occupancy_goal_percent` and
-- `sites.is_seasonal_site` on the list of columns a new park does not get until that separate,
-- scoped job runs. Called out rather than half-done: the default is true, so a park missing the
-- column behaves exactly as it does today, and the UI guards on the column's presence.

ALTER TABLE public.guests
  ADD COLUMN IF NOT EXISTS seasonal_active boolean NOT NULL DEFAULT true;

COMMENT ON COLUMN public.guests.seasonal_active IS
  'Seasonal program membership. true = currently a seasonal camper; false = has left the program but is kept for their history. Independent of is_seasonal (which says they are a seasonal camper at all) and of whether they hold a contract for any given season.';

-- Read path for the directory: every seasonal camper, active first, then by site.
CREATE INDEX IF NOT EXISTS guests_seasonal_active_idx
  ON public.guests (is_seasonal, seasonal_active)
  WHERE is_seasonal = true;
