import assert from 'node:assert/strict'
import test from 'node:test'
import { buildCmd as buildGooseCmd } from '../bin/lib/spawn/harness/goose.mjs'
import {
  listModels,
  resolveClaudeModel,
  resolveGooseModelSelection,
} from '../bin/lib/spawn/models.mjs'
import { spawn } from '../bin/lib/spawn/index.mjs'

test('configured provider row wins over built-in alias for provider-routed models', () => {
  const config = {
    models: {
      deepseek: {
        deepseek: {
          id: 'deepseek-chat',
          tags: ['deepseek', 'provider:deepseek', 'cloud'],
        },
      },
    },
  }
  const selected = resolveGooseModelSelection('deepseek', { config })
  assert.equal(selected.model, 'deepseek-chat')
  assert.equal(selected.provider, 'deepseek')
})

test('deny-wins tags refuse account-provider models and remove them from usable list view', () => {
  const config = { tags: { claude: 'none' } }
  assert.throws(
    () => resolveClaudeModel('sonnet', { config }),
    /refused by model tag gate: claude/
  )
  const sonnet = listModels(config).models.find((model) => model.kind === 'claude' && model.alias === 'sonnet')
  assert.equal(sonnet.available, false)
})

test('DeepSeek-direct goose command routes through OpenAI provider with DeepSeek host and key', () => {
  const cmd = buildGooseCmd({
    fleetId: 'fleet:test',
    tmuxSession: 'fleet-test',
    model: 'deepseek-chat',
    modelProvider: 'deepseek',
    api: 'http://localhost:5176',
    env: { DEEPSEEK_API_KEY: 'sk-deepseek-test' },
    config: {},
  })
  assert.match(cmd, /OPENAI_API_KEY=.*sk-deepseek-test/)
  assert.match(cmd, /OPENAI_HOST=https:\/\/api\.deepseek\.com/)
  assert.match(cmd, /--params provider=.*openai/)
  assert.match(cmd, /--params model=.*deepseek-chat/)
})

test('spawn request refuses a freshly denied model before launching tmux', async () => {
  let launched = false
  await assert.rejects(
    () => spawn({
      spawnMode: 'fresh',
      kind: 'claude',
      model: 'sonnet',
      name: 'model-gov-denied',
      config: { tags: { claude: 'none' } },
      _deps: {
        ensureServer: async () => false,
        uniqueSessionName: async () => 'fleet-model-gov-denied',
        resolveApi: () => 'http://localhost:5176',
        spawnTmux: async () => {
          launched = true
          return true
        },
      },
    }),
    /refused by model tag gate: claude/
  )
  assert.equal(launched, false)
})
