// The bucket-label override rule. Pure — `node --test`, no server, no DB.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { bucketLabels, bucketLabel } from './bucket-labels.ts'
import { BUCKET_LABEL_DEFAULT } from './account-buckets.ts'

test('a park that has configured nothing gets the built-in wording', () => {
  assert.deepEqual(bucketLabels({}), BUCKET_LABEL_DEFAULT)
  assert.deepEqual(bucketLabels(null), BUCKET_LABEL_DEFAULT)
  assert.deepEqual(bucketLabels(undefined), BUCKET_LABEL_DEFAULT)
})

test("a park that has not run the migration is not a crash — the columns are simply absent", () => {
  // The guarded select comes back without these keys on an un-migrated park.
  const settings = { park_name: 'Somewhere Pines' } as Record<string, unknown>
  assert.deepEqual(bucketLabels(settings), BUCKET_LABEL_DEFAULT)
})

test("the owner's wording wins when they have set it", () => {
  const l = bucketLabels({ bucket_label_camp: 'Store Account', bucket_label_seasonal: 'Lot Rent' })
  assert.equal(l.camp, 'Store Account')
  assert.equal(l.seasonal, 'Lot Rent')
})

test('one bucket may be renamed without the other', () => {
  const l = bucketLabels({ bucket_label_seasonal: 'Site Fee' })
  assert.equal(l.camp, BUCKET_LABEL_DEFAULT.camp)
  assert.equal(l.seasonal, 'Site Fee')
})

test('⚠ BLANK IS NOT A LABEL — a cleared box returns the default, never an empty heading', () => {
  for (const blank of ['', '   ', '\t', '\n', null, undefined]) {
    const l = bucketLabels({ bucket_label_camp: blank as string | null })
    assert.equal(l.camp, BUCKET_LABEL_DEFAULT.camp, `blank ${JSON.stringify(blank)}`)
    assert.ok(l.camp.length > 0)
  }
})

test('surrounding whitespace is trimmed rather than shipped into a card title', () => {
  assert.equal(bucketLabels({ bucket_label_camp: '  Camp Store  ' }).camp, 'Camp Store')
})

test('a non-string in the column is treated as unset rather than rendered', () => {
  // Defensive: PostgREST hands back whatever is in the column, and a money screen should not
  // print "42" or "[object Object]" as a heading.
  assert.equal(bucketLabels({ bucket_label_camp: 42 as unknown as string }).camp, BUCKET_LABEL_DEFAULT.camp)
})

test('bucketLabel() gives one label and agrees with bucketLabels()', () => {
  const s = { bucket_label_camp: 'Store Account' }
  assert.equal(bucketLabel(s, 'camp'), 'Store Account')
  assert.equal(bucketLabel(s, 'seasonal'), BUCKET_LABEL_DEFAULT.seasonal)
  assert.equal(bucketLabel(s, 'camp'), bucketLabels(s).camp)
})
