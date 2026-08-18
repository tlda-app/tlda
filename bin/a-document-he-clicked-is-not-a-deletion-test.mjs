#!/usr/bin/env node
// A document he clicked is not a deletion.
//
// Skip, 2026-08-13 ~23:35 EDT, on a live project he was working in:
//
//   "mirror sync fails. Source change for tilde was rejected by the server.
//    Source manifest still contains deleted file agents dot m d"
//
// He had added the file the only way the app offers: "I fucking added agents dot
// m d by clicking on your fucking agents dot m d link". Clicking the chip is the
// feature working. What followed was not.
//
// Measured before the fix, on the live server: `referencedSourcePaths` declared
// `AGENTS.md` and `the-list.md`, and the current revision held neither —
// `README.md` came back 200 and both of those 404. His edits had stopped
// reaching the paper entirely, for every push that touched any Markdown file.
//
// The instrument for "did a push land" is `currentRevision` on
// `/api/projects/:name/source-authority`, and nothing else. Twice that night I
// read `lastSourceMachineAt` as the last accepted push and reported it as
// evidence; `server/unified-server.mjs` writes it on RECEIPT, before
// `processProjectPush` runs, so it moves just as happily for a push that is
// about to be refused. A revision that does not move is the only thing that
// means nobody's work is landing.
//
// The cause is two halves of one push disagreeing. A Markdown project's closure
// is recomputed from the main file, and a chat-referenced root is not reachable
// from the main file — it is a second root, not a leaf. The rescan deleted it;
// the manifest, built from the same watch set, declared it; the server refuses a
// path that is in both.

import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createSourceSync } from '../daemon/source-sync.mjs'

let activeWatcher = null
function silentWatch() {
  const watcher = new EventEmitter()
  watcher.close = () => Promise.resolve()
  activeWatcher = watcher
  return watcher
}

const root = mkdtempSync(join(tmpdir(), 'tlda-clicked-chip-'))
const sent = []

try {
  // A Markdown project, and a second document that its main file never links to.
  writeFileSync(join(root, 'README.md'), '# tlda\n\nNo link to the other file.\n')
  writeFileSync(join(root, 'AGENTS.md'), '# agents\n\nGuidance.\n')

  const sync = createSourceSync({
  sourceChangeSettleDeadlineMs: 300_000,
    sourceBindingsFile: join(root, 'missing-bindings.json'),
    log: { info() {}, error() {}, warn() {} },
    sendMsg(message) { sent.push(message); return true },
    isConnected: () => true,
    resolveEditor: () => null,
    reconcileIntervalMs: 20,
    watch: silentWatch,
  })

  // ## He clicks the chip, and the project gains a second root

  // ### The server already holds both files and says so
  sync.bindSource('tlda', root)
  sync.sync([{
    name: 'tlda',
    sourceDir: root,
    mainFile: 'README.md',
    format: 'markdown',
    // What the click writes, and it is absolute — this is the shape the live
    // project carried when it wedged.
    referencedSourcePaths: [join(root, 'AGENTS.md')],
    sourceManifest: ['README.md', 'AGENTS.md'],
  }], { authoritativeRevisions: true })

  // ### He edits the main document, which is an ordinary thing to do
  writeFileSync(join(root, 'README.md'), '# tlda\n\nStill no link, one word more.\n')
  activeWatcher?.emit('change', join(root, 'README.md'))

  const deadline = Date.now() + 5000
  while (!sent.some(message => message.type === 'source-change') && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  const push = sent.find(message => message?.type === 'source-change' && message.project === 'tlda')
  assert.ok(push,
    'the daemon — pushes his edit; otherwise this story is about a push that never happened and proves nothing')

  // ### The push does not both declare the clicked document and delete it
  const declared = new Set(push.sourceManifest || [])
  const deleted = new Set(push.deletedFiles || [])

  assert.equal(declared.has('AGENTS.md'), true,
    'the manifest — still declares the document he clicked, because it is part of the project until he says otherwise')
  assert.equal(deleted.has('AGENTS.md'), false,
    'the push — does not also delete it; otherwise the server refuses the whole push and every edit in it, '
    + 'which is exactly what "sourceManifest still contains deleted file: AGENTS.md" was telling him')

  // ### Which is the condition the server actually enforces
  const bothHalves = [...deleted].filter(path => declared.has(path))
  assert.deepEqual(bothHalves, [],
    'no path — is in the manifest and the delete list at once, which is the rule the server rejects on '
    + '(server/routes/projects.mjs, "sourceManifest still contains deleted file")')

  // ### And his edit is in it
  assert.equal((push.files || []).some(file => file.path === 'README.md'), true,
    'his edit — is carried by the push; a push that is accepted and empty would satisfy everything above '
    + 'while still losing his work')

  console.log('a document he clicked is not a deletion: the push declares it and does not delete it')
} finally {
  rmSync(root, { recursive: true, force: true })
}
