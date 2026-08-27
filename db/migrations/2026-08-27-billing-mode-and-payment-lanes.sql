-- Phase 4, PR 1: the billing-mode switch and a lane tag on payments.
--
-- TWO NULLABLE COLUMNS. STRICTLY ADDITIVE, safe on a live park mid-season, safe to re-run.
-- Nothing is backfilled and no existing column is altered — which is the whole safety argument
-- here, because this migration touches the MONEY tables.
--
-- ── WHY NOTHING MOVES WHEN THIS RUNS ─────────────────────────────────────────────────────────
--
-- A park keeps one blended account today: electric, the store tab and (soon) the seasonal fee all
-- land in one folio and net against each other. Phase 4 lets a park separate those into LANES.
-- This migration only creates the switch and the tag; it changes no behaviour at all.
--
-- `billing_mode` is NULL on every existing park the moment this runs, and NULL is read as
-- 'combined' — today's blended behaviour — by normalizeBillingMode() in lib/ledger-lanes.ts.
-- ANY unrecognised value reads as 'combined' too. That direction is deliberate: the failure mode
-- of guessing 'separated' is a camper receiving a bill that omits money they owe, while the
-- failure mode of guessing 'combined' is the bill a park already gets today.
--
-- No DEFAULT is set, on purpose. A DEFAULT 'combined' would be equivalent in behaviour but would
-- claim every park has made a choice; NULL says "never configured", which is the truth and is
-- what lets a later screen tell "not set up" from "deliberately combined".

ALTER TABLE public.settings
  ADD COLUMN IF NOT EXISTS billing_mode text;

COMMENT ON COLUMN public.settings.billing_mode IS
  'combined (default) = one blended folio, today''s behaviour. separated = electric / store / seasonal tracked as separate lanes. NULL or any unrecognised value reads as combined.';

-- ── THE LANE TAG ON A PAYMENT ────────────────────────────────────────────────────────────────
--
-- Which lane a payment was made against: 'electric', 'store', 'seasonal', or NULL.
--
-- ⚠ NULL IS NOT "UNKNOWN, FIX LATER" — IT IS TODAY'S BEHAVIOUR, AND IT IS CORRECT. Every payment
-- that exists when this runs is untagged, and an untagged payment applies to the WHOLE ACCOUNT
-- exactly as it always has. laneBalances() keeps them in a separate `untagged` bucket rather than
-- guessing a lane for them, so no historical payment is silently reassigned to a lane nobody
-- chose. Back-filling a guess here would rewrite the financial history of every existing park.
--
-- ⚠ NOTHING WRITES THIS COLUMN IN THIS PR. It exists now purely so the next PR — the tap-to-pay
-- checkout screen, which records a payment against the lanes the camper selected — can populate
-- it WITHOUT a second migration against live parks. A schema change on a money table is the part
-- worth batching; the code that fills it is not.
--
-- Deliberately NOT a foreign key or an enum: the lane set is defined in application code
-- (lib/ledger-lanes.ts), a CHECK constraint would need a migration every time a lane is added,
-- and an unrecognised value already degrades safely — laneBalances() treats it as untagged.

ALTER TABLE public.folio_payments
  ADD COLUMN IF NOT EXISTS lane text;

COMMENT ON COLUMN public.folio_payments.lane IS
  'Which money lane this payment was made against: electric | store | seasonal. NULL = applies to the whole account (today''s behaviour, and what every pre-Phase-4 payment is). Not enum-constrained; unrecognised values are treated as untagged.';
