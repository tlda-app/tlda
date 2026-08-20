import assert from 'node:assert/strict'
import test from 'node:test'

import { migrateReadabilityProfiles } from '../src/readabilityDefaults.ts'

test('readability migration moves the retired chat aspect into column aspect once', () => {
  const stored = {
    air: { chatAspect: 0.7, railAspect: 0.4 },
    desktop: { columnAspect: 0.9, chatAspect: 0.6 },
  }

  const migrated = migrateReadabilityProfiles(stored)

  assert.equal(migrated.migrated, true)
  assert.deepEqual(migrated.profiles, {
    air: { columnAspect: 0.7, railAspect: 0.4 },
    desktop: { columnAspect: 0.9 },
  })
  assert.deepEqual(stored, {
    air: { chatAspect: 0.7, railAspect: 0.4 },
    desktop: { columnAspect: 0.9, chatAspect: 0.6 },
  })
})

test('canonical readability profiles need no second migration', () => {
  const stored = { air: { columnAspect: 0.8 } }
  const migrated = migrateReadabilityProfiles(stored)

  assert.equal(migrated.migrated, false)
  assert.deepEqual(migrated.profiles, stored)
})
