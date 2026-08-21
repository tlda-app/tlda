import assert from 'node:assert/strict'
import test from 'node:test'
import { execFileSync } from 'node:child_process'
import { gzipSync } from 'node:zlib'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import express from 'express'

import historyRoutes from '../server/routes/history.mjs'
import {
  closeProjectStore,
  createProject,
  initProjectStore,
  projectDir,
  sourceDir,
} from '../server/lib/project-store.mjs'
import { closeAllRooms, getRoomRecords, initSyncRooms } from '../server/lib/sync-rooms.mjs'
import { sourceTextSpanToPdfSpans } from '../server/lib/synctex-query.mjs'

const SCALE = 800 / 612

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

test('diff-region crosses the server boundary with shared current and historical span placement', async t => {
  const root = mkdtempSync(join(tmpdir(), 'tlda-version-span-'))
  const projects = join(root, 'projects')
  const bin = join(root, 'bin')
  const oldPath = process.env.PATH
  let server

  t.after(async () => {
    if (server) await new Promise(resolve => server.close(resolve))
    process.env.PATH = oldPath
    closeAllRooms()
    await closeProjectStore()
    rmSync(root, { recursive: true, force: true })
  })

  await initProjectStore(projects)
  initSyncRooms(projects)
  createProject({ name: 'span-fixture', mainFile: 'main.tex', format: 'svg' })

  const currentSource = 'alpha newword gamma\n'
  const historicalSource = 'alpha oldword gamma\n'
  const currentDir = sourceDir('span-fixture')
  writeFileSync(join(currentDir, 'main.tex'), currentSource)
  seedArtifacts(currentDir, join(currentDir, 'main.tex'), [100, 130, 190, 250])

  const repo = join(projectDir('span-fixture'), 'shadow-repo')
  mkdirSync(repo, { recursive: true })
  git(repo, ['init'])
  git(repo, ['config', 'user.email', 'span-test@example.invalid'])
  git(repo, ['config', 'user.name', 'span test'])
  writeFileSync(join(repo, 'main.tex'), historicalSource)
  git(repo, ['add', 'main.tex'])
  git(repo, ['commit', '-m', 'historical'])
  const hash7 = git(repo, ['rev-parse', '--short=7', 'HEAD'])

  const historicalDir = join(projectDir('span-fixture'), 'history', `shadow-${hash7}`)
  seedArtifacts(historicalDir, join(root, 'historical-checkout', 'main.tex'), [200, 240, 300, 380])

  mkdirSync(bin)
  const latexdiff = join(bin, 'latexdiff')
  writeFileSync(latexdiff, '#!/bin/sh\nprintf "\\\\DIFdel{oldword}\\\\DIFadd{newword}\\n"\n')
  chmodSync(latexdiff, 0o755)
  process.env.PATH = `${bin}:${oldPath}`

  const app = express()
  app.use(express.json())
  app.use('/api/projects/:name/history', historyRoutes)
  server = app.listen(0, '127.0.0.1')
  await new Promise(resolve => server.once('listening', resolve))
  const { port } = server.address()

  const currentGeometry = await sourceTextSpanToPdfSpans(
    'span-fixture', 'main.tex', currentSource.split('\n'),
    { startLine: 1, startCol: 6, endLine: 1, endCol: 13 },
    { texBase: 'main' },
  )
  const historicalGeometry = await sourceTextSpanToPdfSpans(
    'span-fixture', 'main.tex', historicalSource.split('\n'),
    { startLine: 1, startCol: 6, endLine: 1, endCol: 13 },
    { texBase: 'main', version: hash7 },
  )
  assert.ok(currentGeometry?.pdfSpans.length)
  assert.ok(historicalGeometry?.pdfSpans.length)
  assert.notEqual(currentGeometry.pdfSpans[0].xStart, historicalGeometry.pdfSpans[0].xStart)

  const response = await fetch(`http://127.0.0.1:${port}/api/projects/span-fixture/history/diff-region`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      hash7, page: 1, pdfYMin: 90, pdfYMax: 110,
      columnX: 800, shadowYOffset: 40, triggerId: 'shape:trigger',
    }),
  })
  const responseText = await response.text()
  assert.equal(response.status, 200, responseText)
  const body = JSON.parse(responseText)
  assert.equal(body.shapeIds.length, 2)

  const shapes = (await getRoomRecords('doc-span-fixture', null))
    .filter(row => body.shapeIds.includes(row.id))
  const addition = shapes.find(row => row.meta?.diffType === 'addition')
  const deletion = shapes.find(row => row.meta?.diffType === 'deletion')
  assert.ok(addition)
  assert.ok(deletion)

  const currentSpan = currentGeometry.pdfSpans[0]
  const historicalSpan = historicalGeometry.pdfSpans[0]
  assert.equal(addition.x, (currentSpan.xStart + 72) * SCALE)
  assert.equal(addition.y, (currentSpan.y + 72) * SCALE - 3)
  assert.equal(deletion.x, (historicalSpan.xStart + 72) * SCALE + 800)
  assert.equal(deletion.y, (historicalSpan.y + 72) * SCALE + 40 - 3)
})
