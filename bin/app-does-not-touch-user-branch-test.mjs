#!/usr/bin/env node

/**
 * The app does not touch the branch the person is standing on.
 *
 * Skip, verbatim: "the app DOES NOT TOUCH MAIN EVER."
 *
 * This exercises the real mirror path — `createShadowMirror(...).mirrorShadowRef`
 * from `daemon/shadow-mirror.mjs`, the same function the daemon calls on every
 * build — against a disposable fixture checkout, and then reads ordinary Git
 * state. It asserts nothing about the source; it asserts what a person would see
 * in their own repository afterward.
 *
 * The negative control runs first. A red test whose fixture never reached the
 * code is indistinguishable from a red test that found something, so the control
 * establishes that the snapshot/diff instrument reports "unchanged" when nothing
 * ran. If the control fails, that is a broken harness and this test says so in
 * those words rather than reporting a finding.
 *
 * Run:  node bin/app-does-not-touch-user-branch-test.mjs
 */

import { execFile as execFileCb } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { promisify } from 'util'
import { createShadowMirror } from '../daemon/shadow-mirror.mjs'
import { snapshotUserTerritory, diffUserTerritory } from './lib/user-territory.mjs'

const execFileP = promisify(execFileCb)

async function git(cwd, args) {
  return execFileP('git', args, { cwd, timeout: 120000 })
}

async function initRepo(dir, branch = 'main') {
  await git(dir, ['init', '-b', branch])
  await git(dir, ['config', 'user.name', 'fixture'])
  await git(dir, ['config', 'user.email', 'fixture@example.test'])
}

async function write(file, content) {
  await fs.promises.mkdir(path.dirname(file), { recursive: true })
  await fs.promises.writeFile(file, content)
}

/**
 * A person's checkout, standing on `main`, with a built paper in it.
 */
async function makeUserCheckout(root) {
  const dir = await fs.promises.mkdtemp(path.join(root, 'user-checkout-'))
  await initRepo(dir)
  await write(path.join(dir, 'main.tex'), 'old\n')
  await write(path.join(dir, 'notes.md'), 'my notes\n')
  await git(dir, ['add', 'main.tex', 'notes.md'])
  await git(dir, ['commit', '-m', 'the author writes their paper'])
  // The build rendered this text; the checkout carries it too.
  await write(path.join(dir, 'main.tex'), 'new\n')
  await git(dir, ['add', 'main.tex'])
  await git(dir, ['commit', '-m', 'the author writes some more'])
  return dir
}

/**
 * The server's shadow history for that paper, as the bundle the daemon receives.
 */
async function makeShadowBundle(root) {
  const shadow = await fs.promises.mkdtemp(path.join(root, 'shadow-'))
  await initRepo(shadow)
  await write(path.join(shadow, 'main.tex'), 'old\n')
  await git(shadow, ['add', 'main.tex'])
  await git(shadow, ['commit', '-m', 'Build at old'])
  await write(path.join(shadow, 'main.tex'), 'new\n')
  await git(shadow, ['add', 'main.tex'])
  await git(shadow, ['commit', '-m', 'Build at new'])
  const { stdout: hashRaw } = await git(shadow, ['rev-parse', 'HEAD'])
  const bundlePath = path.join(root, `shadow-${Date.now()}.bundle`)
  await git(shadow, ['bundle', 'create', bundlePath, '--all'])
  return { hash: hashRaw.trim(), bundleBase64: fs.readFileSync(bundlePath).toString('base64') }
}

async function runMirror(sourceDir, { hash, bundleBase64 }) {
  const mirror = createShadowMirror({
    getSourceDir: () => sourceDir,
    log: { info: () => {}, warn: () => {} },
  })
  return mirror.mirrorShadowRef({
    project: 'fixture-paper',
    hash,
    bundleBase64,
    sourceScope: ['main.tex'],
  })
}

function report(title, violations) {
  if (violations.length === 0) {
    console.log(`  user territory unchanged`)
    return
  }
  console.log(`  ${violations.length} write(s) into user territory:`)
  for (const violation of violations) console.log(`    * ${violation}`)
}

async function main() {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'tlda-user-territory-'))
  let failed = false
  try {
    // --- Negative control: the mirror path is never invoked. ------------------
    console.log('NEGATIVE CONTROL: same fixture, mirror never invoked')
    const control = await makeUserCheckout(root)
    const controlBefore = await snapshotUserTerritory(control)
    // Read-only work only. Nothing here may write, and that is the point.
    await git(control, ['status', '--porcelain'])
    await git(control, ['log', '--oneline', '-5'])
    const controlAfter = await snapshotUserTerritory(control)
    const controlViolations = diffUserTerritory(controlBefore, controlAfter)
    report('control', controlViolations)
    if (controlViolations.length > 0) {
      console.log('\nBROKEN HARNESS: the assertion reports writes when nothing ran.')
      console.log('Nothing below is a finding about the app.')
      process.exit(2)
    }
    console.log('  control passes: the instrument is quiet when nothing runs\n')

    // --- The real path. ------------------------------------------------------
    console.log('MIRROR PATH: daemon/shadow-mirror.mjs mirrorShadowRef() on a real checkout')
    const source = await makeUserCheckout(root)
    const bundle = await makeShadowBundle(root)
    const before = await snapshotUserTerritory(source)
    console.log(`  fixture stands on ${before.symbolicHead} at ${before.head}`)
    const result = await runMirror(source, bundle)
    console.log(`  mirrorShadowRef returned preservation.committed=${result.preservation?.committed}`)
    const after = await snapshotUserTerritory(source)
    const violations = diffUserTerritory(before, after)
    report('mirror', violations)
    if (violations.length > 0) {
      failed = true
      console.log('\nFAIL: the app moved a ref the user owns and/or wrote the user\'s real index.')
      console.log('Skip: "the app DOES NOT TOUCH MAIN EVER."')
    } else {
      console.log('\nPASS: the mirror path left user territory alone.')
    }
  } finally {
    await fs.promises.rm(root, { recursive: true, force: true })
  }
  process.exit(failed ? 1 : 0)
}

main().catch((e) => {
  console.error(e)
  process.exit(3)
})
