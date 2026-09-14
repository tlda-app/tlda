/**
 * `diff-region` must read the current source from the project, not from the
 * absolute path baked into the synctex.
 *
 * Measured on the deployed testing box, `build-card-proof`, scrubbed back one
 * day:
 *
 *   POST /api/projects/build-card-proof/history/diff-region  →  HTTP 500
 *   {"error":"Cannot read current source: ENOENT: no such file or directory,
 *             open '/tmp/tlda-build-instance-QMhD52/build-card-proof/source/main.tex'"}
 *
 * A synctex records the ABSOLUTE path of each input at build time. Builds run
 * in an ephemeral instance directory, so that path is gone by the time anyone
 * asks for a diff — and the route read it directly. The user saw `Show diff`
 * turn into `Diff failed`.
 *
 * The route already computes the fallback for exactly this case and used it
 * only for the historical `git show`:
 *
 *   const relHitFile = hitFileAbsolute.startsWith(srcDir)
 *     ? hitFileAbsolute.slice(srcDir.length + 1)
 *     : (project.mainFile || 'main.tex')
 *
 * So the repair is to resolve the CURRENT read the same way. These tests are
 * about that resolution and nothing else.
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import assert from 'node:assert/strict'

import { resolveCurrentSourcePath } from '../server/routes/history.mjs'

test('a synctex path inside the source dir is used as-is', () => {
  const srcDir = '/projects/demo/source'
  const hit = join(srcDir, 'chapters', 'intro.tex')
  assert.equal(resolveCurrentSourcePath(hit, srcDir, 'main.tex'), hit)
})

test('an absolute EPHEMERAL build path falls back into the project source dir', () => {
  // The measured failure, as data: the synctex names a build instance that no
  // longer exists. Anything that returns this path unchanged is the bug.
  const srcDir = '/projects/build-card-proof/source'
  const hit = '/tmp/tlda-build-instance-QMhD52/build-card-proof/source/main.tex'

  const resolved = resolveCurrentSourcePath(hit, srcDir, 'main.tex')

  assert.notEqual(resolved, hit, 'the ephemeral build path was returned unchanged')
  assert.equal(resolved, join(srcDir, 'main.tex'))
})

test('the fallback reads the file that actually exists on disk', async () => {
  // The resolution is only worth anything if the path it returns opens. This
  // is the end the 500 came from.
  const root = mkdtempSync(join(tmpdir(), 'tlda-diff-region-'))
  try {
    const srcDir = join(root, 'source')
    mkdirSync(srcDir, { recursive: true })
    writeFileSync(join(srcDir, 'main.tex'), '\\section{Real}\nthe current source\n')

    const ephemeral = '/tmp/tlda-build-instance-GONE/demo/source/main.tex'
    const resolved = resolveCurrentSourcePath(ephemeral, srcDir, 'main.tex')

    const { readFile } = await import('node:fs/promises')
    const text = await readFile(resolved, 'utf8')
    assert.match(text, /the current source/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('with no mainFile recorded it still resolves rather than throwing', () => {
  // `project.mainFile` is optional in the store; the route's own fallback
  // defaults to main.tex and this must not become a crash on a null.
  const srcDir = '/projects/demo/source'
  const hit = '/tmp/tlda-build-instance-X/demo/source/main.tex'
  assert.equal(resolveCurrentSourcePath(hit, srcDir, null), join(srcDir, 'main.tex'))
  assert.equal(resolveCurrentSourcePath(hit, srcDir, undefined), join(srcDir, 'main.tex'))
})
