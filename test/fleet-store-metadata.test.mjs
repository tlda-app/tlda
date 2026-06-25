#!/usr/bin/env node

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { FleetStore } from '../server/lib/fleet-store.mjs'

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
})
