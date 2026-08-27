-- Seasonal Contracts, Phase 3: deposit + due-by dates, and an editable invitation email.
--
-- FOUR NULLABLE COLUMNS. STRICTLY ADDITIVE, safe to run on a live park mid-season, safe to
-- re-run (IF NOT EXISTS throughout). No existing column is altered, nothing is backfilled, and
-- no code path reads any of them until the Phase 3 application code ships. A tenant that applies
-- this file and nothing else behaves exactly as it does today.
--
-- ── PART 1: THE AMOUNTS (three columns on seasonal_contracts) ────────────────────────────────
--
-- ⚠ DISPLAY ONLY, exactly like the total_due_cents that already sits beside them. These PRINT on
-- the agreement the camper signs; NOTHING IS CHARGED FROM THEM. No money moves anywhere in this
-- repo as a result of these columns — real charging is a later phase. They are stated in the same
-- shape as total_due_cents so that when charging does arrive it finds one consistent set of
-- fields rather than two conventions.
--
-- `deposit_due_cents` is INTEGER CENTS, matching total_due_cents and every other amount in this
-- schema. Never a float: money in this system is integer cents everywhere, and a numeric(10,2)
-- here would be the one column that rounds differently from the rest of the fee model.
--
-- The two dates are plain `date`, not timestamptz: "the deposit is due by May 1st" is a calendar
-- day the park states in a contract, not an instant — and formatContractDate() parses at noon
-- precisely so a date like this cannot shift a day across a timezone. A timestamptz here would
-- reintroduce exactly the bug that noon-parsing exists to prevent.
--
-- All three are NULLABLE with no default, and that is the load-bearing choice: NULL means "no
-- figure agreed", which is different from zero. formatCents(null) renders '' while formatCents(0)
-- renders '$0.00' — a contract saying "Deposit due: $0.00" makes a claim the park never made,
-- whereas a blank says nothing. A DEFAULT 0 here would put a stated deposit of zero on every
-- contract that never mentioned one.

ALTER TABLE public.seasonal_contracts
  ADD COLUMN IF NOT EXISTS deposit_due_cents integer;
ALTER TABLE public.seasonal_contracts
  ADD COLUMN IF NOT EXISTS total_due_by       date;
ALTER TABLE public.seasonal_contracts
  ADD COLUMN IF NOT EXISTS deposit_due_by     date;

COMMENT ON COLUMN public.seasonal_contracts.deposit_due_cents IS
  'DISPLAY ONLY, integer cents. Prints on the contract via {{deposit_due}}; nothing is charged from it. NULL = no deposit stated (distinct from $0.00).';
COMMENT ON COLUMN public.seasonal_contracts.total_due_by IS
  'DISPLAY ONLY. Prints via {{total_due_by}}. A calendar day, not an instant.';
COMMENT ON COLUMN public.seasonal_contracts.deposit_due_by IS
  'DISPLAY ONLY. Prints via {{deposit_due_by}}. A calendar day, not an instant.';

-- ── PART 2: THE INVITATION EMAIL'S MESSAGE (one column on settings) ──────────────────────────
--
-- The packet invitation email currently hard-codes the paragraph a camper reads before opening
-- the sign link. This column makes that paragraph a park's own text — so a park can add, say,
-- its winter payment instructions — while the greeting and the "Review & Sign Packet" button
-- stay fixed in code so the call to action can never be broken by an edit.
--
-- ⚠ NULL / BLANK MEANS "USE THE BUILT-IN DEFAULT", NOT "SEND AN EMPTY EMAIL". Every park in
-- existence has NULL here the moment this runs, so the fallback is the normal case rather than an
-- edge case — which is why the default paragraph stays in code rather than being backfilled into
-- this column. Backfilling it would freeze today's wording into every park's database and make a
-- future improvement to the default unshippable.
--
-- ⚠ IT IS A COVER NOTE, NOT PART OF THE SIGNED DOCUMENT. The packet's two documents are frozen
-- onto signature rows at send and never re-read. This text is rendered fresh each time an email
-- goes out, so editing it between a send and a resend changes the cover text and CANNOT change
-- what the camper signs.
--
-- It supports the same {{tokens}} the contract body does, rendered against the same guest +
-- contract + season the document uses. It is STAFF INPUT reaching an email body, so the renderer
-- HTML-escapes it — see lib/contract-emails.ts.

ALTER TABLE public.settings
  ADD COLUMN IF NOT EXISTS packet_email_intro text;

COMMENT ON COLUMN public.settings.packet_email_intro IS
  'Park-authored message in the seasonal packet invitation email. Supports the contract merge tokens. NULL/blank = use the built-in default paragraph. A cover note only — never part of the signed documents.';
