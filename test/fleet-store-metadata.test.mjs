#!/usr/bin/env node

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { FleetStore } from '../server/lib/fleet-store.mjs'
import { prettyNameForFriendlyName } from '../shared/lineage-name.mjs'

describe('FleetStore agent metadata', () => {
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
      { kind: 'glyph', id: 'day', glyph: '☀', label: '☀' },
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
        { kind: 'glyph', id: 'day', glyph: '☀', label: '☀' },
        'chief',
      ])
    } finally {
      store.close()
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})
