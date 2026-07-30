import assert from 'node:assert/strict'
import test from 'node:test'

import { createCommandRegistry, generateCommandMarkdown } from './commands.mjs'
import { configTypes, defineConfig, generateConfigMarkdown, parseConfig } from './config.mjs'

test('dispatches declared commands and bounds help by authorization', async () => {
  const registry = createCommandRegistry([{
    name: 'probe', aliases: ['check'], usage: '[target]', summary: 'Run the probe.',
    help: 'Runs one probe and reports the result.', examples: ['probe document'],
    authorize: ({ from }) => from === 'allowed', handler: ({ args }) => args,
  }])
  const replies = []
  const reply = message => replies.push(message)
  assert.deepEqual((await registry.dispatch('check document', { from: 'allowed', reply })).value, ['document'])
  await registry.dispatch('missing', { from: 'allowed', reply })
  assert.match(replies.at(-1), /Unknown command/)
  assert.match(replies.at(-1), /probe \[target\]/)
  await registry.dispatch('probe', { from: 'denied', reply })
  assert.doesNotMatch(replies.at(-1), /probe \[target\]/)
  assert.match(generateCommandMarkdown(registry), /### `probe \[target\]`/)
})

test('uses one configuration schema for validation and documentation', () => {
  const schema = defineConfig({ intervalMs: {
    env: 'INTERVAL_MS', default: 1000, description: 'Probe interval.',
    parse: configTypes.integer, validate: value => value > 0,
  } })
  assert.deepEqual(parseConfig(schema, { INTERVAL_MS: '12' }), { intervalMs: 12 })
  assert.throws(() => parseConfig(schema, { INTERVAL_MS: 'no' }), /must be an integer/)
  assert.match(generateConfigMarkdown(schema), /`INTERVAL_MS`.*`1000`.*Probe interval/)
})
