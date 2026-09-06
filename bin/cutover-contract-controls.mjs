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
const { buildDocument } = await import('../server/lib/build-document.mjs')
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
  const root = trackTemp(prefix)
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

// ── classification ──────────────────────────────────────────────────────────
//
// An earlier version of this script caught every exception and then exited 0
// unconditionally. It could not fail anything: a control that broke for a
// reason nobody anticipated printed FAIL and the gate still reported success.
// That is the shape this repository warns about -- a check that cannot go red
// -- and it was in the gate itself.
//
// So outcomes are now classified, and the exit code is the classification.

/**
 * Is this the known 5-second exec timeout in `shadow-repo.mjs`?
 *
 * EXACT signature only. Measured across 800 invocations of
 * `git rev-parse --verify HEAD 2>/dev/null || true` in a bare temp repo, no
 * build involved: 22/400 and 9/400 failed, and every single failure was
 * `{ killed: true, signal: 'SIGTERM', code: null, stderr: '' }`.
 *
 * That command ends in `|| true` and so cannot exit non-zero on its own
 * merits, which is what identifies the kill as the timeout rather than as git
 * disagreeing with us. `shadow-repo.mjs` has 33 `execAsync(..., { timeout:
 * 5000 })` call sites.
 *
 * Anything that does not match exactly is NOT environment. A near miss -- a
 * different signal, a real exit code, any stderr at all -- is a genuine
 * failure and must not be laundered into "the box was busy".
 */
export function classifyExecFailure(e) {
  return e?.killed === true && e?.signal === 'SIGTERM' && e?.code === null && e?.stderr === ''
    ? 'ENVIRONMENT'
    : null
}

/**
 * What does an outcome mean, given what the control expected?
 *
 * BASELINE-RED  expected to fail before the cutover, and it did
 * GREEN         expected to hold, and it does
 * ENVIRONMENT   the known timeout; the run proves nothing either way
 * RESOLVED      expected to fail and it PASSED -- the obligation is satisfied.
 *               Not a silent success: the cutover commit flips the expectation,
 *               and until it does this must stop the gate.
 * UNEXPECTED    anything else, including a GREEN baseline that broke
 */
export function categorize({ expect, passed, environment, reasonMatched }) {
  if (environment) return 'ENVIRONMENT'
  if (expect === 'RED') {
    if (passed) return 'RESOLVED'
    // A red control that fails for the WRONG reason is not the baseline. Until
    // this existed, any exception at all inside an `expect: 'RED'` control
    // counted as the intended failure -- so a typo, an import error, or the
    // shadow-repo timeout would all have been reported as "the obligation is
    // still outstanding, as expected". The gate would have looked identical
    // whether or not it was measuring anything.
    return reasonMatched ? 'BASELINE-RED' : 'WRONG-REASON'
  }
  return passed ? 'GREEN' : 'UNEXPECTED'
}

const OK_CATEGORIES = new Set(['BASELINE-RED', 'GREEN'])
const EXIT = { OK: 0, ENVIRONMENT: 2, UNEXPECTED: 3, SELFTEST: 4, CLEANUP: 5 }

// Every mkdtemp root this process creates, so cleanup is an asserted observable
// rather than a hope. `stagedProject` and the inline controls both register
// here, and the end of the run proves none survive.
const tempRoots = []
const trackTemp = prefix => { const root = mkdtempSync(join(tmpdir(), prefix)); tempRoots.push(root); return root }

const results = []
/**
 * @param expect 'RED' | 'GREEN'
 * @param because for a RED control, the failure it is REQUIRED to produce.
 *   Failing for any other reason is WRONG-REASON, not the baseline. Optional
 *   for GREEN, which has nothing to match -- it either holds or it does not.
 */
async function control(label, expect, because, run) {
  const t0 = Date.now()
  let passed = false
  let environment = false
  let detail = ''
  let reasonMatched = true
  try {
    await run()
    passed = true
  } catch (e) {
    environment = classifyExecFailure(e) === 'ENVIRONMENT'
    detail = (e?.message || String(e)).replace(/\s+/g, ' ').slice(0, 400)
    reasonMatched = expect === 'RED' ? Boolean(because?.test(detail)) : true
  } finally {
    setBuildReporter(null)
    try { await closeProjectStore() } catch { /* a control that failed early may have no store */ }
    const category = categorize({ expect, passed, environment, reasonMatched })
    results.push({ label, expect, category, detail, because: because?.source })
    process.stdout.write(`  ${category.padEnd(12)} ${label}  (${((Date.now() - t0) / 1000).toFixed(1)}s)\n`)
  }
}

