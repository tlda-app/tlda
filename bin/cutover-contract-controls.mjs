#!/usr/bin/env node
// The cutover contract, as controls that run against the REAL build worker.
//
// Written BEFORE the cutover. Some of these are expected RED -- they name
// outcomes production produces today that routing through `buildDocument()`
// would silently stop producing. Every one of them fails by simply not
// happening, which is why a green suite after the cutover would not notice.
//
// A SCRIPT rather than a `node --test` file, and ending in process.exit(0), for
// the same reason as `bin/a-latex-build-describes-itself-test.mjs` says: the
// build stack holds handles open and the runner hangs rather than reporting.
// Under `node --test` this took sixteen minutes when it finished at all, and
// twice it hung after the last control without ever printing a summary -- which
// looks exactly like a test that never ran.
//
// Running the controls in sequence in one process also removes the other thing
// that made those runs untrustworthy: the project store and sync rooms are
// module singletons, so controls sharing a project name interfered with each
// other. One control failed its own success precondition on a fixture that had
// succeeded moments earlier, and which control failed moved between runs.
//
// NO CONTROL HERE PROVES ONLY THAT A MODULE IMPORTS. An earlier version had
// four whose bodies asserted `typeof buildDocument === 'function'` and carried
// the real obligation in the assertion message. Those are placebos: red on the
// link error, green the moment the export exists, and asserting nothing about
// the behaviour they were named for.
//
// RUN OUTSIDE THE FENCE: env -u FLEET_ID node bin/cutover-contract-controls.mjs

import assert from 'node:assert/strict'
import { fork } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const { setBuildReporter } = await import('../server/lib/build-runner.mjs')
const {
  closeProjectStore, createProject, initProjectStore, outputDir, projectDir, readProject,
  sourceLifecycleStore, updateProject,
} = await import('../server/lib/project-store.mjs')
const { missingDeclaredMainFile } = await import('../server/lib/build-decision.mjs')
const { buildAdapterFor } = await import('../server/lib/build-adapter-registry.mjs')
const { publishBuildInstance, PUBLISH_REPLACED_ITEMS } = await import('../server/lib/build-dispatch.mjs')
const { initSyncRooms } = await import('../server/lib/sync-rooms.mjs')
const { listVersions } = await import('../server/lib/shadow-repo.mjs')

const WORKER = new URL('./build-worker.mjs', import.meta.url).pathname
const QUIET_REPORTER = { updateProject: async () => {}, broadcastSignal: () => {}, regenerateBookTocs: async () => {} }

/**
 * Fork the real build worker for one build and record everything it asks the
 * parent to do.
 *
 * Counts, not presence: "publishes once" has to fail if the cutover publishes
 * twice, and a presence check would pass just as happily.
 *
 * `publishBuildInstance` is PERFORMED, not stubbed, and with the same
 * `pReplaced || PUBLISH_REPLACED_ITEMS` normalization `build-dispatch.mjs` does
 * when it relays this RPC. Both mattered:
 *   - stubbed, the first build's `relevant-files.json` never left the instance,
 *     so the next build read `no-relevant-files-yet` and rendered -- a filter
 *     that could never say no;
 *   - un-normalized, a `null` argument does not trigger a default parameter and
 *     it threw "replacedItems is not iterable", which read as every successful
 *     build failing to publish.
 */
function runWorker({ projectsDir, name, sourceRevision, acceptSeq = 1 }) {
  return new Promise((resolve, reject) => {
    const calls = []
    const child = fork(WORKER, { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] })
    const cap = setTimeout(() => { child.kill(); reject(new Error('worker did not finish in 180s')) }, 180_000)
    // Resolve on the child's EXIT, not on its `done` message.
    //
    // `done` says the build finished; it does not say the process and its git
    // grandchildren are gone. Resolving there let the next control start while
    // the previous worker was still shutting down, and the shadow-repo bootstrap
    // then failed on `git config user.name` -- surfacing as "the build must
    // succeed" against a fixture that had succeeded moments before.
    //
    // I first tried to fix this by never deleting the temp roots. That was a
    // guess about which resource was contended and it did not hold: a control
    // still flaked with every root preserved. Waiting for the process is the
    // actual ordering guarantee, so the roots are cleaned up again.
    let finished = null
    child.on('exit', () => { clearTimeout(cap); if (finished) resolve(finished) })
    child.on('message', msg => {
      if (msg?.t === 'rpc') {
        calls.push({ method: msg.m, args: msg.a })
        const answer = msg.m === 'publishBuildInstance'
          ? publishBuildInstance(msg.a[0], msg.a[1], msg.a[2], msg.a[3], msg.a[4], msg.a[5] || PUBLISH_REPLACED_ITEMS)
          : Promise.resolve(null)
        answer
          .then(result => child.send({ t: 'rpc-result', id: msg.id, ok: true, result }))
          .catch(e => child.send({ t: 'rpc-result', id: msg.id, ok: false, error: e?.message || String(e) }))
        return
      }
      if (msg?.t === 'done') { finished = { calls, ok: msg.ok, error: msg.error } }
    })
    child.on('error', e => { clearTimeout(cap); reject(e) })
    child.send({ t: 'build', kind: 'build', name, projectsDir, sourceRevision, acceptSeq })
  })
}

