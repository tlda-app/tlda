import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

import {
  formatSpawnModelSummary,
  validateSpawnModelSelection,
} from '../shared/spawn-model-validation.mjs'

const catalog = {
  default: 'deepseek/deepseek-v4-pro',
  models: [
    { alias: 'opus48', id: 'claude-opus-4-8[1m]', kind: 'claude', verified: true },
    { alias: 'gpt', id: 'gpt-5.5', kind: 'codex', verified: true },
    { alias: 'gpt-5.5', id: 'gpt-5.5', kind: 'codex', verified: true },
    { alias: 'deepseek', id: 'deepseek/deepseek-v4-pro', kind: 'goose', verified: true },
    { alias: 'deepseek-v4-pro', id: 'deepseek/deepseek-v4-pro', kind: 'goose', verified: true },
  ],
}

test('spawn model validation accepts the DeepSeek Goose alias agents actually need', () => {
  const result = validateSpawnModelSelection({ model: 'deepseek', kind: 'goose' }, catalog)
  assert.equal(result.ok, true)
  assert.equal(result.model.id, 'deepseek/deepseek-v4-pro')
})

test('spawn model validation rejects DeepSeek under the Codex harness before spawning', () => {
  const result = validateSpawnModelSelection({ model: 'deepseek-v4-pro', kind: 'codex' }, catalog)
  assert.equal(result.ok, false)
  assert.match(result.error, /belongs to goose/)
  assert.match(result.error, /kind "goose"/)
  assert.match(result.error, /gpt-5\.5/)
})

test('spawn model validation rejects unsupported ChatGPT Codex model names loudly', () => {
  const result = validateSpawnModelSelection({ model: 'gpt-5', kind: 'codex' }, catalog)
  assert.equal(result.ok, false)
  assert.match(result.error, /Unknown spawn model "gpt-5"/)
  assert.match(result.error, /spawn_models\(\)/)
  assert.match(result.error, /gpt-5\.5/)
})

test('spawn model validation allows raw vendor/model ids only through Goose', () => {
  assert.equal(validateSpawnModelSelection({ model: 'vendor/model', kind: 'goose' }, catalog).ok, true)

  const result = validateSpawnModelSelection({ model: 'vendor/model', kind: 'codex' }, catalog)
  assert.equal(result.ok, false)
  assert.match(result.error, /can only run through kind "goose"/)
})

test('spawn model summary exposes canonical aliases without hiding Codex or Goose', () => {
  const summary = formatSpawnModelSummary(catalog, { verifiedOnly: true })
  assert.match(summary, /claude: .*opus48/)
  assert.match(summary, /codex: .*gpt-5\.5/)
  assert.match(summary, /goose: .*deepseek -> deepseek\/deepseek-v4-pro/)
})

test('fleet-spawn live model catalog keeps DeepSeek and Codex aliases spawnable', () => {
  const out = execFileSync('python3', ['bin/fleet-spawn.py', '--list-models'], {
    cwd: fileURLToPath(new URL('..', import.meta.url)),
    encoding: 'utf8',
    timeout: 10_000,
  })
  const liveCatalog = JSON.parse(out)

  assert.equal(validateSpawnModelSelection({ model: 'deepseek', kind: 'goose' }, liveCatalog).ok, true)
  assert.equal(validateSpawnModelSelection({ model: 'gpt-5.5', kind: 'codex' }, liveCatalog).ok, true)

  const rejected = validateSpawnModelSelection({ model: 'deepseek', kind: 'codex' }, liveCatalog)
  assert.equal(rejected.ok, false)
  assert.match(rejected.error, /belongs to goose/)
})
