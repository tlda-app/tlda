import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

const root = mkdtempSync(join(tmpdir(), 'tlda-failfreeze-'))
const projectsDir = join(root, 'projects')

const { carryFreezeOutOfFailedInstance, publishBuildDiagnostics } = await import('./build-dispatch.mjs')
const { initProjectStore, closeProjectStore, projectDir } = await import('./project-store.mjs')
await initProjectStore(projectsDir)

test.after(async () => {
  await closeProjectStore()
  rmSync(root, { recursive: true, force: true })
})

function record(dir, document, hash) {
  const at = join(dir, document, 'execute-results')
  mkdirSync(at, { recursive: true })
  writeFileSync(join(at, 'html.json'), JSON.stringify({ hash }))
}

function readHash(dir, document) {
  return JSON.parse(readFileSync(join(dir, document, 'execute-results', 'html.json'), 'utf8')).hash
}

function instance(name, freezeAt) {
  mkdirSync(join(projectsDir, name), { recursive: true })
  const inst = join(root, `instance-${name}`)
  mkdirSync(join(inst, 'output'), { recursive: true })
  record(join(inst, freezeAt), 'chapters/rendered-before-it-died', 'fresh')
  return inst
}

// THE DEFECT. A build that rendered 48 of 73 documents and then hit the
// fifteen-minute render timeout computed 48 freeze records and took them to the
// grave with its instance -- so the next build started cold, and so did the one
// after it. Measured 2026-09-13 on a real course: SIGTERM at document 48, twice,
// with no progress between attempts. A loop that cannot converge.
test('a failed build hands its freeze to the project instead of taking it to the grave', () => {
  const inst = instance('died-mid-render', join('output', '_freeze'))
  const carried = carryFreezeOutOfFailedInstance('died-mid-render', inst)

  assert.equal(carried, 'output/_freeze')
  assert.equal(
    readHash(join(projectDir('died-mid-render'), '_freeze'), 'chapters/rendered-before-it-died'),
    'fresh',
    'the work this build completed was destroyed with its instance, so the next build starts cold',
  )
})

// The success path moves the freeze beside `output/` just before the publication
// sweep. A build that got that far and then failed at publication has it there
// rather than inside the render directory, and both are real.
test('it finds the freeze whether or not the retain step ran before the failure', () => {
  const inst = instance('failed-after-retain', '_freeze')
  assert.equal(carryFreezeOutOfFailedInstance('failed-after-retain', inst), '_freeze')
  assert.equal(
    readHash(join(projectDir('failed-after-retain'), '_freeze'), 'chapters/rendered-before-it-died'),
    'fresh',
  )
})

// THE CORRECTNESS OF THE WHOLE THING. A failed build executed a SUBSET, so the
// project holds records for documents this run never reached. Replacing rather
// than merging throws those away and leaves the cache no better than before --
// which is the bug, not the fix.
test('carrying MERGES, so documents this build never reached keep their records', () => {
  const name = 'merges'
  const inst = instance(name, join('output', '_freeze'))
  const projectFreeze = join(projectDir(name), '_freeze')
  record(projectFreeze, 'chapters/from-an-earlier-build', 'older')
  record(projectFreeze, 'chapters/rendered-before-it-died', 'stale')

  carryFreezeOutOfFailedInstance(name, inst)

  assert.equal(readHash(projectFreeze, 'chapters/from-an-earlier-build'), 'older',
    'a document this build never reached lost the record it already had')
  assert.equal(readHash(projectFreeze, 'chapters/rendered-before-it-died'), 'fresh',
    'the record this build just computed should win over the one it supersedes')
})

// A build can fail before it has an instance at all — resolving the revision,
// opening the lifecycle store, materializing. Nothing to carry, and it must not
// throw into the failure it is being called about.
test('a failure with no instance carries nothing rather than throwing', () => {
  assert.equal(carryFreezeOutOfFailedInstance('never-materialised', null), null)
})

// The failure reason is written AFTER this in `publishBuildDiagnostics`, and it
// is the only account of why the build died. A carry that throws -- full disk,
// EACCES, a tree that vanished -- must not take that write with it. A cache is
// worth one wasted render; the reason is worth the next person's night.
test('a non-directory is refused rather than carried, and the reason survives', () => {
  const name = 'carry-throws'
  mkdirSync(join(projectsDir, name), { recursive: true })
  const inst = join(root, 'instance-throws')
  mkdirSync(join(inst, 'output'), { recursive: true })
  // A FILE where the freeze directory should be. `cpSync` does NOT refuse this
  // -- measured while writing the test -- it copies happily and leaves a file
  // named `_freeze` in the project, which the next build's staging reads as the
  // freeze tree. Success, and a cache nobody can use.
  writeFileSync(join(inst, 'output', '_freeze'), 'not a directory')

  const result = publishBuildDiagnostics(name, inst, 'the reason this build died')

  assert.equal(result.carriedFreeze, null, 'a non-directory was carried as though it were the freeze')
  assert.equal(existsSync(join(projectDir(name), '_freeze')), false,
    'a file named _freeze was left in the project, and the next build will stage it')
  assert.match(
    readFileSync(join(projectDir(name), 'build.log'), 'utf8'),
    /the reason this build died/,
    'the failure reason was lost to something that went wrong carrying a cache',
  )
})

// AND THE CATCH ITSELF, which the case above does NOT exercise: the directory
// check prevents that throw, so with the try/catch removed it still passes. This
// makes the copy genuinely fail -- a FILE where the project's freeze tree must
// go, so `cpSync` refuses a directory onto it -- and asserts the reason survives.
test('a carry that genuinely throws still leaves the failure reason', () => {
  const name = 'carry-really-throws'
  const inst = instance(name, join('output', '_freeze'))
  // The destination is a file, so copying a tree onto it cannot succeed.
  writeFileSync(join(projectDir(name), '_freeze'), 'a file where the tree goes')

  const result = publishBuildDiagnostics(name, inst, 'the reason this build died')

  assert.equal(result.carriedFreeze, null, 'the carry reported success despite failing')
  assert.match(
    readFileSync(join(projectDir(name), 'build.log'), 'utf8'),
    /the reason this build died/,
    'a failing cache copy took the only account of the failure with it',
  )
})

test('an instance with no freeze carries nothing', () => {
  mkdirSync(join(projectsDir, 'no-freeze'), { recursive: true })
  const inst = join(root, 'instance-empty')
  mkdirSync(join(inst, 'output'), { recursive: true })
  assert.equal(carryFreezeOutOfFailedInstance('no-freeze', inst), null)
  assert.equal(existsSync(join(projectDir('no-freeze'), '_freeze')), false)
})
