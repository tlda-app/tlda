import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import {
  DOC_VERSION_RETIRED_PROP_MIGRATION_ID,
  stripRetiredDocVersionProps,
} from '../shared/shapes/doc-version-migrations.mjs'

test('retired branch-era doc-version buildStatus is removed without changing current props', () => {
  const stored = {
    w: 1,
    h: 1,
    commitHash: 'abc123',
    timestamp: 42,
    buildStatus: 'failed',
    errorsJson: '["build failed"]',
  }

  assert.deepEqual(stripRetiredDocVersionProps(stored), {
    w: 1,
    h: 1,
    commitHash: 'abc123',
    timestamp: 42,
    errorsJson: '["build failed"]',
  })
  assert.equal(stored.buildStatus, 'failed', 'migration must not mutate its input')
})

test('client and sync-room schemas apply the same doc-version migration', () => {
  assert.equal(DOC_VERSION_RETIRED_PROP_MIGRATION_ID, 'com.tldraw.shape.doc-version/1')

  const client = readFileSync(new URL('../src/shapes/DocVersionShape.tsx', import.meta.url), 'utf8')
  const server = readFileSync(new URL('../server/lib/sync-rooms.mjs', import.meta.url), 'utf8')
  for (const source of [client, server]) {
    assert.match(source, /DOC_VERSION_RETIRED_PROP_MIGRATION_ID/)
    assert.match(source, /stripRetiredDocVersionProps/)
  }
  assert.match(server, /record\.type === 'doc-version'/)
  for (const source of [client, server]) {
    assert.match(source, /sourceVersion: T\.optional\(T\.number\)/)
    assert.match(source, /sourceRevision: T\.optional\(T\.string\)/)
  }
})
