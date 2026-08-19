#!/usr/bin/env node

// Extracted from bin/source-manifest-contract-test.mjs during the old-sync
// strip, for the same reason bin/source-project-store-contract-test.mjs was:
// these promises do not depend on `processProjectPush` or on any accept
// mechanism, so they survive the cut unchanged rather than dying with the
// file that happened to hold them.
//
// That file is now DEAD AT IMPORT -- `processProjectPush` no longer exists, so
// it throws a SyntaxError before a single assertion runs, and every promise
// left in it has been silently unenforced since. Its own header still says
// "nothing below is red because of this pass", which was true when written and
// is not now.
//
// **What is here is the part that was never entangled.** In particular the
// daemon check below is the INCIDENT TEST -- three deleted passages of Skip's
// paper -- and `pm-sync`'s standing instruction on the strip is that it must
// survive in some form. It survives here, unchanged, including the comments
// that record which assertion deleted what.
//
// What did NOT come across, and is still owed rather than retired: the
// crash-recovery window ordering, the `.source-transactions` recovery states,
// the credential-non-leak checks, and the Overleaf push/rollback compensation
// invariant. Those are expressed against a mechanism that no longer exists --
// `acceptRevision` is a single atomic `commit-tree`, with no separate
// snapshot/journal phase -- so they need re-derivation against the new
// mechanism's real failure points, not a mechanical repoint. See the header of
// bin/source-manifest-contract-test.mjs for the full disposition.

import assert from 'assert/strict'
import { EventEmitter } from 'events'
import fs from 'fs'
import os from 'os'
import path from 'path'

import { normalizeSourceManifest, sourceFilesFromApiResponse } from '../shared/source-manifest.mjs'
import { pushMcpSourceFiles } from '../mcp-server/source-push-orchestration.mjs'
import { createSourceSync } from '../daemon/source-sync.mjs'

function write(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, content)
}

async function assertDaemonSourceChangeSeparatesOwnershipFromBytePayload(root) {
  const sourceRoot = path.join(root, 'daemon-source-change')
  fs.mkdirSync(sourceRoot, { recursive: true })
  write(path.join(sourceRoot, 'main.tex'), 'first\n')
  write(path.join(sourceRoot, 'legacy-preserved.tex'), 'server-owned bytes\n')

  const sent = []
  const watchers = []
  const sourceSync = createSourceSync({
  sourceChangeSettleDeadlineMs: 300_000,
    sourceBindingsFile: path.join(root, 'source-bindings.json'),
    log: { info() {}, warn() {}, error() {} },
    sendMsg(message) { sent.push(message); return true },
    isConnected: () => true,
    resolveEditor: () => null,
    reconcileIntervalMs: 60_000,
    watch(paths) {
      const watcher = new EventEmitter()
      watcher.paths = paths
      watcher.close = () => Promise.resolve()
      watchers.push(watcher)
      return watcher
    },
  })

  try {
    sourceSync.bindSource('daemon-source-change', sourceRoot)
    sourceSync.sync([{
      name: 'daemon-source-change',
      mainFile: 'main.tex',
      format: 'svg',
      sourceRevision: 'revision-1',
      sourceManifest: ['legacy-preserved.tex'],
    }], { authoritativeRevisions: true })
    assert.equal(sent.length, 0, 'daemon sync must not replay every watched source body on connect')
    assert.equal(watchers.length, 1, 'daemon source watcher must start')

    write(path.join(sourceRoot, 'main.tex'), 'second\n')
    watchers[0].emit('change', path.join(sourceRoot, 'main.tex'))
    await new Promise(resolve => setTimeout(resolve, 250))

    assert.equal(sent.length, 1, 'daemon source mutation must send one source-change')
    assert.deepEqual(sent[0].files.map(file => file.path), ['main.tex'], 'daemon files must contain only byte-bearing changed paths')
    assert.equal(sent[0].files[0].content, 'second\n')
    assert.deepEqual(sent[0].sourceManifest, ['legacy-preserved.tex', 'main.tex'], 'daemon sourceManifest must preserve inherited ownership around the changed byte inventory')
    // The base is what this checkout HOLDS (materializedRevision), never the
    // server head it has merely been told about. This fixture never materializes
    // anything, so it holds nothing and claims nothing — `null` is the honest
    // value here, not a weakened assertion. The case where a real revision IS
    // held is covered over the wire in
    // server/lib/push-base-means-content.test.mjs.
    //
    // This asserted 'revision-1' — "reads the durable observed server head" —
    // until 2026-08-18. That is the defect written down as a requirement: a
    // source-change carries whole file contents, so a base naming a revision the
    // sender was refused permission to materialize is a claim it cannot honour,
    // and the server accepting it deleted three passages of his paper.
    assert.equal(sent[0].expectedRevision, null)

    write(path.join(sourceRoot, 'main.tex'), 'third\n')
    watchers[0].emit('change', path.join(sourceRoot, 'main.tex'))
    await new Promise(resolve => setTimeout(resolve, 250))
    assert.equal(sent.length, 1, 'a later local edit waits behind the accepted source operation')
    assert.equal(sourceSync.handleSourceChangeResult({
      type: 'source-change-result', project: 'daemon-source-change', requestId: sent[0].requestId,
      ok: true, sourceRevision: 'revision-2',
    }), true)
    assert.equal(sent.length, 2, 'the queued local edit is emitted after acceptance')
    // Same value as before, different reason, and the reason is the contract:
    // the accept advanced what this checkout HOLDS, so it may claim it.
    assert.equal(sent[1].expectedRevision, 'revision-2', 'queued emission claims the revision the accept made this checkout hold')
    assert.equal(sourceSync.handleSourceChangeResult({
      type: 'source-change-result', project: 'daemon-source-change', requestId: sent[1].requestId,
      ok: false, status: 'stale-base', authority: { state: 'current', currentRevision: 'revision-3' },
    }), true)
    const sourceChanges = sent.filter(message => message.type === 'source-change')
    assert.equal(sourceChanges.length, 3, 'stale-base observation emits one retry')
    // The clearest statement of the rule in this file. The rejection named
    // 'revision-3' as the server's head; this checkout still holds 'revision-2',
    // which is what the accept above gave it, and 'revision-3' never came down.
    // So the retry claims 'revision-2' and lets the server merge from a base it
    // can actually reason about — rather than claiming 'revision-3' and handing
    // over a whole file that is 'revision-3' MINUS whatever it never received.
    //
    // Asserted 'revision-3' until 2026-08-18. Three passages of his paper were
    // deleted by exactly that claim.
    assert.equal(sourceChanges[2].expectedRevision, 'revision-2', 'retry claims the revision this checkout holds, not the head the rejection named')
  } finally {
    sourceSync.closeAll()
  }
}

