/**
 * Read/write route authorization: routes that persist room or file effects
 * must refuse read-only tokens.
 *
 * `POST /:name/highlight` writes a highlight shape with `putShape` and
 * `POST /:name/history/diff-region` writes highlight shapes through its
 * `_createHighlightShape` helper — both were guarded by `requireRead`, so a
 * read-only token could mutate the room. Each test below asserts three
 * things with token gating explicitly enabled: a read token gets 403 and
 * leaves no room effect, and an RW token succeeds with the effect present.
 * Reverting either guard change makes its test fail on the forbidden effect.
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import express from 'express'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { gzipSync } from 'node:zlib'

const RW_TOKEN = 'guard-probe-rw-token'
const READ_TOKEN = 'guard-probe-read-token'
const PROJECT = 'guard-probe'

// Token gating is a server.yaml decision, not an env one: with gating off
// `validateToken` answers 'rw' for every caller and both tests below pass
// while proving nothing. The config dir must exist before the first server
// import because shared/config.mjs captures it at module load.
const root = mkdtempSync(join(tmpdir(), 'tlda-read-write-guard-'))
const configDir = join(root, 'config')
mkdirSync(configDir, { recursive: true })
writeFileSync(join(configDir, 'server.yaml'), 'tokenGating: true\ntokensFromEnvironmentOnly: true\n')
process.env.TLDA_CONFIG_DIR = configDir
process.env.TLDA_TOKEN_READ = READ_TOKEN
process.env.TLDA_TOKEN_RW = RW_TOKEN

const { initAuth, isTokenGatingEnabled } = await import('../lib/auth.mjs')
initAuth()
assert.equal(isTokenGatingEnabled(), true, 'token gating must be on: ungated, every token is rw and this test proves nothing')

const { closeProjectStore, createProject, initProjectStore, projectDir, sourceDir } =
  await import('../lib/project-store.mjs')
const { closeAllRooms, getRoomRecords, initSyncRooms } = await import('../lib/sync-rooms.mjs')
const { default: projectRoutes } = await import('./projects.mjs')

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
}

function synctex(inputPath, xs) {
  const sp = n => Math.round(n * 65536)
  return gzipSync([
    'SyncTeX Version:1',
    `Input:1:${inputPath}`,
    'Unit:1',
    'Magnification:1000',
    '{1',
    ...xs.map(x => `x1,1:${sp(x)},${sp(100)}`),
    '}',
    '',
  ].join('\n'))
}

function seedArtifacts(dir, inputPath, xs) {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'main.dvi'), 'fixture')
  writeFileSync(join(dir, 'main.synctex.gz'), synctex(inputPath, xs))
  writeFileSync(join(dir, 'main-lookup.json'), JSON.stringify({
    meta: { version: 2 },
    lines: { 1: { page: 1, x: xs[0], y: 100 } },
  }))
}

let setup = null
async function ensureSetup() {
  if (setup) return setup
  const projects = join(root, 'projects')
  await initProjectStore(projects)
  initSyncRooms(projects)
  createProject({ name: PROJECT, mainFile: 'main.tex', format: 'svg' })

  const currentSource = 'alpha newword gamma\n'
  const historicalSource = 'alpha oldword gamma\n'
  const currentDir = sourceDir(PROJECT)
  writeFileSync(join(currentDir, 'main.tex'), currentSource)
  seedArtifacts(currentDir, join(currentDir, 'main.tex'), [100, 130, 190, 250])

  const repo = join(projectDir(PROJECT), 'shadow-repo')
  mkdirSync(repo, { recursive: true })
  git(repo, ['init'])
  git(repo, ['config', 'user.email', 'guard-test@example.invalid'])
  git(repo, ['config', 'user.name', 'guard test'])
  writeFileSync(join(repo, 'main.tex'), historicalSource)
  git(repo, ['add', 'main.tex'])
  git(repo, ['commit', '-m', 'historical'])
  const hash7 = git(repo, ['rev-parse', '--short=7', 'HEAD'])

  const historicalDir = join(projectDir(PROJECT), 'history', `shadow-${hash7}`)
  seedArtifacts(historicalDir, join(root, 'historical-checkout', 'main.tex'), [200, 240, 300, 380])

  const bin = join(root, 'bin')
  mkdirSync(bin)
  const latexdiff = join(bin, 'latexdiff')
  writeFileSync(latexdiff, '#!/bin/sh\nprintf "\\\\DIFdel{oldword}\\\\DIFadd{newword}\\n"\n')
  chmodSync(latexdiff, 0o755)
  process.env.PATH = `${bin}:${process.env.PATH}`

  // Same mount point as the production server.
  const app = express()
  app.use(express.json())
  app.use('/api/projects', projectRoutes)
  const server = createServer(app)
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  setup = { server, hash7, port: server.address().port }
  return setup
}

async function post(port, path, token, body) {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  })
  const text = await response.text()
  let parsed = text
  try { parsed = JSON.parse(text) } catch { /* keep raw text for assertions */ }
  return { status: response.status, body: parsed }
}

