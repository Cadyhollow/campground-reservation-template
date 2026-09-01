-- Mobile meter reading: the registry, the walk, and the permanent record.
--
-- ── WHAT THIS IS FOR ─────────────────────────────────────────────────────────────────────────
--
-- Today a park walks its sites with a clipboard, writes ~79 numbers down, and re-types the
-- seasonal ones into the Electric Billing screen. This schema collapses that to one step: the
-- numbers are entered once, on a phone, in the field. The seasonal ones become DRAFT electric
-- bills for review; every meter's number is kept forever, seasonal or not.
--
-- ── THE SHAPE, IN ONE PARAGRAPH ──────────────────────────────────────────────────────────────
--
--   meters                  one row per physical meter. meter_number = site number.
--   meter_reading_sessions  one dated walk ("September 2027"), mapped to a billing month.
--   meter_readings          the raw numbers. THE PERMANENT RECORD — every meter, every session.
--
-- and three additive columns on the existing `electric_readings` so a reading can be staged as a
-- DRAFT bill before anybody posts it.
--
-- ── ⚠ WHY `electric_readings.status` DEFAULTS TO 'posted' ────────────────────────────────────
--
-- This is the load-bearing line of the whole migration. Until now, the EXISTENCE of an
-- electric_readings row for a camper and month WAS the fact "that bill has been sent" — the
-- Electric Billing page reads exactly that and marks the row ✓ Billed. Staging drafts into the
-- same table without a status column would tell every park that a walk they have not reviewed
-- had already been billed and emailed.
--
-- So: every row that exists today is 'posted', by default, and behaves precisely as it does now.
-- A draft is the new state, and every consumer that must not see one is updated in the same
-- change. NOT NULL with a default, so there is no third "unknown" state to reason about.
--
-- ── SAFE TO RUN ON A LIVE PARK MID-SEASON, AND SAFE TO RE-RUN ────────────────────────────────
--
-- Additive throughout: three new tables, three new columns, two new settings columns. No existing
-- column is altered, dropped, rewritten or re-defaulted; no existing row's meaning changes. Every
-- statement is guarded (CREATE TABLE / ADD COLUMN / CREATE INDEX IF NOT EXISTS, DROP POLICY IF
-- EXISTS before CREATE POLICY), and the meter seed inserts only what is not already there, so a
-- second run is a no-op rather than 79 duplicate meters.
--
-- Order is deliberate: sites-referencing table first, then the sessions it does not depend on,
-- then readings (which reference both), then the electric_readings columns (which reference
-- sessions), then policies, then the seed.

-- ═════════════════════════════════════════════════════════════════════════════════════════════
-- 1. THE REGISTRY
-- ═════════════════════════════════════════════════════════════════════════════════════════════
--
-- `meter_number` is the number painted on the box in the ground, and for a site meter it IS the
--   site number. That equivalence was decided deliberately and is why this feature ships with no
--   meter-to-site mapping screen to fill in.
-- `site_id` is the link, and it is what makes a meter billable at all. NULL means a common-area
--   meter (a bathhouse, a shop) — recorded forever, never billed to anybody. ON DELETE SET NULL
--   rather than CASCADE: deleting a site must not delete years of meter history, and an
--   unattached meter is a safe state (it can bill nobody) whereas an orphaned FK is not.
-- `active` retires a meter without deleting it. A retired meter keeps its history and drops out
--   of the walk.
-- `billable_override` is THREE-VALUED on purpose and NULL is the normal value:
--       NULL  → decide from occupancy (a seasonal camper on this site ⇒ it bills)
--       true  → always bill it
--       false → never bill it
--   A two-valued boolean could not express "follow the campers", which is what ~79 of ~79 meters
--   should do; the owner would have had to maintain the answer by hand forever.
CREATE TABLE IF NOT EXISTS public.meters (
  id uuid DEFAULT gen_random_uuid() NOT NULL PRIMARY KEY,
  created_at timestamptz DEFAULT now(),
  meter_number text NOT NULL,
  site_id uuid REFERENCES public.sites(id) ON DELETE SET NULL,
  label text DEFAULT '',
  active boolean NOT NULL DEFAULT true,
  billable_override boolean,
  display_order integer NOT NULL DEFAULT 0,
  notes text DEFAULT ''
);

