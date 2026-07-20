#!/usr/bin/env node

import assert from 'assert/strict'
import { execFile as execFileCb } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { promisify } from 'util'
import { createShadowMirror } from '../daemon/shadow-mirror.mjs'

const execFile = promisify(execFileCb)

async function git(cwd, args, opts = {}) {
  return execFile('git', args, { cwd, timeout: 10000, ...opts })
}

async function initRepo(dir) {
  await git(dir, ['init', '-b', 'main'])
  await git(dir, ['config', 'user.name', 'fixture'])
  await git(dir, ['config', 'user.email', 'fixture@example.test'])
}

async function write(file, content) {
  await fs.promises.mkdir(path.dirname(file), { recursive: true })
  await fs.promises.writeFile(file, content)
}

async function makeBundle(root) {
  const shadow = path.join(root, 'shadow')
  await fs.promises.mkdir(shadow, { recursive: true })
  await initRepo(shadow)
  await write(path.join(shadow, 'main.tex'), 'old\n')
  await git(shadow, ['add', 'main.tex'])
  await git(shadow, ['commit', '-m', 'Build at old'])
  await write(path.join(shadow, 'main.tex'), 'new\n')
  await git(shadow, ['add', 'main.tex'])
  await git(shadow, ['commit', '-m', 'Build at new'])
  const { stdout: hashRaw } = await git(shadow, ['rev-parse', 'HEAD'])
  const hash = hashRaw.trim()
  const bundle = path.join(root, 'shadow.bundle')
  await git(shadow, ['bundle', 'create', bundle, '--all'])
  return { hash, bundleBase64: fs.readFileSync(bundle).toString('base64') }
}

async function bundleRepo(root, shadow) {
  const { stdout: hashRaw } = await git(shadow, ['rev-parse', 'HEAD'])
  const hash = hashRaw.trim()
  const bundle = path.join(root, `shadow-${hash.slice(0, 7)}.bundle`)
  await git(shadow, ['bundle', 'create', bundle, '--all'])
  return { hash, bundleBase64: fs.readFileSync(bundle).toString('base64') }
}

async function makeScopedBundle(root, build) {
  const shadow = await fs.promises.mkdtemp(path.join(root, 'shadow-'))
  await initRepo(shadow)
  await build(shadow)
  return bundleRepo(root, shadow)
}

async function makeSource(root, mainContent) {
  const source = await fs.promises.mkdtemp(path.join(root, 'source-'))
  await initRepo(source)
  await write(path.join(source, 'main.tex'), 'old\n')
  await write(path.join(source, 'notes.tex'), 'tracked\n')
  await git(source, ['add', 'main.tex', 'notes.tex'])
  await git(source, ['commit', '-m', 'author base'])
  await write(path.join(source, 'main.tex'), mainContent)
  await write(path.join(source, 'notes.tex'), 'tracked dirty but unrelated\n')
  return source
}

async function runMirror(source, hash, bundleBase64, options = {}) {
  const messages = []
  const mirror = createShadowMirror({
    getSourceDir: () => source,
    log: {
      info: (msg) => messages.push(['info', msg]),
      warn: (msg) => messages.push(['warn', msg]),
    },
    beforePreserveUpdateRef: options.beforePreserveUpdateRef,
  })
  const result = await mirror.mirrorShadowRef({
    project: 'fixture-doc',
    hash,
    bundleBase64,
    sourceScope: options.sourceScope || ['main.tex'],
  })
  return { result, messages }
}

async function assertDirty(source, file) {
  try {
    await git(source, ['diff', '--quiet', '--', file])
  } catch (e) {
    assert.equal(e.code, 1)
    return
  }
  assert.fail(`${file} was unexpectedly clean`)
}

async function assertCachedDirty(source, file) {
  try {
    await git(source, ['diff', '--cached', '--quiet', '--', file])
  } catch (e) {
    assert.equal(e.code, 1)
    return
  }
  assert.fail(`${file} was unexpectedly clean in the index`)
}

async function assertCachedClean(source, file) {
  await git(source, ['diff', '--cached', '--quiet', '--', file])
}

async function assertClean(source, file) {
  await git(source, ['diff', '--quiet', '--', file])
  await git(source, ['diff', '--cached', '--quiet', '--', file])
}

async function assertMissing(source, file) {
  assert.equal(fs.existsSync(path.join(source, file)), false, `${file} should be absent`)
  const { stdout } = await git(source, ['ls-files', '--', file])
  assert.equal(stdout.trim(), '', `${file} should be removed from the index`)
}

