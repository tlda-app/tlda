/**
 * **A committed symlinked directory must not make a project unpushable.**
 *
 * A repository can commit a directory symlink — `scratch/book/figs ->
 * ../../lectures/figs` — and a document inside it writes the ordinary relative
 * include, `\includegraphics{figs/plot.png}`. The closure walker resolves that
 * against the document's directory and records `scratch/book/figs/plot.png`.
 *
 * **Git does not traverse symlinks in a tree.** Measured on a minimal repo:
 *
 *     git ls-tree HEAD -- scratch/book/figs/plot.png   ->  (nothing)
 *     git ls-tree HEAD -- scratch/book/figs            ->  120000 blob …
 *     git ls-tree HEAD -- lectures/figs/plot.png       ->  100644 blob …
 *
 * So the immutable-closure check in `filteredProjectCommit` looks up a path
 * that is real on disk, real in the repository, and absent from the tree AT
 * THAT PATH — and throws `immutable closure member is absent`. The whole push
 * fails, and the file it names is committed and present.
 *
 * **What this asserts, and what it deliberately does not.** The closure member
 * has to resolve to the canonical committed path; the symlink itself stays a
 * member, because it is a committed blob and the built document needs it to
 * find its figures. The immutable check itself is NOT relaxed.
 *
 * The last test reaches that check at link/refilter time: the archive retains
 * the dependency while the injected immutable tree listing omits it. Removing
 * the check makes that counterfactual fail on the missing named refusal.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile as execFileCb } from 'node:child_process'
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

import { createGitProjectSync } from './git-project-sync.mjs'

const execFile = promisify(execFileCb)
const git = (cwd, args) => execFile('git', args, { cwd, encoding: 'utf8', timeout: 30_000 })

/**
 * A repo whose document lives behind a committed directory symlink.
 *
 * Built the way a person's repository actually is: the figures live once, under
 * `lectures/`, and the book directory points at them. Nothing here is exotic —
 * `git add` commits the link as a `120000` blob without being asked.
 */
async function repoWithASymlinkedFigureDir(root, { includeLine = '\\includegraphics{figs/plot.png}' } = {}) {
  const remote = join(root, 'server.git')
  const checkout = join(root, 'checkout')
  await git(root, ['init', '--bare', remote])
  await git(root, ['init', '-b', 'main', checkout])
  await git(checkout, ['config', 'user.name', 'fixture'])
  await git(checkout, ['config', 'user.email', 'fixture@example.test'])
  await git(checkout, ['remote', 'add', 'tlda', remote])

  mkdirSync(join(checkout, 'lectures', 'figs'), { recursive: true })
  mkdirSync(join(checkout, 'scratch', 'book'), { recursive: true })
  writeFileSync(join(checkout, 'lectures', 'figs', 'plot.png'), 'PNG-BYTES\n')
  symlinkSync('../../lectures/figs', join(checkout, 'scratch', 'book', 'figs'))
  writeFileSync(join(checkout, 'scratch', 'book', 'main.tex'),
    `\\documentclass{article}\n\\begin{document}\n${includeLine}\n\\end{document}\n`)
  await git(checkout, ['add', '-A'])
  await git(checkout, ['commit', '-m', 'book behind a symlinked figure dir'])
  await git(checkout, ['checkout', '-q', '-b', 'tlda/paper'])
  return { remote, checkout }
}

function syncFor(checkout, remote) {
  return createGitProjectSync({
    sourceDir: checkout,
    project: 'paper',
    daemonId: 'daemon-a',
    bindingId: 'paper',
    remote,
    documentRoots: ['scratch/book/main.tex'],
    log: { info() {}, warn() {}, error() {} },
  })
}

/** The paths carried by the newest proposal the remote holds. */
async function pushedPaths(remote) {
  const refs = (await git(remote, ['for-each-ref', '--format=%(objectname)', 'refs/tlda/proposals/'])).stdout
    .split('\n').filter(Boolean)
  if (!refs.length) return null
  const listing = (await git(remote, ['ls-tree', '-r', '--name-only', refs[0]])).stdout
  return listing.split('\n').filter(Boolean)
}

test('a document behind a committed symlinked directory pushes', async () => {
  const root = mkdtempSync(join(tmpdir(), 'tlda-symlink-closure-'))
  const { remote, checkout } = await repoWithASymlinkedFigureDir(root)

  // Confirm the fixture is the real shape before drawing any conclusion from
  // it: git must NOT resolve the through-the-symlink path, or this test is
  // measuring something else entirely.
  const throughLink = (await git(checkout, ['ls-tree', 'HEAD', '--', 'scratch/book/figs/plot.png'])).stdout.trim()
  assert.equal(throughLink, '', 'the fixture really does hide the file behind a symlink git will not traverse')
  const canonical = (await git(checkout, ['ls-tree', 'HEAD', '--', 'lectures/figs/plot.png'])).stdout.trim()
  assert.notEqual(canonical, '', 'and the file really is committed at its canonical path')

  const result = await syncFor(checkout, remote).editClusterSettled()
  assert.notEqual(result?.ok, false,
    `the push must not be refused for a file that is committed: ${JSON.stringify(result)}`)

  const paths = await pushedPaths(remote)
  assert.ok(paths, 'a proposal reached the remote')
  assert.ok(paths.includes('lectures/figs/plot.png'),
    `the figure is in the revision at its CANONICAL path (saw ${JSON.stringify(paths)})`)
  assert.ok(paths.includes('scratch/book/figs'),
    `and the symlink itself is still carried, or the built document cannot find its figures (saw ${JSON.stringify(paths)})`)
  assert.ok(paths.includes('scratch/book/main.tex'), 'along with the document')
})

