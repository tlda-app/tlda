#!/usr/bin/env node
//
// Integration test for Overleaf git sync. Stands up a local *bare* git repo as
// the "Overleaf remote", links a project to it, then exercises the change-sync
// path: edit the remote, sync, assert the project's source/ tracks the remote.
//
// Verifies the Overleaf mirror against real git: initial pull into tlda,
// remote→tlda change propagation, and tlda→remote push propagation. No LaTeX
// build needed (SVG projects mark stale on push rather than building
// synchronously).

import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { execSync } from 'node:child_process'
import { chmodSync, mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs'
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

let overleaf, store, routes
before(async () => {
  seedRemote()
  store = await import('../server/lib/project-store.mjs')
  const rooms = await import('../server/lib/sync-rooms.mjs')
  store.initProjectStore(projectsDir)
  rooms.initSyncRooms(projectsDir)
  overleaf = await import('../server/lib/overleaf-sync.mjs')
  routes = await import('../server/routes/projects.mjs')
})

after(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('overleaf-sync', () => {
  it('links + does the initial full sync', async () => {
    const res = await overleaf.linkOverleaf('paper', { gitUrl: bareRemote, mainFile: 'main.tex', pollSeconds: 9999 })
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

  it('pushes tlda-side source changes back to the remote', async () => {
    const content = '\\documentclass{article}\\begin{document}Hello from tlda\\end{document}\n'
    const res = await routes.processProjectPush('paper', {
      files: [
        { path: 'main.tex', content },
        { path: 'notes.tex', content: 'temporary note from tlda\n' },
      ],
      editedBy: 'test-agent',
    })
    assert.equal(res.ok, true)

    git(authorRepo, 'pull --ff-only origin HEAD')
    assert.match(readFileSync(join(authorRepo, 'main.tex'), 'utf8'), /Hello from tlda/)
    assert.match(readFileSync(join(authorRepo, 'notes.tex'), 'utf8'), /temporary note/)

    const del = await routes.processProjectPush('paper', {
      deletedFiles: ['notes.tex'],
      editedBy: 'test-agent',
    })
    assert.equal(del.ok, true)

    git(authorRepo, 'pull --ff-only origin HEAD')
    assert.equal(existsSync(join(authorRepo, 'notes.tex')), false)

    const project = store.readProject('paper')
    const remoteHead = git(authorRepo, 'rev-parse HEAD').trim()
    assert.equal(project.overleafHead, remoteHead)
  })

  it('copies git conflict markers into tlda source when push rebase conflicts', async () => {
    const hookPath = join(projectsDir, 'paper', 'overleaf-clone', '.git', 'hooks', 'pre-push')
    writeFileSync(hookPath, `#!/bin/sh
rm "$0"
cd "${authorRepo}"
cat > main.tex <<'EOF'
\\\\documentclass{article}\\\\begin{document}Remote conflict\\\\end{document}
EOF
git add main.tex
git commit -m "remote conflict from hook"
git push origin HEAD
exit 1
`)
    chmodSync(hookPath, 0o755)

    const localContent = '\\documentclass{article}\\begin{document}Tlda conflict\\end{document}\n'
    const res = await routes.processProjectPush('paper', {
      files: [{ path: 'main.tex', content: localContent }],
      editedBy: 'test-agent',
    })

    assert.equal(res.ok, false)
    assert.equal(res.status, 409)
    assert.match(res.error, /Git sync conflict/)

    const source = readFileSync(join(store.sourceDir('paper'), 'main.tex'), 'utf8')
    assert.match(source, /<<<<<<< HEAD/)
    assert.match(source, /=======/)
    assert.match(source, />>>>>>>/)
    assert.match(source, /Remote conflict/)
    assert.match(source, /Tlda conflict/)

    const project = store.readProject('paper')
    assert.equal(project.overleafSyncStatus, 'conflict')
    assert.deepEqual(project.overleafConflictFiles, ['main.tex'])
  })
})
