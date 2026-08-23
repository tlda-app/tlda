#!/usr/bin/env node

/**
 * A document dropped from a push must not be reported as a success.
 *
 * What syncs is the transitive closure of a project's declared document roots.
 * A tracked file that no root references is not in the closure, so it never
 * enters the revision. That is the design and this test does not question it.
 *
 * What it measures is the REPORT. Before this change, a person who wrote a
 * document, ran `git add`, and pushed was answered `SubmittedToBuildQueue`,
 * `ok=true`, with the document nowhere in the revision and nothing said about
 * it anywhere. The only evidence they ever got was the document not appearing.
 *
 * Two halves, and the second is the point:
 *
 *   1. When a document is dropped, the drop is named — in the submission the
 *      CLI prints, and through the manager's dropped-document callback, which
 *      is what `bin/fleet-daemon.mjs` turns into a `daemon-warning`.
 *   2. When nothing is dropped, nothing is said. A warning that always fires is
 *      a warning people stop reading, which is the same silence one layer up.
 *      Two counterfactual shapes here, plus a repeat check: the same drop set
 *      settling twice reports once.
 *
 * The wire: this drives the real `createGitSyncManager` over real git, so
 * git-project-sync → manager → callback is crossed rather than assumed, and it
 * imports the real CLI formatter. The last hop — the daemon's callback sending
 * `daemon-warning`, and the server turning that into a chat message — is not
 * crossed here; it needs a daemon and a server. That hop is stated, not
 * claimed: see the verdict block at the end.
 *
 * This does real git work in real repositories — six settles, each a handful of
 * git subprocesses — so on a loaded machine it takes a few minutes.
 *
 * Run:  node bin/a-dropped-document-does-not-report-success-test.mjs
 */

import { execFile as execFileCb } from 'child_process'
import { EventEmitter } from 'events'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { promisify } from 'util'
import { createGitSyncManager } from '../daemon/git-sync-manager.mjs'
import { printDocumentsNotInRevision } from '../cli/tlda.mjs'

const execFileP = promisify(execFileCb)
const git = (cwd, args) => execFileP('git', args, { cwd, encoding: 'utf8', timeout: 60000 })
const PROJECT = 'fixture-project'

const failures = []
const warnings = []
function check(condition, description) {
  console.log(`  ${condition ? 'ok  ' : 'FAIL'}  ${description}`)
  if (!condition) failures.push(description)
}

function testWatcher() {
  const watcher = new EventEmitter()
  watcher.add = () => {}
  watcher.unwatch = async () => {}
  watcher.close = async () => {}
  return watcher
}

async function until(predicate, label, timeoutMs = 120000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return true
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  throw new Error(`timed out waiting for ${label}; daemon log said: ${warnings.join(' | ') || '(nothing)'}`)
}

async function commitAll(checkout, message) {
  await git(checkout, ['add', '-A'])
  await git(checkout, ['commit', '-m', message])
}

async function makeHarness(root, label, files) {
  const checkout = path.join(root, `checkout-${label}`)
  const remote = path.join(root, `remote-${label}.git`)
  await git(root, ['init', '--bare', remote])
  await git(root, ['init', '-b', 'main', checkout])
  await git(checkout, ['config', 'user.name', 'fixture'])
  await git(checkout, ['config', 'user.email', 'fixture@example.test'])
  for (const [file, content] of Object.entries(files)) {
    await fs.promises.writeFile(path.join(checkout, file), content)
  }
  await commitAll(checkout, 'the project so far')
  return { checkout, remote }
}

function makeManager(root, label, checkout, remote, documentRoots) {
  const reports = []
  const submissions = []
  const manager = createGitSyncManager({
    bindingsFile: path.join(root, `bindings-${label}.json`),
    daemonId: 'fixture-daemon',
    server: 'http://unused.test',
    remoteUrlFor: () => remote,
    watch: () => testWatcher(),
    quietMs: 10,
    // A settle that fails is logged at warn and swallowed by the manager, so a
    // silenced log turns "the proposal was rejected" into "the wire is broken".
    log: { info() {}, warn(value) { warnings.push(String(value)) }, error(value) { warnings.push(String(value)) } },
    onProposalSubmitted: async event => { submissions.push(event) },
    onDocumentsDropped: async event => { reports.push(event) },
  })
  manager.bindSource(PROJECT, checkout, { documentRoots })
  return { manager, reports, submissions }
}

// A settle driven by the file watcher, the way a person's editor drives it.
// Returns once the settle has run: the settle pushes a proposal, so the
// submission count moving is the settle having finished its work.
async function settleThroughTheWatcher(manager, checkout, submissions, marker) {
  const before = submissions.length
  await fs.promises.appendFile(path.join(checkout, 'main.tex'), `% ${marker}\n`)
  await commitAll(checkout, marker)
  manager.queuePaths(PROJECT, ['main.tex'])
  await until(() => submissions.length > before, `settle after ${marker}`)
  // The dropped-document report is raised after the settle resolves, so give
  // the microtask that raises it a turn before reading the list.
  await new Promise(resolve => setTimeout(resolve, 50))
}

async function revisionContains(remote, revision, file) {
  try {
    await git(remote, ['cat-file', '-e', `${revision}:${file}`])
    return true
  } catch {
    return false
  }
}

// ---------------------------------------------------------------------------

