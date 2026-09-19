import assert from 'node:assert/strict'
import test from 'node:test'

import { formatModelOptionWarnings, normalizeSpawnModelKwargs } from '../agent-launch/models.mjs'

// The warning text lives beside the value in config, so anything can be warned
// about without a code change.
const CONFIG = {
  modelCatalog: { default: 'opus' },
  modelSpecs: {
    opus: {
      alias: 'opus',
      id: 'claude-opus-5',
      harness: { kind: 'claude' },
      options: {
        effort: {
          default: 'medium',
          values: {
            low: {},
            medium: {},
            high: { warn: 'opus at high effort is destructive' },
          },
        },
      },
    },
    muse: {
      alias: 'muse',
      id: 'meta/muse-spark-1.3-contributor',
      harness: { kind: 'claude' },
      options: { effort: { default: 'max', values: { low: {}, max: {} } } },
    },
  },
}

test('a warned value still resolves — it is available, it is not blocked', () => {
  const chosen = normalizeSpawnModelKwargs({ model: 'opus', effort: 'high' }, { config: CONFIG })
  assert.equal(chosen.options.effort, 'high')
  assert.equal(chosen.warnings.length, 1)
  assert.deepEqual(chosen.warnings[0], {
    option: 'effort',
    value: 'high',
    model: 'opus',
    message: 'opus at high effort is destructive',
  })
})

test('an unwarned value says nothing', () => {
  assert.deepEqual(normalizeSpawnModelKwargs({ model: 'opus', effort: 'low' }, { config: CONFIG }).warnings, [])
  assert.deepEqual(normalizeSpawnModelKwargs({ model: 'muse' }, { config: CONFIG }).warnings, [])
})

// The warning is about a choice. Falling back to the configured default is the
// considered setting, not an override, so it must stay quiet.
test('taking the configured default does not warn, even at a warned value', () => {
  const defaultedToWarned = {
    modelCatalog: { default: 'edge' },
    modelSpecs: {
      edge: {
        alias: 'edge',
        id: 'edge-1',
        harness: { kind: 'claude' },
        options: { effort: { default: 'high', values: { high: { warn: 'loud' } } } },
      },
    },
  }
  const implicit = normalizeSpawnModelKwargs({ model: 'edge' }, { config: defaultedToWarned })
  assert.equal(implicit.options.effort, 'high')
  assert.deepEqual(implicit.warnings, [], 'the default is the setting, not a choice against it')

  const explicit = normalizeSpawnModelKwargs({ model: 'edge', effort: 'high' }, { config: defaultedToWarned })
  assert.equal(explicit.warnings.length, 1, 'asking for it explicitly is a choice')
})

test('the warning names the model, option and value, so it is legible out of context', () => {
  const { warnings } = normalizeSpawnModelKwargs({ model: 'opus', effort: 'high' }, { config: CONFIG })
  assert.deepEqual(
    formatModelOptionWarnings(warnings),
    ['warning: opus effort=high — opus at high effort is destructive'],
  )
  assert.deepEqual(formatModelOptionWarnings([]), [])
})

test('an invalid value is still an error, not a warning', () => {
  assert.throws(
    () => normalizeSpawnModelKwargs({ model: 'opus', effort: 'ludicrous' }, { config: CONFIG }),
    /invalid model option effort="ludicrous"/,
  )
})
