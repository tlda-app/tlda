import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { createSourceSync } from './source-sync.mjs'

test('watches an absolute build watchFile beneath the project source directory', async (t) => {
  const sourceDir = mkdtempSync(join(tmpdir(), 'tlda-source-sync-'))
  const scratchDir = join(sourceDir, 'scratch')
  const sourceFile = join(scratchDir, 'report.md')
  await import('node:fs/promises').then(({ mkdir }) => mkdir(scratchDir, { recursive: true }))
  writeFileSync(sourceFile, '# Before\n')

  const messages = []
  const sync = createSourceSync({
    sourceBindingsFile: join(sourceDir, 'bindings.json'),
    log: { info() {}, warn() {}, error() {} },
    sendMsg: message => messages.push(message),
    isConnected: () => true,
    resolveEditor: () => null,
  })
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
