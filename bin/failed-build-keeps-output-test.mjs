// A failed build must leave the previously published output exactly as it was.
//
// The wire, not the two ends: this forks the REAL build worker and services its
// RPCs with the REAL publishBuildInstance, because the destruction happens when
// a builder's verdict crosses IPC and is read as success. A test that called the
// builder and the publisher from one process would prove both and miss the only
// part that can be wrong -- which is how this shipped.
//
// Both halves run the same fixture and differ in ONE thing: whether a declared
// document root exists. A check that only ever saw the failing case could not
// tell "the failed build was refused" from "nothing publishes at all", so the
// second half asserts a good build still replaces the render.
import assert from 'node:assert/strict'
import { fork } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  closeProjectStore, createProject, initProjectStore, outputDir,
  sourceLifecycleStore, updateProject,
} from '../server/lib/project-store.mjs'
import { PUBLISH_REPLACED_ITEMS, publishBuildDiagnostics, publishBuildInstance } from '../server/lib/build-dispatch.mjs'

const NAME = 'disposable-book'
const GOOD_HTML = '<html><head><title>Good</title></head><body><h1>THE LAST GOOD RENDER</h1></body></html>'
const GOOD_PAGE_INFO = [{ file: 'index.html', width: 800, height: 1200, title: 'Good', format: 'qmd' }]
const QMD = '---\ntitle: Good\n---\n\nThe last good render.\n'

/**
 * @param {string[]} documentRoots — what the project declares it renders.
 *   `mainFile` exists in both halves, so `missingDeclaredMainFile` passes and the
 *   verdict is made inside the builder, which is where the defect is.
 */
async function runBuild(documentRoots) {
  const root = mkdtempSync(join(tmpdir(), 'tlda-failed-build-output-'))
  await initProjectStore(root)
  createProject({ name: NAME, mainFile: 'index.qmd', format: 'qmd' })
  await updateProject(NAME, { documentRoots, pages: 1 })

  // The previously published render: what must survive a failed build.
  const live = outputDir(NAME)
  mkdirSync(live, { recursive: true })
  writeFileSync(join(live, 'index.html'), GOOD_HTML)
  writeFileSync(join(live, 'page-info.json'), JSON.stringify(GOOD_PAGE_INFO))
  writeFileSync(join(live, 'relevant-files.json'), JSON.stringify({ files: ['index.qmd'] }))

  const git = await (await sourceLifecycleStore(NAME)).gitRepository()
  const base = await git.acceptRevision({
    project: NAME, files: [{ path: 'index.qmd', content: QMD }], message: 'base',
  })
  await git.advanceHead(NAME, base, null)
  const proposal = await git.acceptRevision({
    project: NAME, parent: base,
    files: [{ path: 'index.qmd', content: `${QMD}\nEdited.\n` }],
    message: 'edit',
  })

  const child = fork(new URL('./build-worker.mjs', import.meta.url), [], {
    stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
  })
  const seen = []
  child.on('message', async (message) => {
    if (message?.t !== 'rpc') return
    seen.push({ method: message.m, args: message.a })
    // The real publisher, not a stub. Whether the live render survives is a
    // fact about what this function does to disk, so stubbing it would answer
    // a question nobody asked.
    let result = {}
    try {
      if (message.m === 'publishBuildInstance') {
        // Exactly what the real dispatcher does, and the `|| PUBLISH_REPLACED_ITEMS`
        // is load-bearing: IPC is JSON, so the worker's omitted set arrives as
        // `null` and never reaches the signature's default. Spreading the args
        // raw made this throw `replacedItems is not iterable`, which routed the
        // build into the failure path and made today's code look like it kept
        // the render. A harness that fails is not a system that passed.
        const [pName, pRevision, pSeq, pInstance, pReports, pReplaced] = message.a || []
        result = await publishBuildInstance(
          pName, pRevision, pSeq, pInstance, pReports, pReplaced || PUBLISH_REPLACED_ITEMS)
      }
      else if (message.m === 'publishBuildDiagnostics') result = publishBuildDiagnostics(...message.a)
      else if (message.m === 'updateProject') result = await updateProject(...message.a)
      child.send({ t: 'rpc-result', id: message.id, ok: true, result })
    } catch (e) {
      child.send({ t: 'rpc-result', id: message.id, ok: false, error: e?.message || String(e) })
    }
  })
  child.send({ t: 'build', name: NAME, projectsDir: root, kind: 'build', sourceRevision: proposal, acceptSeq: 2 })
  await new Promise((resolve) => child.once('exit', resolve))

  const read = (path) => (existsSync(path) ? readFileSync(path, 'utf8') : null)
  const published = {
    pageInfo: read(join(live, 'page-info.json')),
    indexHtml: read(join(live, 'index.html')),
  }
  const buildLog = read(join(root, NAME, 'build.log'))
  await closeProjectStore()
  return { seen, published, buildLog }
}

// A build that cannot render what the project declares. `index.qmd` is present,
// so this is not the missing-main refusal in the worker -- the builder itself
// decides it has nothing to render, which is the verdict that used to reach the
// publisher as success.
const failed = await runBuild(['index.qmd', 'chapter-that-does-not-exist.qmd'])

// The requirement, asserted before the mechanism that delivers it.
assert.equal(failed.published.indexHtml, GOOD_HTML,
  'the previously published render must still be serving')
assert.equal(failed.published.pageInfo, JSON.stringify(GOOD_PAGE_INFO),
  'the previously published page-info.json must be exactly as it was')
assert.ok(
  !failed.seen.some((entry) => entry.method === 'publishBuildInstance'),
  'a failed build must not publish -- publishing swaps the live output/ wholesale, so a build that rendered nothing destroys the last good render',
)

// The failure has to be recorded somewhere a person can read, or the outage has
// no account of itself. This is the `logMissing: true` half.
const recorded = failed.seen.find((entry) => entry.method === 'recordBuildResult')
assert.equal(recorded?.args?.[3], 'build_failed',
  'a build that rendered nothing must record itself as failed, not silently as built')
assert.ok(failed.seen.some((entry) => entry.method === 'publishBuildDiagnostics'),
  'a failed build must carry its log out of the instance, or nothing can say why it failed')
// `logMissing`: the diagnostics wire existed and had nothing on it, because the
// format builders logged to console.log and never wrote a build.log at all.
assert.ok(failed.buildLog, 'a failed build must leave a build.log in the live project')
assert.match(failed.buildLog, /chapter-that-does-not-exist\.qmd/,
  'the log must name what actually failed, not merely exist')

// The counterfactual, same fixture, one declaration different: a build that CAN
// render must still publish and replace the render. This half is what proves the
// refusal above is a verdict rather than publishing being broken outright.
const good = await runBuild(['index.qmd'])
assert.ok(
  good.seen.some((entry) => entry.method === 'publishBuildInstance'),
  'a successful build must still publish',
)
// Non-null FIRST: `notEqual(..., GOOD_HTML)` alone is satisfied by the file
// being destroyed, which is the very thing under test.
assert.ok(good.published.indexHtml, 'a successful build must leave a render in place')
assert.notEqual(good.published.indexHtml, GOOD_HTML,
  'a successful build must replace the previous render with the new one')
assert.ok(good.published.pageInfo, 'a successful build must publish a page-info.json')

console.log('a failed build keeps the last good render; a good build replaces it')
