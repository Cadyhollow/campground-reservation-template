-- Seasonal Contracts, Phase 1 (A): a STANDING party roster on the guest record.
--
-- WHAT CHANGES. Until now the party (occupants) existed ONLY on a seasonal contract, and could
-- only be edited from inside the Send-packet modal — i.e. on the way out the door. Rig and home
-- address are already standing camper info: they live on `guests`, are edited inline on the
-- camper screen at any time, and are snapshotted onto the contract at send. This column gives the
-- party the same shape.
--
-- `guests.party` is the ROSTER — who lives in that camper, as a standing fact.
-- `seasonal_contracts.occupants` stays exactly as it is — the party FROZEN onto one year's
-- signed legal document. The two are deliberately NOT merged: editing the roster must never
-- retroactively alter an agreement somebody has already signed.
--
-- SHAPE: an array of { "name": text, "kind": "adult" | "child" }, matching the Occupant type in
-- app/admin/seasonals/PartyEditor.tsx and the `occupants` column it already writes.
--   [{"name":"Ana Ortiz","kind":"adult"},{"name":"Luis Ortiz","kind":"child"}]
--
-- STRICTLY ADDITIVE and safe to re-run: one new column, IF NOT EXISTS, with a default that means
-- "no roster recorded" — which is what every existing row is. Nothing is backfilled, no existing
-- column is touched, and no code path reads it until the Phase 1 application code ships. A tenant
-- that applies this and nothing else behaves exactly as it does today.
--
-- NOT NULL + DEFAULT '[]' rather than a nullable column, on purpose: the readers below all do
-- `Array.isArray(...)`, and a column that is always an array removes the null branch from every
-- one of them. Postgres 11+ adds a defaulted NOT NULL column without rewriting the table, so this
-- is still instant on a live tenant.

ALTER TABLE guests
  ADD COLUMN IF NOT EXISTS party jsonb NOT NULL DEFAULT '[]'::jsonb;

COMMENT ON COLUMN guests.party IS
  'Standing party roster for a seasonal camper: [{"name":…,"kind":"adult"|"child"}]. Edited on the camper screen; seeds seasonal_contracts.occupants on a NEW draft. Never rewrites an already-sent contract.';
