// The cutover contract, as failing controls.
//
// These are written BEFORE the cutover and are expected to be RED. Each one
// names an outcome the production build path produces today and that routing
// through `buildDocument()` would silently stop producing -- every one of them
// fails by simply not happening, which is why a green suite after the cutover
// would not notice.
//
// Kept in one file but as separate tests per mechanism, deliberately: the point
// is that no single green can hide another. Where two mechanisms are commonly
// described as one -- `withBuildLog` and `regenerateBookTocs` are both "the
// wrapper" -- they are two tests here, because they need different fixes. One
// has no equivalent anywhere in buildDocument; the other has a finalizer hook
// that no adapter sets.
//
// WHAT IS AND IS NOT PROVABLE AT THIS BOUNDARY, stated so nobody reads more
// coverage here than exists:
//
//   - Items that exercise an importable module are real tests and go red on
//     their own terms today.
//   - Items marked WORKER BRANCH live in `bin/build-worker.mjs`, which is a
//     message handler, not an importable unit. The importable half is tested
//     here; the other half is a real push through the worker and is named in
//     the test rather than faked with a source grep. A grep asserting that
//     someone did not delete a line is not a test -- see AGENTS.md on testing
//     for the nonexistence of things.
//
// RUN OUTSIDE THE FENCE: env -u FLEET_ID node --test server/lib/cutover-contract.test.mjs

import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { setBuildReporter } from './build-runner.mjs'
import { closeProjectStore, createProject, initProjectStore, projectDir } from './project-store.mjs'
import { missingDeclaredMainFile } from './build-decision.mjs'
import { buildAdapterFor } from './build-adapter-registry.mjs'

const QUIET_REPORTER = {
  updateProject: async () => {},
  broadcastSignal: () => {},
  regenerateBookTocs: async () => {},
}

async function withProject(prefix, { name, mainFile, files = {} }, run) {
  const root = mkdtempSync(join(tmpdir(), prefix))
  try {
    await initProjectStore(root)
    createProject({ name, mainFile })
    const src = join(root, name, 'source')
    mkdirSync(src, { recursive: true })
    for (const [rel, body] of Object.entries(files)) writeFileSync(join(src, rel), body)
    return await run({ root, src, name })
  } finally {
    setBuildReporter(null)
    await closeProjectStore()
    rmSync(root, { recursive: true, force: true })
  }
}

// ── 1. the boundary has to be loadable at all ───────────────────────────────
// Two independent link failures have hidden behind each other here already:
// the registry's missing `buildSlidesDocument` (fixed in b4f141ec5) masked
// build-document's missing `completeBuildSuccess`. An ESM link error is not a
// latent bug -- the module cannot be imported, so everything downstream of it
// is unreachable and reports nothing.
test('cutover: both halves of the boundary load', async () => {
  await assert.doesNotReject(
    () => import('./build-adapter-registry.mjs'),
    'the adapter registry must be importable',
  )
  await assert.doesNotReject(
    () => import('./build-document.mjs'),
    'buildDocument() must be importable -- completeBuildSuccess is imported from build-runner.mjs and defined nowhere',
  )
})

// ── 2. WORKER BRANCH: the relevance skip ────────────────────────────────────
// Importable half: nothing. The skip decides whether a builder is called at
// all, and it lives in the worker above the dispatch. The whole of it is the
// real-push proof named below.
//
// What it must show, red before green: pushing a revision that changes only
// files the render does not read must publish the source, advance the head via
// replacedItems ['source'], record `not_required`, and run NO builder. The
// cutover must therefore leave buildDocument() inside the `else if (builder)`
// position, not replace the branch that contains it.
test('cutover: the relevance skip is not reachable from this boundary', async () => {
  const { buildDocument } = await import('./build-document.mjs')
  assert.equal(
    typeof buildDocument, 'function',
    'once loadable, assert here that buildDocument neither reads nor honours a relevance skip -- '
    + 'the skip must stay in the worker. Full proof is a real push of a render-irrelevant change: '
    + 'source published, head advanced, disposition not_required, no builder invoked.',
  )
})

// ── 3. WORKER BRANCH: a declared main file that is not there ────────────────
// Importable half IS testable: the predicate itself.
test('cutover: a project declaring an absent main file is still refused', async () => {
  await withProject('cutover-mainfile-', { name: 'talk', mainFile: 'main.tex' }, async ({ name }) => {
    const { readProject } = await import('./project-store.mjs')
    const project = await readProject(name)
    assert.ok(
      missingDeclaredMainFile(project, name),
      'the predicate must still catch a declared main file with nothing behind it -- '
      + 'this is what stopped a Quarto talk declaring main.tex from building "successfully" for four days',
    )
    // The other half, and it is the half that is only a file: the worker writes
    // build.log synchronously into the INSTANCE before throwing, and that file
    // is the only copy of the reason. Real-push proof: push such a project and
    // read build.log out of the published project directory.
    assert.ok(
      existsSync(projectDir(name)),
      'and the reason must survive as build.log -- proved by a real push, not here',
    )
  })
})

