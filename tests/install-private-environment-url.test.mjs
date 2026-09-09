import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import test from 'node:test'

const installer = new URL('../scripts/install-private-environment-url.mjs', import.meta.url)
const sentinel = '__TLDA_PROMOTION_SOURCE_URL__'
const picSource = new URL('../config/deployments/pic/daemon.yaml', import.meta.url)

function run(source, value) {
  const dir = mkdtempSync(join(tmpdir(), 'tlda-private-environment-'))
  const daemonPath = join(dir, 'daemon.yaml')
  writeFileSync(daemonPath, source)
  const env = { ...process.env }
  delete env.TLDA_PROMOTION_SOURCE_URL
  if (value !== undefined) env.TLDA_PROMOTION_SOURCE_URL = value
  const result = spawnSync(process.execPath, [installer.pathname, daemonPath], {
    encoding: 'utf8',
    env,
  })
  const installed = readFileSync(daemonPath, 'utf8')
  rmSync(dir, { recursive: true })
  return { ...result, installed }
}

test('substitutes the private URL only in the installed copy', () => {
  const source = readFileSync(picSource, 'utf8')
  const result = run(source, 'https://preview.example.test')
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.installed, /environments:\n  default: pic\n/)
  assert.match(result.installed, /pic-preview:\n      database: https:\/\/preview\.example\.test\n      store: https:\/\/preview\.example\.test\n      licenseKey: ""/)
  assert.equal(readFileSync(picSource, 'utf8'), source)
})

test('fails closed when the required private URL is absent', () => {
  const result = run(`database: ${sentinel}\nstore: ${sentinel}\n`)
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /TLDA_PROMOTION_SOURCE_URL is required/)
})

test('fails closed for malformed or non-HTTPS private URLs without printing them', () => {
  for (const value of ['not a URL', 'http://private.example.test', 'https://private.example.test/path']) {
    const result = run(`database: ${sentinel}\nstore: ${sentinel}\n`, value)
    assert.notEqual(result.status, 0)
    assert.doesNotMatch(result.stderr, new RegExp(value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  }
})

test('fails closed unless the sentinel occurs exactly in both URL fields', () => {
  const result = run(`database: ${sentinel}\nstore: https://example.test\n`, 'https://preview.example.test')
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /exactly twice/)
})

test('does not affect deployment configs without the sentinel', () => {
  const source = 'environments:\n  default: stable\n  values: {}\n'
  const result = run(source)
  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.installed, source)
})
