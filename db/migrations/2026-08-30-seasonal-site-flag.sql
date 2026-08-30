-- Reports R4b: tell seasonal sites apart from transient ones.
--
-- ONE COLUMN ON sites. Strictly additive, IF NOT EXISTS, and DEFAULT false — which is the
-- existing behaviour exactly: before this migration every site was, in effect, transient, because
-- nothing distinguished them.
--
-- ── WHY A COLUMN AND NOT AN INFERENCE ────────────────────────────────────────────────────────
--
-- "A site with a seasonal camper on it" is not the same fact as "a site the park SELLS by the
-- season". A seasonal site standing empty is the single most important number in the seasonal
-- business — it is a site to go and sell — and an inference would make it disappear the moment
-- it became interesting. It would also flicker: a camper leaving would silently shrink the
-- denominator instead of opening a vacancy.
--
-- `in_rotation` was considered and rejected: it governs assignment rotation, not tenure, and
-- cabins are transient while sharing whatever value the seasonal RV sites happen to carry.
--
-- ── THE SEED ─────────────────────────────────────────────────────────────────────────────────
--
-- Flagging 48 sites by hand on day one is the kind of chore that means a feature never gets
-- switched on, so any site that ALREADY has a seasonal camper on it starts out flagged. It is a
-- starting point, not a rule: the Sites screen can flip any of them freely afterwards, and a
-- seasonal site that happens to be empty today is exactly the case an owner will want to add.
--
-- Both sources are read, because either can be the one a park maintains: the camper's own
-- `guests.site_number`, and the site named on their signed contract. Matching is trimmed and
-- case-insensitive — "A1", "a1" and " A1 " are one site to everyone except a string comparison.

ALTER TABLE public.sites
  ADD COLUMN IF NOT EXISTS is_seasonal_site boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.sites.is_seasonal_site IS
  'True when this site is sold for the SEASON rather than by the night. Drives the Occupancy tab''s split between seasonal program fill (filled ÷ total seasonal sites) and transient nightly occupancy. Default false = transient, which is how every site behaved before this column existed.';

UPDATE public.sites s
   SET is_seasonal_site = true
 WHERE s.is_seasonal_site = false
   AND (
     EXISTS (
       SELECT 1 FROM public.guests g
        WHERE g.is_seasonal = true
          AND lower(btrim(coalesce(g.site_number, ''))) <> ''
          AND lower(btrim(g.site_number)) = lower(btrim(s.site_number))
     )
     OR EXISTS (
       SELECT 1 FROM public.seasonal_contracts c
        WHERE lower(btrim(coalesce(c.status, ''))) NOT IN ('cancelled', 'canceled', 'void', 'voided', 'declined')
          AND lower(btrim(coalesce(c.site_number, ''))) <> ''
          AND lower(btrim(c.site_number)) = lower(btrim(s.site_number))
     )
   );