const callsTo = (calls, method) => calls.filter(c => c.method === method)

/** A project with a real accepted revision, which is what the worker requires. */
async function stagedProject(prefix, { name, mainFile, format, files }) {
  const root = mkdtempSync(join(tmpdir(), prefix))
  await initProjectStore(root)
  // The parent performs the publication, and publishing touches sync rooms.
  // Without this the publish RPC throws and the worker faithfully reports a
  // failed build -- a rig fault that reads exactly like a broken build path.
  initSyncRooms(root)
  createProject({ name, mainFile, ...(format ? { format } : {}) })
  const src = join(root, name, 'source')
  mkdirSync(src, { recursive: true })
  for (const [rel, body] of Object.entries(files)) writeFileSync(join(src, rel), body)
  const git = await (await sourceLifecycleStore(name)).gitRepository()
  const revision = await git.acceptRevision({
    project: name,
    files: Object.entries(files).map(([path, content]) => ({ path, content })),
    message: 'staged for a cutover control',
  })
  return { root, name, revision, git }
}

const results = []
async function control(label, expectation, run) {
  const t0 = Date.now()
  let root = null
  try {
    root = await run()
    results.push({ label, expectation, status: 'PASS', detail: '' })
  } catch (e) {
    root = e.root || root
    results.push({ label, expectation, status: 'FAIL', detail: (e?.message || String(e)).replace(/\s+/g, ' ').slice(0, 400) })
  } finally {
    setBuildReporter(null)
    try { await closeProjectStore() } catch { /* a control that failed early may have no store */ }
    if (typeof root === 'string') rmSync(root, { recursive: true, force: true })
    process.stdout.write(`  ${results.at(-1).status.padEnd(4)} ${label}  (${((Date.now() - t0) / 1000).toFixed(1)}s)\n`)
  }
}

// ── 1. the boundary has to be loadable at all ───────────────────────────────
// Two independent link failures have already hidden behind each other: the
// registry's missing `buildSlidesDocument` (fixed in b4f141ec5) masked
// build-document's missing `completeBuildSuccess`. An ESM link error is not a
// latent bug -- the module cannot be imported, so everything downstream of it
// is unreachable and reports nothing.
await control('both halves of the boundary load', 'RED until the cutover', async () => {
  await import('../server/lib/build-adapter-registry.mjs')
  await import('../server/lib/build-document.mjs')
  return null
})

// ── 2. a failed adapter build still writes build.log ────────────────────────
// The registry binds the INNER builders; `withBuildLog` lives only in the
// exported wrappers, and nothing in buildDocument or finalizeDocumentBuild
// writes a build log. So a failed markdown, qmd, html or slides build through
// the adapter leaves no log, no errors and no recorded reason -- the exact
// logMissing outage those wrappers were added to fix.
await control('a failed adapter build writes build.log', 'RED until the cutover', async () => {
  const root = mkdtempSync(join(tmpdir(), 'cutover-buildlog-'))
  await initProjectStore(root)
  createProject({ name: 'deck', mainFile: 'deck.html' })
  mkdirSync(join(root, 'deck', 'source'), { recursive: true })
  writeFileSync(join(root, 'deck', 'source', 'deck.html'), '<html><body><p>not a reveal deck</p></body></html>')
  await updateProject('deck', { format: 'slides' })
  setBuildReporter(QUIET_REPORTER)
  const adapter = buildAdapterFor(await readProject('deck'))
  await assert.rejects(() => adapter.build({ name: 'deck', log: () => {} }), /not a reveal\.js deck/,
    'control: the build must fail for the reason we chose')
  const log = join(projectDir('deck'), 'build.log')
  if (!existsSync(log)) throw Object.assign(new Error('OBSERVABLE build.log: absent (adapter bypasses withBuildLog)'), { root })
  assert.match(readFileSync(log, 'utf8'), /not a reveal\.js deck/, 'build.log must carry the reason')
  return root
})

