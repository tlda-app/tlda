import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

// The fork's viewport wheel handler must ADD the normalized delta, the way
// Editor.ts's 'wheel' case does. normalizeWheel already returns a negated delta
// — `{ x: -deltaX, y: -deltaY }` — so subtracting it negates a second time and
// the viewport pans opposite to the main canvas for the same gesture. Skip
// reported that as "scrolling on the canvas and scrolling in the thing are
// giving me opposite scroll directions"; it was fixed in -tlda.11.
//
// This is a test rather than a line in docs/vendored-tldraw-editor.md because
// the failure is silent. TldrawViewport.tsx does not exist upstream, so a
// re-fork re-applies our features by hand onto a new base and this sign is one
// character in a file nobody diffs. Nothing about a reverted sign fails to
// build, fails to typecheck, or logs anything — it just pans the wrong way on
// five surfaces and waits for someone to notice again.
//
// It reads the tarball rather than node_modules deliberately: node_modules is
// whatever was last installed, which in a shared checkout is not necessarily
// the pinned artifact. The tarball is what the pin points at and what ships.

const root = fileURLToPath(new URL('..', import.meta.url))

function pinnedEditorTarball() {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  const spec = pkg.dependencies?.['@tldraw/editor'] ?? pkg.devDependencies?.['@tldraw/editor']
  assert.ok(spec, '@tldraw/editor is not pinned in package.json')
  assert.ok(spec.startsWith('file:'), `@tldraw/editor should be pinned to a file, got ${spec}`)
  return spec.slice('file:'.length)
}

function shippedViewportSource(tarball) {
  // -O writes one member to stdout, so this never unpacks 1.7MB to disk.
  return execFileSync(
    'tar',
    ['xzOf', tarball, 'package/dist-esm/lib/components/TldrawViewport.mjs'],
    { cwd: root, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 },
  )
}

test('the pinned editor tarball exists and is what package.json names', () => {
  const tarball = pinnedEditorTarball()
  const source = shippedViewportSource(tarball)
  assert.ok(source.length > 0, `${tarball} has no dist-esm TldrawViewport`)
})

test('the fork viewport adds the normalized wheel delta, as the editor does', () => {
  const source = shippedViewportSource(pinnedEditorTarball())

  const matches = source.match(/camera\.[xy] [+-] delta\.[xy] \/ camera\.z/g) ?? []
  assert.equal(matches.length, 2, `expected both axes in the pan branch, found ${matches.length}`)

  for (const match of matches) {
    assert.match(
      match,
      /\+/,
      `viewport pan subtracts the normalized delta (${match}), so it pans opposite to the ` +
        'main canvas. Editor.ts uses "cx + (dx * panSpeed) / cz" and normalizeWheel has ' +
        'already negated the raw event.',
    )
  }
})
