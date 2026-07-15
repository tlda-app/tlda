import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  createPermissionLedger,
  readDaemonConfig,
  resolveRemoteDaemonGrant,
} from '../agent-launch/permission-ledger.mjs'

function daemonYaml() {
  return `
regions:
  project:
    - /work/project
profiles:
  app-dev:
    read: { allow: [project] }
    write: { allow: [project] }
  wd:
    read: { allow: [project] }
    write: { allow: [] }
remoteGrants:
  "mini:default":
    "fleet:skip":
      ops: app-dev
    "*":
      app-dev: wd
default: wd
`
}

test('destination daemon maps a remote agent class to a local durable grant', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tlda-remote-grant-'))
  const yaml = path.join(tmp, 'daemon.yaml')
  fs.writeFileSync(yaml, daemonYaml())
  const ledger = createPermissionLedger(path.join(tmp, 'fleet-daemon.db'))
  try {
    const config = readDaemonConfig(yaml)
    const resolved = resolveRemoteDaemonGrant(config, {
      id: 'fleet:skip',
      daemonId: 'mini:default',
      permissionClass: 'ops',
    })
    assert.equal(resolved.localProfile, 'app-dev')
    assert.equal(resolved.source, 'remote:mini:default:ops')
    assert.deepEqual(resolved.permissionSet.operations.write.allow, ['/work/project'])

    resolved.permissionSet.permissionClass = resolved.localProfile
    ledger.setSync('fleet:skip', resolved)
    const persisted = ledger.get('fleet:skip')
    assert.equal(persisted.permissionSet.permissionClass, 'app-dev')
    assert.equal(persisted.source, 'remote:mini:default:ops')
  } finally {
    await ledger.close()
    fs.rmSync(tmp, { recursive: true, force: true })
  }
})

test('remote class mappings are destination-owned, agent-specific, and fail closed', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tlda-remote-grant-config-'))
  const yaml = path.join(tmp, 'daemon.yaml')
  fs.writeFileSync(yaml, daemonYaml())
  try {
    const config = readDaemonConfig(yaml)
    assert.equal(resolveRemoteDaemonGrant(config, {
      id: 'fleet:other', daemonId: 'mini:default', permissionClass: 'app-dev',
    }).localProfile, 'wd')
    assert.equal(resolveRemoteDaemonGrant(config, {
      id: 'fleet:other', daemonId: 'air:default', permissionClass: 'app-dev',
    }), null)
    assert.equal(resolveRemoteDaemonGrant(config, {
      id: 'fleet:other', daemonId: 'mini:default', permissionClass: 'ops',
    }), null)
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
})

test('server spawn relay forwards identity, source daemon, and source class without resolving policy', () => {
  const source = fs.readFileSync(new URL('../server/unified-server.mjs', import.meta.url), 'utf8')
  assert.match(source, /daemonId: caller\.daemon_key \|\| caller\.metadata\?\.daemon_key/)
  assert.match(source, /permissionClass: caller\.metadata\?\.spawnPolicy\?\.permission \|\| caller\.metadata\?\.permissionClass/)
})
