import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { poolBrowserConfigPath, openArgs } from './pw.mjs'

// Pins the pool browser's --config resolution: the cli.config.json that carries
// --no-sandbox/--disable-gpu lives with the canonical workspace, NOT the code
// root. An installed `tlda-dev` resolves repoRoot to its package dir (no
// .playwright/ there), so `open` silently dropped the flags and Chromium died
// in sandbox init. Regression: config must resolve via the workspace first.

function layOut({ workspaceHas = true, repoHas = false, repoHasFixture = true } = {}) {
  const base = mkdtempSync(join(tmpdir(), 'pw-open-config-'))
  const workspace = join(base, 'checkout')
  const repoRoot = join(base, 'pkg')
  mkdirSync(join(workspace, 'sub', 'dir'), { recursive: true })
  mkdirSync(repoRoot, { recursive: true })
  if (repoHasFixture) {
    mkdirSync(join(repoRoot, 'test', 'fixtures'), { recursive: true })
    writeFileSync(join(repoRoot, 'test', 'fixtures', 'fake-mic-16k.wav'), 'RIFF')
  }
  if (workspaceHas) {
    mkdirSync(join(workspace, '.playwright'), { recursive: true })
    writeFileSync(join(workspace, '.playwright', 'cli.config.json'), '{}')
  }
  if (repoHas) {
    mkdirSync(join(repoRoot, '.playwright'), { recursive: true })
    writeFileSync(join(repoRoot, '.playwright', 'cli.config.json'), '{}')
  }
  return { workspace, repoRoot, subdir: join(workspace, 'sub', 'dir') }
}

test('workspace config wins when the code root has none (installed layout)', () => {
  const { workspace, repoRoot } = layOut({ workspaceHas: true, repoHas: false })
  assert.equal(
    poolBrowserConfigPath(repoRoot, { workspace, cwd: workspace }),
    join(workspace, '.playwright', 'cli.config.json'),
  )
})

test('config is found walking up from a workspace subdir', () => {
  const { workspace, repoRoot, subdir } = layOut({ workspaceHas: true, repoHas: false })
  assert.equal(
    poolBrowserConfigPath(repoRoot, { workspace: join(workspace, 'nope'), cwd: subdir }),
    join(workspace, '.playwright', 'cli.config.json'),
  )
})

test('falls back to the code root config when the workspace lacks one', () => {
  const { repoRoot } = layOut({ workspaceHas: false, repoHas: true })
  assert.equal(
    poolBrowserConfigPath(repoRoot, { workspace: join(repoRoot, '..', 'missing'), cwd: repoRoot }),
    join(repoRoot, '.playwright', 'cli.config.json'),
  )
})

test('returns null when no root carries a config', () => {
  const { workspace, repoRoot } = layOut({ workspaceHas: false, repoHas: false })
  assert.equal(poolBrowserConfigPath(repoRoot, { workspace, cwd: workspace }), null)
})

test('openArgs carries --config pointing at the resolved workspace file', () => {
  const { workspace, repoRoot } = layOut({ workspaceHas: true, repoHas: false })
  const argv = openArgs(repoRoot, { workspace, cwd: workspace })
  const i = argv.indexOf('--config')
  assert.notEqual(i, -1)
  assert.equal(argv[i + 1], join(workspace, '.playwright', 'cli.config.json'))
})

test('openArgs still launches headed persistent chromium', () => {
  const { workspace, repoRoot } = layOut({ workspaceHas: true, repoHas: false })
  const argv = openArgs(repoRoot, { workspace, cwd: workspace })
  assert.deepEqual(argv.slice(0, 4), ['open', '--browser', 'chromium', '--headed'])
  assert.ok(argv.includes('--persistent'))
})

// A tree with no .playwright/ had nothing to find, so `open` ran bare and fresh
// Chromium died in sandbox init. The options are tracked code now, so the tree
// gets one written into it instead.

function configFrom(argv) {
  const i = argv.indexOf('--config')
  assert.notEqual(i, -1, 'openArgs carried no --config')
  return { path: argv[i + 1], json: JSON.parse(readFileSync(argv[i + 1], 'utf8')) }
}

test('openArgs writes a config into a tree that has none, carrying the sandbox flags', () => {
  const { workspace, repoRoot } = layOut({ workspaceHas: false, repoHas: false })
  assert.equal(poolBrowserConfigPath(repoRoot, { workspace, cwd: workspace }), null)
  const { path, json } = configFrom(openArgs(repoRoot, { workspace, cwd: workspace, warn() {} }))
  assert.equal(path, join(workspace, '.playwright', 'cli.config.json'))
  const args = json.browser.launchOptions.args
  for (const flag of ['--no-sandbox', '--disable-setuid-sandbox', '--disable-gpu', '--ignore-certificate-errors']) {
    assert.ok(args.includes(flag), `generated config is missing ${flag}`)
  }
  assert.equal(json.browser.contextOptions.ignoreHTTPSErrors, true)
})

test('the generated mic fixture path resolves against the repo root, not a hardcoded one', () => {
  const { workspace, repoRoot } = layOut({ workspaceHas: false, repoHas: false })
  const { json } = configFrom(openArgs(repoRoot, { workspace, cwd: workspace, warn() {} }))
  const audio = json.browser.launchOptions.args.find(a => a.startsWith('--use-file-for-fake-audio-capture='))
  assert.equal(audio, `--use-file-for-fake-audio-capture=${join(repoRoot, 'test', 'fixtures', 'fake-mic-16k.wav')}`)
})

test('a tree with no mic fixture still gets the sandbox flags, minus fake audio', () => {
  const { workspace, repoRoot } = layOut({ workspaceHas: false, repoHas: false, repoHasFixture: false })
  const warnings = []
  const { json } = configFrom(openArgs(repoRoot, { workspace, cwd: workspace, warn: m => warnings.push(m) }))
  const args = json.browser.launchOptions.args
  assert.ok(args.includes('--no-sandbox'))
  assert.ok(!args.some(a => a.startsWith('--use-file-for-fake-audio-capture=')))
  assert.ok(warnings.some(m => /fake-mic-16k\.wav/.test(m)), 'missing fixture was not reported')
})

test('an existing config is used untouched — materialising never overwrites', () => {
  const { workspace, repoRoot } = layOut({ workspaceHas: true, repoHas: false })
  const cfg = join(workspace, '.playwright', 'cli.config.json')
  writeFileSync(cfg, '{"browser":{"launchOptions":{"args":["--sentinel"]}}}')
  const argv = openArgs(repoRoot, { workspace, cwd: workspace, warn() {} })
  assert.equal(argv[argv.indexOf('--config') + 1], cfg)
  assert.deepEqual(JSON.parse(readFileSync(cfg, 'utf8')).browser.launchOptions.args, ['--sentinel'])
})

test('a found config elsewhere is not shadowed by a newly written one', () => {
  const { workspace, repoRoot } = layOut({ workspaceHas: false, repoHas: true })
  const argv = openArgs(repoRoot, { workspace, cwd: workspace, warn() {} })
  assert.equal(argv[argv.indexOf('--config') + 1], join(repoRoot, '.playwright', 'cli.config.json'))
  assert.equal(existsSync(join(workspace, '.playwright', 'cli.config.json')), false)
})