// ── the classifier's own controls, before anything else runs ────────────────
//
// A classifier that never rejects would relabel every genuine failure as
// "the box was busy", which is worse than not classifying at all. So it is
// tested here with one positive and a row of NEAR MISSES -- each differing
// from the real signature in exactly one field. If any of these is wrong the
// script exits before running a single control, because nothing it reported
// afterwards could be trusted.
const ENV_SIGNATURE = { killed: true, signal: 'SIGTERM', code: null, stderr: '' }
const CLASSIFIER_CASES = [
  ['the measured signature', ENV_SIGNATURE, 'ENVIRONMENT'],
  ['near miss: not killed', { ...ENV_SIGNATURE, killed: false }, null],
  ['near miss: SIGKILL', { ...ENV_SIGNATURE, signal: 'SIGKILL' }, null],
  ['near miss: a real exit code', { ...ENV_SIGNATURE, code: 1, signal: null }, null],
  ['near miss: git said something', { ...ENV_SIGNATURE, stderr: 'fatal: not a git repository' }, null],
  ['near miss: killed field absent', { signal: 'SIGTERM', code: null, stderr: '' }, null],
  ['near miss: stderr absent', { killed: true, signal: 'SIGTERM', code: null }, null],
  ['an ordinary assertion failure', new Error('OBSERVABLE build.log: absent'), null],
]
const CATEGORY_CASES = [
  ['expected red, failed for its stated reason', { expect: 'RED', passed: false, environment: false, reasonMatched: true }, 'BASELINE-RED'],
  ['expected red, failed for the WRONG reason', { expect: 'RED', passed: false, environment: false, reasonMatched: false }, 'WRONG-REASON'],
  ['expected red, PASSED', { expect: 'RED', passed: true, environment: false, reasonMatched: false }, 'RESOLVED'],
  ['expected green, passed', { expect: 'GREEN', passed: true, environment: false, reasonMatched: true }, 'GREEN'],
  ['expected green, FAILED', { expect: 'GREEN', passed: false, environment: false, reasonMatched: true }, 'UNEXPECTED'],
  ['environment beats a red expectation', { expect: 'RED', passed: false, environment: true, reasonMatched: true }, 'ENVIRONMENT'],
  ['environment beats a wrong-reason red', { expect: 'RED', passed: false, environment: true, reasonMatched: false }, 'ENVIRONMENT'],
  ['environment beats a green expectation', { expect: 'GREEN', passed: false, environment: true, reasonMatched: true }, 'ENVIRONMENT'],
]
{
  const failures = []
  for (const [label, input, want] of CLASSIFIER_CASES) {
    const got = classifyExecFailure(input)
    if (got !== want) failures.push(`classifyExecFailure(${label}) = ${got}, want ${want}`)
  }
  for (const [label, input, want] of CATEGORY_CASES) {
    const got = categorize(input)
    if (got !== want) failures.push(`categorize(${label}) = ${got}, want ${want}`)
  }
  if (failures.length) {
    console.error('classifier self-test FAILED:\n  ' + failures.join('\n  '))
    process.exit(EXIT.SELFTEST)
  }
  console.log(`classifier self-test: ${CLASSIFIER_CASES.length} classifier cases, ${CATEGORY_CASES.length} category cases, all correct\n`)
}

