import assert from 'node:assert/strict'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import test from 'node:test'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { acquireLease, renewLease, releaseLease, expiredLeases, formatLeaseMarkdownTable, listLeases } from '../cli/lib/resource-leases.mjs'

function fixture() { return { file: join(mkdtempSync(join(tmpdir(), 'tlda-lease-')), 'leases.json'), now: 1_000 } }
function lease(kind, resource_id) { return { kind, resource_id, owner: { id: 'fleet:test' }, metadata: { session: 'shared', tab: 2, pid: 42, ports: [5190], worktree: '/tmp/wt' }, policy: { ttl_ms: 500 } } }
const execFileP = promisify(execFile)

test('acquire renew release keeps lease lifecycle and metadata', () => {
  const { file, now } = fixture()
  const acquired = acquireLease(lease('playwright-tab', 'tab:shared:test'), { file, now })
  assert.equal(acquired.created_at, '1970-01-01T00:00:01.000Z')
  const renewed = renewLease(acquired.resource_id, { metadata: { ...acquired.metadata, tab: 3 } }, { file, now: 1_200 })
  assert.equal(renewed.metadata.tab, 3)
  assert.equal(renewed.expires_at, '1970-01-01T00:00:01.700Z')
  assert.equal(releaseLease(acquired.resource_id, { file }), true)
  assert.deepEqual(listLeases({ file }), [])
})

test('expiry orders tabs before sessions before preview servers', () => {
  const { file, now } = fixture()
  acquireLease(lease('preview-server', 'preview:main'), { file, now })
  acquireLease(lease('playwright-session', 'session:shared'), { file, now })
  acquireLease(lease('playwright-tab', 'tab:shared:test'), { file, now })
  assert.deepEqual(expiredLeases({ file, now: 2_000 }).map(l => l.kind), ['playwright-tab', 'playwright-session', 'preview-server'])
})

test('markdown status shows resource and pressure-ready lease fields', () => {
  const { file, now } = fixture()
  acquireLease(lease('playwright-tab', 'tab:shared:test'), { file, now })
  const report = formatLeaseMarkdownTable(listLeases({ file, now: 1_100 }))
  assert.match(report, /\| Kind \| Resource \| Owner \| Location \| Runtime \| Expires \| State \|/)
  assert.match(report, /playwright-tab.*fleet:test.*tab 2.*active/)
})

test('concurrent agents retain every lease record', async () => {
  const { file } = fixture()
  const moduleUrl = new URL('../cli/lib/resource-leases.mjs', import.meta.url).href
  const worker = `import { acquireLease } from ${JSON.stringify(moduleUrl)}; acquireLease({ kind: 'playwright-tab', resource_id: process.env.RESOURCE_ID, owner: { id: process.env.RESOURCE_ID }, metadata: { session: 'shared' }, policy: { ttl_ms: 60000 } }, { file: process.env.LEASE_FILE })`
  await Promise.all(Array.from({ length: 24 }, (_, i) => execFileP(process.execPath, ['--input-type=module', '--eval', worker], {
    env: { ...process.env, LEASE_FILE: file, RESOURCE_ID: `tab:shared:${i}` },
  })))
  assert.equal(listLeases({ file }).length, 24)
})
