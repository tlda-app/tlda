#!/usr/bin/env node
//
// A refused push leaves the project exactly as it found it.
//
// This re-creates a promise the old snapshot-cost test carried
// (`source-transaction-snapshot-cost-test.mjs`, deleted alongside the old
// accept path: the snapshot-copy cost it measured is structurally gone on
// the new path). The promise itself is not a cost — it is the guarantee that
// a rejected write cannot leave the project holding neither its old state
// nor its new one, the same shape as the deleted-3-passages incident. That
// guarantee is not optional just because the mechanism under it changed.
//
// Expressed here against the new accept path's actual refusal, a
// non-fast-forward (`refusedRevision`), over the real HTTP boundary — see
// `a-checkout-proposes-a-commit-test.mjs` for why in-process is not enough.
//
// What "leaves nothing behind" means on THIS mechanism, precisely: the ref
// that decides truth (`refs/tlda/source/<project>`) does not move, and
// `authority.json` (still written by an accept, though no longer what is
// read to answer "what's current" — see the docstring in
// `createSourceLifecycleStore`) is byte-identical. A refused candidate DOES
// land in the object store, under a separate quarantine ref
// (`refs/tlda/refused/<project>`) — that is deliberate (so the refused
// commit can be named and looked at) and is not a violation of this
// promise: it is inert until something makes it the accepted head, which a
// refusal never does.
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { startServer, stopServer, unusedPort } from '../server/lib/durable-source-wire-harness.mjs'
import { initProjectStore, createProject, updateProject, closeProjectStore } from '../server/lib/project-store.mjs'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'refused-leaves-nothing-'))
const projectsDir = path.join(root, 'projects')
const checkout = path.join(root, 'checkout')
fs.mkdirSync(projectsDir, { recursive: true })
fs.mkdirSync(checkout, { recursive: true })
const PROJECT = 'refused-leaves-nothing'
const LOCAL_REF = `refs/tlda/local/${PROJECT}`

const git = (args, cwd = checkout) => {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' })
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr || r.stdout}`)
  return r.stdout.trim()
}

git(['init', '-b', 'main'])
git(['config', 'user.name', 'the author'])
git(['config', 'user.email', 'author@example.test'])

function proposeCommit(text, parent) {
  fs.writeFileSync(path.join(checkout, 'main.tex'), text)
  const blob = git(['hash-object', '-w', path.join(checkout, 'main.tex')])
  const index = path.join(root, `index-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  const env = { ...process.env, GIT_INDEX_FILE: index }
  spawnSync('git', ['update-index', '--add', '--cacheinfo', `100644,${blob},main.tex`], { cwd: checkout, env })
  const tree = spawnSync('git', ['write-tree'], { cwd: checkout, env, encoding: 'utf8' }).stdout.trim()
  fs.rmSync(index, { force: true })
  const args = ['commit-tree', tree, '-m', 'source revision']
  if (parent) args.push('-p', parent)
  const commit = git(args)
  git(['update-ref', LOCAL_REF, commit])
  return commit
}

function bundleSince(have) {
  const out = path.join(root, `propose-${Date.now()}-${Math.random().toString(36).slice(2)}.bundle`)
  git(['bundle', 'create', out, ...(have ? [`${have}..${LOCAL_REF}`] : [LOCAL_REF])])
  return fs.readFileSync(out)
}

// The server runs as a separate process, so `projectDir()` (bound to
// project-store's own module-global `projectsDir`) is not usable here — the
// path is built directly from the `projectsDir` this test itself created.
const projectGitDir = path.join(projectsDir, PROJECT, '.source-lifecycle', 'git')
const authorityPath = path.join(projectsDir, PROJECT, '.source-lifecycle', 'authority.json')
const sourceRefName = `refs/tlda/source/${PROJECT}`
const refusedRefName = `refs/tlda/refused/${PROJECT}`

