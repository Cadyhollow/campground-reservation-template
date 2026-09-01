-- Meter billing: drop "Always", widen "Auto" to seasonal OR monthly.
--
-- Folds into the meter-reading feature (2026-09-01-meter-readings.sql). Run it after that one.
--
-- ── WHAT CHANGED, AND WHY THERE IS ALMOST NOTHING HERE ───────────────────────────────────────
--
-- The billing setting on a meter was three-valued:
--
--     billable_override   NULL = decide from occupancy | TRUE = always bill | FALSE = never bill
--
-- "Always" is gone. It read as "always bill", but a bill is a CHARGE ON A CAMPER'S FOLIO — so a
-- meter with nobody on its site has nothing to bill and no amount of forcing changes that. Under
-- the park's policy (electric is billed to seasonal and monthly campers, never to nightly ones
-- whose power is already inside their rate, never to empty sites) there is no case it serves.
--
-- It only ever looked useful because Auto appeared to check `is_seasonal` alone, so a MONTHLY
-- camper seemed to need forcing. That was the real gap. Widening Auto to seasonal-or-monthly is
-- the fix, and it lives in application code — lib/meters.ts, resolveBillable() — because it reads
-- columns that already exist (`guests.is_monthly`, which the Reports screen already pairs with
-- `is_seasonal` the same way). NO SCHEMA CHANGE IS NEEDED FOR IT.
--
-- So this file does exactly one thing: makes sure no meter is left holding a value the product no
-- longer has a button for.
--
-- ── SAFE TO RUN ON A LIVE PARK, AND SAFE TO RE-RUN ───────────────────────────────────────────
--
-- One UPDATE, scoped to rows holding the removed value, moving them to the DEFAULT state rather
-- than to the restrictive one. Re-running touches nothing because no row matches the second time.
-- No column is added, altered or dropped. No money is written or read.
--
-- ⚠ TRUE -> NULL (Auto), NOT TRUE -> FALSE. A meter that somebody had forced ON was one they
-- wanted billed; moving it to "Don't bill" would silently stop billing a camper who has been
-- billed every month until now. Auto is also what the code does with a surviving TRUE — see the
-- defensive note below — so the data and the behaviour agree either way.
--
-- ⚠ THE CODE DOES NOT DEPEND ON THIS MIGRATION HAVING RUN. resolveBillable() treats any
-- `billable_override = true` it still finds as Auto, and the API refuses to write a new one. A
-- removed value must not be able to resurrect removed behaviour from an old row, a restored
-- backup, or a park whose migrations are behind. This file tidies the data; the code is what
-- makes the tidying non-load-bearing.
--
-- Expected effect on the live park: zero rows. The meter registry ships with this feature, so no
-- park has had time to set "Always" on anything. Written to run correctly rather than because
-- anything is known to need it.

UPDATE public.meters
   SET billable_override = NULL
 WHERE billable_override IS TRUE;

COMMENT ON COLUMN public.meters.billable_override IS
  'NULL = Auto: bill the site''s current camper when they are seasonal or monthly AND their electric billing is on. FALSE = Don''t bill: record the reading, never bill it. TRUE is a REMOVED value ("Always") — the API refuses to write one and resolveBillable() reads any survivor as Auto.';
