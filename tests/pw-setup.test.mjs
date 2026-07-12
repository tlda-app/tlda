import test from 'node:test'
import assert from 'node:assert/strict'

import { pwCanCreateTab, pwSetupUrl } from '../cli/lib/pw.mjs'

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