// ── 1. the boundary has to be loadable at all ───────────────────────────────
// Two independent link failures have already hidden behind each other: the
// registry's missing `buildSlidesDocument` (fixed in b4f141ec5) masked
// build-document's missing `completeBuildSuccess`. An ESM link error is not a
// latent bug -- the module cannot be imported, so everything downstream of it
// is unreachable and reports nothing.
await control('both halves of the boundary load', 'GREEN', null, async () => {
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
// Through `buildDocument()`, which is the path production takes -- not through
// `adapter.build()` directly. Calling the adapter would test a component that
// never runs on its own; the log belongs to the boundary, because binding the
// inner builders is what bypassed the wrappers that used to write it.
await control('a failed build through the boundary writes build.log', 'GREEN', null, async () => {
  const root = trackTemp('cutover-buildlog-')
  await initProjectStore(root)
  createProject({ name: 'deck', mainFile: 'deck.html' })
  mkdirSync(join(root, 'deck', 'source'), { recursive: true })
  writeFileSync(join(root, 'deck', 'source', 'deck.html'), '<html><body><p>not a reveal deck</p></body></html>')
  await updateProject('deck', { format: 'slides' })
  setBuildReporter(QUIET_REPORTER)
  const project = await readProject('deck')
  await assert.rejects(
    () => buildDocument(project, { name: 'deck', sourceRevision: null, acceptSeq: 1, reporter: QUIET_REPORTER, log: () => {} }),
    /not a reveal\.js deck/,
    'control: the build must fail for the reason we chose',
  )
  const log = join(projectDir('deck'), 'build.log')
  if (!existsSync(log)) throw Object.assign(new Error('OBSERVABLE build.log: absent'), { root })
  assert.match(readFileSync(log, 'utf8'), /not a reveal\.js deck/, 'build.log must carry the reason')
})

// ── 2b. a SUCCESSFUL build's log carries the builder's own output ───────────
//
// The failing-build control above is not enough, and believing it was cost a
// live defect. `withBuildLog` appends the error to its own `lines` in the
// catch, so a failed build's `build.log` has content whether or not the
// builder's output was ever captured. Only a SUCCESSFUL build proves the wire.
//
// It was broken exactly there: `buildDocument` built `run` as a zero-argument
// arrow, so the wrapper's `addLog` went nowhere and the adapter kept logging to
// the console. A successful markdown build wrote a ONE BYTE log -- a newline --
// and every check that asked "is there a build.log" passed.
//
// So this asserts the builder's OWN lines, by content. Size and existence are
// exactly the two things that did not distinguish the broken state.
await control('a successful build log carries the builder\'s own output', 'GREEN', null, async () => {
  const { root, name, revision } = await stagedProject('cutover-successlog-', {
    name: 'paper-log', mainFile: 'main.md', format: 'markdown',
    files: { 'main.md': '# Paper\n\nProse enough to index.\n' },
  })
  const { ok, error } = await runWorker({ projectsDir: root, name, sourceRevision: revision })
  assert.equal(ok, true, `control: the build must SUCCEED -- a failed build's log proves nothing here (${error || ''})`)
  const log = join(projectDir(name), 'build.log')
  assert.ok(existsSync(log), 'OBSERVABLE build.log: absent')
  const text = readFileSync(log, 'utf8')
  assert.match(text, /\[markdown\] Reading /, 'OBSERVABLE build.log content: the builder\'s read line')
  assert.match(text, /\[markdown\] paper-log: indexed \d+ column/, 'OBSERVABLE build.log content: the builder\'s index line')
})

// ── 3. book ToC regeneration, markdown and qmd only ─────────────────────────
// A DIFFERENT fix from control 2: finalizeDocumentBuild already has the hook,
// `if (result.regenerateBookTocs)`, and no adapter sets the flag. One needs a
// mechanism built, the other needs a flag set. Together, the missing mechanism
// would hide behind the missing flag.
await control('the markdown adapter asks for book ToC regeneration', 'GREEN', null, async () => {
  const root = trackTemp('cutover-toc-')
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
})

// ── 4. the declared-main predicate, as a predicate ──────────────────────────
await control('the declared-main predicate refuses an absent main file', 'GREEN', null, async () => {
  const root = trackTemp('cutover-predicate-')
  await initProjectStore(root)
  createProject({ name: 'talk', mainFile: 'main.tex' })
  assert.ok(missingDeclaredMainFile(await readProject('talk'), 'talk'),
    'the predicate must catch a declared main file with nothing behind it')
})

// ── 5. REAL WORKER: the failure tails ───────────────────────────────────────
// Three separate callParent invocations in the worker's catch, each
// individually wrapped so losing one does not lose the others. Counted
// separately for that reason.
await control('a failed build records diagnostics, a report and one build_failed', 'GREEN', null, async () => {
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
})

// ── 6. REAL WORKER: the relevance skip ──────────────────────────────────────
// A LaTeX project, NOT markdown, and that is a fact about the system rather
// than a fixture preference: `shouldBuildOnPush` returns `format-eager` for
// markdown, html, slides and qmd BEFORE it reaches the relevant-files filter,
// so `outside-tree` -- the only verdict the worker treats as a skip -- is
// reachable on the svg path alone. Three earlier attempts at this control used
// a markdown fixture and could never have skipped.
const TEX = '\\documentclass{article}\n\\begin{document}\nOne page of prose.\n\\end{document}\n'
await control('a render-irrelevant revision publishes source only and records not_required', 'GREEN', null, async () => {
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
})

// ── 7. REAL WORKER: one build, one version ──────────────────────────────────
// Against a REAL accepted source revision. An earlier rig passed
// `sourceRevision: null` and counted ZERO version rows for a build that
// SUCCEEDED -- a rig that could not tell one from two, whose zero was not
// evidence of anything.
//
// runBuild already calls finalizeBuildVersion internally; buildDocument would
// call it again afterwards with different arguments.
await control('one successful build records exactly one version', 'GREEN', null, async () => {
  const { root, name, revision } = await stagedProject('cutover-version-', {
    name: 'paper-version', mainFile: 'main.md', format: 'markdown', files: { 'main.md': '# Paper\n\nProse.\n' },
  })
  const before = (await listVersions(name, { limit: 50 })).length
  const { ok, error } = await runWorker({ projectsDir: root, name, sourceRevision: revision })
  assert.equal(ok, true, `control: the build must succeed, or a version count is meaningless (${error || ''})`)
  const after = (await listVersions(name, { limit: 50 })).length
  assert.equal(after - before, 1, `OBSERVABLE versions recorded: ${after - before}`)
})

// ── 8. REAL WORKER: one completion, one publication ─────────────────────────
await control('one successful build publishes once and records one built disposition', 'GREEN', null, async () => {
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
})

// ── cleanup, as an asserted observable ──────────────────────────────────────
// Every mkdtemp root this process made is removed here and then PROVED gone.
// Cleanup that is merely attempted is indistinguishable from cleanup that
// silently failed, and this script creates a store, a git repo and build
// instances under each root.
const survivors = []
for (const root of tempRoots) {
  try { rmSync(root, { recursive: true, force: true }) } catch { /* reported below by the existence check */ }
  if (existsSync(root)) survivors.push(root)
}

console.log('\n──────────────────────────────────────────────────────────────')
for (const r of results) {
  console.log(`${r.category.padEnd(12)}  ${r.label}`)
  console.log(`              expected ${r.expect}${r.because ? ` because /${r.because}/` : ''}`
    + `${r.detail ? `\n              got: ${r.detail}` : ''}`)
}

const counts = results.reduce((acc, r) => ({ ...acc, [r.category]: (acc[r.category] || 0) + 1 }), {})
console.log('\n' + Object.entries(counts).map(([k, v]) => `${k}: ${v}`).join('   '))
console.log(`temp roots created: ${tempRoots.length}, surviving: ${survivors.length}`)

const environment = results.filter(r => r.category === 'ENVIRONMENT')
const unexpected = results.filter(r => !OK_CATEGORIES.has(r.category) && r.category !== 'ENVIRONMENT')

if (survivors.length) {
  console.error(`\nFAILED: ${survivors.length} temp root(s) survived cleanup:\n  ${survivors.join('\n  ')}`)
  process.exit(EXIT.CLEANUP)
}
if (unexpected.length) {
  console.error(`\nFAILED: ${unexpected.length} outcome(s) not as expected.`
    + `\n  RESOLVED     a red obligation now holds -- the cutover commit flips its expectation; not a silent pass.`
    + `\n  WRONG-REASON a red control failed, but NOT for the failure it declared. It is not measuring what it names.`
    + `\n  UNEXPECTED   a green baseline broke.`)
  process.exit(EXIT.UNEXPECTED)
}
if (environment.length) {
  console.error(`\nINCONCLUSIVE: ${environment.length} control(s) hit the known 5s shadow-repo exec timeout.`
    + ` This run proves nothing either way -- re-run on a quieter host.`)
  process.exit(EXIT.ENVIRONMENT)
}
console.log('\nAll outcomes as expected.')
process.exit(EXIT.OK)
