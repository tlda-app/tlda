#!/usr/bin/env node
//
// A checkout proposes a commit; the server accepts it iff it fast-forwards.
//
// This is the accept path with the machinery taken out. There is no
// expected-revision handshake, no declared manifest, no three-way merge and no
// retry state machine — the proposer either had our head when they wrote, or
// they did not and it goes back to them to rebase. Every bug shipped on the old
// path was our own answer to a question git already answers.
//
// It crosses the real HTTP boundary rather than calling the lifecycle directly,
// because the thing under test is a **transport decision**: bundle bytes as a
// raw body instead of base64 in JSON. Calling `acceptBundle` in-process would
// prove the accept and nothing about the wire that carries it, which is the
// failure that hid a dropped field for a night.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { startServer, stopServer, unusedPort } from '../server/lib/durable-source-wire-harness.mjs'
import { initProjectStore, createProject, updateProject, closeProjectStore } from '../server/lib/project-store.mjs'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'proposes-'))
const projectsDir = path.join(root, 'projects')
const checkout = path.join(root, 'checkout')
fs.mkdirSync(projectsDir, { recursive: true })
fs.mkdirSync(checkout, { recursive: true })
const PROJECT = 'proposed-paper'
const git = (args, cwd = checkout) => {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' })
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr || r.stdout}`)
  return r.stdout.trim()
}

// The checkout keeps the project's source under a tlda-owned ref rather than on
// the author's own branch. Their branch is theirs; ours never carries what they
// did not put in the paper.
const LOCAL_REF = `refs/tlda/local/${PROJECT}`

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
  const out = path.join(root, `propose-${Date.now()}.bundle`)
  git(['bundle', 'create', out, ...(have ? [`${have}..${LOCAL_REF}`] : [LOCAL_REF])])
  return fs.readFileSync(out)
}

const port = await unusedPort()
await initProjectStore(projectsDir)
createProject({ name: PROJECT, mainFile: 'main.tex', format: 'svg' })
await updateProject(PROJECT, { pages: 1, buildStatus: 'success' })
await closeProjectStore()

const server = await startServer({ port, projectsDir, fleetDb: path.join(root, 'fleet.db') })
// The harness's server serves TLS with a self-signed certificate, which is why
// its own daemon helper dials `wss://` with verification off. Reading the scheme
// off the banner rather than assuming it is what stops this from failing as
// `other side closed`, which looks like the endpoint rejecting the request.
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

try {
  // A first proposal against an empty project is a fast-forward from nothing.
  const first = proposeCommit('first draft\n', null)
  const accepted = await propose(bundleSince(null))
  assert.equal(accepted.status, 200, JSON.stringify(accepted.body))
  assert.equal(accepted.body.ok, true)
  assert.equal(accepted.body.sourceRevision, first, 'the accepted revision is the commit the checkout proposed')

  // A second proposal built on the first fast-forwards.
  const second = proposeCommit('second draft\n', first)
  const advanced = await propose(bundleSince(first))
  assert.equal(advanced.status, 200, JSON.stringify(advanced.body))
  assert.equal(advanced.body.sourceRevision, second)

  // A proposal built on a base the server has moved past does NOT fast-forward.
  // This is the conflict, and it is a refusal rather than a merge: the proposer
  // holds the commits and is the one who can rebase them.
  git(['update-ref', LOCAL_REF, first])
  const stale = proposeCommit('a different second draft\n', first)
  const refused = await propose(bundleSince(null))
  assert.equal(refused.status, 409, JSON.stringify(refused.body))
  assert.equal(refused.body.status, 'non-fast-forward')
  assert.equal(refused.body.currentRevision, second, 'the refusal names what the project actually holds')

  // **The refused candidate is not lost.** It is already an object in the store
  // under a ref, which is what lets it be shown to the person who wrote it
  // instead of existing only as a rejection payload on a server.
  assert.equal(refused.body.refusedRevision, stale, 'a refusal names the commit it refused')

  // And the refusal changed nothing: the project still holds what it held.
  const after = await (await fetch(`${base}/api/projects/${PROJECT}/source-authority`)).json()
  assert.equal(after.currentRevision, second, 'a refused proposal must not move the project')

  // Rebasing onto the current head and proposing again is the whole recovery
  // path — no retry state machine, no blocked terminal state.
  const rebased = proposeCommit('a different second draft\n', second)
  const retried = await propose(bundleSince(second))
  assert.equal(retried.status, 200, JSON.stringify(retried.body))
  assert.equal(retried.body.sourceRevision, rebased)

  console.log('a checkout proposes a commit: passed')
} finally {
  await stopServer(server)
  fs.rmSync(root, { recursive: true, force: true })
}
