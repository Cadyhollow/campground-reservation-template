-- Seasonal Contracts, Phase 1 (B): a customer-facing note explaining the charge.
--
-- WHAT CHANGES. `total_due_cents` prints one number on the contract and says nothing about how it
-- was reached. Owners need somewhere to write "includes 2 extra family members, golf cart, second
-- site" so the camper sees it on the document they sign. This is freeform text for now; a fully
-- itemised receipt is later work.
--
-- ⚠ THIS IS NOT `staff_notes`, AND MUST NOT BE MERGED INTO IT.
--   staff_notes  = the owner's PRIVATE scratchpad. Never rendered to a camper.
--   charge_note  = CUSTOMER-FACING. It is available to the contract body as {{charge_note}} and
--                  prints under Total Due on a legal agreement the camper signs.
-- Repurposing staff_notes is how a private remark about a camper ends up printed in their
-- contract. The two columns exist separately for exactly that reason.
--
-- STRICTLY ADDITIVE and safe to re-run: one nullable text column, IF NOT EXISTS, no default, no
-- backfill, nothing else touched. Every existing row keeps behaving exactly as it does today — a
-- NULL charge_note renders as an empty string, the same null-safe treatment every other merge var
-- already gets, so an unchanged contract body prints byte-for-byte what it prints now.

ALTER TABLE seasonal_contracts
  ADD COLUMN IF NOT EXISTS charge_note text;

COMMENT ON COLUMN seasonal_contracts.charge_note IS
  'CUSTOMER-FACING explanation of the total due; rendered into the contract body as {{charge_note}}. Distinct from staff_notes, which is private.';
