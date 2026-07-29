import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  closeProjectStore,
  createProject,
  initProjectStore,
  outputDir,
  projectDir,
  sourceDir,
} from '../server/lib/project-store.mjs'
import { commitSnapshot, currentVersion } from '../server/lib/shadow-repo.mjs'
import {
  markdownVersionTriggerProjection,
  maskVolatileMarkdown,
  stripVolatileMarkdownMarkersForRender,
} from '../shared/markdown-volatile.mjs'

test('heading and fenced volatile objects are masked as whole objects', () => {
  const source = [
    '# Stable',
    'kept',
    '## Generated {.volatile}',
    'changing',
    '### Nested',
    'also changing',
    '## Stable again',
    'kept too',
    '```{.volatile}',
    'generated code',
    '```',
  ].join('\n')
  assert.equal(maskVolatileMarkdown(source), [
    '# Stable',
    'kept',
    '<!-- tlda:volatile -->',
    '## Stable again',
    'kept too',
    '<!-- tlda:volatile -->',
  ].join('\n'))
})

test('Pandoc volatile fenced div is masked as one object', () => {
  assert.equal(maskVolatileMarkdown([
    'before',
    '::: {.volatile}',
    'generated',
    ':::',
    'after',
  ].join('\n')), [
    'before',
    '<!-- tlda:volatile -->',
    'after',
  ].join('\n'))
})

test('volatile attributes annotate the source without appearing as document text', () => {
  assert.equal(stripVolatileMarkdownMarkersForRender([
    '## Generated {.volatile}',
    '::: {.volatile}',
    'inside',
    ':::',
    '```python {.volatile}',
    'print(1)',
    '```',
  ].join('\n')), [
    '## Generated',
    '',
    'inside',
    '',
    '```python',
    'print(1)',
    '```',
  ].join('\n'))
})

test('volatile-only changes leave the version-trigger projection unchanged', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'tlda-volatile-'))
  writeFileSync(path.join(root, 'index.md'), '# Stable\nsame\n## Plot {.volatile}\nfirst\n')
  const files = ['index.md']
  const before = await markdownVersionTriggerProjection({ root, mainFile: 'index.md', files })
  writeFileSync(path.join(root, 'index.md'), '# Stable\nsame\n## Plot {.volatile}\nsecond\n')
  const after = await markdownVersionTriggerProjection({ root, mainFile: 'index.md', files })
  assert.deepEqual(after, before)

  writeFileSync(path.join(root, 'index.md'), '# Stable\nchanged\n## Plot {.volatile}\nsecond\n')
  assert.notDeepEqual(await markdownVersionTriggerProjection({ root, mainFile: 'index.md', files }), before)
})

test('an image included only by a volatile object inherits volatility', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'tlda-volatile-image-'))
  mkdirSync(path.join(root, 'figures'))
  writeFileSync(path.join(root, 'index.md'), '# Stable\nsame\n## Plot {.volatile}\n![](figures/plot.png)\n')
  writeFileSync(path.join(root, 'figures/plot.png'), 'first')
  const files = ['index.md', 'figures/plot.png']
  const before = await markdownVersionTriggerProjection({ root, mainFile: 'index.md', files })
  writeFileSync(path.join(root, 'figures/plot.png'), 'second')
  assert.deepEqual(await markdownVersionTriggerProjection({ root, mainFile: 'index.md', files }), before)

  writeFileSync(path.join(root, 'index.md'), '# Stable\n![](figures/plot.png)\n## Plot {.volatile}\n![](figures/plot.png)\n')
  assert.notDeepEqual(await markdownVersionTriggerProjection({ root, mainFile: 'index.md', files }), before)
})

test('a Markdown file included only inside a volatile object inherits volatility', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'tlda-volatile-include-'))
  writeFileSync(path.join(root, 'index.md'), '# Stable\n## Generated {.volatile}\n[details](details.md)\n')
  writeFileSync(path.join(root, 'details.md'), '# Details\nfirst\n')
  const files = ['index.md', 'details.md']
  const before = await markdownVersionTriggerProjection({ root, mainFile: 'index.md', files })
  writeFileSync(path.join(root, 'details.md'), '# Details\nsecond\n')
  assert.deepEqual(await markdownVersionTriggerProjection({ root, mainFile: 'index.md', files }), before)
})

test('the shadow version advances only for nonvolatile edits and then records current volatile bytes', async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), 'tlda-volatile-shadow-'))
  const project = 'volatile-shadow-fixture'
  await initProjectStore(root)
  t.after(async () => {
    await closeProjectStore()
    rmSync(root, { recursive: true, force: true })
  })
  createProject({ name: project, format: 'markdown', mainFile: 'index.md' })
  const src = sourceDir(project)
  const out = outputDir(project)
  mkdirSync(path.join(src, 'figures'), { recursive: true })
  writeFileSync(path.join(src, 'index.md'), '# Stable\nsame\n## Plot {.volatile}\n![](figures/plot.png)\nfirst\n')
  writeFileSync(path.join(src, 'figures/plot.png'), 'plot one')
  writeFileSync(path.join(out, 'relevant-files.json'), JSON.stringify({
    files: ['index.md', 'figures/plot.png'],
  }))

  const first = await commitSnapshot(project)
  assert.equal(first.status, 'committed')

  writeFileSync(path.join(src, 'index.md'), '# Stable\nsame\n## Plot {.volatile}\n![](figures/plot.png)\nsecond\n')
  writeFileSync(path.join(src, 'figures/plot.png'), 'plot two')
  assert.deepEqual(await commitSnapshot(project), { status: 'volatile-only' })
  assert.equal((await currentVersion(project)).hash, first.hash)

  writeFileSync(path.join(src, 'index.md'), '# Stable\nchanged\n## Plot {.volatile}\n![](figures/plot.png)\nthird\n')
  const mixed = await commitSnapshot(project)
  assert.equal(mixed.status, 'committed')
  assert.notEqual(mixed.hash, first.hash)

  const repo = path.join(projectDir(project), 'shadow-repo')
  assert.match(
    execFileSync('git', ['show', `${mixed.hash}:index.md`], { cwd: repo, encoding: 'utf8' }),
    /third/,
    'the normal edit snapshot excluded the current volatile Markdown bytes',
  )
  assert.equal(
    execFileSync('git', ['show', `${mixed.hash}:figures/plot.png`], { cwd: repo, encoding: 'utf8' }),
    'plot two',
    'the normal edit snapshot excluded the current volatile image bytes',
  )
})
