#!/usr/bin/env node
// What the app promises when more than one person is working on a paper.
//
// Skip's matrix: one daemon plus the editor is a baseline, two daemons is a
// baseline, two daemons plus the editor is where real collaboration starts,
// and the pattern is "two plus n". These are the daemon rows. The editor is a
// participant of the same kind and slots in beside them.
//
// The count is a loop bound here, not a mechanism — the two-person story and
// the six-person story run the same code, so nothing needs rewriting when
// someone asks for four.
import assert from 'assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import {
  closeProjectStore,
  createProject,
  initProjectStore,
  outputDir,
  readSourceFile,
  sourceLifecycleStore,
  updateProject,
} from '../server/lib/project-store.mjs'
import { processProjectPush } from '../server/routes/projects.mjs'
import { daemonOn, everyoneArrivesAt } from './lib/source-collaborators.mjs'

const root = mkdtempSync(join(tmpdir(), 'tlda-collaborators-'))
await initProjectStore(root)

function suppressBuilds(name) {
  mkdirSync(outputDir(name), { recursive: true })
  writeFileSync(join(outputDir(name), 'relevant-files.json'), JSON.stringify({ files: ['not-this-test.tex'] }))
}

async function paper(name, manifest, opening) {
  createProject({ name, title: name, mainFile: 'main.tex', format: 'svg' })
  await updateProject(name, { pages: 1, buildStatus: 'success' })
  suppressBuilds(name)
  const start = await processProjectPush(name, {
    expectedRevision: null,
    sourceManifest: manifest,
    files: manifest.map(path => ({ path, content: opening(path) })),
  })
  assert.equal(start.status, 200, `the paper had to exist before anyone could edit it: ${start.error}`)
  return start.sourceRevision
}

const authorityOf = async name => (await sourceLifecycleStore(name)).readAuthority()