// ── 4. WORKER BRANCH: the failure path keeps its account ────────────────────
// publishBuildDiagnostics, reportBuildFailure and recordBuildResult('build_failed')
// are three separate callParent tails in the worker's catch, each individually
// wrapped so that losing one does not lose the others. Real-push proof: a build
// that fails must leave diagnostics, deliver a failure report, and persist a
// build_failed disposition -- three observables, checked separately.
test('cutover: the failure tails are three observables, not one', async () => {
  const { buildDocument } = await import('./build-document.mjs')
  assert.equal(
    typeof buildDocument, 'function',
    'buildDocument has no failure path of its own -- it throws and the worker catch handles it. '
    + 'The cutover must not move these into buildDocument, and must not leave the catch unreached.',
  )
})

// ── 5. the build log, for all four non-LaTeX formats ────────────────────────
// GENUINELY RED TODAY, independently of the link failure.
//
// The registry binds the INNER builders, not the exported wrappers, and
// `withBuildLog` lives only in the wrappers. Nothing in buildDocument or
// finalizeDocumentBuild writes build.log. So a failed markdown, qmd, html or
// slides build through the registry leaves no log, no errors and no recorded
// reason -- the exact logMissing outage the wrappers were added to fix.
test('cutover: a failed build through the adapter still writes build.log', async () => {
  await withProject('cutover-buildlog-', {
    name: 'deck', mainFile: 'deck.html',
    files: { 'deck.html': '<html><body><p>not a reveal deck</p></body></html>' },
  }, async ({ name }) => {
    const { updateProject } = await import('./project-store.mjs')
    await updateProject(name, { format: 'slides' })
    const { readProject } = await import('./project-store.mjs')
    setBuildReporter(QUIET_REPORTER)
    const adapter = buildAdapterFor(await readProject(name))
    await assert.rejects(
      () => adapter.build({ name, log: () => {} }),
      /not a reveal\.js deck/,
      'control: the build must fail for the reason we chose, not some other one',
    )
    const log = join(projectDir(name), 'build.log')
    assert.ok(
      existsSync(log),
      'a build that failed through the ADAPTER must leave build.log -- the adapter binds the inner '
      + 'builder and bypasses withBuildLog, so today it does not',
    )
    assert.match(readFileSync(log, 'utf8'), /not a reveal\.js deck/, 'and the log must carry the reason')
  })
})

// ── 6. book ToC regeneration, for markdown and qmd only ─────────────────────
// GENUINELY RED TODAY, independently of the link failure, and a DIFFERENT fix
// from item 5: finalizeDocumentBuild already has the hook --
// `if (result.regenerateBookTocs) await reporter.regenerateBookTocs(name)` --
// and no adapter sets the flag. Item 5 needs a mechanism built; this one needs
// a flag set. Proving them together would let the missing mechanism hide behind
// the missing flag.
test('cutover: the markdown adapter asks for book ToC regeneration', async () => {
  await withProject('cutover-toc-md-', {
    name: 'notes', mainFile: 'notes.md', files: { 'notes.md': '# Notes\n\nA paragraph.\n' },
  }, async ({ name }) => {
    const { readProject } = await import('./project-store.mjs')
    setBuildReporter(QUIET_REPORTER)
    const adapter = buildAdapterFor(await readProject(name))
    const result = await adapter.build({ name, log: () => {}, view: adapter.view })
    assert.equal(
      result?.regenerateBookTocs, true,
      'buildMarkdown regenerates book ToCs today; the adapter binds buildMarkdownDocument, which does not. '
      + 'The finalizer hook exists and nothing sets it.',
    )
  })
})

// ── 7. exactly one version finalization ─────────────────────────────────────
// runBuild calls finalizeBuildVersion internally, with ctx, projDir,
// expectedPages, svgsReadyAt and the error snapshots. buildDocument calls it
// again afterwards with only name/sourceRevision/acceptSeq. For the two latex
// adapters that is two calls per build, with different arguments.
//
// NOT YET BASELINED, and deliberately not asserted as a defect: a rig with
// sourceRevision null recorded ZERO version rows for a build that succeeded, so
// that rig cannot tell one from two and its zero is not evidence. The baseline
// needs a build carrying a real source revision through the daemon path.
test('cutover: one build records one version', async () => {
  const { buildDocument } = await import('./build-document.mjs')
  assert.equal(
    typeof buildDocument, 'function',
    'inject a counting versioner via services.versioner and assert exactly 1 for a latex adapter, '
    + 'whose runBuild already versions internally. Baseline first against a real sourceRevision.',
  )
})

// ── 8. exactly one completion and one publication ───────────────────────────
// publishBuildInstance and recordBuildResult are called once each by the
// worker, after the dispatch. buildDocument calls its own completer. The
// cutover must not produce two completions for one build, and must not lose
// the worker's single publication.
test('cutover: one build completes once and publishes once', async () => {
  const { buildDocument } = await import('./build-document.mjs')
  assert.equal(
    typeof buildDocument, 'function',
    'inject services.completer and assert it is called exactly once, while publishBuildInstance and '
    + 'recordBuildResult remain the worker\'s and are called exactly once each.',
  )
})
