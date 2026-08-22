#!/usr/bin/env node

/**
 * Settle selects different files depending on who owns the working tree.
 *
 * Two directories, two rules, and the verdict INVERTS between them:
 *
 *   - The app's own tree (`.source-room/working`) has no person in it. Nothing
 *     stages anything, so a document the app wrote must reach the server or it
 *     reaches nothing, ever.
 *   - A person's checkout has a person in it. A new file they have not staged
 *     is deliberately not submitted — the accepted trade — and their own
 *     `git status` saying `?? chapter2.tex` is the signal. No app-side notice.
 *
 * THE TRAP THIS HARNESS EXISTS TO AVOID, and it is why the person's column is
 * asserted the way it is: on that side "the new file is absent" is ALSO what a
 * totally broken repair produces. Absence alone passes a repair that fixed
 * nothing. So for B and C the assertion is `settle completed and every OTHER
 * file still reached the server` — because the damage defect (c) causes was
 * never to the new file, it was to everything else in the build.
 *
 * NOT asserted, deliberately: that the revision B produces on the person's side
 * BUILDS. It will not — `main.tex` \inputs a `chapter2` that is not in it. That
 * is correct. The person wrote an \input for a file they have not staged, and
 * the build error is the second ordinary signal after `git status`. A test
 * demanding a successful build there would be asserting the old sweep
 * behaviour under a new name.
 *
 * Run:  node bin/settle-selection-by-tree-ownership-test.mjs
 */

import { execFile as execFileCb } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { promisify } from 'util'
import { createGitProjectSync } from '../daemon/git-project-sync.mjs'

const execFileP = promisify(execFileCb)
const PROJECT = 'paper'

// The ownership flag is a `createGitProjectSync` constructor option that
// `bindSource` forwards. Named in one place so renaming it is one line here.
const OWNERSHIP_OPTION = 'appOwnedWorkingTree'

const git = (cwd, args) => execFileP('git', args, { cwd, timeout: 120000 })

async function initRepo(dir) {
  await git(dir, ['init', '-b', 'main'])
  await git(dir, ['config', 'user.name', 'fixture'])
  await git(dir, ['config', 'user.email', 'fixture@example.test'])
}

async function setup(root, label, { mainContent, baseCommit }) {
  const checkout = path.join(root, `checkout-${label}`)
  const remote = path.join(root, `remote-${label}`)
  await fs.promises.mkdir(checkout)
  await fs.promises.mkdir(remote)
  await initRepo(checkout)
  await initRepo(remote)
  if (baseCommit) {
    await fs.promises.writeFile(path.join(checkout, 'main.tex'), mainContent)
    await fs.promises.writeFile(path.join(checkout, 'preface.tex'), 'a second tracked file\n')
    await git(checkout, ['add', 'main.tex', 'preface.tex'])
    await git(checkout, ['commit', '-m', 'the paper so far'])
    // A tracked edit, so there is always something legitimate to submit. This is
    // what makes "every OTHER file still reached the server" a real assertion.
    await fs.promises.writeFile(path.join(checkout, 'preface.tex'), 'a second tracked file, edited\n')
  }
  await fs.promises.writeFile(path.join(remote, 'seed'), 'x')
  await git(remote, ['add', 'seed'])
  await git(remote, ['commit', '-m', 'seed'])
  return { checkout, remote }
}

function makeSync(sourceDir, remote, documentRoots, appOwned) {
  const submitted = []
  const sync = createGitProjectSync({
    sourceDir,
    project: PROJECT,
    daemonId: 'fixture-daemon',
    bindingId: 'fixture-binding',
    branch: 'main',
    remote,
    documentRoots,
    [OWNERSHIP_OPTION]: appOwned,
    log: { info: () => {}, warn: () => {}, error: () => {} },
    onSubmitted: event => submitted.push(event),
  })
  return { sync, submitted }
}

async function inRevision(remote, revision, file) {
  if (!revision) return false
  try {
    await git(remote, ['cat-file', '-e', `${revision}:${file}`])
    return true
  } catch {
    return false
  }
}

