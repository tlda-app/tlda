#!/usr/bin/env node
//
// **Recording a replica is not sending it.**
//
// `recordReplicaTargets` writes pending replica rows. Something else has to
// read them and send `apply-source-update` to each daemon — and on the new
// accept path nothing did. The old route reached that dispatch by tagging its
// result with `acceptedSourceMutation`, which `runSerializedProjectSourceOperation`
// notices on the way out; this path cannot use that hook, because the
// serialized operation returns BEFORE the effects run, so the handler would
// fire while there is nothing recorded to send.
//
// Left open, every carrier records replicas that nothing dispatches. **No
// linked machine is ever told the paper moved, with no error anywhere** — a
// person's laptop simply stops receiving their own edits. That is the
// working-copy gap's shape one more time, and it is why this asserts the SEND
// rather than the record: the record was always there.
//
// It also asserts the echo guard, which is the half that bites in the other
// direction. The room checkpoint accepts through the same path, and the room
// skips a fan-out message whose origin is a source room. If the accept does not
// carry that origin, the room re-applies its own edit to itself.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  acceptSourceSnapshot, setAcceptedSourceMutationHandler, setSourceBindingTargetProvider,
} from '../server/routes/projects.mjs'
import { closeProjectStore, createProject, initProjectStore } from '../server/lib/project-store.mjs'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tells-machines-'))
await initProjectStore(path.join(root, 'projects'))
const project = 'paper'
await createProject({ name: project, format: 'svg', mainFile: 'main.tex' })

// A bound checkout on some machine, so there is somebody to tell.
setSourceBindingTargetProvider(async () => ([
  { bindingId: 'a-binding', daemonKey: 'a-machine', sourceDir: '/somewhere/checkout' },
]))

const told = []
setAcceptedSourceMutationHandler(async message => { told.push(message) })

const first = await acceptSourceSnapshot(project, {
  expectedRevision: null,
  sourceManifest: ['main.tex'],
  files: [{ path: 'main.tex', content: 'the paper\n' }],
  sourceDaemonKey: 'the-pushing-machine',
})
assert.equal(first.status, 200, `the accept succeeded (${JSON.stringify(first.body).slice(0, 200)})`)

// The dispatch is fire-and-forget, like the mirror and the build, so it lands
// on a later tick rather than before the response.
for (let i = 0; i < 50 && told.length === 0; i += 1) await new Promise(r => setTimeout(r, 20))

assert.ok(first.body.postAcceptEffects.includes('replicas'),
  'the replica rows were recorded')
assert.equal(told.length > 0, true,
  'TOLD THE MACHINES: the accept dispatched the replica, rather than only recording it')
assert.ok(first.body.postAcceptEffects.includes('replica-dispatch'),
  'and says so, so a caller can tell preserved from merely accepted')

const message = told[0]
assert.equal(message.project, project)
assert.equal(message.sourceRevision, first.body.sourceRevision,
  'naming the revision that was accepted')
assert.deepEqual(message.files.map(file => file.path), ['main.tex'],
  'and the paths that moved')

// **The echo guard.** The origin has to survive into the fan-out, or a machine
// materializes its own push back over the file its author is still editing.
assert.equal(message.sourceDaemonKey, 'the-pushing-machine',
  'THE ECHO GUARD: the fan-out knows which machine the change came from')

await closeProjectStore()
fs.rmSync(root, { recursive: true, force: true })
console.log('an accept that tells the machines: the replica is dispatched, not just recorded')
process.exit(0)