function readRefOrNull(ref) {
  try {
    return execFileSync('git', ['--git-dir', projectGitDir, 'rev-parse', ref], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  } catch {
    return null
  }
}

const port = await unusedPort()
await initProjectStore(projectsDir)
createProject({ name: PROJECT, mainFile: 'main.tex', format: 'svg' })
await updateProject(PROJECT, { pages: 1, buildStatus: 'success' })
await closeProjectStore()

const server = await startServer({ port, projectsDir, fleetDb: path.join(root, 'fleet.db') })
const banner = server.output().split('\n').find(line => line.includes('Unified server running')) || ''
const base = (banner.match(/https?:\/\/[^\s]+/) || [`http://127.0.0.1:${port}`])[0]
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'
const propose = async body => {
  const response = await fetch(`${base}/api/projects/${PROJECT}/source-bundle`, {
    method: 'POST',
    headers: { 'content-type': 'application/octet-stream' },
    body,
  })
  return { status: response.status, body: await response.json() }
}
const readFile = async () => {
  const response = await fetch(`${base}/api/projects/${PROJECT}/source/main.tex`)
  return { status: response.status, text: response.status === 200 ? await response.text() : null }
}

try {
  // Two accepted revisions, so there is real state to protect, not an empty
  // project a refusal could not distinguish from a preserved one.
  const first = proposeCommit('first draft\n', null)
  const accepted = await propose(bundleSince(null))
  assert.equal(accepted.status, 200, JSON.stringify(accepted.body))

  const second = proposeCommit('second draft\n', first)
  const advanced = await propose(bundleSince(first))
  assert.equal(advanced.status, 200, JSON.stringify(advanced.body))
  assert.equal(advanced.body.sourceRevision, second)

  // Snapshot everything a refusal must not touch, before attempting it.
  const sourceRefBefore = readRefOrNull(sourceRefName)
  assert.equal(sourceRefBefore, second, 'setup — the source ref points at the second revision before the refusal')
  const refusedRefBefore = readRefOrNull(refusedRefName)
  const authorityBytesBefore = fs.readFileSync(authorityPath)
  const fileBefore = await readFile()
  assert.equal(fileBefore.text, 'second draft\n')

  // A proposal built on a base the server has moved past — the live case, not
  // a contrived one: the daemon sends the revision it last saw, the server
  // has moved on, and this is refused rather than merged.
  git(['update-ref', LOCAL_REF, first])
  const stale = proposeCommit('a different second draft\n', first)
  const refused = await propose(bundleSince(null))
  assert.equal(refused.status, 409, JSON.stringify(refused.body))
  assert.equal(refused.body.status, 'non-fast-forward')
  assert.equal(refused.body.refusedRevision, stale, 'a refusal names the commit it refused')

  // ### The refusal moved nothing that decides truth
  const sourceRefAfter = readRefOrNull(sourceRefName)
  assert.equal(sourceRefAfter, sourceRefBefore, 'the source ref — did not move; a refusal is not an accept under another name')

  // ### authority.json is byte-identical
  // `acceptBundle` only writes this file in its success branch (see
  // `server/lib/source-lifecycle.mjs`); a refusal returns before reaching it.
  // Asserted here as bytes, not as parsed fields, so a refusal that touched
  // the file at all — even to write the same values back — would be caught.
  const authorityBytesAfter = fs.readFileSync(authorityPath)
  assert.ok(authorityBytesBefore.equals(authorityBytesAfter), 'authority.json — byte-identical after a refused push')

  // ### The served content is unchanged
  const fileAfter = await readFile()
  assert.equal(fileAfter.text, fileBefore.text, 'the served file — holds exactly what it held before the refusal')
  assert.equal(fileAfter.status, fileBefore.status)

  // ### What DID change, named so it is a recorded decision and not a
  // surprise: the refused candidate is now a real object under the
  // quarantine ref, so it can be mirrored to the author and looked at. That
  // is new state, deliberately — it is not the accepted project changing.
  const refusedRefAfter = readRefOrNull(refusedRefName)
  assert.notEqual(refusedRefAfter, refusedRefBefore, 'the refused ref — does advance, recording the refusal for the mirror path')
  assert.equal(refusedRefAfter, stale, 'the refused ref — names exactly the commit that was refused')

  // The project's readable state, independent of the refs above: still
  // exactly the second revision's tree.
  const record = await (await fetch(`${base}/api/projects/${PROJECT}/source-authority`)).json()
  assert.equal(record.currentRevision, second, 'the source authority — still the second revision after the refused push')

  console.log('a refused push leaves nothing behind: passed')
} finally {
  await stopServer(server)
  fs.rmSync(root, { recursive: true, force: true })
}
