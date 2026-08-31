-- Seasonal redesign PR 2b: an optional, printed payment schedule on the seasonal contract.
--
-- ONE COLUMN ON seasonal_contracts. Strictly additive, IF NOT EXISTS, DEFAULT '[]' — which is
-- today's behaviour exactly: an empty schedule prints nothing and the contract is unchanged.
--
-- ── WHY A COLUMN AND NOT MORE deposit_*/total_* PAIRS ────────────────────────────────────────
--
-- Parks collect the fee in several instalments — September, January, March, May is a common
-- shape — not merely a deposit and a balance. Modelling that as more fixed columns means a new
-- migration every time a park wants a fourth or fifth date, and columns standing empty for the
-- parks that want two. A jsonb array is the shape of the fact: a list, of unknown length, of
-- (label, amount, due date).
--
-- ⚠ DISPLAY ONLY, EXACTLY LIKE total_due_cents AND deposit_due_cents. This prints on the
-- agreement and NOTHING is charged from it. It is a printed plan, not a billing engine: no
-- schedule row ever posts a folio charge, and nothing here changes when the seasonal charge is
-- posted (still on send, unchanged). If that ever stops being true, this comment is the thing
-- that was not read.
--
-- deposit_due_cents and total_due_cents are KEPT and are not superseded. The schedule supplements
-- them: an owner may state a deposit, a total, and the instalments in between.
--
-- ── SHAPE ────────────────────────────────────────────────────────────────────────────────────
--
--   [{ "label": "First instalment", "amount_cents": 50000, "due_by": "2026-09-15" }, …]
--
-- Every field is OPTIONAL, deliberately. Half-known plans are the normal state in the autumn —
-- "something in January, we'll agree the figure later" is a real row. A row with only a date, or
-- only an amount, must be storable and must print what it knows. Only a completely empty row is
-- dropped, and that is done in the UI, not here.
--
-- ── PROPAGATION ──────────────────────────────────────────────────────────────────────────────
--
-- Existing parks: this file, run per park like every other migration in this directory.
-- Newly-provisioned parks: database-setup.sql is KNOWN-STALE under a standing do-not-propagate
-- note, so it is deliberately NOT touched here. `seasonal_contracts.payment_schedule` therefore
-- joins guests.seasonal_active, settings.occupancy_goal_percent and sites.is_seasonal_site on the
-- list of columns a new park does not get until that separate, scoped job runs. The default is
-- '[]' and every read guards on the column's presence, so a park without it behaves as it does
-- today rather than erroring.

ALTER TABLE public.seasonal_contracts
  ADD COLUMN IF NOT EXISTS payment_schedule jsonb NOT NULL DEFAULT '[]'::jsonb;

COMMENT ON COLUMN public.seasonal_contracts.payment_schedule IS
  'DISPLAY ONLY. An optional list of instalments printed on the agreement: [{label?, amount_cents?, due_by?}]. Nothing is charged from it — it supplements deposit_due_cents and total_due_cents, which are unchanged. Every field is optional.';
