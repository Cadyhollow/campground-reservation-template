-- Reports R3: an OPTIONAL occupancy goal.
--
-- ONE NULLABLE COLUMN ON settings. Strictly additive, IF NOT EXISTS, nothing backfilled, no
-- existing column altered. Every park that runs this migration is unchanged by it until an owner
-- chooses otherwise.
--
-- ── WHY NULL IS THE DEFAULT, AND WHY THAT IS THE WHOLE POINT ─────────────────────────────────
--
-- A fill target is not a neutral piece of configuration. Some owners find one motivating; others
-- find a number they are permanently short of demoralising, particularly in a shoulder season
-- they cannot do anything about. So the forward view ships with NO goal line at all, and the
-- owner opts in.
--
-- NULL means "no goal": no line on the chart, and no week is ever called "behind" against it.
-- ⚠ 0 IS TREATED AS NULL BY THE APPLICATION, deliberately. A stray zero would otherwise be a
-- target that every week clears, quietly marking the whole board "ahead" against a goal nobody
-- set. Clearing the field in the UI writes NULL rather than 0 for the same reason.
--
-- Stored as a whole percent (1-100). Not CHECK-constrained, matching the other soft settings on
-- this table: the range is enforced where it is entered, an out-of-range value degrades safely
-- (the chart clamps), and a constraint here would need a migration to ever change.
--
-- A weekend-vs-midweek split was considered and deliberately left for later — see the PR. One
-- number is enough to be useful, and two would need a UI that explains itself before it earns
-- the extra column.

ALTER TABLE public.settings
  ADD COLUMN IF NOT EXISTS occupancy_goal_percent integer;

COMMENT ON COLUMN public.settings.occupancy_goal_percent IS
  'Optional occupancy target for the Weeks Ahead forward view, as a whole percent (1-100). NULL = the owner has not set a goal: no goal line is drawn and no week is judged against one. The application also reads 0 as "no goal".';
