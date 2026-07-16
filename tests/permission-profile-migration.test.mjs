import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import Database from 'better-sqlite3'

import { analyzeRows, runMigration } from '../bin/backfill-permission-profiles.mjs'

function permissionSet({ name = 'profile', writeAllow = [] } = {}) {
  return {
    type: 'permission-set',
    name,
    operations: {
      read: { allow: writeAllow, deny: [] },
      write: { allow: writeAllow, deny: [] },
      spawn: { allow: [], deny: [] },
    },
    rules: [],
    projectedPolicy: { policy: writeAllow.includes('**') ? 'unsandboxed' : 'cwd' },
  }
}

function context() {
  const profiles = {
    app: permissionSet({ name: 'app', writeAllow: ['/work/app/**'] }),
    duplicate: permissionSet({ name: 'duplicate', writeAllow: ['/work/app/**'] }),
    ops: permissionSet({ name: 'ops', writeAllow: ['**'] }),
  }
  return {
    daemonYaml: '/tmp/unused-daemon.yaml',
    baseConfig: { spawnPolicy: { permissionProfiles: profiles } },
  }
}

function row(id, { profile = null, set = null, cwd = '/work/app' } = {}) {
  return {
    id,
    permission_profile: profile,
    permission_set: set ? JSON.stringify(set) : null,
    cwd,
  }
}

test('permission profile migration classifies exact, ambiguous, unresolved, and conflicting rows', () => {
  const rows = [
    row('fleet:resolved', { set: permissionSet({ writeAllow: ['**'] }) }),
    row('fleet:ambiguous', { set: permissionSet({ writeAllow: ['/work/app/**'] }) }),
    row('fleet:unresolved', { set: permissionSet({ writeAllow: ['/other/**'] }) }),
    row('fleet:already', { profile: 'ops', set: permissionSet({ writeAllow: ['**'] }) }),
    row('fleet:conflict', { profile: 'app', set: permissionSet({ writeAllow: ['**'] }) }),
  ]

  const { report, updates } = analyzeRows(rows, context())
  assert.equal(report.total, 5)
  assert.equal(report.resolved, 1)
  assert.equal(report.ambiguous, 1)
  assert.equal(report.unresolved, 1)
  assert.equal(report.alreadySet, 1)
  assert.equal(report.conflicting, 1)
  assert.deepEqual(updates, [{ id: 'fleet:resolved', permissionProfile: 'ops' }])
})

function writeConfig(dir) {
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({}, null, 2))
  fs.writeFileSync(path.join(dir, 'daemon.yaml'), `
regions:
  app:
    - /work/app/**
  machine:
    - "**"
profiles:
  app:
    read: { allow: [app] }
    write: { allow: [app] }
  ops:
    read: { allow: [machine] }
    write: { allow: [machine] }
default: app
`)
}

function createLedger(dbPath) {
  const db = new Database(dbPath)
  db.exec(`
    CREATE TABLE permission_grants (
      id TEXT PRIMARY KEY,
      spawn_policy TEXT NOT NULL,
      permission_set TEXT,
      updated_at TEXT NOT NULL,
      source TEXT NOT NULL,
      cwd TEXT
    )
  `)
  const insert = db.prepare('INSERT INTO permission_grants VALUES (?, ?, ?, ?, ?, ?)')
  insert.run(
    'fleet:needs-fill',
    JSON.stringify({ policy: 'unsandboxed' }),
    JSON.stringify(permissionSet({ writeAllow: ['**'] })),
    '2026-07-16T00:00:00.000Z',
    'test',
    '/work/app',
  )
  insert.run(
    'fleet:no-match',
    JSON.stringify({ policy: 'cwd' }),
    JSON.stringify(permissionSet({ writeAllow: ['/other/**'] })),
    '2026-07-16T00:00:00.000Z',
    'test',
    '/work/app',
  )
  db.close()
}

test('permission profile migration apply is backed up and idempotent', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tlda-profile-migration-'))
  const dbPath = path.join(dir, 'fleet-daemon.db')
  const backupDir = path.join(dir, 'backup')
  try {
    writeConfig(dir)
    createLedger(dbPath)

    const dryRun = runMigration({ configDir: dir, dbPath })
    assert.equal(dryRun.mode, 'dry-run')
    assert.equal(dryRun.report.resolved, 1)
    assert.equal(dryRun.report.unresolved, 1)

    const applied = runMigration({ apply: true, configDir: dir, dbPath, backupDir })
    assert.equal(applied.mode, 'apply')
    assert.equal(applied.apply.updated, 1)
    assert.equal(applied.apply.quickCheck, 'ok')
    assert.equal(applied.apply.postApplyDryRun.resolved, 0)
    assert.equal(applied.apply.postApplyDryRun.alreadySet, 1)
    assert.ok(applied.backups.some((entry) => entry.source === dbPath && entry.bytes > 0))
    assert.ok(applied.revertProcedure.some((line) => line.includes(JSON.stringify(dbPath))))

    const db = new Database(dbPath, { readonly: true })
    try {
      assert.equal(db.prepare('SELECT permission_profile FROM permission_grants WHERE id = ?').pluck().get('fleet:needs-fill'), 'ops')
      assert.equal(db.prepare('SELECT permission_profile FROM permission_grants WHERE id = ?').pluck().get('fleet:no-match'), null)
    } finally {
      db.close()
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