// ── 3. book ToC regeneration, markdown and qmd only ─────────────────────────
// A DIFFERENT fix from control 2: finalizeDocumentBuild already has the hook,
// `if (result.regenerateBookTocs)`, and no adapter sets the flag. One needs a
// mechanism built, the other needs a flag set. Together, the missing mechanism
// would hide behind the missing flag.
await control('the markdown adapter asks for book ToC regeneration', 'RED until the cutover', async () => {
  const root = mkdtempSync(join(tmpdir(), 'cutover-toc-'))
  await initProjectStore(root)
  createProject({ name: 'notes', mainFile: 'notes.md' })
  mkdirSync(join(root, 'notes', 'source'), { recursive: true })
  writeFileSync(join(root, 'notes', 'source', 'notes.md'), '# Notes\n\nA paragraph.\n')
  setBuildReporter(QUIET_REPORTER)
  const adapter = buildAdapterFor(await readProject('notes'))
  const result = await adapter.build({ name: 'notes', log: () => {}, view: adapter.view })
  if (result?.regenerateBookTocs !== true) {
    throw Object.assign(new Error(`OBSERVABLE result.regenerateBookTocs: ${JSON.stringify(result?.regenerateBookTocs)}, want true`), { root })
  }
  return root
})

// ── 4. the declared-main predicate, as a predicate ──────────────────────────
await control('the declared-main predicate refuses an absent main file', 'GREEN, must stay green', async () => {
  const root = mkdtempSync(join(tmpdir(), 'cutover-predicate-'))
  await initProjectStore(root)
  createProject({ name: 'talk', mainFile: 'main.tex' })
  assert.ok(missingDeclaredMainFile(await readProject('talk'), 'talk'),
    'the predicate must catch a declared main file with nothing behind it')
  return root
})

// ── 5. REAL WORKER: the failure tails ───────────────────────────────────────
// Three separate callParent invocations in the worker's catch, each
// individually wrapped so losing one does not lose the others. Counted
// separately for that reason.
await control('a failed build records diagnostics, a report and one build_failed', 'GREEN, must stay green', async () => {
  const { root, name, revision } = await stagedProject('cutover-tails-', {
    name: 'talk', mainFile: 'main.tex', files: { 'notes.md': 'no main.tex anywhere' },
  })
  const { calls, ok } = await runWorker({ projectsDir: root, name, sourceRevision: revision })
  assert.equal(ok, false, 'control: this build must fail, or the tails are not being exercised')
  assert.equal(callsTo(calls, 'publishBuildDiagnostics').length, 1, 'OBSERVABLE publishBuildDiagnostics count')
  assert.equal(callsTo(calls, 'reportBuildFailure').length, 1, 'OBSERVABLE reportBuildFailure count')
  const results_ = callsTo(calls, 'recordBuildResult')
  assert.equal(results_.length, 1, 'OBSERVABLE recordBuildResult count')
  assert.equal(results_[0].args[3], 'build_failed', 'OBSERVABLE disposition')
  const updates = callsTo(calls, 'updateProject')
  assert.equal(updates.length, 1, 'OBSERVABLE updateProject count')
  assert.equal(updates[0].args[1].buildStatus, 'error', 'OBSERVABLE buildStatus')
  assert.equal(callsTo(calls, 'publishBuildInstance').length, 0,
    'OBSERVABLE publications on failure: must be 0 so the last good render stays published')
  return root
})

