#!/usr/bin/env node
// `tlda agent mint --effort high` must launch and say why high is warned about.
// The launch is stubbed at the lifecycle boundary, so nothing is spawned.
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const configDir = mkdtempSync(join(tmpdir(), 'tlda-warned-option-'))
process.env.TLDA_DAEMON_CONFIG_DIR = configDir
process.env.TLDA_ENV = 'testing'

writeFileSync(join(configDir, 'server.yaml'), '')
writeFileSync(join(configDir, 'daemon.yaml'), `machineId: mini
environments:
  default: testing
  values:
    testing:
      database: http://127.0.0.1:9
      store: http://127.0.0.1:9
      licenseKey: ""
regions:
  machine: ["**"]
profiles:
  wd:
    read: { allow: [machine], deny: [] }
    write: { allow: [machine], deny: [] }
  app-dev:
    read: { allow: [machine], deny: [] }
    write: { allow: [machine], deny: [] }
grants:
  localhost: wd
models:
  default: opus
  values:
    opus:
      id: claude-opus-5
      harness:
        kind: claude
        required: []
        preferences: []
        controls: true
      options:
        effort:
          default: medium
          values:
            low: {}
            medium: {}
            high: { warn: "opus at high effort is destructive" }
default: wd
`)

const { runFleetSpawn } = await import(`../cli/tlda.mjs?warned-option-test=${Date.now()}`)

async function mintAndCaptureWarnings(args) {
  const warnings = []
  const realWarn = console.warn
  const realError = console.error
  const capture = (...parts) => warnings.push(parts.join(' '))
  console.warn = capture
  console.error = capture
  try {
    await runFleetSpawn(args, {
      configDir,
      localAgentLedgerPath: join(configDir, 'daemon-mints.sqlite'),
      lifecycleImpl: async () => ({ ok: true, tmux_session: 'fleet-warned-option-test' }),
    })
  } finally {
    console.warn = realWarn
    console.error = realError
  }
  return warnings.join('\n')
}

try {
  const warned = await mintAndCaptureWarnings(['--fresh', 'warned-high', '--model', 'opus', '--effort', 'high', '--cwd', configDir])
  assert.match(warned, /opus effort=high/, 'choosing a warned value names the choice')
  assert.match(warned, /opus at high effort is destructive/, 'and carries the configured warning text')

  const quiet = await mintAndCaptureWarnings(['--fresh', 'warned-medium', '--model', 'opus', '--effort', 'medium', '--cwd', configDir])
  assert.doesNotMatch(quiet, /effort=medium/, 'an unwarned value says nothing')

  const defaulted = await mintAndCaptureWarnings(['--fresh', 'warned-default', '--model', 'opus', '--cwd', configDir])
  assert.doesNotMatch(defaulted, /effort=/, 'taking the configured default is not a choice to warn about')

  console.log('warned model option: ok')
} finally {
  rmSync(configDir, { recursive: true, force: true })
}
