-- Phase 4, PR 2: the seasonal fee becomes a tracked charge in the seasonal lane.
--
-- TWO NULLABLE COLUMNS ON folio_line_items. STRICTLY ADDITIVE, IF NOT EXISTS, nothing backfilled,
-- no existing column altered. This is a MONEY table, so the "nothing backfilled" is the load-
-- bearing part: every row that exists keeps classifying exactly as it does today.
--
-- ⚠ THE FEE IS TRACKED IN BOTH BILLING MODES. billing_mode governs DISPLAY — lanes vs. one
-- blended balance, and whether the electric bill is lane-isolated. Whether a fee is on the books
-- is not a display question, so a combined park posts the same charge and simply sees it inside
-- its single balance. The real gate is the contract stating an amount at all.
--
-- ── WHY AN EXPLICIT `lane`, WHEN PR 1 ALREADY INFERS ONE ─────────────────────────────────────
--
-- PR 1 classifies a line item from signals already in the data: an electric_readings row pointing
-- at it → electric; a product_id → store; otherwise other. That works because those two signals
-- are written by the code that creates those charges and mean exactly one thing.
--
-- The seasonal fee has NO such signal. It has no product_id (it is not a store item) and no
-- electric reading, so under PR 1's rules it would land in `other` — indistinguishable from a
-- manual "custom item" charge. Rather than invent a fragile signal (a magic description string, a
-- reserved category name — and see the note in lib/ledger-lanes.ts about how 'Fees' already
-- collides between electric and the POS), the charge simply DECLARES its lane.
--
-- classifyLineItem() reads this column FIRST and falls back to PR 1's inference for anything that
-- does not carry it. Since every existing row is NULL here, every existing row classifies exactly
-- as it did before this migration. That equivalence is pinned by a test.
--
-- NOT enum-constrained and no CHECK, matching folio_payments.lane from PR 1: the lane set is
-- defined in application code, a constraint would need a migration every time it grows, and an
-- unrecognised value already degrades safely — the classifier ignores it and falls through to
-- inference.

ALTER TABLE public.folio_line_items
  ADD COLUMN IF NOT EXISTS lane text;

COMMENT ON COLUMN public.folio_line_items.lane IS
  'Explicit money lane for this charge: electric | store | seasonal | other. NULL = infer from the row (electric_readings link, then product_id) — which is every pre-Phase-4 row.';

-- ── THE LINK BACK TO THE CONTRACT ────────────────────────────────────────────────────────────
--
-- Deliberately modelled on electric_readings.folio_line_item_id, which is how an electric charge
-- already knows which reading created it — except pointed the other way, because a contract can
-- exist long before any charge and the charge is the newer, optional thing.
--
-- IT EXISTS SO A CANCEL CAN FIND THE CHARGE. Cancelling a sent packet retracts the agreement; if
-- the fee it posted stayed on the books the camper would carry a debt for a contract that no
-- longer exists. The cancel route voids by seasonal_contract_id, so it finds exactly the charge
-- this contract created and nothing else.
--
-- IT IS ALSO THE IDEMPOTENCY KEY. freezePacket posts the fee only when no non-voided seasonal
-- charge already exists for the contract, so a cancel → edit → re-send cycle cannot leave a
-- camper billed twice.
--
-- ON DELETE SET NULL rather than CASCADE: deleting a seasonal contract is not something the app
-- does — a retracted packet is CANCELLED, not deleted — but if one ever were, silently deleting a
-- posted CHARGE with it would remove money from a camper's account with no audit trail. Losing
-- the link is recoverable; losing the ledger row is not.

ALTER TABLE public.folio_line_items
  ADD COLUMN IF NOT EXISTS seasonal_contract_id uuid REFERENCES public.seasonal_contracts(id) ON DELETE SET NULL;

COMMENT ON COLUMN public.folio_line_items.seasonal_contract_id IS
  'The seasonal contract that posted this charge. Lets a cancel void exactly this charge, and is the idempotency key that stops a re-send posting the fee twice.';

-- The cancel route and the idempotency check both look a charge up by contract. Partial index:
-- only rows that actually carry the link, which is a tiny fraction of a busy park's ledger.
CREATE INDEX IF NOT EXISTS folio_line_items_seasonal_contract_idx
  ON public.folio_line_items (seasonal_contract_id)
  WHERE seasonal_contract_id IS NOT NULL;