// The route half of this check is gone with `PUT /:name/source/:file`. What it
// asserted -- that the manifest comes from the caller and is never synthesized
// from server state -- is now the accept carrier's own contract and is checked
// where that carrier is.
//
// The client half below is NOT about the manifest mechanism and does not die
// with it. It is the guard on the editor's write: send the revision the buffer
// was loaded at, and do not re-read authority immediately before overwriting a
// loaded buffer. Three passages of Skip's paper were deleted by exactly that,
// per the note above at `assertRetryClaimsHeldRevision`.
function assertEditorWriteCarriesItsBuffersRevision() {
  const callerSource = fs.readFileSync(path.join(process.cwd(), 'src/shapes/FleetSourceEditorShape.tsx'), 'utf8')
  const writeStart = callerSource.indexOf('const writeSourceFile = async')
  const writeEnd = callerSource.indexOf('const trackedAnchorStatusText', writeStart)
  assert.ok(writeStart >= 0 && writeEnd > writeStart, 'fleet source editor writeSourceFile not found')
  const writeSource = callerSource.slice(writeStart, writeEnd)
  assert.match(writeSource, /sourceManifest/, 'fleet source editor write must send sourceManifest')
  assert.match(writeSource, /expectedRevision/, 'fleet source editor write must send expectedRevision')
  assert.doesNotMatch(writeSource, /\/source-authority/, 'fleet source editor must not refresh authority immediately before overwriting a loaded buffer')
  assert.match(writeSource, /loadSourceFiles\(\)/, 'fleet source editor write must base manifest on current client inventory')
  assert.match(callerSource, /X-TLDA-Source-Revision/, 'fleet source editor load must retain the revision served with its source bytes')
  assert.match(writeSource, /expectedRevision,\s*\n/, 'fleet source editor write must send the caller buffer revision')
}

function assertMcpCallersCarryManifest() {
  const reportDocPost = fs.readFileSync(path.join(process.cwd(), 'mcp-server/report-doc-post.mjs'), 'utf8')
  assert.match(reportDocPost, /sourceManifest:\s*normalizeSourceManifest\(\[mainFile\]/, 'MCP report sharing must send sourceManifest')
  const index = fs.readFileSync(path.join(process.cwd(), 'mcp-server/index.mjs'), 'utf8')
  const pushStart = index.indexOf("if (name === 'push')")
  const pushEnd = index.indexOf('// Shadow-branch commit', pushStart)
  assert.ok(pushStart >= 0 && pushEnd > pushStart, 'MCP push handler not found')
  const pushHandler = index.slice(pushStart, pushEnd)
  assert.match(pushHandler, /pushMcpSourceFiles\(\{[\s\S]*\bproject,[\s\S]*\bfiles,[\s\S]*session:\s*process\.env\.CLAUDE_SESSION,[\s\S]*editedBy:\s*process\.env\.FLEET_ID,[\s\S]*\bserverFetch,[\s\S]*\}\)/, 'MCP push handler must use tested source push orchestration')
  assert.doesNotMatch(pushHandler, /catch\s*\{[^}]*\}/, 'MCP push must fail closed if current authored inventory cannot be read')
}