// ── 6. REAL WORKER: the relevance skip ──────────────────────────────────────
// A LaTeX project, NOT markdown, and that is a fact about the system rather
// than a fixture preference: `shouldBuildOnPush` returns `format-eager` for
// markdown, html, slides and qmd BEFORE it reaches the relevant-files filter,
// so `outside-tree` -- the only verdict the worker treats as a skip -- is
// reachable on the svg path alone. Three earlier attempts at this control used
// a markdown fixture and could never have skipped.
const TEX = '\\documentclass{article}\n\\begin{document}\nOne page of prose.\n\\end{document}\n'
await control('a render-irrelevant revision publishes source only and records not_required', 'GREEN, must stay green', async () => {
  const { root, name, revision, git } = await stagedProject('cutover-skip-', {
    name: 'paper-skip', mainFile: 'main.tex',
    files: { 'main.tex': TEX, 'notes.txt': 'first notes, never read by the render' },
  })
  const first = await runWorker({ projectsDir: root, name, sourceRevision: revision })
  assert.equal(first.ok, true,
    `control: the first build must render, or there is no relevant-files.json to filter against (${first.error || 'no error reported'})`)
  assert.ok(existsSync(join(outputDir(name), 'relevant-files.json')),
    'control: the filter has to have something to read, or the verdict is no-relevant-files-yet and everything renders')

  // An ADDED file is treated as relevant, correctly, so the stimulus is an EDIT
  // to an existing file the render never reads.
  const irrelevant = await git.acceptRevision({
    project: name, parent: revision,
    files: [{ path: 'main.tex', content: TEX }, { path: 'notes.txt', content: 'CHANGED, still never read' }],
    message: 'edit outside the render tree',
  })
  const { calls } = await runWorker({ projectsDir: root, name, sourceRevision: irrelevant, acceptSeq: 2 })
  const published = callsTo(calls, 'publishBuildInstance')
  assert.equal(published.length, 1, 'OBSERVABLE publication count')
  assert.deepEqual(published[0].args[5], ['source'], 'OBSERVABLE replacedItems')
  const results_ = callsTo(calls, 'recordBuildResult')
  assert.equal(results_.length, 1, 'OBSERVABLE recordBuildResult count')
  assert.equal(results_[0].args[3], 'not_required', 'OBSERVABLE disposition')
  return root
})

// ── 7. REAL WORKER: one build, one version ──────────────────────────────────
// Against a REAL accepted source revision. An earlier rig passed
// `sourceRevision: null` and counted ZERO version rows for a build that
// SUCCEEDED -- a rig that could not tell one from two, whose zero was not
// evidence of anything.
//
// runBuild already calls finalizeBuildVersion internally; buildDocument would
// call it again afterwards with different arguments.
await control('one successful build records exactly one version', 'GREEN, must stay green', async () => {
  const { root, name, revision } = await stagedProject('cutover-version-', {
    name: 'paper-version', mainFile: 'main.md', format: 'markdown', files: { 'main.md': '# Paper\n\nProse.\n' },
  })
  const before = (await listVersions(name, { limit: 50 })).length
  const { ok, error } = await runWorker({ projectsDir: root, name, sourceRevision: revision })
  assert.equal(ok, true, `control: the build must succeed, or a version count is meaningless (${error || ''})`)
  const after = (await listVersions(name, { limit: 50 })).length
  assert.equal(after - before, 1, `OBSERVABLE versions recorded: ${after - before}`)
  return root
})

// ── 8. REAL WORKER: one completion, one publication ─────────────────────────
await control('one successful build publishes once and records one built disposition', 'GREEN, must stay green', async () => {
  const { root, name, revision } = await stagedProject('cutover-once-', {
    name: 'paper-once', mainFile: 'main.md', format: 'markdown', files: { 'main.md': '# Paper\n\nProse.\n' },
  })
  const { calls, ok, error } = await runWorker({ projectsDir: root, name, sourceRevision: revision })
  assert.equal(ok, true, `control: the build must succeed (${error || ''})`)
  assert.equal(callsTo(calls, 'publishBuildInstance').length, 1, 'OBSERVABLE publication count')
  const results_ = callsTo(calls, 'recordBuildResult')
  assert.equal(results_.length, 1, 'OBSERVABLE recordBuildResult count')
  assert.equal(results_[0].args[3], 'built', 'OBSERVABLE disposition')
  assert.equal(callsTo(calls, 'publishBuildDiagnostics').length, 0, 'OBSERVABLE diagnostics on success: must be 0')
  return root
})

console.log('\n──────────────────────────────────────────────────────────────')
for (const r of results) {
  console.log(`${r.status.padEnd(4)}  ${r.label}`)
  console.log(`      expected: ${r.expectation}${r.detail ? `\n      got: ${r.detail}` : ''}`)
}
const red = results.filter(r => r.status === 'FAIL').length
console.log(`\n${results.length - red} pass, ${red} fail`)
process.exit(0)
