import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { createSourceSync } from './source-sync.mjs'

function makeSync(sourceDir, messages) {
  return createSourceSync({
    sourceBindingsFile: join(sourceDir, 'bindings.json'),
    log: { info() {}, warn() {}, error() {} },
    sendMsg: message => messages.push(message),
    isConnected: () => true,
    resolveEditor: () => null,
  })
}

function pushedPaths(messages) {
  return messages
    .filter(message => message.type === 'source-change')
    .flatMap(message => message.files || [])
    .map(file => file.path)
}

async function waitForMessage(messages, predicate) {
  return await new Promise(resolve => {
    const deadline = Date.now() + 3000
    const poll = () => {
      const match = messages.find(predicate)
      if (match || Date.now() >= deadline) return resolve(match)
      setTimeout(poll, 25)
    }
    poll()
  })
}

test('watches an absolute build watchFile beneath the project source directory', async (t) => {
  const sourceDir = mkdtempSync(join(tmpdir(), 'tlda-source-sync-'))
  const scratchDir = join(sourceDir, 'scratch')
  const sourceFile = join(scratchDir, 'report.md')
  await import('node:fs/promises').then(({ mkdir }) => mkdir(scratchDir, { recursive: true }))
  writeFileSync(sourceFile, '# Before\n')

  const messages = []
  const sync = makeSync(sourceDir, messages)
  t.after(() => sync.closeAll())

  sync.sync([{
    name: 'markdown-source-sync',
    format: 'markdown',
    mainFile: 'README.md',
    sourceDir,
    watchFiles: [sourceFile],
  }])

  await new Promise(resolve => setTimeout(resolve, 150))
  writeFileSync(sourceFile, '# After\n')

  const delivered = await new Promise(resolve => {
    const deadline = Date.now() + 3000
    const poll = () => {
      const update = messages.find(message => message.type === 'source-change' && message.files?.some(file => file.path === 'scratch/report.md' && file.content === '# After\n'))
      if (update || Date.now() >= deadline) return resolve(update)
      setTimeout(poll, 25)
    }
    poll()
  })

  assert.ok(delivered, 'the relative source path should be sent after the absolute watch path changes')
})

test('unions stale build inputs with current includegraphics declarations', (t) => {
  const sourceDir = mkdtempSync(join(tmpdir(), 'tlda-source-sync-'))
  mkdirSync(join(sourceDir, 'sections'), { recursive: true })
  mkdirSync(join(sourceDir, 'figures'), { recursive: true })
  writeFileSync(join(sourceDir, 'main.tex'), '\\input{sections/body}\n')
  writeFileSync(join(sourceDir, 'sections/body.tex'), '\\includegraphics[width=0.7\\textwidth]{../figures/plot.pdf}\n')
  writeFileSync(join(sourceDir, 'figures/plot.pdf'), 'pdf')
  writeFileSync(join(sourceDir, 'figures/plot.svg'), '<svg/>')
  writeFileSync(join(sourceDir, 'figures/unrelated.svg'), '<svg/>')

  const messages = []
  const sync = makeSync(sourceDir, messages)
  t.after(() => sync.closeAll())

  sync.sync([{
    name: 'stale-fls',
    format: 'svg',
    mainFile: 'main.tex',
    sourceDir,
    watchFiles: ['main.tex'],
  }])

  const paths = pushedPaths(messages)
  assert.ok(paths.includes('sections/body.tex'))
  assert.ok(paths.includes('figures/plot.pdf'))
  assert.ok(paths.includes('figures/plot.svg'))
  assert.ok(!paths.includes('figures/unrelated.svg'), 'unreferenced siblings must not be directory-pushed')
})

test('resolves and watches extensionless nested graphics while rejecting traversal', async (t) => {
  const sourceDir = mkdtempSync(join(tmpdir(), 'tlda-source-sync-'))
  const outsideDir = mkdtempSync(join(tmpdir(), 'tlda-source-sync-outside-'))
  mkdirSync(join(sourceDir, 'sections'), { recursive: true })
  mkdirSync(join(sourceDir, 'figures'), { recursive: true })
  writeFileSync(join(sourceDir, 'main.tex'), '\\input{sections/body}\n')
  writeFileSync(join(sourceDir, 'sections/body.tex'), [
    '\\includegraphics{../figures/chart}',
    `\\includegraphics{../../${outsideDir.split('/').pop()}/secret.png}`,
  ].join('\n'))
  writeFileSync(join(sourceDir, 'figures/chart.png'), 'png')
  writeFileSync(join(sourceDir, 'figures/chart.svg'), '<svg/>')
  const epsPath = join(sourceDir, 'figures/chart.eps')
  writeFileSync(epsPath, 'eps-before')
  writeFileSync(join(outsideDir, 'secret.png'), 'secret')

  const messages = []
  const sync = makeSync(sourceDir, messages)
  t.after(() => sync.closeAll())

  sync.sync([{
    name: 'extensionless',
    format: 'svg',
    mainFile: 'main.tex',
    sourceDir,
    watchFiles: ['main.tex'],
  }])

  const paths = pushedPaths(messages)
  assert.ok(paths.includes('figures/chart.png'))
  assert.ok(paths.includes('figures/chart.svg'))
  assert.ok(paths.includes('figures/chart.eps'))
  assert.ok(!paths.some(file => file.includes('secret.png')))

  await new Promise(resolve => setTimeout(resolve, 150))
  writeFileSync(epsPath, 'eps-after')
  const watched = await waitForMessage(messages, message =>
    message.files?.some(file => file.path === 'figures/chart.eps' &&
      file.encoding === 'base64' && Buffer.from(file.content, 'base64').toString() === 'eps-after'))
  assert.ok(watched, 'an extensionless-declared EPS should remain in the active watcher set')
})

test('a new graphics declaration is pushed and becomes watched', async (t) => {
  const sourceDir = mkdtempSync(join(tmpdir(), 'tlda-source-sync-'))
  mkdirSync(join(sourceDir, 'figures'), { recursive: true })
  const mainPath = join(sourceDir, 'main.tex')
  const figurePath = join(sourceDir, 'figures/new.svg')
  writeFileSync(mainPath, 'Before\n')
  writeFileSync(figurePath, '<svg>before</svg>')

  const messages = []
  const sync = makeSync(sourceDir, messages)
  t.after(() => sync.closeAll())
  sync.sync([{
    name: 'new-graphic',
    format: 'svg',
    mainFile: 'main.tex',
    sourceDir,
    watchFiles: ['main.tex'],
  }])

  await new Promise(resolve => setTimeout(resolve, 150))
  writeFileSync(mainPath, '\\includegraphics{figures/new.svg}\n')
  const discovered = await waitForMessage(messages, message =>
    message.files?.some(file => file.path === 'figures/new.svg' && file.content === '<svg>before</svg>'))
  assert.ok(discovered, 'the TeX rescan should push the newly declared figure')

  writeFileSync(figurePath, '<svg>after</svg>')
  const watched = await waitForMessage(messages, message =>
    message.files?.some(file => file.path === 'figures/new.svg' && file.content === '<svg>after</svg>'))
  assert.ok(watched, 'the discovered figure should remain in the active watcher set')
})
