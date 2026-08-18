// A refused push reaches the author's checkout, across the wire that carries it.
//
// `199c85947` made a refused push nameable: the server already committed the
// incoming snapshot before testing staleness, so the work existed as a real
// commit and only lacked a ref. `refs/tlda/refused/<project>` names it, and the
// daemon writes `refs/tlda/refused/HEAD` into the checkout, so a stuck author
// runs `git diff HEAD refs/tlda/refused/HEAD` and sees both sides as two real
// commits instead of one flattened merge blob on a server.
//
// THE REASON THIS TEST EXISTS. `bin/a-commit-per-accepted-push-test.mjs` proves
// the accept path, the bundle format and the daemon receiver, and says plainly
// that it does not cross the WebSocket hop. That hop had a live defect in it:
// `mirrorShadowViaDaemon` rebuilds its params object field by field, and
// `refusedRevision` was not among the fields — produced by the server, consumed
// by the daemon, dropped in between, so `199c85947` would have shipped inert.
// `3cffbbce2` fixed it and `448ffa7ff` made the adapter test assert the whole
// payload. Both are unit-level. Nothing yet proves the three components are
// JOINED: that a refusal on the server reaches a real daemon over a real socket
// and lands as a ref in a real checkout.
//
// So this crosses exactly that, on a fixture:
//
//   real spawned unified-server  ->  real /ws/fleet-daemon socket
//   ->  the daemon's own mirror-shadow-ref handler (bin/fleet-daemon.mjs:1257
//       maps the op straight to shadowMirror.mirrorShadowRef, which is what
//       this test hands the frame to)
//   ->  a real git checkout
//
// And it asserts the REF IN THE CHECKOUT, never the sender's return value. A
// proof that reads what `mirrorShadowRef` returned is still reading the sending
// side; the only thing that matters to a stuck author is what `git rev-parse`
// says on their own disk.
//
// It is written to fail on the pre-fix code. With `3cffbbce2` reverted the
// frame arrives with `refusedRevision` undefined, no ref is written, and the
// rev-parse below fails — verified by reverting it, not by assuming.
import assert from 'node:assert/strict'
import { execFile as execFileCb } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { promisify } from 'node:util'

import { createShadowMirror } from '../../daemon/shadow-mirror.mjs'
import { closeProjectStore, createProject, initProjectStore, updateProject } from './project-store.mjs'
import { deliver, openDaemon, startServer, stopServer, unusedPort } from './durable-source-wire-harness.mjs'

const execFile = promisify(execFileCb)
const git = (cwd, args) => execFile('git', args, { cwd, timeout: 20000 })

const ACCEPTED = 'The paragraph that landed.\n'
const REFUSED = 'The paragraph he could not land.\n'

