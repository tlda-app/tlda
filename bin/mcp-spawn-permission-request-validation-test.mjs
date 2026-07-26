#!/usr/bin/env node
import assert from 'assert/strict'
import { readFileSync } from 'fs'
import { normalizeSpawnModelKwargs } from '../agent-launch/models.mjs'

const config = {
  modelCatalog: { default: 'gpt' },
  modelSpecs: {
    gpt: { alias: 'gpt', id: 'gpt-5.5', harness: 'codex' },
  },
}

assert.throws(
  () => normalizeSpawnModelKwargs({ model: 'gpt', permissionRequest: 'app-dev' }, { config }),
  /unknown model option\(s\) for "gpt": permissionRequest/,
)

const source = readFileSync(new URL('../mcp-server/fleet-tools.mjs', import.meta.url), 'utf8')
assert.match(source, /const reserved = new Set\([\s\S]*['"]permissionRequest['"]/)

console.log('ok mcp spawn preflight reserves permissionRequest outside model options')