try {
  // ---------------------------------------------------------------------
  // Alice is on her laptop, Bob is on his. They pull the same draft, edit
  // different files, and both go to lunch. Both edits have to be in the paper
  // when they get back.
  //
  // This is the story c730ef058 fixed. Before it, Bob's push was refused for
  // being behind — though the server had already worked out that the two of
  // them had not touched each other's files.
  // ---------------------------------------------------------------------
  {
    const name = 'two-daemons-different-files'
    const manifest = ['main.tex', 'notes.tex']
    await paper(name, manifest, path => `opening ${path}\n`)

    const alice = daemonOn('Alice', 'her laptop', name, manifest)
    const bob = daemonOn('Bob', 'his desktop', name, manifest)
    await everyoneArrivesAt(alice, bob)

    const aliceResult = await alice.edits('main.tex', 'alice rewrites the introduction\n').pushes()
    assert.equal(aliceResult.status, 200, `${alice.describe} could not push at all: ${aliceResult.error}`)

    const bobResult = await bob.edits('notes.tex', 'bob adds a note\n').pushes()
    assert.equal(bobResult.status, 200, `${bob.describe} was refused, though he touched a file nobody else did`)

    assert.equal(readSourceFile(name, 'main.tex'), 'alice rewrites the introduction\n', "alice's edit to main.tex was lost")
    assert.equal(readSourceFile(name, 'notes.tex'), 'bob adds a note\n', "bob's edit to notes.tex was lost")
  }

  // ---------------------------------------------------------------------
  // A reading group. Six people, six files, everyone starting from the same
  // draft, nobody coordinating. The last one to push is five revisions behind
  // and every revision between hers and her starting point was itself a rebase.
  //
  // "Two plus n." Nothing below knows the number six.
  // ---------------------------------------------------------------------
  {
    const name = 'a-reading-group'
    const people = [
      ['Alice', 'her laptop'], ['Bob', 'his desktop'], ['Carol', 'the lab machine'],
      ['Dan', 'his iPad'], ['Erin', 'the office box'], ['Frank', 'his laptop'],
    ]
    const manifest = people.map((_, index) => `section-${index + 1}.tex`)
    await paper(name, manifest, path => `opening ${path}\n`)

    const daemons = people.map(([who, where]) => daemonOn(who, where, name, manifest))
    await everyoneArrivesAt(...daemons)

    // Everyone edits before anyone pushes. That is what "same starting point"
    // means, and it is the case that has to hold.
    daemons.forEach((daemon, index) => daemon.edits(manifest[index], `${daemon.who} wrote this\n`))

    for (const daemon of daemons) {
      const result = await daemon.pushes()
      assert.equal(result.status, 200, `${daemon.describe} was refused: ${result.error}`)
    }

    daemons.forEach((daemon, index) => {
      assert.equal(
        readSourceFile(name, manifest[index]),
        `${daemon.who} wrote this\n`,
        `${daemon.who} lost ${manifest[index]} — it was edited from the same draft as everyone else's`,
      )
    })

    // The stored revision has to carry all six. A revision holding only the
    // last push reads as convergent on disk today and destroys the other five
    // the next time anyone rebases against it.
    const authority = await authorityOf(name)
    const stored = (await sourceLifecycleStore(name)).readRevision(authority.currentRevision)
    const byPath = new Map(stored.files.map(file => [file.path, Buffer.from(file.content, 'base64').toString()]))
    daemons.forEach((daemon, index) => {
      assert.equal(
        byPath.get(manifest[index]),
        `${daemon.who} wrote this\n`,
        `the recorded revision does not contain ${daemon.who}'s ${manifest[index]}, so the next rebase will drop it`,
      )
    })
  }

  // ---------------------------------------------------------------------
  // Alice and Bob both rewrite the same paragraph of main.tex from the same
  // draft. One of them has to be told. The one who is told must not have
  // destroyed the other's work on the way to being told — the push route
  // writes files to disk before the lifecycle store adjudicates, so a refusal
  // that leaves bytes behind is the whole hazard.
  //
  // Carol is in the room too, editing a file neither of them touched. Her work
  // is the bystander: it must not be rolled back by somebody else's argument.
  // ---------------------------------------------------------------------
  {
    const name = 'two-daemons-same-paragraph'
    const manifest = ['main.tex', 'notes.tex']
    await paper(name, manifest, path => `opening ${path}\n`)

    const alice = daemonOn('Alice', 'her laptop', name, manifest)
    const bob = daemonOn('Bob', 'his desktop', name, manifest)
    const carol = daemonOn('Carol', 'the lab machine', name, manifest)
    await everyoneArrivesAt(alice, bob, carol)

    const aliceResult = await alice.edits('main.tex', 'alice rewrites the paragraph\n').pushes()
    assert.equal(aliceResult.status, 200, `${alice.describe} could not push: ${aliceResult.error}`)

    const bobResult = await bob.edits('main.tex', 'bob rewrites the same paragraph\n').pushes()
    assert.equal(bobResult.status, 409, `${bob.describe} overwrote Alice's paragraph instead of being told about it`)
    assert.equal(bobResult.lifecycleStatus, 'stale-base')
    assert.equal(
      readSourceFile(name, 'main.tex'),
      'alice rewrites the paragraph\n',
      "bob's refused push still left his bytes on top of alice's paragraph",
    )

    // The refusal names the file they actually fought over, and only that one.
    // A conflict marker dropped into a file nobody edited is how a good file
    // gets destroyed by somebody else's rejection.
    assert.deepEqual(
      bobResult.evidence.classifications.filter(item => item.status === 'conflict').map(item => item.path),
      ['main.tex'],
      'the refusal blamed a file that was not in the argument',
    )

    const carolResult = await carol.edits('notes.tex', 'carol adds a note\n').pushes()
    assert.equal(carolResult.status, 200, `${carol.describe} was refused because Alice and Bob were arguing about a different file`)
    assert.equal(readSourceFile(name, 'notes.tex'), 'carol adds a note\n', "carol's note was lost to someone else's conflict")
    assert.equal(readSourceFile(name, 'main.tex'), 'alice rewrites the paragraph\n', "alice's paragraph was lost when carol pushed")
  }

  // ---------------------------------------------------------------------
  // Bob has been on a plane. His machine has pushed nothing since breakfast,
  // so the revision it holds is from breakfast, while Alice has pushed four
  // times. He lands, opens his laptop, and saves a file before anything has
  // caught him up.
  //
  // Every one of Alice's four revisions has to survive Bob's arrival.
  //
  // This is a claim about a stale base, not about what a client can receive.
  // The per-machine daemon does have a receive side — `applyAcceptedSourceUpdate`
  // in daemon/source-sync.mjs — and being several revisions behind is simply
  // where any client sits between updates.
  // ---------------------------------------------------------------------
  {
    const name = 'a-machine-that-has-been-offline'
    const manifest = ['main.tex', 'notes.tex', 'refs.tex']
    await paper(name, manifest, path => `opening ${path}\n`)

    const bob = daemonOn('Bob', 'his desktop', name, manifest)
    await bob.arrives()
    const breakfast = bob.heldRevision

    const alice = daemonOn('Alice', 'her laptop', name, manifest)
    await alice.arrives()
    for (const round of [1, 2, 3, 4]) {
      const result = await alice.edits('main.tex', `alice, revision ${round}\n`).pushes()
      assert.equal(result.status, 200, `${alice.describe} could not push round ${round}: ${result.error}`)
    }

    assert.equal(bob.heldRevision, breakfast, "the fixture is wrong: Bob's participant moved off the revision it started on without pushing")

    const bobResult = await bob.edits('refs.tex', 'bob adds a citation\n').pushes()
    assert.equal(bobResult.status, 200, `${bob.describe} was refused for being four revisions behind on a file Alice never touched`)

    assert.equal(readSourceFile(name, 'refs.tex'), 'bob adds a citation\n', "bob's citation was lost")
    assert.equal(
      readSourceFile(name, 'main.tex'),
      'alice, revision 4\n',
      "bob's stale push overwrote main.tex with the copy his machine had from breakfast",
    )
  }

  console.log('collaborators on one project: all stories passed')
} finally {
  await closeProjectStore()
}