async function droppedDocumentIsNamed(root) {
  console.log('\nA. a tracked document no root reaches — the measured defect')
  const { checkout, remote } = await makeHarness(root, 'a', {
    'main.tex': '\\documentclass{article}\\begin{document}the paper\\end{document}\n',
    'outline.md': '# the outline the author wrote and staged\n',
  })
  const { manager, reports, submissions } = makeManager(root, 'a', checkout, remote, ['main.tex'])
  await manager.sync([{ name: PROJECT, mainFile: 'main.tex' }])

  const submission = await manager.submit(PROJECT)

  // Positive control: the defect is real in this fixture. Without this the rest
  // measures a report about nothing.
  check(submission.status === 'SubmittedToBuildQueue' && submission.ok === true,
    `the push still reports success — status=${submission.status} ok=${submission.ok}`)
  check(await revisionContains(remote, submission.revision, 'main.tex'),
    'the revision contains main.tex')
  check(!(await revisionContains(remote, submission.revision, 'outline.md')),
    'the revision does NOT contain outline.md — it really was dropped')

  check(Array.isArray(submission.dropped) && submission.dropped.join(',') === 'outline.md',
    `the submission names it: dropped=${JSON.stringify(submission.dropped)}`)

  console.log('  what `tlda project push` prints for that submission:')
  const printed = []
  const realLog = console.log
  console.log = (...args) => printed.push(args.join(' '))
  try { printDocumentsNotInRevision(submission) } finally { console.log = realLog }
  for (const line of printed) console.log(`    │ ${line}`)
  check(printed.some(line => line.includes('outline.md')),
    'the CLI names the file to the person who ran the command')

  // The watcher path has nobody at a terminal, so the report goes out as a
  // message instead. This is the hop the daemon turns into a `daemon-warning`.
  await settleThroughTheWatcher(manager, checkout, submissions, 'an ordinary edit')
  check(reports.length === 1 && reports[0].dropped.join(',') === 'outline.md',
    `a watcher settle raises the report once: ${JSON.stringify(reports.map(item => item.dropped))}`)

  // A warning that fires on every save is a warning nobody reads.
  await settleThroughTheWatcher(manager, checkout, submissions, 'another ordinary edit')
  check(reports.length === 1,
    `the same drop set settling again does not repeat it: reports=${reports.length}`)

  // A drop set that CHANGES is a new thing to say.
  await fs.promises.writeFile(path.join(checkout, 'notes.md'), '# notes\n')
  await settleThroughTheWatcher(manager, checkout, submissions, 'a second unreferenced document')
  check(reports.length === 2 && reports[1].dropped.join(',') === 'notes.md,outline.md',
    `a changed drop set is reported: ${JSON.stringify(reports.at(-1)?.dropped)}`)

  // And when the drop is repaired, the report stops and says nothing new.
  await git(checkout, ['rm', '-q', 'outline.md', 'notes.md'])
  await settleThroughTheWatcher(manager, checkout, submissions, 'the unreferenced documents removed')
  check(reports.length === 2,
    `nothing dropped, nothing said: reports=${reports.length}`)

  await manager.closeAll()
}

async function nothingDroppedSaysNothing(root, { label, title, files, documentRoots, present }) {
  console.log(`\n${label}. ${title}`)
  const { checkout, remote } = await makeHarness(root, label.toLowerCase(), files)
  const { manager, reports, submissions } = makeManager(root, label.toLowerCase(), checkout, remote, documentRoots)
  await manager.sync([{ name: PROJECT, mainFile: 'main.tex' }])

  const submission = await manager.submit(PROJECT)
  for (const file of present) {
    check(await revisionContains(remote, submission.revision, file),
      `the revision contains ${file} — nothing was dropped`)
  }
  check((submission.dropped || []).length === 0,
    `the submission reports no drop: dropped=${JSON.stringify(submission.dropped)}`)

  const printed = []
  const realLog = console.log
  console.log = (...args) => printed.push(args.join(' '))
  try { printDocumentsNotInRevision(submission) } finally { console.log = realLog }
  check(printed.length === 0, 'the CLI prints nothing')

  await settleThroughTheWatcher(manager, checkout, submissions, 'an ordinary edit')
  check(reports.length === 0, `no report is raised: reports=${reports.length}`)

  await manager.closeAll()
}

async function main() {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'tlda-dropped-document-'))
  try {
    await droppedDocumentIsNamed(root)

    await nothingDroppedSaysNothing(root, {
      label: 'B',
      title: 'the same file, referenced by the root — the counterfactual',
      files: {
        'main.tex': '\\documentclass{article}\\begin{document}\\input{chapter2}\\end{document}\n',
        'chapter2.tex': 'a chapter the root reaches\n',
      },
      documentRoots: ['main.tex'],
      present: ['main.tex', 'chapter2.tex'],
    })

    await nothingDroppedSaysNothing(root, {
      label: 'C',
      title: 'no configured roots, so every document is its own root',
      files: {
        'main.tex': '\\documentclass{article}\\begin{document}the paper\\end{document}\n',
        'outline.md': '# the outline\n',
      },
      documentRoots: [],
      present: ['main.tex', 'outline.md'],
    })

    console.log('\n' + '='.repeat(72))
    if (failures.length) {
      console.log(`${failures.length} check${failures.length === 1 ? '' : 's'} failed:`)
      for (const failure of failures) console.log(`  - ${failure}`)
    } else {
      console.log('A dropped document is named; a settle that drops nothing says nothing.')
    }
    console.log('\nCrossed here: git-project-sync → git-sync-manager → dropped-document callback,')
    console.log('and the CLI formatter that prints a submission. NOT crossed here: the daemon')
    console.log('callback sending `daemon-warning`, and the server turning it into a chat')
    console.log('message — that needs a running daemon and server.')
    process.exit(failures.length ? 1 : 0)
  } finally {
    await fs.promises.rm(root, { recursive: true, force: true })
  }
}

main().catch(error => {
  console.error(error)
  process.exit(3)
})