-- One meter per number. The walk identifies a meter by the number on it, so two rows sharing one
-- number is not a park with two meters — it is a park that will read one of them twice and never
-- read the other.
CREATE UNIQUE INDEX IF NOT EXISTS meters_meter_number_key
  ON public.meters (lower(btrim(meter_number)));

COMMENT ON COLUMN public.meters.billable_override IS
  'NULL = decide automatically from seasonal occupancy of the linked site. TRUE/FALSE = the owner has forced this meter on or off, and the override wins.';

-- ═════════════════════════════════════════════════════════════════════════════════════════════
-- 2. THE WALK
-- ═════════════════════════════════════════════════════════════════════════════════════════════
--
-- ⚠ `billing_month` IS A LABEL THE OWNER PICKS, NOT A DATE THIS TABLE DERIVES. Parks routinely
-- read the meters in the last days of August and call it the September bill. The read date and
-- the billing month are therefore two separate, independent columns and NOTHING here checks one
-- against the other — enforcing month arithmetic would reject the park's own normal practice.
-- The value is stored as free text so it matches electric_readings.billing_month exactly, which
-- is how a walk finds its way onto the right Electric Billing screen.
--
-- `status` is in_progress until the owner says the walk is done. It is what lets her put the
-- phone down at meter 12 of 79 and pick it up after lunch.
CREATE TABLE IF NOT EXISTS public.meter_reading_sessions (
  id uuid DEFAULT gen_random_uuid() NOT NULL PRIMARY KEY,
  created_at timestamptz DEFAULT now(),
  label text NOT NULL DEFAULT '',
  billing_month text NOT NULL,
  read_date date NOT NULL DEFAULT CURRENT_DATE,
  status text NOT NULL DEFAULT 'in_progress',
  notes text DEFAULT '',
  completed_at timestamptz,
  CONSTRAINT meter_reading_sessions_status_check
    CHECK (status = ANY (ARRAY['in_progress', 'complete']))
);

COMMENT ON COLUMN public.meter_reading_sessions.billing_month IS
  'The Electric Billing month this walk feeds, e.g. "September 2027". A LABEL THE OWNER CHOOSES — an August read may legitimately be the September bill. Never derived from read_date.';

-- ═════════════════════════════════════════════════════════════════════════════════════════════
-- 3. THE PERMANENT RECORD
-- ═════════════════════════════════════════════════════════════════════════════════════════════
--
-- Every meter, every walk, billable or not. This is the row that answers "what did meter 12 read
-- last September" for a park that does not bill site 12 at all.
--
-- `session_id` is NULLABLE, and null is a real, expected value: a single mid-month read (a
--   move-out on the 14th) belongs to no walk. ON DELETE SET NULL so removing a session cannot
--   take the readings with it.
-- `meter_id` is ON DELETE RESTRICT, and that is the deliberate asymmetry with site_id above. A
--   meter with history cannot be deleted at all — it is RETIRED with active = false. The record
--   is the point of the table; a delete that silently took it would defeat the feature.
-- `previous_value` is the number this reading carried FROM, snapshotted at the moment it was
--   taken rather than re-derived later. Re-deriving would quietly change a past reading's meaning
--   whenever an earlier one was corrected.
-- `guest_id` is who was on the site WHEN THE METER WAS READ. Snapshotted for the same reason, and
--   it is what bills a camper who moved out mid-month for the power they actually used.
--
-- ⚠ THE METER-REPLACEMENT COLUMNS. When the physical meter is swapped, the new one starts near
-- zero and `current - previous` is nonsense — a large negative, or a wild jump if the old meter
-- read low. `is_meter_reset` marks that, and `reset_start_value` is what the NEW meter read when
-- it went in (usually 0). Usage is then measured on the new meter alone. What that does not
-- recover is the old meter's usage since the last read; that number left with the meter, and the
-- Electric Billing page keeps every editing control it has so an owner who wrote it down can add
-- it by hand. Guessing at it in SQL would be worse than leaving it visible and correctable.
CREATE TABLE IF NOT EXISTS public.meter_readings (
  id uuid DEFAULT gen_random_uuid() NOT NULL PRIMARY KEY,
  created_at timestamptz DEFAULT now(),
  meter_id uuid NOT NULL REFERENCES public.meters(id) ON DELETE RESTRICT,
  session_id uuid REFERENCES public.meter_reading_sessions(id) ON DELETE SET NULL,
  reading_value numeric NOT NULL,
  previous_value numeric,
  read_at date NOT NULL DEFAULT CURRENT_DATE,
  is_meter_reset boolean NOT NULL DEFAULT false,
  reset_start_value numeric,
  guest_id uuid REFERENCES public.guests(id) ON DELETE SET NULL,
  billable boolean NOT NULL DEFAULT false,
  notes text DEFAULT ''
);

