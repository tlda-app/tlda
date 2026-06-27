#!/usr/bin/env node
//
// Integration test for Overleaf git sync. Stands up a local *bare* git repo as
// the "Overleaf remote", links a project to it, then exercises the change-sync
// path: edit the remote, sync, assert the project's source/ tracks the remote.
//
// Verifies the NEW code (clone, initial full push, name-status diff, hard-reset,
// delete propagation) against real git — no LaTeX build needed (SVG projects
// mark stale on push rather than building synchronously).

import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { execSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = mkdtempSync(join(tmpdir(), 'overleaf-sync-test-'))
const projectsDir = join(root, 'projects')
const authorRepo = join(root, 'author')      // where "Overleaf" edits happen
const bareRemote = join(root, 'remote.git')  // the git URL we link to
mkdirSync(projectsDir, { recursive: true })

function git(cwd, cmd) {
  return execSync(`git ${cmd}`, { cwd, encoding: 'utf8',
    env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t',
           GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } })
}

// Build the bare remote + an author working copy with a tiny paper.
function seedRemote() {
  execSync(`git init --bare "${bareRemote}"`)
  mkdirSync(authorRepo, { recursive: true })
  git(authorRepo, 'init')
  writeFileSync(join(authorRepo, 'main.tex'), '\\documentclass{article}\\begin{document}Hello v1\\end{document}\n')
  writeFileSync(join(authorRepo, 'refs.bib'), '@article{a, title={A}}\n')
  git(authorRepo, 'add -A')
  git(authorRepo, 'commit -m "v1"')
  git(authorRepo, `remote add origin "${bareRemote}"`)
  // Author's default branch — push it and make it the remote HEAD.
  const branch = git(authorRepo, 'rev-parse --abbrev-ref HEAD').trim()
  git(authorRepo, `push -u origin ${branch}`)
  git(bareRemote, `symbolic-ref HEAD refs/heads/${branch}`)
}

let overleaf, store
before(async () => {
  seedRemote()
  store = await import('../server/lib/project-store.mjs')
  const rooms = await import('../server/lib/sync-rooms.mjs')
  store.initProjectStore(projectsDir)
  rooms.initSyncRooms(projectsDir)
  overleaf = await import('../server/lib/overleaf-sync.mjs')
})

after(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('overleaf-sync', () => {
  it('links + does the initial full sync', async () => {
    const res = await overleaf.linkOverleaf('paper', { gitUrl: bareRemote, pollSeconds: 9999 })
    assert.equal(res.linked, true)
    assert.equal(res.changed, 2, 'both tracked files pushed on initial sync')

    const srcDir = store.sourceDir('paper')
    assert.ok(existsSync(join(srcDir, 'main.tex')), 'main.tex synced to source/')
    assert.ok(existsSync(join(srcDir, 'refs.bib')), 'refs.bib synced to source/')
    assert.match(readFileSync(join(srcDir, 'main.tex'), 'utf8'), /Hello v1/)

    const project = store.readProject('paper')
    assert.ok(project.overleafRemote, 'remote recorded')
    assert.ok(project.overleafHead, 'head recorded')
    assert.equal(project.autoSync, true)
    // Token must never be persisted in project.json (it's served to clients).
    assert.ok(!JSON.stringify(project).includes('@'), 'no creds in project.json')

    overleaf.stopPolling('paper')  // don't leave a 9999s timer dangling
  })

  it('syncs a change: edit + delete propagate', async () => {
    // Author edits main.tex and deletes refs.bib, pushes to "Overleaf".
    writeFileSync(join(authorRepo, 'main.tex'), '\\documentclass{article}\\begin{document}Hello v2 changed\\end{document}\n')
    git(authorRepo, 'rm refs.bib')
    git(authorRepo, 'add -A')
    git(authorRepo, 'commit -m "v2"')
    git(authorRepo, 'push origin HEAD')

    const res = await overleaf.syncOverleaf('paper')
    assert.equal(res.unchanged, undefined)
    assert.equal(res.changed, 1, 'one file changed')
    assert.equal(res.deleted, 1, 'one file deleted')

    const srcDir = store.sourceDir('paper')
    assert.match(readFileSync(join(srcDir, 'main.tex'), 'utf8'), /Hello v2 changed/)
    assert.ok(!existsSync(join(srcDir, 'refs.bib')), 'deleted file removed from source/')
  })

  it('reports unchanged when the remote has no new commits', async () => {
    const res = await overleaf.syncOverleaf('paper')
    assert.equal(res.unchanged, true)
    assert.equal(res.changed, 0)
  })
})