test('a push the server refuses lands as a ref in the daemon\'s checkout', { timeout: 180_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'tlda-refused-wire-'))
  const projectsDir = join(root, 'projects')
  const fleetDb = join(root, 'fleet.db')
  const bindingRegistry = join(root, 'source-bindings.json')
  const checkout = join(root, 'checkout')
  const project = 'paper-refused-wire'
  const port = await unusedPort()

  let server = null
  let ws = null

  try {
    // The author's checkout: an ordinary git repository, the way theirs is.
    mkdirSync(checkout, { recursive: true })
    await git(checkout, ['init', '-b', 'main'])
    await git(checkout, ['config', 'user.name', 'author'])
    await git(checkout, ['config', 'user.email', 'author@example.test'])
    writeFileSync(join(checkout, 'main.tex'), 'first draft\n')
    await git(checkout, ['add', 'main.tex'])
    await git(checkout, ['commit', '-m', 'First draft'])

    await initProjectStore(projectsDir)
    createProject({ name: project, mainFile: 'main.tex', format: 'svg' })
    await updateProject(project, { pages: 1, buildStatus: 'success' })
    mkdirSync(join(projectsDir, project, 'output'), { recursive: true })
    writeFileSync(join(projectsDir, project, 'output', 'relevant-files.json'), JSON.stringify(['main.tex']))
    await closeProjectStore()

    server = await startServer({ port, projectsDir, fleetDb, bindingRegistry })

    // The daemon side is the daemon's own handler, not a re-implementation:
    // bin/fleet-daemon.mjs registers 'mirror-shadow-ref' as
    // shadowMirror.mirrorShadowRef and hands it the frame, which is what
    // happens here.
    const mirrored = []
    const mirror = createShadowMirror({ getSourceDir: () => checkout, log: { info() {}, warn() {}, error() {} } })
    ws = await openDaemon(port, {
      machineId: 'refused-wire-machine',
      sourceBindings: [{ bindingId: 'refused-wire-binding', project }],
      onRpc: async message => {
        if (message.op !== 'mirror-shadow-ref') return {}
        const result = await mirror.mirrorShadowRef(message)
        mirrored.push({ frame: message, result })
        return result
      },
    })

    const push = (requestId, content, expectedRevision, outboxId) => deliver(ws, {
      type: 'source-change', project, requestId, expectedRevision,
      sourceBindingId: 'refused-wire-binding',
      files: [{ path: 'main.tex', content }],
      deletedFiles: [], sourceManifest: ['main.tex'], editedBy: 'author',
      __daemon_outbox_id: outboxId,
    })

    // One accepted push, so there is an accepted revision to be stale against.
    const acceptedReplies = await push('R-accept', ACCEPTED, null, 'D-accept')
    const accepted = acceptedReplies.find(m => m.type === 'source-change-result')
    assert.equal(accepted?.ok, true, JSON.stringify(acceptedReplies))

    // Then a push against a base the server has moved past. submit commits the
    // incoming snapshot before it tests staleness, so this refusal has a real
    // commit behind it — the thing that had no ref.
    const refusedReplies = await push('R-refuse', REFUSED, 'sha256:0000000000000000000000000000000000000000000000000000000000000000', 'D-refuse')
    const refusedResult = refusedReplies.find(m => m.type === 'source-change-result')
    assert.equal(refusedResult?.ok, false, JSON.stringify(refusedReplies))
    assert.equal(refusedResult?.status, 'stale-base', JSON.stringify(refusedResult))

    // The refusal mirrors on the refusal rather than riding the next accept —
    // a stalemate is a run of refusals with no accept between them — and the
    // server fires it without awaiting, so wait for the checkout rather than
    // for the reply.
    const deadline = Date.now() + 30_000
    let refusedSha = null
    while (Date.now() < deadline) {
      try {
        const { stdout } = await git(checkout, ['rev-parse', 'refs/tlda/refused/HEAD'])
        refusedSha = stdout.trim()
        break
      } catch {
        await new Promise(resolve => setTimeout(resolve, 200))
      }
    }

    assert.ok(refusedSha, 'refs/tlda/refused/HEAD exists in the checkout after a refused push'
      + ` (mirror frames seen: ${JSON.stringify(mirrored.map(m => ({ op: m.frame.op, refusedRevision: m.frame.refusedRevision })))})`)

    // The ref must carry HIS text — the push that was refused, not the one that
    // landed. This is the assertion the whole chain exists for.
    const { stdout: refusedText } = await git(checkout, ['show', 'refs/tlda/refused/HEAD:main.tex'])
    assert.equal(refusedText, REFUSED, 'the refused ref carries the text the server would not take')

    // And both sides are reachable as two real commits, which is what makes
    // `git diff HEAD refs/tlda/refused/HEAD` the resolution path rather than a
    // merge blob nobody can open.
    const { stdout: headSha } = await git(checkout, ['rev-parse', 'HEAD'])
    assert.notEqual(headSha.trim(), refusedSha, 'the refused commit is a sibling of HEAD, not HEAD itself')
    const { stdout: diff } = await git(checkout, ['diff', 'HEAD', 'refs/tlda/refused/HEAD'])
    assert.ok(diff.includes(REFUSED), 'git diff HEAD refs/tlda/refused/HEAD shows the refused side')
  } finally {
    if (ws) {
      ws.close()
      await new Promise(resolve => ws.once('close', resolve))
    }
    await stopServer(server)
    await closeProjectStore().catch(() => {})
    rmSync(root, { recursive: true, force: true })
  }
})