-- One reading per meter per walk. This is what makes "Save & next" idempotent: going Prev and
-- correcting a digit updates the row instead of leaving two readings for one meter, which would
-- double that meter's usage into the draft bill.
CREATE UNIQUE INDEX IF NOT EXISTS meter_readings_session_meter_key
  ON public.meter_readings (session_id, meter_id) WHERE session_id IS NOT NULL;

-- The two questions asked constantly: "this walk's readings" and "this meter's history".
CREATE INDEX IF NOT EXISTS meter_readings_session_idx ON public.meter_readings (session_id);
CREATE INDEX IF NOT EXISTS meter_readings_meter_read_at_idx
  ON public.meter_readings (meter_id, read_at DESC, created_at DESC);

-- ═════════════════════════════════════════════════════════════════════════════════════════════
-- 4. DRAFT BILLS — three additive columns on the EXISTING electric_readings
-- ═════════════════════════════════════════════════════════════════════════════════════════════
--
-- See the header for why `status` defaults to 'posted'. Restated because it is the one line that
-- can break a park: EVERY EXISTING ROW IS 'posted' AND BEHAVES EXACTLY AS IT DOES TODAY.
ALTER TABLE public.electric_readings
  ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'posted';

-- Added separately from the column so re-running on a park that already has the column still gets
-- the constraint. Guarded, because ADD CONSTRAINT has no IF NOT EXISTS in PostgreSQL 15.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'electric_readings_status_check'
  ) THEN
    ALTER TABLE public.electric_readings
      ADD CONSTRAINT electric_readings_status_check
      CHECK (status = ANY (ARRAY['draft', 'posted']));
  END IF;
END $$;

COMMENT ON COLUMN public.electric_readings.status IS
  'posted = a real bill: charged to the folio and sent. draft = staged by a meter walk and NOT charged to anything. DEFAULT posted, because before this column existed the row''s existence was itself the record that the bill had been sent.';

-- Which walk produced this draft. Lets the Electric Billing page show "from the September walk,
-- read 28 Aug" and lets a re-run of a walk find its own drafts instead of making new ones.
ALTER TABLE public.electric_readings
  ADD COLUMN IF NOT EXISTS reading_session_id uuid
    REFERENCES public.meter_reading_sessions(id) ON DELETE SET NULL;

-- ⚠ THE DOUBLE-SITE LINES. A camper on "43, 44" has two meters and ONE bill. This is the
-- per-meter breakdown of that one bill — [{meter_id, meter_number, previous, current, kwh}] — so
-- the Electric Billing page can show a reading line per meter, each verifiable and editable,
-- under a single camper with a single total.
--
-- A snapshot rather than a join, deliberately: it is the record of WHAT WAS BILLED. The readings
-- in meter_readings are the record of what was READ. Those are different facts and they are
-- allowed to differ — an owner who corrects an amount on the bill has not changed what the meter
-- said in the field, and next month still carries forward from the meter, not from the bill.
--
-- DEFAULT '[]' so every existing row has a valid, empty breakdown and nothing has to special-case
-- a NULL.
ALTER TABLE public.electric_readings
  ADD COLUMN IF NOT EXISTS meter_breakdown jsonb NOT NULL DEFAULT '[]'::jsonb;

-- Finding this month's drafts is the Electric Billing page's first query on every load.
CREATE INDEX IF NOT EXISTS electric_readings_status_month_idx
  ON public.electric_readings (status, billing_month);

