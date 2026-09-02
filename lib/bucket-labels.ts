// What a park calls its two money buckets.
//
// The defaults live in ./account-buckets.ts beside the buckets themselves; this module is only
// the override rule — read the owner's wording from settings when they have set one, fall back to
// the default when they have not. Split out from the UI because five screens, the payment doors
// and the receipt all need the same answer, and five hand-rolled `settings.x || 'Camp Account'`
// expressions is how they drift apart.
//
// Relative import with the extension: the repo convention for one lib module importing another,
// and the only form that resolves under `node --test`.
import { BUCKET_LABEL_DEFAULT, type Bucket } from './account-buckets.ts'

export type BucketLabels = Record<Bucket, string>

/** The shape of the two settings columns. Both optional: a park that has not run the migration
 *  has neither, and a park that has run it but chosen nothing has them as NULL. */
export type BucketLabelSettings = {
  bucket_label_camp?: string | null
  bucket_label_seasonal?: string | null
} | null | undefined

/**
 * ⚠ BLANK IS NOT A LABEL. An owner who clears the box, or types only spaces, gets the default
 * back — never an empty heading over a balance. This is the one rule worth stating: the
 * difference between "" and undefined is invisible to the person typing, so both must behave the
 * same way.
 *
 * Trimmed, because a trailing space in a settings box should not become a trailing space in a
 * card title on every money screen.
 */
function pick(value: string | null | undefined, fallback: string): string {
  const t = typeof value === 'string' ? value.trim() : ''
  return t.length > 0 ? t : fallback
}

/**
 * Both bucket labels, the owner's where they set one.
 *
 * Safe on a park that has not run the bucket-labels migration: the columns are absent, `settings`
 * is missing them (or is null entirely, if the guarded select failed), and every label falls back
 * to the default. Nothing here throws, because a settings read failing must never take a money
 * screen down — it should simply render the built-in wording.
 */
export function bucketLabels(settings: BucketLabelSettings): BucketLabels {
  return {
    camp: pick(settings?.bucket_label_camp, BUCKET_LABEL_DEFAULT.camp),
    seasonal: pick(settings?.bucket_label_seasonal, BUCKET_LABEL_DEFAULT.seasonal),
  }
}

/** One label, for the callers that only need a single bucket's name. */
export function bucketLabel(settings: BucketLabelSettings, bucket: Bucket): string {
  return bucketLabels(settings)[bucket]
}