async function cell({ root, shape, appOwned, title, mainContent, newFile, newContent, documentRoots, baseCommit = true, writeNewFile = true }) {
  const label = `${shape}/${appOwned ? 'app-owned' : 'person'}`
  console.log(`\n${label}: ${title}`)
  const { checkout, remote } = await setup(root, `${shape}${appOwned ? 'a' : 'p'}`, { mainContent, baseCommit })
  const { sync, submitted } = makeSync(checkout, remote, documentRoots, appOwned)

  if (writeNewFile) await fs.promises.writeFile(path.join(checkout, newFile), newContent)

  const tracked = (await git(checkout, ['ls-files', '--', newFile])).stdout.trim() !== ''
  if (writeNewFile && (!fs.existsSync(path.join(checkout, newFile)) || tracked)) {
    console.log('  FIXTURE NOT CAPABLE: the new file is not present-and-untracked')
    return { label, shape, appOwned, capable: false, ok: false, outcome: 'incapable' }
  }

  let result = null
  let threw = null
  try {
    result = await sync.editClusterSettled()
  } catch (e) {
    threw = e.message.split('\n')[0]
  }

  if (threw) {
    console.log(`  settle THREW: ${threw}`)
    return { label, shape, appOwned, capable: true, ok: false, why: 'settle threw', outcome: `threw:${threw}` }
  }
  console.log(`  settle -> status=${result.status} ok=${result.ok}`)

  const revision = result.revision
  const newReached = await inRevision(remote, revision, newFile)
  const otherReached = baseCommit ? await inRevision(remote, revision, 'preface.tex') : null
  console.log(`  new file in submitted revision: ${newReached}`)
  if (baseCommit) console.log(`  OTHER tracked file (preface.tex) reached: ${otherReached}`)

  // Shape D writes no new file at all — the \input points at something that has
  // never existed. There is nothing that could "reach the server", so asserting
  // arrival would fail forever, in both columns and after any repair. What (c)
  // owes here is that the broken reference is skipped and the checkpoint still
  // completes carrying everything else.
  if (!writeNewFile) {
    const ok = otherReached === true
    console.log(`  expected: settle completes and other files reach  →  ${ok ? 'ok' : 'FAILED'}`)
    return { label, shape, appOwned, capable: true, ok, outcome: `${result.status}:${otherReached}`, why: ok ? null : 'a broken reference stopped the rest of the build reaching the server' }
  }

  if (appOwned) {
    // Nobody there to stage. The app's own document must reach the server.
    const ok = newReached
    console.log(`  expected: new file MUST reach  →  ${ok ? 'ok' : 'FAILED'}`)
    return { label, shape, appOwned, capable: true, ok, outcome: `${result.status}:${newReached}`, why: ok ? null : 'app-written document did not reach the server' }
  }

  // A person's checkout. The new file must NOT be swept in — that is the trade.
  // What must hold is that everything else still got there.
  if (!baseCommit) {
    const ok = result.status === 'empty-checkout'
    console.log(`  expected: clean empty-checkout, no throw  →  ${ok ? 'ok' : 'FAILED'}`)
    return { label, shape, appOwned, capable: true, ok, outcome: `${result.status}:${newReached}`, why: ok ? null : `expected empty-checkout, got ${result.status}` }
  }
  const ok = !newReached && otherReached === true
  console.log(`  expected: new file absent AND other files reached  →  ${ok ? 'ok' : 'FAILED'}`)
  return {
    label, shape, appOwned,
    capable: true,
    ok,
    outcome: `${result.status}:${newReached}`,
    why: ok ? null : (newReached ? 'the new file was swept in' : 'the rest of the build did not reach the server'),
  }
}

async function main() {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'tlda-ownership-'))
  const results = []
  try {
    for (const appOwned of [true, false]) {
      results.push(await cell({
        root, shape: 'A', appOwned,
        title: 'standalone new document, no configured roots',
        mainContent: 'the paper\n',
        newFile: 'chapter2.tex',
        newContent: 'a chapter\n',
        documentRoots: [],
      }))
      results.push(await cell({
        root, shape: 'B', appOwned,
        title: 'new file \\input by a tracked root',
        // preface is \input too, so it is inside main.tex's closure. Without
        // that, documentRoots: ['main.tex'] excludes it legitimately and the
        // "other files reached" assertion tests nothing.
        mainContent: 'the paper\n\\input{preface}\n\\input{chapter2}\n',
        newFile: 'chapter2.tex',
        newContent: 'a chapter\n',
        documentRoots: ['main.tex'],
      }))
      results.push(await cell({
        root, shape: 'C', appOwned,
        title: 'nothing tracked, HEAD unborn',
        baseCommit: false,
        mainContent: null,
        newFile: 'chapter1.tex',
        newContent: 'the first document\n',
        documentRoots: [],
      }))
    }

    // Shape D, app-owned only: an \input pointing at a file that genuinely does
    // not exist — broken reference rather than unstaged file. Under (c) this
    // must skip and let the checkpoint complete, which is the other branch of
    // the same repair.
    results.push(await cell({
      root, shape: 'D', appOwned: true,
      title: '\\input of a file that does not exist at all — broken reference',
      mainContent: 'the paper\n\\input{preface}\n\\input{nowhere}\n',
      newFile: 'unused.tex',
      newContent: 'x\n',
      documentRoots: ['main.tex'],
      writeNewFile: false,
    }))

    console.log('\n' + '='.repeat(72))
    for (const r of results) {
      console.log(`  ${r.label.padEnd(18)} ${!r.capable ? 'INCONCLUSIVE' : r.ok ? 'ok' : `FAILED — ${r.why}`}`)
    }

    // Control on the flag itself, and it is the difference between this being a
    // gate and a formality. `OWNERSHIP_OPTION` is passed as a constructor
    // option; an option a constructor does not read is silently ignored, so a
    // renamed or unwired flag produces app-owned cells that behave EXACTLY like
    // their person counterparts. That is a real red — but for the wrong reason,
    // and it would be read as "the repair is broken" rather than "the harness
    // is not connected to it". If every shape behaves identically across the
    // two columns, the flag is not being honoured and nothing here is evidence
    // about the repair.
    const shapes = [...new Set(results.filter(r => r.capable).map(r => r.shape))]
    const paired = shapes.filter(s => results.filter(r => r.shape === s && r.capable).length === 2)
    const differing = paired.filter(s => {
      const [a, p] = results.filter(r => r.shape === s).sort((x, y) => Number(y.appOwned) - Number(x.appOwned))
      return a.outcome !== p.outcome
    })
    console.log(`\n  flag control: ${differing.length} of ${paired.length} paired shapes behave differently across the two columns`)
    if (paired.length && differing.length === 0) {
      console.log(`\n  FLAG NOT HONOURED: every shape behaves identically with ${OWNERSHIP_OPTION}`)
      console.log('  true and false. Either the option is not wired yet, or its name here does')
      console.log('  not match the implementation. Nothing above is evidence about the repair.')
      process.exit(2)
    }

    const failed = results.filter(r => r.capable && !r.ok)
    console.log(failed.length
      ? `\n${failed.length} of ${results.length} cells FAILED.`
      : `\nAll ${results.length} cells hold.`)
    process.exit(failed.length ? 1 : 0)
  } finally {
    await fs.promises.rm(root, { recursive: true, force: true })
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(3)
})
