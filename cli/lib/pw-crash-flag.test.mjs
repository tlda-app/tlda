import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { clearCrashFlag } from './pw.mjs'

// A SIGKILLed Chrome keeps profile.exit_type=Crashed, so the next launch
// replays the restore bubble. clearCrashFlag rewrites it to a clean exit.

function layOutProfile(exitType) {
  const base = mkdtempSync(join(tmpdir(), 'pw-crash-flag-'))
  mkdirSync(join(base, 'Default'), { recursive: true })
  writeFileSync(join(base, 'Default', 'Preferences'), JSON.stringify({ profile: { exit_type: exitType } }))
  return base
}

test('clearCrashFlag rewrites Crashed to a clean exit', () => {
  const dir = layOutProfile('Crashed')
  assert.equal(clearCrashFlag(dir), true)
  const prefs = JSON.parse(readFileSync(join(dir, 'Default', 'Preferences'), 'utf8'))
  assert.equal(prefs.profile.exit_type, 'Normal')
  assert.equal(prefs.profile.exited_cleanly, true)
})

test('clearCrashFlag leaves a clean profile untouched', () => {
  const dir = layOutProfile('Normal')
  assert.equal(clearCrashFlag(dir), false)
})

test('clearCrashFlag returns false with no Preferences', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pw-crash-flag-'))
  assert.equal(clearCrashFlag(dir), false)
  assert.equal(clearCrashFlag(null), false)
})
