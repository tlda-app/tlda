#!/usr/bin/env node

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { FleetStore } from '../server/lib/fleet-store.mjs'
import { prettyNameForFriendlyName } from '../shared/lineage-name.mjs'

describe('FleetStore agent metadata', () => {
  it('persists daemon registry ownership and agent resume handles', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-store-daemon-registry-'))
    const dbPath = path.join(dir, 'fleet.db')
    const store = new FleetStore(dbPath)

    try {
      store.upsertDaemonRegistration({
        daemon_key: 'mini:stable',
        machine_id: 'mini',
        env_name: 'stable',
        install_path: '/Users/skip/work/tlda/bin/fleet-daemon.mjs',
        boot_id: 123,
        status: 'connected',
      })
      store.upsertAgent({
        id: 'fleet:codex',
        friendly_name: 'codex-worker',
        machine_id: 'mini',
        env_name: 'stable',
        tmux_session: 'fleet-codex',
        resume_id: 'rollout-abc',
        metadata: { kind: 'codex' },
      })

      const daemon = store.getDaemonRegistration('mini:stable')
      assert.equal(daemon.status, 'connected')
      assert.equal(daemon.machine_id, 'mini')
      assert.equal(daemon.env_name, 'stable')

      const agent = store.getAgent('fleet:codex')
      assert.equal(agent.daemon_key, 'mini:stable')
      assert.equal(agent.resume_id, 'rollout-abc')
      assert.deepEqual(store.getAgentsByDaemonKey('mini:stable').map(a => a.id), ['fleet:codex'])

      store.markDaemonDisconnected('mini:stable', '2026-07-04T20:00:00.000Z')
      assert.equal(store.getDaemonRegistration('mini:stable').status, 'disconnected')
    } finally {
      store.close()
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('merges registration metadata without dropping spawn policy', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-store-metadata-'))
    const dbPath = path.join(dir, 'fleet.db')
    const store = new FleetStore(dbPath)

    try {
      store.upsertAgent({
        id: 'fleet:testgoose',
        friendly_name: 'testgoose',
        metadata: {
          kind: 'goose',
          model: 'deepseek/deepseek-v4-pro',
          spawnPolicy: { capability: 'read-only' },
        },
      })
      store.upsertAgent({
        id: 'fleet:testgoose',
        friendly_name: 'testgoose',
        metadata: { kind: 'goose' },
      })

      const agent = store.findAgent('fleet:testgoose')
      assert.deepEqual(agent.metadata, {
        kind: 'goose',
        model: 'deepseek/deepseek-v4-pro',
        spawnPolicy: { capability: 'read-only' },
      })
    } finally {
      store.close()
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('round-trips explicit pretty_name display parts', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-store-pretty-name-'))
    const dbPath = path.join(dir, 'fleet.db')
    const store = new FleetStore(dbPath)

    try {
      const pretty_name = [
        { kind: 'glyph', id: 'love-symbol', glyph: 'Love' },
        'the-artist-formerly-known-as',
      ]
      store.upsertAgent({
        id: 'fleet:artist',
        friendly_name: 'the-artist-formerly-known-as:prince',
        pretty_name,
        labels: [],
      })

      const agent = store.findAgent('fleet:artist')
      assert.equal(agent.friendly_name, 'the-artist-formerly-known-as:prince')
      assert.deepEqual(agent.pretty_name, pretty_name)
    } finally {
      store.close()
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('derives explicit pretty_name for generated phase names', () => {
    assert.equal(prettyNameForFriendlyName('chief'), 'chief')
    assert.deepEqual(prettyNameForFriendlyName('chief:day'), [
      { kind: 'glyph', id: 'day', glyph: '☀' },
      'chief',
    ])
  })

  it('stores pretty_name when lineage phase writes friendly_name', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-store-lineage-pretty-'))
    const dbPath = path.join(dir, 'fleet.db')
    const store = new FleetStore(dbPath)

    try {
      store.upsertAgent({ id: 'fleet:chief', friendly_name: 'chief', labels: [] })
      const lineage = store.getOrCreateLineage('chief')
      store.assignPhase('fleet:chief', lineage.id, 'day')

      const agent = store.getAgent('fleet:chief')
      assert.equal(agent.friendly_name, 'chief:day')
      assert.deepEqual(agent.pretty_name, [
        { kind: 'glyph', id: 'day', glyph: '☀' },
        'chief',
      ])
    } finally {
      store.close()
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('backfills missing pretty_name from friendly_name without replacing custom values', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-store-pretty-backfill-'))
    const dbPath = path.join(dir, 'fleet.db')
    let store = new FleetStore(dbPath)

    try {
      store.upsertAgent({ id: 'fleet:chief-day', friendly_name: 'chief:day', labels: [] })
      store.upsertAgent({
        id: 'fleet:custom',
        friendly_name: 'custom:day',
        pretty_name: [{ kind: 'glyph', id: 'custom', glyph: 'C' }, 'custom'],
        labels: [],
      })
      store.close()

      store = new FleetStore(dbPath)
      const backfilled = store.getAgent('fleet:chief-day')
      assert.equal(backfilled.friendly_name, 'chief:day')
      assert.deepEqual(backfilled.pretty_name, [
        { kind: 'glyph', id: 'day', glyph: '☀' },
        'chief',
      ])

      const custom = store.getAgent('fleet:custom')
      assert.deepEqual(custom.pretty_name, [{ kind: 'glyph', id: 'custom', glyph: 'C' }, 'custom'])
    } finally {
      store.close()
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})