-- ═════════════════════════════════════════════════════════════════════════════════════════════
-- 5. THE PARK'S ELECTRIC RATE — two additive settings columns
-- ═════════════════════════════════════════════════════════════════════════════════════════════
--
-- The rate and the minimum charge lived in React state on the Electric Billing page, seeded with
-- `useState('0.27')` / `useState('15.00')` and never saved anywhere. That meant the owner retyped
-- their rate on every visit, and ONE PARK'S rates were hard-coded into the blueprint every park
-- is cloned from — the exact shape CLAUDE.md's Configurability principle names as the signal to
-- make something a setting.
--
-- It also became load-bearing: the walk screen shows a live "≈ $" as each reading is typed, and
-- that figure can only agree with the bill if both read one stored rate.
--
-- ⚠ BOTH PROVISION NULL, NOT 0.27 / 1500. A default here would assert one park's prices about
-- every park, which is the same mistake as a defaulted booking horizon. NULL means "this owner
-- has not set a rate", and the screens fall back to the 0.27 / 15.00 they show today — so a park
-- that never opens Settings sees no change at all.
ALTER TABLE public.settings
  ADD COLUMN IF NOT EXISTS electric_rate_per_kwh numeric;
ALTER TABLE public.settings
  ADD COLUMN IF NOT EXISTS electric_minimum_charge integer;

COMMENT ON COLUMN public.settings.electric_rate_per_kwh IS
  'Dollars per kWh for seasonal electric billing. NULL = never set; the screens fall back to the 0.27 they have always displayed.';
COMMENT ON COLUMN public.settings.electric_minimum_charge IS
  'Minimum electric charge per bill, in CENTS (integer, like every other money column here). NULL = never set; falls back to 1500.';

