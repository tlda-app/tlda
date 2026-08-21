import assert from 'node:assert/strict'
import { fork } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { closeProjectStore, createProject, initProjectStore, sourceLifecycleStore, updateProject } from '../server/lib/project-store.mjs'

const root = mkdtempSync(join(tmpdir(), 'tlda-missing-main-'))
const name = 'missing-main-proof'
await initProjectStore(root)
createProject({ name, mainFile: 'proof.md', format: 'markdown' })
await updateProject(name, { pages: 1, buildStatus: 'unknown' })
const git = await (await sourceLifecycleStore(name)).gitRepository()
const sourceRevision = await git.acceptRevision({
  project: name,
  files: [{ path: 'other.md', content: '# not the declared main' }],
  message: 'missing main fixture',
})
await closeProjectStore()

const child = fork(new URL('./build-worker.mjs', import.meta.url), [], {
  stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
})

let update = null
child.on('message', message => {
  if (message?.t !== 'rpc') return
  if (message.m === 'updateProject') update = message.a
  child.send({ t: 'rpc-result', id: message.id, ok: true, result: null })
})

child.send({ t: 'build', name, projectsDir: root, kind: 'build', sourceRevision, acceptSeq: 1 })
const [code] = await new Promise(resolve => child.once('exit', (...args) => resolve(args)))

assert.equal(code, 1)
assert.deepEqual(update, [name, { buildStatus: 'error', pages: 0 }])
console.log('missing main clears stale pages before the worker exits')
