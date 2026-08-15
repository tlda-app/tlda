import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import test from 'node:test'

const packageRoot = new URL('../packages/tldraw-wm/', import.meta.url)

test('window-manager package source is self-contained', () => {
  const sourceDir = new URL('src/', packageRoot)
  const files = readdirSync(sourceDir).filter(file => file.endsWith('.ts'))
  assert.ok(files.length > 0)
  for (const file of files) {
    const source = readFileSync(new URL(file, sourceDir), 'utf8')
    assert.doesNotMatch(source, /from ['"]\.\.\/\.\.\/\.\.\/src\//, file)
    assert.doesNotMatch(source, /from ['"][^'"]*src\//, file)
  }
})

test('package exposes project semantics separately from editor-local adapters', async () => {
  const core = await import('../packages/tldraw-wm/dist/core.js')
  const adapter = await import('../packages/tldraw-wm/dist/tldraw-adapter.js')
  assert.equal(typeof core.createLayerModel, 'function')
  assert.equal(typeof core.ManagedSurfaceLifecycle, 'function')
  assert.equal(typeof adapter.getEditorWMCore, 'function')
  assert.equal('getEditorWMCore' in core, false)
})
