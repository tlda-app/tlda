import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import { checkRigHealth, runRigHealthSmoke } from './rig-health-smoke.mjs'

function tempDir() {
  return mkdtempSync(join(tmpdir(), 'tlda-rig-health-'))
}

function writeRig(path, rig) {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, JSON.stringify(rig, null, 2))
}

function healthyRig(overrides = {}) {
  return {
    viewer: 'http://localhost:5180/',
    doc: 'smoke-doc',
    noAuth: true,
    ...overrides,
  }
}

test('rig health smoke accepts explicit --rig path through resolver', () => {
  const dir = tempDir()
  try {
    const rigPath = join(dir, 'explicit-rig.json')
    writeRig(rigPath, healthyRig())

    const seen = []
    const code = runRigHealthSmoke(['--rig', rigPath], {
      log: message => seen.push(message),
      error: message => seen.push(message),
    })

    assert.equal(code, 0)
    assert.match(seen.join('\n'), /rig-health-smoke PASS/)
    assert.equal(checkRigHealth({ rig: rigPath }).env.manifestPath, rigPath)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('rig health smoke accepts explicit --rig=path through resolver', () => {
  const dir = tempDir()
  try {
    const rigPath = join(dir, 'explicit-rig.json')
    writeRig(rigPath, healthyRig())

    assert.equal(checkRigHealth({ rig: rigPath }).ok, true)
    assert.equal(runRigHealthSmoke([`--rig=${rigPath}`], { log() {}, error() {} }), 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('rig health smoke discovers TLDA_RIG_JSON through resolver env', () => {
  const dir = tempDir()
  try {
    const rigPath = join(dir, 'env-rig.json')
    writeRig(rigPath, healthyRig({ viewer: 'https://example.test/viewer/' }))

    const result = checkRigHealth({
      cwd: join(dir, 'missing-cwd'),
      home: join(dir, 'missing-home'),
      env: { TLDA_RIG_JSON: rigPath },
    })

    assert.equal(result.ok, true)
    assert.equal(result.env.manifestPath, rigPath)
    assert.equal(result.env.viewer, 'https://example.test/viewer')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('rig health smoke discovers cwd fallback through resolver', () => {
  const dir = tempDir()
  try {
    const cwd = join(dir, 'worktree')
    const rigPath = join(cwd, '.tlda-dev', 'rig.json')
    writeRig(rigPath, healthyRig({ doc: 'cwd-doc' }))

    const result = checkRigHealth({
      cwd,
      home: join(dir, 'missing-home'),
      env: {},
    })

    assert.equal(result.ok, true)
    assert.equal(result.env.manifestPath, rigPath)
    assert.equal(result.env.doc, 'cwd-doc')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('rig health smoke discovers home fallback through resolver', () => {
  const dir = tempDir()
  try {
    const home = join(dir, 'home')
    const rigPath = join(home, '.config', 'tlda', 'dev-server', 'rig.json')
    writeRig(rigPath, healthyRig({ doc: 'home-doc', noAuth: false }))

    const result = checkRigHealth({
      cwd: join(dir, 'missing-cwd'),
      home,
      env: {},
    })

    assert.equal(result.ok, true)
    assert.equal(result.env.manifestPath, rigPath)
    assert.equal(result.env.doc, 'home-doc')
    assert.equal(result.env.noAuth, false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('rig health smoke rejects manifests missing UI smoke fields', () => {
  const dir = tempDir()
  try {
    const rigPath = join(dir, 'bad-rig.json')
    writeRig(rigPath, { viewer: 'not-a-url', doc: '', noAuth: 'yes' })

    const result = checkRigHealth({ rig: rigPath })

    assert.equal(result.ok, false)
    assert.deepEqual(result.problems, [
      'rig manifest must provide an http(s) viewer URL',
      'rig manifest must provide a non-empty doc',
      'rig manifest must provide boolean noAuth',
    ])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('rig health smoke reports unreadable JSON as health failure', () => {
  const dir = tempDir()
  try {
    const rigPath = join(dir, 'broken-rig.json')
    mkdirSync(join(rigPath, '..'), { recursive: true })
    writeFileSync(rigPath, '{')

    const result = checkRigHealth({ rig: rigPath })

    assert.equal(result.ok, false)
    assert.match(result.problems[0], /^rig manifest could not be read:/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
