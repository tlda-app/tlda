import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

import { loadRigManifest, resolveRigEnv } from './rig-env.mjs'

function tempDir() {
  return mkdtempSync(join(tmpdir(), 'tlda-rig-env-'))
}

function writeRig(path, rig) {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, JSON.stringify(rig, null, 2))
}

test('resolveRigEnv uses explicit rig path first', () => {
  const dir = tempDir()
  try {
    const rigPath = join(dir, 'rig.json')
    writeRig(rigPath, {
      viewer: 'http://localhost:5180/',
      backend: 'http://localhost:5280/',
      doc: 'demo',
      noAuth: true,
      isolated: true,
    })
    const env = resolveRigEnv({ rig: rigPath, cwd: join(dir, 'none'), home: join(dir, 'home') })
    assert.equal(env.manifestPath, rigPath)
    assert.equal(env.viewer, 'http://localhost:5180')
    assert.equal(env.backend, 'http://localhost:5280')
    assert.equal(env.doc, 'demo')
    assert.equal(env.token, '')
    assert.equal(env.noAuth, true)
    assert.equal(env.isolated, true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('loadRigManifest falls back to cwd then home manifests', () => {
  const dir = tempDir()
  try {
    const cwd = join(dir, 'worktree')
    const home = join(dir, 'home')
    const cwdRig = join(cwd, '.tlda-dev', 'rig.json')
    const homeRig = join(home, '.config', 'tlda', 'dev-server', 'rig.json')
    writeRig(homeRig, { viewer: 'http://localhost:9999' })
    writeRig(cwdRig, { viewer: 'http://localhost:5181' })
    assert.equal(loadRigManifest({ cwd, home })?.path, cwdRig)
    assert.equal(loadRigManifest({ cwd: join(dir, 'other'), home })?.path, homeRig)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('resolveRigEnv returns null URLs and default doc without a manifest', () => {
  const dir = tempDir()
  try {
    const env = resolveRigEnv({ cwd: dir, home: join(dir, 'home') })
    assert.equal(env.manifestPath, null)
    assert.equal(env.viewer, null)
    assert.equal(env.backend, null)
    assert.equal(env.doc, 'bregman')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
