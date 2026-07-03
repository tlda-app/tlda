import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { fork } from 'child_process'
import { fileURLToPath } from 'url'
import { listSessionsByRecency } from '../bin/fleet-owner-harvester.mjs'

const HARVESTER = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'fleet-owner-harvester.mjs')

function makeProjects() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tlda-harvest-'))
  const proj = path.join(root, 'proj-a')
  fs.mkdirSync(proj, { recursive: true })
  const write = (name, body, mtime) => {
    const p = path.join(proj, name)
    fs.writeFileSync(p, body)
    fs.utimesSync(p, mtime, mtime)
  }
  // three sessions, distinct mtimes (recent -> old: new, mid, old)
  write('sess-old.jsonl', 'noise\nRegistered fleet:oldguy\n', 1000)
  write('sess-mid.jsonl', 'Registered fleet:midguy\nmore\n', 2000)
  write('sess-new.jsonl', 'Registered fleet:newguy\n', 3000)
  write('sess-none.jsonl', 'no registration here\n', 2500)
  return root
}

test('listSessionsByRecency sorts most-recent-first', () => {
  const root = makeProjects()
  try {
    const order = listSessionsByRecency(root).map(s => s.sessionId)
    assert.deepEqual(order, ['sess-new', 'sess-none', 'sess-mid', 'sess-old'])
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('forked harvester streams owners recent->old and completes', async () => {
  const root = makeProjects()
  const child = fork(HARVESTER, [], {
    execArgv: [], stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    env: { ...process.env, TLDA_HARVEST_DIR: root },
  })
  const owners = []
  let complete = null
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('harvester timed out')), 8000)
    child.on('message', (m) => {
      if (m.type === 'owners') owners.push({ id: m.sessionId, owners: m.owners })
      else if (m.type === 'harvest-complete') { complete = m; clearTimeout(timer); resolve() }
    })
    child.on('error', reject)
  })
  try {
    // recent -> old ordering preserved in the stream
    assert.deepEqual(owners.map(o => o.id), ['sess-new', 'sess-none', 'sess-mid', 'sess-old'])
    // owners harvested correctly (empty for the no-registration file)
    const byId = Object.fromEntries(owners.map(o => [o.id, o.owners]))
    assert.deepEqual(byId['sess-new'], ['fleet:newguy'])
    assert.deepEqual(byId['sess-mid'], ['fleet:midguy'])
    assert.deepEqual(byId['sess-old'], ['fleet:oldguy'])
    assert.deepEqual(byId['sess-none'], [])
    assert.equal(complete.count, 4)
  } finally { child.kill(); fs.rmSync(root, { recursive: true, force: true }) }
})
