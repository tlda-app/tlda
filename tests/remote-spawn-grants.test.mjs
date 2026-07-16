import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { readDaemonConfig } from '../agent-launch/permission-ledger.mjs'

test('daemon config rejects deleted remote grant mappings', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tlda-remote-grant-config-'))
  const yaml = path.join(tmp, 'daemon.yaml')
  fs.writeFileSync(yaml, `
regions:
  project:
    - /work/project
profiles:
  app-dev:
    read: { allow: [project] }
    write: { allow: [project] }
remoteGrants:
  "mini:default":
    "fleet:skip":
      ops: app-dev
default: app-dev
`)
  try {
    assert.throws(() => readDaemonConfig(yaml), /unknown key\(s\): remoteGrants/)
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
})

test('spawn entry surfaces use one request spelling and no source-class mapping', () => {
  const http = fs.readFileSync(new URL('../server/routes/fleet.mjs', import.meta.url), 'utf8')
  assert.match(http, /permissionRequest: permissionRequest \|\| undefined/)
  assert.doesNotMatch(http, /requestedPermissions: permissionRequest/)
  assert.doesNotMatch(http, /requestedPermission: /)
  assert.doesNotMatch(http, /permissionClass/)
  assert.doesNotMatch(http, /permission_class/)

  const tools = fs.readFileSync(new URL('../mcp-server/fleet-tools.mjs', import.meta.url), 'utf8')
  assert.match(tools, /permissionRequest: spawnOpts\.permissionRequest/)
  assert.doesNotMatch(tools, /requestedPermissions: spawnOpts/)
  assert.doesNotMatch(tools, /permission: spawnOpts\.permission/)

  const launcher = fs.readFileSync(new URL('../agent-launch/agent-launch.mjs', import.meta.url), 'utf8')
  assert.match(launcher, /permissionRequest,\n\s+acknowledgeNoSecurity/)
  assert.match(launcher, /permissionProfile: grant\.permissionProfile \|\| null/)
  assert.doesNotMatch(launcher, /resolveRemoteDaemonGrant/)
  assert.doesNotMatch(launcher, /permissionClass/)
})
