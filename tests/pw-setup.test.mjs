import test from 'node:test'
import assert from 'node:assert/strict'

import {
  memoryPressure,
  parseDarwinAvailableMemoryBytes,
  pwCanCreateTab,
  pwSetupUrl,
} from '../cli/lib/pw.mjs'

const GIB = 1024 * 1024 * 1024

const genuinePressureVmStat = `Mach Virtual Memory Statistics: (page size of 4096 bytes)
Pages free:                               12,288.
Pages active:                          2,800,000.
Pages inactive:                          12,288.
Pages speculative:                       12,288.
Pages throttled:                              0.
Pages wired down:                       900,000.
Pages purgeable:                              0.
File-backed pages:                       10,000.
Anonymous pages:                      2,790,000.
Pages stored in compressor:             200,000.
Pages occupied by compressor:            80,000.
`

const reclaimableCacheVmStat = `Mach Virtual Memory Statistics: (page size of 4096 bytes)
Pages free:                                1,024.
Pages active:                          1,700,000.
Pages inactive:                       1,000,000.
Pages speculative:                      500,000.
Pages throttled:                              0.
Pages wired down:                       600,000.
Pages purgeable:                        200,000.
File-backed pages:                    1,450,000.
Anonymous pages:                      1,750,000.
Pages stored in compressor:             400,000.
Pages occupied by compressor:           120,000.
`

test('pw setup targets the requested document in the real environment', () => {
  const url = new URL(pwSetupUrl(['--doc', 'agent-ui-test'], 'https://tlda.example.test'))
  assert.equal(url.origin, 'https://tlda.example.test')
  assert.equal(url.searchParams.get('doc'), 'agent-ui-test')
  assert.equal(url.searchParams.get('pw'), '1')
  assert.ok(url.searchParams.get('name'))
  assert.equal(url.searchParams.has('fleetLayout'), false)
})

test('pw setup requires an explicit unused document', () => {
  assert.throws(
    () => pwSetupUrl([], 'https://tlda.example.test'),
    /--doc NAME is required; choose a document Skip is not using/
  )
})

test('pw setup fails on unknown arguments', () => {
  assert.throws(
    () => pwSetupUrl(['--sandbox'], 'https://tlda.example.test'),
    /unknown or incomplete argument/
  )
})

test('pw tab creation is refused at the per-session cap', () => {
  assert.deepEqual(
    pwCanCreateTab({ tabCount: 6, maxTabs: 6, pressure: 0.2, pressureLimit: 0.9 }),
    { ok: false, reason: 'session tab cap reached (6/6)' }
  )
})

test('pw tab creation is refused under high memory pressure', () => {
  assert.deepEqual(
    pwCanCreateTab({ tabCount: 1, maxTabs: 6, pressure: 0.95, pressureLimit: 0.9 }),
    { ok: false, reason: 'memory pressure 95% >= 90%' }
  )
})

test('pw tab creation is allowed under cap and pressure limit', () => {
  assert.deepEqual(
    pwCanCreateTab({ tabCount: 5, maxTabs: 6, pressure: 0.5, pressureLimit: 0.9 }),
    { ok: true }
  )
})

test('Darwin memory pressure trips under genuine low available memory', () => {
  const pressure = memoryPressure({
    platformName: 'darwin',
    total: 16 * GIB,
    vmStatOutput: genuinePressureVmStat,
  })

  assert.equal(parseDarwinAvailableMemoryBytes(genuinePressureVmStat), 144 * 1024 * 1024)
  assert.equal(Math.round(pressure * 1000) / 1000, 0.991)
  assert.deepEqual(
    pwCanCreateTab({ tabCount: 1, maxTabs: 6, pressure, pressureLimit: 0.9 }),
    { ok: false, reason: 'memory pressure 99% >= 90%' }
  )
})

test('Darwin memory pressure allows reclaimable inactive and speculative cache', () => {
  const pressure = memoryPressure({
    platformName: 'darwin',
    total: 16 * GIB,
    vmStatOutput: reclaimableCacheVmStat,
  })
  const rawFreeOnlyPressure = 1 - (1024 * 4096) / (16 * GIB)

  assert.equal(parseDarwinAvailableMemoryBytes(reclaimableCacheVmStat), 6148194304)
  assert.ok(rawFreeOnlyPressure > 0.99)
  assert.equal(Math.round(pressure * 1000) / 1000, 0.642)
  assert.deepEqual(
    pwCanCreateTab({ tabCount: 1, maxTabs: 6, pressure, pressureLimit: 0.9 }),
    { ok: true }
  )
})
