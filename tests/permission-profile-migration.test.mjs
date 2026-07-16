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
    recipeIndex: { byGrantId: new Map() },
    rosterIndex: { byId: new Map() },
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

function withRecipe(ctx, id, recipe) {
  const next = {
    ...ctx,
    recipeIndex: { byGrantId: new Map(ctx.recipeIndex.byGrantId) },
  }
  next.recipeIndex.byGrantId.set(id, [recipe])
  return next
}

test('permission profile migration classifies all amended census categories', () => {
  let ctx = context()
  ctx = withRecipe(ctx, 'fleet:recipe', { localAgentId: 'local:00000000-0000-0000-0000-000000000001', serverAgentId: 'fleet:recipe', permissionProfile: 'app' })
  ctx = withRecipe(ctx, 'fleet:missingprofile', { localAgentId: 'local:00000000-0000-0000-0000-000000000002', serverAgentId: 'fleet:missingprofile', permissionProfile: null })
  ctx = withRecipe(ctx, 'fleet:unconfigured', { localAgentId: 'local:00000000-0000-0000-0000-000000000003', serverAgentId: 'fleet:unconfigured', permissionProfile: 'wd' })
  ctx = withRecipe(ctx, 'fleet:recipeconflict', { localAgentId: 'local:00000000-0000-0000-0000-000000000004', serverAgentId: 'fleet:recipeconflict', permissionProfile: 'ops' })
  ctx = withRecipe(ctx, 'fleet:uniqueconflict', { localAgentId: 'local:00000000-0000-0000-0000-000000000007', serverAgentId: 'fleet:uniqueconflict', permissionProfile: 'app' })
  ctx.recipeIndex.byGrantId.set('fleet:stillambiguous', [
    { localAgentId: 'local:00000000-0000-0000-0000-000000000005', serverAgentId: 'fleet:stillambiguous', permissionProfile: 'app' },
    { localAgentId: 'local:00000000-0000-0000-0000-000000000006', serverAgentId: 'fleet:stillambiguous', permissionProfile: 'duplicate' },
  ])
  const rows = [
    row('fleet:unique', { set: permissionSet({ writeAllow: ['**'] }) }),
    row('fleet:recipe', { set: permissionSet({ writeAllow: ['/work/app/**'] }) }),
    row('fleet:missing', { set: permissionSet({ writeAllow: ['/work/app/**'] }) }),
    row('fleet:${suffix}`', { set: permissionSet({ writeAllow: ['**'] }) }),
    row('fleet:unconfigured', { set: permissionSet({ writeAllow: ['/work/app/**'] }) }),
    row('fleet:recipeconflict', { set: permissionSet({ writeAllow: ['/work/app/**'] }) }),
    row('fleet:uniqueconflict', { set: permissionSet({ writeAllow: ['**'] }) }),
    row('fleet:stillambiguous', { set: permissionSet({ writeAllow: ['/work/app/**'] }) }),
    row('fleet:missingprofile', { set: permissionSet({ writeAllow: ['/work/app/**'] }) }),
    row('fleet:already', { profile: 'ops', set: permissionSet({ writeAllow: ['**'] }) }),
    row('fleet:conflict', { profile: 'app', set: permissionSet({ writeAllow: ['**'] }) }),
  ]

  const { report, updates } = analyzeRows(rows, ctx)
  assert.equal(report.total, 11)
  assert.equal(report.wouldUpdate, 2)
  assert.equal(report.wouldRegenerate, 2)
  assert.equal(report.uniqueSetResolved, 1)
  assert.equal(report.recipeDisambiguated, 1)
  assert.equal(report.recipeRegenerated, 2)
  assert.equal(report.missingRecipe, 2)
  assert.equal(report.malformedJunkIdentity, 1)
  assert.equal(report.unconfiguredRecipeProfile, 1)
  assert.equal(report.setProfileConflict, 1)
  assert.equal(report.stillAmbiguous, 1)
  assert.equal(report.alreadySet, 1)
  assert.deepEqual(updates.map((entry) => [entry.id, entry.action, entry.permissionProfile]), [
    ['fleet:unique', 'fill-profile', 'ops'],
    ['fleet:recipe', 'fill-profile', 'app'],
    ['fleet:recipeconflict', 'regenerate-from-recipe', 'ops'],
    ['fleet:uniqueconflict', 'regenerate-from-recipe', 'app'],
  ])
  assert.equal(updates.find((entry) => entry.id === 'fleet:recipeconflict').source, 'migration:permission-profile-backfill-20260716')
  assert.equal(report.rows.find((entry) => entry.id === 'fleet:${suffix}`').category, 'malformed/junk identity')
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
  duplicate:
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
    );
    CREATE TABLE local_agents (
      local_agent_id TEXT PRIMARY KEY,
      server_agent_id TEXT UNIQUE,
      friendly_name TEXT,
      created_at TEXT NOT NULL,
      bound_at TEXT
    );
    CREATE TABLE local_agent_process_recipes (
      local_agent_id TEXT PRIMARY KEY,
      tmux_name TEXT,
      cwd TEXT,
      permission_profile TEXT
    );
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
  insert.run(
    'fleet:recipe-fill',
    JSON.stringify({ policy: 'cwd' }),
    JSON.stringify(permissionSet({ writeAllow: ['/work/app/**'] })),
    '2026-07-16T00:00:00.000Z',
    'test',
    '/work/app',
  )
  insert.run(
    'fleet:recipe-regen',
    JSON.stringify({ policy: 'unsandboxed' }),
    JSON.stringify(permissionSet({ writeAllow: ['**'] })),
    '2026-07-16T00:00:00.000Z',
    'test',
    '/work/app',
  )
  db.prepare('INSERT INTO local_agents VALUES (?, ?, ?, ?, ?)').run(
    'local:00000000-0000-0000-0000-000000000010',
    'fleet:recipe-fill',
    'recipe-fill',
    '2026-07-16T00:00:00.000Z',
    '2026-07-16T00:00:00.000Z',
  )
  db.prepare('INSERT INTO local_agent_process_recipes VALUES (?, ?, ?, ?)').run(
    'local:00000000-0000-0000-0000-000000000010',
    'recipe-fill',
    '/work/app',
    'app',
  )
  db.prepare('INSERT INTO local_agents VALUES (?, ?, ?, ?, ?)').run(
    'local:00000000-0000-0000-0000-000000000011',
    'fleet:recipe-regen',
    'recipe-regen',
    '2026-07-16T00:00:00.000Z',
    '2026-07-16T00:00:00.000Z',
  )
  db.prepare('INSERT INTO local_agent_process_recipes VALUES (?, ?, ?, ?)').run(
    'local:00000000-0000-0000-0000-000000000011',
    'recipe-regen',
    '/work/app',
    'app',
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
    const rosterJsonPath = path.join(dir, 'fleet-table.json')
    fs.writeFileSync(rosterJsonPath, JSON.stringify({
	    agents: [
	      { id: 'fleet:recipe-fill', name: 'recipe-fill', status: 'awake', cwd: '/work/app', machine_id: 'mini', daemon_key: 'mini:default' },
	      { id: 'fleet:recipe-regen', name: 'recipe-regen', status: 'awake', cwd: '/work/app', machine_id: 'mini', daemon_key: 'mini:default' },
	    ],
	  }))

    const dryRun = runMigration({ configDir: dir, dbPath, rosterJsonPath })
    assert.equal(dryRun.mode, 'dry-run')
    assert.equal(dryRun.report.wouldUpdate, 2)
    assert.equal(dryRun.report.wouldRegenerate, 1)
    assert.equal(dryRun.report.uniqueSetResolved, 1)
    assert.equal(dryRun.report.recipeDisambiguated, 1)
    assert.equal(dryRun.report.recipeRegenerated, 1)
    assert.equal(dryRun.report.missingRecipe, 1)
    assert.equal(dryRun.report.rows.find((entry) => entry.id === 'fleet:recipe-fill').evidence.roster.status, 'awake')
    assert.equal(dryRun.report.rows.find((entry) => entry.id === 'fleet:recipe-regen').plan.source, 'migration:permission-profile-backfill-20260716')

    const applied = runMigration({ apply: true, configDir: dir, dbPath, backupDir })
    assert.equal(applied.mode, 'apply')
    assert.equal(applied.apply.planned, 3)
    assert.equal(applied.apply.updated, 3)
    assert.equal(applied.apply.quickCheck, 'ok')
    assert.equal(applied.apply.postApplyDryRun.wouldUpdate, 0)
    assert.equal(applied.apply.postApplyDryRun.wouldRegenerate, 0)
    assert.equal(applied.apply.postApplyDryRun.alreadySet, 3)
    assert.ok(applied.backups.some((entry) => entry.source === dbPath && entry.bytes > 0))
    assert.ok(applied.revertProcedure.some((line) => line.includes(JSON.stringify(dbPath))))

    const db = new Database(dbPath, { readonly: true })
    try {
      assert.equal(db.prepare('SELECT permission_profile FROM permission_grants WHERE id = ?').pluck().get('fleet:needs-fill'), 'ops')
      assert.equal(db.prepare('SELECT permission_profile FROM permission_grants WHERE id = ?').pluck().get('fleet:no-match'), null)
      assert.equal(db.prepare('SELECT permission_profile FROM permission_grants WHERE id = ?').pluck().get('fleet:recipe-fill'), 'app')
      assert.equal(db.prepare('SELECT permission_profile FROM permission_grants WHERE id = ?').pluck().get('fleet:recipe-regen'), 'app')
      assert.equal(db.prepare('SELECT source FROM permission_grants WHERE id = ?').pluck().get('fleet:recipe-regen'), 'migration:permission-profile-backfill-20260716')
      assert.deepEqual(JSON.parse(db.prepare('SELECT spawn_policy FROM permission_grants WHERE id = ?').pluck().get('fleet:recipe-regen')), { policy: 'cwd' })
      assert.deepEqual(JSON.parse(db.prepare('SELECT permission_set FROM permission_grants WHERE id = ?').pluck().get('fleet:recipe-regen')).operations.write.allow, ['/work/app/**'])
    } finally {
      db.close()
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