async function main() {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'tlda-shadow-mirror-preserve-'))
  try {
    const { hash, bundleBase64 } = await makeBundle(root)

    const source = await makeSource(root, 'new\n')
    const { stdout: beforeHeadRaw } = await git(source, ['rev-parse', 'HEAD'])
    const { result } = await runMirror(source, hash, bundleBase64)
    const { stdout: afterHeadRaw } = await git(source, ['rev-parse', 'HEAD'])
    assert.equal(result.preservation.committed, true)
    assert.notEqual(afterHeadRaw.trim(), beforeHeadRaw.trim())
    await git(source, ['diff', '--quiet', '--', 'main.tex'])
    await assertDirty(source, 'notes.tex')
    const { stdout: shadowHeadRaw } = await git(source, ['rev-parse', 'refs/tlda/shadow/HEAD'])
    assert.equal(shadowHeadRaw.trim(), hash)

    const stagedUnrelated = await makeSource(root, 'new\n')
    await git(stagedUnrelated, ['add', 'notes.tex'])
    await runMirror(stagedUnrelated, hash, bundleBase64)
    await git(stagedUnrelated, ['diff', '--quiet', '--', 'main.tex'])
    await assertCachedDirty(stagedUnrelated, 'notes.tex')

    const stagedTarget = await makeSource(root, 'new\n')
    await write(path.join(stagedTarget, 'main.tex'), 'staged target\n')
    await git(stagedTarget, ['add', 'main.tex'])
    await write(path.join(stagedTarget, 'main.tex'), 'new\n')
    const { stdout: stagedTargetBeforeRaw } = await git(stagedTarget, ['rev-parse', 'HEAD'])
    await assert.rejects(
      () => runMirror(stagedTarget, hash, bundleBase64),
      /staged main\.tex differs from shadow/,
    )
    const { stdout: stagedTargetAfterRaw } = await git(stagedTarget, ['rev-parse', 'HEAD'])
    assert.equal(stagedTargetAfterRaw.trim(), stagedTargetBeforeRaw.trim())
    await assertCachedDirty(stagedTarget, 'main.tex')

    const raceSource = await makeSource(root, 'new\n')
    await assert.rejects(
      () => runMirror(raceSource, hash, bundleBase64, {
        beforePreserveUpdateRef: async ({ sourceDir }) => {
          await write(path.join(sourceDir, 'race.tex'), 'branch advanced\n')
          await git(sourceDir, ['add', 'race.tex'])
          await git(sourceDir, ['commit', '-m', 'concurrent author commit'])
        },
      }),
      /cannot lock ref|is at .* but expected|update-ref/,
    )
    await assertDirty(raceSource, 'main.tex')
    await assertCachedClean(raceSource, 'main.tex')

    const conflictSource = await makeSource(root, 'newer local\n')
    const { stdout: conflictBeforeRaw } = await git(conflictSource, ['rev-parse', 'HEAD'])
    await assert.rejects(
      () => runMirror(conflictSource, hash, bundleBase64),
      /local main\.tex changed after build/,
    )
    const { stdout: conflictAfterRaw } = await git(conflictSource, ['rev-parse', 'HEAD'])
    assert.equal(conflictAfterRaw.trim(), conflictBeforeRaw.trim())
    await assertDirty(conflictSource, 'main.tex')

    const accumulated = await makeScopedBundle(root, async (shadow) => {
      await write(path.join(shadow, 'a.tex'), 'old a\n')
      await write(path.join(shadow, 'b.tex'), 'old b\n')
      await git(shadow, ['add', 'a.tex', 'b.tex'])
      await git(shadow, ['commit', '-m', 'Build at base'])
      await write(path.join(shadow, 'a.tex'), 'new a\n')
      await git(shadow, ['add', 'a.tex'])
      await git(shadow, ['commit', '-m', 'Build at A'])
      await write(path.join(shadow, 'b.tex'), 'new b\n')
      await git(shadow, ['add', 'b.tex'])
      await git(shadow, ['commit', '-m', 'Build at B'])
    })
    const accumulatedSource = await fs.promises.mkdtemp(path.join(root, 'source-'))
    await initRepo(accumulatedSource)
    await write(path.join(accumulatedSource, 'a.tex'), 'old a\n')
    await write(path.join(accumulatedSource, 'b.tex'), 'old b\n')
    await git(accumulatedSource, ['add', 'a.tex', 'b.tex'])
    await git(accumulatedSource, ['commit', '-m', 'author base'])
    await write(path.join(accumulatedSource, 'a.tex'), 'new a\n')
    await write(path.join(accumulatedSource, 'b.tex'), 'new b\n')
    await runMirror(accumulatedSource, accumulated.hash, accumulated.bundleBase64, { sourceScope: ['a.tex', 'b.tex'] })
    await assertClean(accumulatedSource, 'a.tex')
    await assertClean(accumulatedSource, 'b.tex')

    const addDeleteRename = await makeScopedBundle(root, async (shadow) => {
      await write(path.join(shadow, 'delete-me.tex'), 'gone soon\n')
      await write(path.join(shadow, 'old-name.tex'), 'renamed\n')
      await git(shadow, ['add', 'delete-me.tex', 'old-name.tex'])
      await git(shadow, ['commit', '-m', 'Build at base'])
      await fs.promises.rm(path.join(shadow, 'delete-me.tex'))
      await fs.promises.rename(path.join(shadow, 'old-name.tex'), path.join(shadow, 'new-name.tex'))
      await write(path.join(shadow, 'added.tex'), 'added\n')
      await git(shadow, ['add', '-A'])
      await git(shadow, ['commit', '-m', 'Build at add delete rename'])
    })
    const adrSource = await fs.promises.mkdtemp(path.join(root, 'source-'))
    await initRepo(adrSource)
    await write(path.join(adrSource, 'delete-me.tex'), 'gone soon\n')
    await write(path.join(adrSource, 'old-name.tex'), 'renamed\n')
    await git(adrSource, ['add', 'delete-me.tex', 'old-name.tex'])
    await git(adrSource, ['commit', '-m', 'author base'])
    await fs.promises.rm(path.join(adrSource, 'delete-me.tex'))
    await fs.promises.rename(path.join(adrSource, 'old-name.tex'), path.join(adrSource, 'new-name.tex'))
    await write(path.join(adrSource, 'added.tex'), 'added\n')
    await runMirror(adrSource, addDeleteRename.hash, addDeleteRename.bundleBase64, {
      sourceScope: ['added.tex', 'delete-me.tex', 'old-name.tex', 'new-name.tex'],
    })
    await assertClean(adrSource, 'added.tex')
    await assertClean(adrSource, 'new-name.tex')
    await assertMissing(adrSource, 'delete-me.tex')
    await assertMissing(adrSource, 'old-name.tex')

    const modeOnly = await makeScopedBundle(root, async (shadow) => {
      await write(path.join(shadow, 'script.sh'), '#!/bin/sh\necho old\n')
      await git(shadow, ['add', 'script.sh'])
      await git(shadow, ['commit', '-m', 'Build at mode base'])
      await fs.promises.chmod(path.join(shadow, 'script.sh'), 0o755)
      await git(shadow, ['add', 'script.sh'])
      await git(shadow, ['commit', '-m', 'Build at mode executable'])
    })
    const modeMismatchSource = await fs.promises.mkdtemp(path.join(root, 'source-'))
    await initRepo(modeMismatchSource)
    await git(modeMismatchSource, ['config', 'core.filemode', 'false'])
    await write(path.join(modeMismatchSource, 'script.sh'), '#!/bin/sh\necho old\n')
    await git(modeMismatchSource, ['add', 'script.sh'])
    await git(modeMismatchSource, ['commit', '-m', 'author base'])
    await fs.promises.chmod(path.join(modeMismatchSource, 'script.sh'), 0o644)
    const { stdout: modeMismatchBeforeRaw } = await git(modeMismatchSource, ['rev-parse', 'HEAD'])
    await assert.rejects(
      () => runMirror(modeMismatchSource, modeOnly.hash, modeOnly.bundleBase64, { sourceScope: ['script.sh'] }),
      /local script\.sh mode 100644 differs from shadow 100755/,
    )
    const { stdout: modeMismatchAfterRaw } = await git(modeMismatchSource, ['rev-parse', 'HEAD'])
    assert.equal(modeMismatchAfterRaw.trim(), modeMismatchBeforeRaw.trim())

    const modeMatchSource = await fs.promises.mkdtemp(path.join(root, 'source-'))
    await initRepo(modeMatchSource)
    await git(modeMatchSource, ['config', 'core.filemode', 'false'])
    await write(path.join(modeMatchSource, 'script.sh'), '#!/bin/sh\necho old\n')
    await git(modeMatchSource, ['add', 'script.sh'])
    await git(modeMatchSource, ['commit', '-m', 'author base'])
    await fs.promises.chmod(path.join(modeMatchSource, 'script.sh'), 0o755)
    await runMirror(modeMatchSource, modeOnly.hash, modeOnly.bundleBase64, { sourceScope: ['script.sh'] })
    const { stdout: modeRaw } = await git(modeMatchSource, ['ls-tree', 'HEAD', 'script.sh'])
    assert.match(modeRaw, /^100755 blob /)

    console.log('shadow mirror preserve regression passed')
  } finally {
    await fs.promises.rm(root, { recursive: true, force: true })
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
