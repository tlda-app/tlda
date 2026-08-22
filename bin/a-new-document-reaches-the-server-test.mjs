#!/usr/bin/env node

/**
 * Does a document the app itself created reach the server?
 *
 * `rync-pm` found that `server/lib/source-room-daemon.mjs` binds its own
 * directory as a `sourceDir` and then writes document files into it —
 * `bindSource(project, join(paths.root, 'working'))` at 148 with
 * `atomicWrite(paths.working, text)` at 165, and `bindSource(project, root)` at
 * 465 with `atomicWrite(join(root, file.path), …)` at 473. On first write for a
 * path, those files are UNTRACKED.
 *
 * Settle used to stage `git add -A -- .`, which swept them in. It now stages
 * `git add -u`, which is tracked paths only, and the source module says so:
 * "a NEW file is not submitted until the author `git add`s it." That cost was
 * accepted for a PERSON's checkout, where a person can stage. In the source
 * room's own working tree there is no person and nothing stages anything.
 *
 * This runs the experiment rather than reading more code. Two shapes:
 *
 *   A. a standalone new document, no configured roots
 *   B. a new file `\input`'d by an existing tracked root, roots configured —
 *      the realistic browser case, and the one that can fail hardest, because
 *      the dependency closure is scanned against the COMMITTED tree
 *
 * Neither outcome is assumed. Run it on both branches and compare:
 *   passes on e2545ebea, fails on the fix  → the fix introduces it
 *   fails on both                          → pre-existing, not ours
 *   passes on both                         → the code read was wrong
 *
 * Run:  node bin/a-new-document-reaches-the-server-test.mjs
 */

import { execFile as execFileCb } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { promisify } from 'util'
import { createGitProjectSync } from '../daemon/git-project-sync.mjs'

const execFileP = promisify(execFileCb)
const PROJECT = 'paper'

const git = (cwd, args) => execFileP('git', args, { cwd, timeout: 120000 })

async function initRepo(dir) {
  await git(dir, ['init', '-b', 'main'])
  await git(dir, ['config', 'user.name', 'fixture'])
  await git(dir, ['config', 'user.email', 'fixture@example.test'])
}

async function setup(root, label, { mainContent, baseCommit = true }) {
  const checkout = path.join(root, `checkout-${label}`)
  const remote = path.join(root, `remote-${label}`)
  await fs.promises.mkdir(checkout)
  await fs.promises.mkdir(remote)
  await initRepo(checkout)
  await initRepo(remote)
  // With baseCommit, a bound working tree that already has a tracked document —
  // the state after the first successful round trip.
  //
  // Without it, what `ensureRepo()` actually leaves behind: `git init -b main`
  // plus user config, no add, no commit, nothing tracked, HEAD unborn. That is
  // the state of a source room's working tree on FIRST use, and no fixture any
  // of us wrote had that shape — every one committed a base first, because that
  // is how people picture a repository. The bind sites are the only place this
  // occurs and it is the case that matters.
  if (baseCommit) {
    await fs.promises.writeFile(path.join(checkout, 'main.tex'), mainContent)
    await git(checkout, ['add', 'main.tex'])
    await git(checkout, ['commit', '-m', 'the paper so far'])
  }
  await fs.promises.writeFile(path.join(remote, 'seed'), 'x')
  await git(remote, ['add', 'seed'])
  await git(remote, ['commit', '-m', 'seed'])
  return { checkout, remote }
}

function makeSync(sourceDir, remote, documentRoots) {
  const submitted = []
  const sync = createGitProjectSync({
    sourceDir,
    project: PROJECT,
    daemonId: 'fixture-daemon',
    bindingId: 'fixture-binding',
    branch: 'main',
    remote,
    documentRoots,
    // This whole file is about a document THE APP created, in the app's own
    // bound working tree, where there is no person and nothing stages anything.
    // Without this the fixture is a person's checkout, where a new unstaged file
    // not being submitted is the accepted trade rather than a defect — so the
    // verdict line below would be measuring the right thing and calling it by
    // the wrong name. On a branch with no such option this is inert.
    appOwnedWorkingTree: true,
    log: { info: () => {}, warn: () => {}, error: () => {} },
    onSubmitted: event => submitted.push(event),
  })
  return { sync, submitted }
}