test('the file is the SAME blob at the canonical path, not a copy', async () => {
  // A fix that materialised the bytes at the virtual path would satisfy the
  // first test and be wrong: it would put a second copy of every figure in
  // every revision, and the two would drift the moment one was edited.
  const root = mkdtempSync(join(tmpdir(), 'tlda-symlink-blob-'))
  const { remote, checkout } = await repoWithASymlinkedFigureDir(root)
  await syncFor(checkout, remote).editClusterSettled()

  const refs = (await git(remote, ['for-each-ref', '--format=%(objectname)', 'refs/tlda/proposals/'])).stdout
    .split('\n').filter(Boolean)
  const inProposal = (await git(remote, ['ls-tree', refs[0], '--', 'lectures/figs/plot.png'])).stdout.trim()
  const inCheckout = (await git(checkout, ['ls-tree', 'HEAD', '--', 'lectures/figs/plot.png'])).stdout.trim()
  assert.equal(inProposal.split('\t')[0], inCheckout.split('\t')[0],
    'same mode and same blob id — the revision points at the committed object')

  const paths = await pushedPaths(remote)
  assert.equal(paths.filter(entry => entry.endsWith('plot.png')).length, 1,
    `exactly one copy of the figure (saw ${JSON.stringify(paths)})`)
})

test('a symlink pointing OUT of the repository ships nothing and does not wedge the push', async () => {
  // CONTAINMENT. A symlink that leaves the repository is not a way to pull
  // files into a revision from outside it, and it must not wedge the push
  // either: the figure is simply not carried, and the document still publishes.
  //
  // It reaches the immutable check by no route -- the link materialises
  // pointing outside the temporary tree, so the file is missing rather than a
  // member. The check has its own test below.
  const root = mkdtempSync(join(tmpdir(), 'tlda-symlink-escapes-'))
  const outside = join(root, 'outside')
  mkdirSync(outside, { recursive: true })
  writeFileSync(join(outside, 'plot.png'), 'PNG-BYTES\n')

  const remote = join(root, 'server.git')
  const checkout = join(root, 'checkout')
  await git(root, ['init', '--bare', remote])
  await git(root, ['init', '-b', 'main', checkout])
  await git(checkout, ['config', 'user.name', 'fixture'])
  await git(checkout, ['config', 'user.email', 'fixture@example.test'])
  await git(checkout, ['remote', 'add', 'tlda', remote])
  mkdirSync(join(checkout, 'scratch', 'book'), { recursive: true })
  symlinkSync('../../../outside', join(checkout, 'scratch', 'book', 'figs'))
  writeFileSync(join(checkout, 'scratch', 'book', 'main.tex'),
    '\\documentclass{article}\n\\begin{document}\n\\includegraphics{figs/plot.png}\n\\end{document}\n')
  await git(checkout, ['add', '-A'])
  await git(checkout, ['commit', '-m', 'figures outside the repository'])
  await git(checkout, ['checkout', '-q', '-b', 'tlda/paper'])

  const result = await syncFor(checkout, remote).editClusterSettled()
  assert.notEqual(result?.ok, false, `the document still publishes: ${JSON.stringify(result)}`)

  const paths = await pushedPaths(remote)
  assert.ok(paths.includes('scratch/book/main.tex'), 'the document is in the revision')
  assert.ok(!paths.some(entry => entry.endsWith('plot.png')),
    `nothing from outside the repository was carried in (saw ${JSON.stringify(paths)})`)
})

test('link-time filtering refuses a closure member absent from the immutable tree', async () => {
  const root = mkdtempSync(join(tmpdir(), 'tlda-immutable-link-check-'))
  const { remote, checkout } = await repoWithASymlinkedFigureDir(root)

  const runGit = async (args, options = {}) => {
    const result = await execFile('git', args, { cwd: checkout, encoding: 'utf8', timeout: 30_000, ...options })
    if (args[0] !== 'ls-tree' || !args.includes('-z')) return result
    return {
      ...result,
      stdout: result.stdout.split('\0')
        .filter(record => !record.endsWith('\tlectures/figs/plot.png'))
        .join('\0'),
    }
  }

  const sync = createGitProjectSync({
    sourceDir: checkout,
    project: 'paper',
    daemonId: 'daemon-a',
    bindingId: 'paper',
    remote,
    documentRoots: ['scratch/book/main.tex'],
    log: { info() {}, warn() {}, error() {} },
    runGit,
  })

  await assert.rejects(
    () => sync.standOnWorkBranch({ refilter: true }),
    /immutable closure member is absent: scratch\/book\/figs\/plot\.png/,
  )
  const refs = (await git(remote, ['for-each-ref', '--format=%(objectname)', 'refs/tlda/proposals/'])).stdout.trim()
  assert.equal(refs, '', 'no proposal reached the remote')
})
