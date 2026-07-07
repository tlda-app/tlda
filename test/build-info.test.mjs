import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { readBuildInfo } from '../server/lib/build-info.mjs'

test('readBuildInfo returns stamped commit metadata', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tlda-build-info-'))
  try {
    const stamp = join(dir, 'server', 'build-info.json')
    mkdirSync(join(dir, 'server'))
    writeFileSync(stamp, `${JSON.stringify({
      gitSha: 'abc123',
      sha: 'abc123',
      ref: 'main',
      branch: 'main',
      dirty: false,
      checkoutPath: dir,
      builtAt: '2026-07-07T12:00:00.000Z',
    })}\n`)

    const result = readBuildInfo(stamp)

    assert.equal(result.ok, true)
    assert.equal(result.status, 200)
    assert.deepEqual(result.buildInfo, {
      gitSha: 'abc123',
      sha: 'abc123',
      ref: 'main',
      branch: 'main',
      dirty: false,
      checkoutPath: dir,
      builtAt: '2026-07-07T12:00:00.000Z',
    })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('readBuildInfo reports a visible missing-stamp failure', () => {
  const result = readBuildInfo(join(tmpdir(), 'missing-tlda-build-info.json'))

  assert.equal(result.ok, false)
  assert.equal(result.status, 503)
  assert.match(result.error, /stamp missing/)
})

test('readBuildInfo rejects malformed stamps', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tlda-build-info-'))
  try {
    const stamp = join(dir, 'build-info.json')
    writeFileSync(stamp, '{"gitSha":"abc123"}\n')

    const result = readBuildInfo(stamp)

    assert.equal(result.ok, false)
    assert.equal(result.status, 500)
    assert.match(result.error, /missing sha/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
