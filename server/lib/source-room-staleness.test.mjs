import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSourceRoomDaemon } from './source-room-daemon.mjs'

// The bug this guards is not a subscription bug and does not behave like one.
//
// `headChanged` used to set `room.heldRevision = revision`, persist it, and
// broadcast `status: 'synced'` WITHOUT touching the room's text. The room then
// recorded that it held a revision whose content it did not have. Two things
// followed, and the second is why this file exists:
//
//   You saw old code. Measured on a live project: the server's copy of a file
//   carried four edits a FRESHLY MOUNTED editor did not show.
//
//   And your writing could be overwritten by it. On that broadcast the client
//   adopts the new revision as its base and records the stale text as saved, so
//   the next keystroke saves the whole stale document against a base the server
//   agrees is current — accepted, no conflict, no merge. Everything that landed
//   in between is replaced.
//
// The stamp is also what made it survive: a reopened room compares held against
// current, finds them equal, and correctly decides it has nothing to do. So a
// test that only reopens a room would have passed throughout.

const CONTENT = {
  r1: 'one\n',
  r2: 'one\ntwo\n',
  r3: 'one\ntwo\nthree\n',
}

function harness(root, head) {
  const lifecycle = {
    gitRepository: async () => ({ head: async () => head() }),
    readCurrentFile: async () => ({ content: Buffer.from(CONTENT[head()] || '') }),
    readRevisionFile: async (revisionId) => Buffer.from(CONTENT[revisionId] ?? ''),
  }
  const manager = {
    bindSource: () => {},
    sync: async () => {},
    // The room stands on its project branch like any other checkout.
    standOnWorkBranch: async () => ({ ok: true, status: 'already-on-it' }),
    queuePaths: () => {},
    headChanged: async () => ({ ok: true }),
  }
  return createSourceRoomDaemon({
    projectDir: project => join(root, project),
    readProject: async name => ({ name, mainFile: 'main.md' }),
    sourceLifecycleStore: async () => lifecycle,
    readClientSourceManifest: async () => ['main.md'],
    gitSyncManagerForProject: () => manager,
    pushDelayMs: 5,
    log: { info() {}, warn() {}, error() {} },
  })
}

test('a room that is open when a revision lands shows the new text, not just the new revision id', async () => {
  const root = mkdtempSync(join(tmpdir(), 'tlda-room-stale-open-'))
  let head = 'r1'
  const daemon = harness(root, () => head)
  try {
    const room = await daemon.getRoom('paper', 'main.md')
    assert.equal(room.ytext.toString(), CONTENT.r1)

    head = 'r2'
    await daemon.headChanged('paper', 'r2')

    // The stamp alone is what shipped. It is necessary and it was never
    // sufficient, so assert the text FIRST — asserting heldRevision on its own
    // is the assertion that passed while the app was broken.
    assert.equal(room.ytext.toString(), CONTENT.r2)
    assert.equal(room.heldRevision, 'r2')
  } finally {
    daemon.closeAll()
    rmSync(root, { recursive: true, force: true })
  }
})

test('a room reopened after revisions landed shows the current text rather than its restored snapshot', async () => {
  const root = mkdtempSync(join(tmpdir(), 'tlda-room-stale-reopen-'))
  let head = 'r1'
  const first = harness(root, () => head)
  try {
    const room = await first.getRoom('paper', 'main.md')
    assert.equal(room.ytext.toString(), CONTENT.r1)
  } finally {
    first.closeAll()
  }

  // Revisions land while nothing is open. The room's persisted Yjs snapshot
  // still holds r1, and on reopen that snapshot wins over the file — which is
  // why a freshly mounted editor was already stale.
  head = 'r3'
  const second = harness(root, () => head)
  try {
    const room = await second.getRoom('paper', 'main.md')
    assert.equal(room.ytext.toString(), CONTENT.r3)
    assert.equal(room.heldRevision, 'r3')
  } finally {
    second.closeAll()
    rmSync(root, { recursive: true, force: true })
  }
})

test('catching a room up does not take away text the person has not saved', async () => {
  const root = mkdtempSync(join(tmpdir(), 'tlda-room-stale-unsaved-'))
  let head = 'r1'
  const daemon = harness(root, () => head)
  try {
    const room = await daemon.getRoom('paper', 'main.md')
    // Typed and not yet submitted. An overwrite would be a worse bug than the
    // one being fixed, so the catch-up goes through a three-way merge.
    room.ytext.insert(room.ytext.length, 'mine, unsaved\n')

    head = 'r2'
    await daemon.headChanged('paper', 'r2')

    const text = room.ytext.toString()
    assert.ok(text.includes('mine, unsaved'), `the unsaved line was lost: ${JSON.stringify(text)}`)
    assert.ok(text.includes('two'), `the newly accepted line never arrived: ${JSON.stringify(text)}`)
  } finally {
    daemon.closeAll()
    rmSync(root, { recursive: true, force: true })
  }
})