async function roomShapeIds() {
  return new Set((await getRoomRecords(`doc-${PROJECT}`, null)).map(row => row.id))
}

test.after(async () => {
  if (setup?.server.listening) await new Promise(resolve => setup.server.close(resolve))
  closeAllRooms()
  await closeProjectStore()
  rmSync(root, { recursive: true, force: true })
})

test('POST /:name/highlight refuses a read token without a room effect; RW succeeds', async () => {
  const { port } = await ensureSetup()
  const before = await roomShapeIds()

  const denied = await post(port, `/api/projects/${PROJECT}/highlight`, READ_TOKEN, {
    text: 'newword', startLine: 1,
  })
  assert.equal(denied.status, 403, `read token wrote or was answered otherwise: ${JSON.stringify(denied.body)}`)
  assert.match(String(denied.body?.error || ''), /read-only/)
  for (const id of await roomShapeIds()) {
    assert.ok(before.has(id), `read token left a room effect: ${id}`)
  }

  const allowed = await post(port, `/api/projects/${PROJECT}/highlight`, RW_TOKEN, {
    text: 'newword', startLine: 1,
  })
  assert.equal(allowed.status, 200, JSON.stringify(allowed.body))
  assert.ok(allowed.body.shapeId, 'RW response carries no shapeId')
  assert.ok((await roomShapeIds()).has(allowed.body.shapeId), 'RW highlight shape is missing from the room')
})

test('POST /:name/history/diff-region refuses a read token without a room effect; RW succeeds', async () => {
  const { port, hash7 } = await ensureSetup()

  const deniedTrigger = 'guard-read-probe'
  const denied = await post(port, `/api/projects/${PROJECT}/history/diff-region`, READ_TOKEN, {
    hash7, page: 1, pdfYMin: 90, pdfYMax: 110,
    columnX: 800, shadowYOffset: 40, triggerId: deniedTrigger,
  })
  assert.equal(denied.status, 403, `read token wrote or was answered otherwise: ${JSON.stringify(denied.body)}`)
  assert.match(String(denied.body?.error || ''), /read-only/)
  const leaked = (await getRoomRecords(`doc-${PROJECT}`, null))
    .filter(row => row.meta?.diffTrigger === deniedTrigger)
  assert.equal(leaked.length, 0, `read token left ${leaked.length} room effect(s)`)

  const rwTrigger = 'guard-rw-probe'
  const allowed = await post(port, `/api/projects/${PROJECT}/history/diff-region`, RW_TOKEN, {
    hash7, page: 1, pdfYMin: 90, pdfYMax: 110,
    columnX: 800, shadowYOffset: 40, triggerId: rwTrigger,
  })
  assert.equal(allowed.status, 200, JSON.stringify(allowed.body))
  assert.equal(allowed.body.shapeIds.length, 2)
  const present = new Set((await getRoomRecords(`doc-${PROJECT}`, null)).map(row => row.id))
  for (const id of allowed.body.shapeIds) {
    assert.ok(present.has(id), `RW diff shape ${id} is missing from the room`)
  }
})
