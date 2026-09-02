-- Camp Account & Seasonal: the two bucket labels a park may rename.
--
-- TWO COLUMNS ON settings. Strictly additive, IF NOT EXISTS, nullable with no default — and the
-- absence of a default is the point. NULL means "this park has not chosen", which the app reads
-- as "use the built-in default" (BUCKET_LABEL_DEFAULT in lib/account-buckets.ts: "Camp Account"
-- and "Seasonal"). A park that runs this migration and changes nothing sees exactly what it saw
-- before, because nothing consults these columns until they hold a non-blank value.
--
-- ── WHY THESE ARE SETTINGS AND NOT STRINGS IN THE CODE ───────────────────────────────────────
--
-- This repo's rule is that owner-facing copy is configurable with a sensible default rather than
-- hard-coded, and bucket names are the clearest possible case for it. "Camp Account" is a good
-- neutral name, but parks do not all use it: some say "Store Account", some "Camp Store", some
-- name the everyday bucket after the park itself. "Seasonal" is likewise "Site Fee" or "Lot Rent"
-- depending on the park. These names appear on the camper page, the guest directory, the folio,
-- the payment doors and the receipt — so getting them wrong is not a cosmetic annoyance, it is
-- every money screen speaking a language the park's staff and campers do not use.
--
-- ── WHY NULLABLE RATHER THAN NOT NULL DEFAULT 'Camp Account' ─────────────────────────────────
--
-- A NOT NULL default would bake today's English into every park's database, and there would then
-- be no way to tell a park that deliberately chose "Camp Account" from a park that never chose
-- anything. That distinction matters the day the default changes: a park that never chose should
-- follow the new default, and a park that chose should keep its choice. NULL preserves it.
--
-- The app treats blank and whitespace-only the same as NULL (see lib/bucket-labels.ts), so an
-- owner who clears the box gets the default back rather than an empty heading.
--
-- ── SEPARATED MODE ONLY, IN PRACTICE ─────────────────────────────────────────────────────────
--
-- The two buckets only exist when settings.billing_mode = 'separated'. A combined park may carry
-- these columns harmlessly; nothing reads them, and combined mode is byte-identical to today.
--
-- ── PROPAGATION ──────────────────────────────────────────────────────────────────────────────
--
-- Existing parks: this file, run per park like every other migration in this directory.
-- Newly-provisioned parks: `database-setup.sql` is the source for DATABASE_SETUP_SQL and lives in
-- the LIVE PARK's repo (cady-hollow-reservations), not here. Updating it is a separate, gated
-- task in that repo — it is not done by running this file.

ALTER TABLE public.settings
  ADD COLUMN IF NOT EXISTS bucket_label_camp text;

ALTER TABLE public.settings
  ADD COLUMN IF NOT EXISTS bucket_label_seasonal text;

COMMENT ON COLUMN public.settings.bucket_label_camp IS
  'Owner''s name for the everyday money bucket (electric + store + other). NULL or blank = use the built-in default, "Camp Account". Separated billing mode only.';

COMMENT ON COLUMN public.settings.bucket_label_seasonal IS
  'Owner''s name for the season fee bucket (fee, deposit, installments). NULL or blank = use the built-in default, "Seasonal". Separated billing mode only.';