async function revisionContains(remote, revision, file) {
  try {
    await git(remote, ['cat-file', '-e', `${revision}:${file}`])
    return true
  } catch {
    return false
  }
}

async function shape({ root, label, title, mainContent, newFile, newContent, documentRoots, baseCommit = true }) {
  console.log(`\nSHAPE ${label}: ${title}`)
  const { checkout, remote } = await setup(root, label, { mainContent, baseCommit })
  const { sync, submitted } = makeSync(checkout, remote, documentRoots)

  // The app creates a document, exactly as atomicWrite does: it writes the file
  // and stages nothing.
  await fs.promises.writeFile(path.join(checkout, newFile), newContent)

  // Capability control: the file must really be present and really untracked,
  // or nothing below is about the thing being tested.
  const onDisk = fs.existsSync(path.join(checkout, newFile))
  const tracked = (await git(checkout, ['ls-files', '--', newFile])).stdout.trim() !== ''
  const head = (await git(checkout, ['rev-parse', 'HEAD']).then(r => r.stdout.trim()).catch(() => null)) || '(unborn)'
  console.log(`  ${newFile} written by the app: on disk=${onDisk}, tracked=${tracked}`)
  console.log(`  HEAD: ${head}`)
  if (!onDisk || tracked) {
    console.log('  FIXTURE NOT CAPABLE: the file is not an untracked app-written document.')
    return { label, capable: false, reached: null, note: 'fixture wrong' }
  }

  let result
  let threw = null
  try {
    result = await sync.editClusterSettled()
  } catch (e) {
    threw = e.message
  }

  if (threw) {
    console.log(`  settle THREW: ${threw}`)
    console.log(`  the new document did NOT reach the server, and settle failed outright`)
    return { label, capable: true, reached: false, threw, note: 'settle threw' }
  }

  console.log(`  settle -> status=${result.status} ok=${result.ok}`)
  console.log(`  proposals submitted: ${submitted.length}`)

  const revision = result.revision
  const reached = revision ? await revisionContains(remote, revision, newFile) : false
  const mainReached = revision ? await revisionContains(remote, revision, 'main.tex') : false
  console.log(`  submitted revision contains ${newFile}: ${reached}`)
  console.log(`  submitted revision contains main.tex:  ${mainReached}`)

  return { label, capable: true, reached, status: result.status, submitted: submitted.length, note: result.status }
}

async function main() {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'tlda-new-document-'))
  const results = []
  try {
    results.push(await shape({
      root,
      label: 'A',
      title: 'a standalone new document, no configured roots',
      mainContent: 'the paper\n',
      newFile: 'chapter2.tex',
      newContent: 'a chapter the app created\n',
      documentRoots: [],
    }))

    results.push(await shape({
      root,
      label: 'B',
      title: 'a new file \\input by a tracked root, roots configured — the browser case',
      mainContent: 'the paper\n\\input{chapter2}\n',
      newFile: 'chapter2.tex',
      newContent: 'a chapter the app created\n',
      documentRoots: ['main.tex'],
    }))

    results.push(await shape({
      root,
      label: 'C',
      title: 'a fresh source room — nothing tracked, HEAD unborn, exactly what ensureRepo leaves',
      baseCommit: false,
      mainContent: null,
      newFile: 'chapter1.tex',
      newContent: 'the first document, created in the browser\n',
      documentRoots: [],
    }))

    console.log('\n' + '='.repeat(72))
    for (const r of results) {
      const verdict = !r.capable ? 'INCONCLUSIVE'
        : r.reached ? 'REACHED THE SERVER'
        : 'DID NOT REACH THE SERVER'
      console.log(`  ${r.label}: ${verdict} (${r.note})`)
    }
    const lost = results.some(r => r.capable && !r.reached)
    console.log(lost
      ? '\nA document the app created does not reach the server on this branch.'
      : '\nEvery app-created document reached the server on this branch.')
    process.exit(lost ? 1 : 0)
  } finally {
    await fs.promises.rm(root, { recursive: true, force: true })
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(3)
})