async function assertMcpPushOrchestrationBehavior() {
  const current = sourceFilesFromApiResponse({ files: ['main.tex', 'notes.tex'] })
  const pushed = ['main.tex', 'extra.tex']
  assert.deepEqual(
    normalizeSourceManifest([...current, ...pushed], { format: 'svg', mainFile: 'main.tex' }),
    ['extra.tex', 'main.tex', 'notes.tex'],
  )
  assert.throws(() => sourceFilesFromApiResponse(['main.tex']), /files array/)
  assert.throws(() => sourceFilesFromApiResponse({ files: 'main.tex' }), /files array/)
  assert.throws(() => sourceFilesFromApiResponse({ files: ['main.tex', 1] }), /files array/)

  const files = [
    { path: 'main.tex', content: 'new main\n' },
    { path: 'extra.tex', content: 'extra\n' },
  ]
  const calls = []
  await pushMcpSourceFiles({
    project: 'mcp-project',
    files,
    session: 'session-1',
    serverFetch: async (urlPath, options) => {
      calls.push({ urlPath, options })
      if (urlPath === '/api/projects/mcp-project') return { format: 'svg', mainFile: 'main.tex' }
      if (urlPath === '/api/projects/mcp-project/files') return { files: ['main.tex', 'notes.tex'] }
      if (urlPath === '/api/projects/mcp-project/source-authority') return { currentRevision: 'revision-1' }
      // The MCP push moved off /push onto the JSON accept carrier. The stub
      // predated that, so this test aborted on `unexpected fetch` before it
      // reached anything it was written to check -- which reads as the strip
      // having broken the manifest contract when the strip is what it is
      // catching up with.
      if (urlPath === '/api/projects/mcp-project/source-snapshot') return { ok: true }
      throw new Error(`unexpected fetch ${urlPath}`)
    },
  })
  assert.deepEqual(calls.map(call => call.urlPath), [
    '/api/projects/mcp-project',
    '/api/projects/mcp-project/files',
    '/api/projects/mcp-project/source-authority',
    '/api/projects/mcp-project/source-snapshot',
  ])
  const pushBody = JSON.parse(calls[3].options.body)
  assert.deepEqual(pushBody.files, files)
  assert.deepEqual(pushBody.sourceManifest, ['extra.tex', 'main.tex', 'notes.tex'])
  assert.equal(pushBody.session, 'session-1')
  assert.equal(pushBody.expectedRevision, 'revision-1')

  for (const filesResponse of [
    Promise.reject(new Error('files failed')),
    { files: 'main.tex' },
    { files: ['main.tex', 1] },
  ]) {
    const failedCalls = []
    await assert.rejects(
      () => pushMcpSourceFiles({
        project: 'mcp-project',
        files,
        session: 'session-1',
        serverFetch: async (urlPath, options) => {
          failedCalls.push({ urlPath, options })
          if (urlPath === '/api/projects/mcp-project') return { format: 'svg', mainFile: 'main.tex' }
          if (urlPath === '/api/projects/mcp-project/files') return filesResponse
          if (urlPath === '/api/projects/mcp-project/source-authority') return { currentRevision: 'revision-1' }
          if (urlPath === '/api/projects/mcp-project/source-snapshot') return { ok: true }
          throw new Error(`unexpected fetch ${urlPath}`)
        },
      }),
      /files failed|files array/,
    )
    // The point of this case: a bad file listing must never reach the carrier.
    // It checked /push, which the code no longer calls, so it would have passed
    // no matter what the code did.
    assert.equal(failedCalls.some(call => call.urlPath === '/api/projects/mcp-project/source-snapshot'), false)
  }
}

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tlda-source-daemon-caller-'))
  try {
    await assertDaemonSourceChangeSeparatesOwnershipFromBytePayload(root)
    assertEditorWriteCarriesItsBuffersRevision()
    assertMcpCallersCarryManifest()
    await assertMcpPushOrchestrationBehavior()
    console.log('PASS source daemon and caller contract')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
}

main().catch(e => {
  console.error(e)
  process.exit(1)
})
