-- Terminal checkouts carry the money lanes they are paying.
--
-- ONE NULLABLE COLUMN. Additive, IF NOT EXISTS, nothing backfilled, no existing column altered.
--
-- ── WHY THE SPLIT HAS TO BE STORED ───────────────────────────────────────────────────────────
--
-- A terminal charge is asynchronous: staff send it, the customer taps some seconds later, and the
-- COMPLETED event arrives at a DIFFERENT request — a webhook, or a poll — from the one that
-- created it. Whatever is going to be recorded on the folio therefore has to survive that gap.
--
-- The lane split is decided when the charge is sent (the owner tapped Electric and Seasonal), so
-- it is written down here and read back when the checkout completes. Recomputing it at completion
-- time is not an option: the balances may have moved in between, and the camper has by then paid
-- a specific amount for a specific reason.
--
-- Shape matches the lanes payload /api/admin-card-payment already accepts, so the two card paths
-- record through the SAME helper:
--   [{"lane":"electric","amount":4200,"surchargeAmount":126}, …]
--
-- NULL means "no split" — a plain whole-account terminal charge, which is every terminal checkout
-- taken before this column existed and every one taken from the folio or booking screens. Those
-- keep recording exactly one untagged payment row, as they always have.

ALTER TABLE public.terminal_checkouts
  ADD COLUMN IF NOT EXISTS lanes jsonb;

COMMENT ON COLUMN public.terminal_checkouts.lanes IS
  'Money-lane split this checkout is paying: [{"lane":…,"amount":…,"surchargeAmount":…}]. NULL = a plain whole-account charge (one untagged folio_payments row), which is every pre-Phase-4 terminal checkout.';