-- ═════════════════════════════════════════════════════════════════════════════════════════════
-- 6. ROW LEVEL SECURITY
-- ═════════════════════════════════════════════════════════════════════════════════════════════
--
-- The posture the rest of this schema uses: RLS on, the anon role holding nothing at all, and the
-- admin reaching data as `authenticated` through a role-gated policy pair — one PERMISSIVE
-- (grants) and one RESTRICTIVE (cannot be widened by adding another permissive policy later).
--
-- THE ROLE SPLIT, and the reasoning:
--   READING meters and writing readings is STAFF. Walking the park with a phone is the most
--     delegable job in it, and this is the first time in this codebase that entering a reading
--     does NOT also issue a charge — the walk stages drafts and posts nothing. lib/admin-pages.ts
--     records that reading entry could not be separated from bill issuance while
--     create_electric_bill() did both; this table is that separation.
--   CHANGING THE REGISTRY is OWNER. `active` and `billable_override` decide who gets billed, so
--     they sit with the Sites screen, which is Owner for the same reason.
--
-- ⚠ THE PAGE GATE IS SEPARATE AND STRICTER. app/admin/seasonals/** resolves to MANAGER in
-- lib/admin-pages.ts, and the walk screen lives under it, so no staff member reaches the screen
-- today. These policies do not loosen that; they describe what the TABLE permits, so that moving
-- the screen to Staff later is a one-line decision rather than a schema migration.

ALTER TABLE public.meters ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.meter_reading_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.meter_readings ENABLE ROW LEVEL SECURITY;

-- meters — read: staff; write: owner.
DROP POLICY IF EXISTS "authenticated select meters" ON public.meters;
CREATE POLICY "authenticated select meters" ON public.meters
  FOR SELECT TO authenticated USING ((select app.at_least('staff')));
DROP POLICY IF EXISTS "authenticated insert meters" ON public.meters;
CREATE POLICY "authenticated insert meters" ON public.meters
  FOR INSERT TO authenticated WITH CHECK ((select app.at_least('owner')));
DROP POLICY IF EXISTS "authenticated update meters" ON public.meters;
CREATE POLICY "authenticated update meters" ON public.meters
  FOR UPDATE TO authenticated USING ((select app.at_least('owner'))) WITH CHECK ((select app.at_least('owner')));
DROP POLICY IF EXISTS "authenticated delete meters" ON public.meters;
CREATE POLICY "authenticated delete meters" ON public.meters
  FOR DELETE TO authenticated USING ((select app.at_least('owner')));

DROP POLICY IF EXISTS "role gate select meters" ON public.meters;
CREATE POLICY "role gate select meters" ON public.meters
  AS RESTRICTIVE FOR SELECT TO authenticated USING ((select app.at_least('staff')));
DROP POLICY IF EXISTS "role gate insert meters" ON public.meters;
CREATE POLICY "role gate insert meters" ON public.meters
  AS RESTRICTIVE FOR INSERT TO authenticated WITH CHECK ((select app.at_least('owner')));
DROP POLICY IF EXISTS "role gate update meters" ON public.meters;
CREATE POLICY "role gate update meters" ON public.meters
  AS RESTRICTIVE FOR UPDATE TO authenticated USING ((select app.at_least('owner'))) WITH CHECK ((select app.at_least('owner')));
DROP POLICY IF EXISTS "role gate delete meters" ON public.meters;
CREATE POLICY "role gate delete meters" ON public.meters
  AS RESTRICTIVE FOR DELETE TO authenticated USING ((select app.at_least('owner')));

-- meter_reading_sessions — read + create + update: staff (starting and finishing a walk).
-- Delete stays OWNER: a session is the container for a month of readings.
DROP POLICY IF EXISTS "authenticated select meter_reading_sessions" ON public.meter_reading_sessions;
CREATE POLICY "authenticated select meter_reading_sessions" ON public.meter_reading_sessions
  FOR SELECT TO authenticated USING ((select app.at_least('staff')));
DROP POLICY IF EXISTS "authenticated insert meter_reading_sessions" ON public.meter_reading_sessions;
CREATE POLICY "authenticated insert meter_reading_sessions" ON public.meter_reading_sessions
  FOR INSERT TO authenticated WITH CHECK ((select app.at_least('staff')));
DROP POLICY IF EXISTS "authenticated update meter_reading_sessions" ON public.meter_reading_sessions;
CREATE POLICY "authenticated update meter_reading_sessions" ON public.meter_reading_sessions
  FOR UPDATE TO authenticated USING ((select app.at_least('staff'))) WITH CHECK ((select app.at_least('staff')));
DROP POLICY IF EXISTS "authenticated delete meter_reading_sessions" ON public.meter_reading_sessions;
CREATE POLICY "authenticated delete meter_reading_sessions" ON public.meter_reading_sessions
  FOR DELETE TO authenticated USING ((select app.at_least('owner')));

DROP POLICY IF EXISTS "role gate select meter_reading_sessions" ON public.meter_reading_sessions;
CREATE POLICY "role gate select meter_reading_sessions" ON public.meter_reading_sessions
  AS RESTRICTIVE FOR SELECT TO authenticated USING ((select app.at_least('staff')));
DROP POLICY IF EXISTS "role gate insert meter_reading_sessions" ON public.meter_reading_sessions;
CREATE POLICY "role gate insert meter_reading_sessions" ON public.meter_reading_sessions
  AS RESTRICTIVE FOR INSERT TO authenticated WITH CHECK ((select app.at_least('staff')));
DROP POLICY IF EXISTS "role gate update meter_reading_sessions" ON public.meter_reading_sessions;
CREATE POLICY "role gate update meter_reading_sessions" ON public.meter_reading_sessions
  AS RESTRICTIVE FOR UPDATE TO authenticated USING ((select app.at_least('staff'))) WITH CHECK ((select app.at_least('staff')));
DROP POLICY IF EXISTS "role gate delete meter_reading_sessions" ON public.meter_reading_sessions;
CREATE POLICY "role gate delete meter_reading_sessions" ON public.meter_reading_sessions
  AS RESTRICTIVE FOR DELETE TO authenticated USING ((select app.at_least('owner')));

-- meter_readings — read + write: staff. Delete: OWNER, because this is the permanent record.
DROP POLICY IF EXISTS "authenticated select meter_readings" ON public.meter_readings;
CREATE POLICY "authenticated select meter_readings" ON public.meter_readings
  FOR SELECT TO authenticated USING ((select app.at_least('staff')));
DROP POLICY IF EXISTS "authenticated insert meter_readings" ON public.meter_readings;
CREATE POLICY "authenticated insert meter_readings" ON public.meter_readings
  FOR INSERT TO authenticated WITH CHECK ((select app.at_least('staff')));
DROP POLICY IF EXISTS "authenticated update meter_readings" ON public.meter_readings;
CREATE POLICY "authenticated update meter_readings" ON public.meter_readings
  FOR UPDATE TO authenticated USING ((select app.at_least('staff'))) WITH CHECK ((select app.at_least('staff')));
DROP POLICY IF EXISTS "authenticated delete meter_readings" ON public.meter_readings;
CREATE POLICY "authenticated delete meter_readings" ON public.meter_readings
  FOR DELETE TO authenticated USING ((select app.at_least('owner')));

DROP POLICY IF EXISTS "role gate select meter_readings" ON public.meter_readings;
CREATE POLICY "role gate select meter_readings" ON public.meter_readings
  AS RESTRICTIVE FOR SELECT TO authenticated USING ((select app.at_least('staff')));
DROP POLICY IF EXISTS "role gate insert meter_readings" ON public.meter_readings;
CREATE POLICY "role gate insert meter_readings" ON public.meter_readings
  AS RESTRICTIVE FOR INSERT TO authenticated WITH CHECK ((select app.at_least('staff')));
DROP POLICY IF EXISTS "role gate update meter_readings" ON public.meter_readings;
CREATE POLICY "role gate update meter_readings" ON public.meter_readings
  AS RESTRICTIVE FOR UPDATE TO authenticated USING ((select app.at_least('staff'))) WITH CHECK ((select app.at_least('staff')));
DROP POLICY IF EXISTS "role gate delete meter_readings" ON public.meter_readings;
CREATE POLICY "role gate delete meter_readings" ON public.meter_readings
  AS RESTRICTIVE FOR DELETE TO authenticated USING ((select app.at_least('owner')));

-- GRANTS AND POLICIES ARE INDEPENDENT GATES: a policy is only consulted once the role already
-- holds the table privilege. The canonical schema's schema-wide GRANT ran at provisioning time
-- and does not reach a table created afterwards, so each new table names its own.
GRANT SELECT, INSERT, UPDATE, DELETE ON public.meters TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.meter_reading_sessions TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.meter_readings TO authenticated;

-- ═════════════════════════════════════════════════════════════════════════════════════════════
-- 7. THE SEED — one meter per existing site
-- ═════════════════════════════════════════════════════════════════════════════════════════════
--
-- Creating ~79 meters by hand is the chore that means a feature never gets switched on, and the
-- decision "meter number = site number" makes the seed exact rather than a guess.
--
-- ⚠ IDEMPOTENT. Only sites with no meter at that number get one, matched the same trimmed,
-- case-insensitive way the unique index above is built, so a second run inserts nothing. A park
-- that adds site 80 next year runs the same statement from the Meters screen's "Sync from sites"
-- and gets exactly one new meter.
--
-- ⚠ `display_order` IS COPIED BUT DOES NOT DECIDE THE WALK ORDER. The walk runs in numeric site
-- order — see meterWalkOrder() in lib/meters.ts for why. The column DEFAULTS TO 0 on sites and
-- parks populate it partially: on the test tenant, sites 10-14 sat at 0 while 1-6 had 1-6, and an
-- earlier build that honoured it opened the walk on meter 10 and ran 10, 11, 12, 13, 14, 1, 2, 3.
-- It is carried here so a future, deliberately-entered walking route has somewhere to live, not
-- because anything reads it today.
--
-- Sites with a blank site_number are skipped: a meter must have a number to be identified by, and
-- there is nothing to call it.
INSERT INTO public.meters (meter_number, site_id, label, active, display_order)
SELECT btrim(s.site_number), s.id, '', true, COALESCE(s.display_order, 0)
  FROM public.sites s
 WHERE btrim(COALESCE(s.site_number, '')) <> ''
   AND NOT EXISTS (
     SELECT 1 FROM public.meters m
      WHERE lower(btrim(m.meter_number)) = lower(btrim(s.site_number))
   )
   -- Two site rows sharing a number would violate the unique index mid-statement; take the first
   -- and leave the duplicate visible on the Sites screen rather than failing the whole migration.
   AND s.id = (
     SELECT s2.id FROM public.sites s2
      WHERE lower(btrim(COALESCE(s2.site_number, ''))) = lower(btrim(s.site_number))
      ORDER BY s2.created_at NULLS LAST, s2.id
      LIMIT 1
   );
