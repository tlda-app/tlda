import assert from 'node:assert/strict'
import { fork } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = mkdtempSync(join(tmpdir(), 'tlda-missing-main-'))
const name = 'missing-main-proof'
const projectDir = join(root, name)
mkdirSync(join(projectDir, 'source'), { recursive: true })
writeFileSync(join(projectDir, 'project.json'), JSON.stringify({
  name,
  mainFile: 'proof.md',
  format: 'markdown',
  pages: 1,
  buildStatus: 'unknown',
}))

const child = fork(new URL('./build-worker.mjs', import.meta.url), [], {
  stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
})

let update = null
child.on('message', message => {
  if (message?.t !== 'rpc') return
  if (message.m === 'updateProject') update = message.a
  child.send({ t: 'rpc-result', id: message.id, ok: true, result: null })
})

child.send({ t: 'build', name, projectsDir: root, kind: 'build' })
const [code] = await new Promise(resolve => child.once('exit', (...args) => resolve(args)))

assert.equal(code, 1)
assert.deepEqual(update, [name, { buildStatus: 'error', pages: 0 }])
console.log('missing main clears stale pages before the worker exits')
