#!/usr/bin/env node
// Your collaborator pushes to Overleaf. Nobody's checkout is told.
//
// ---------------------------------------------------------------------------
// The story
//
// Alice has a paper linked to a git remote -- Overleaf, or any linked remote.
// Her collaborator, who does not use tlda at all, pushes a chapter to it from
// their own machine. tlda polls, pulls the change, and writes it into the
// project's source.
//
// Alice's laptop has that project linked. Her daemon is connected. She is not
// told. She keeps editing on a revision the project has already moved past,
// and she finds out by being refused -- or does not find out at all, because a
// clean three-way rebase quietly reconciles it and the version she was writing
// against is simply gone.
//
// ---------------------------------------------------------------------------
// Where it was, before tonight's sync strip (history, not the current path)
//
// On the OLD path, an accepted push notified every linked machine:
// `processProjectPush` (server/routes/projects.mjs) called
// `acceptedSourceMutationHandler`, and unified-server fanned
// `apply-source-update` out to every connected daemon. The Overleaf pull
// applied the remote's change with `processProjectPushSerialized` -- the
// inner function the wrapper called inside the lock -- and the fan-out ran
// from there.
//
// ---------------------------------------------------------------------------
// PASSES now. It did not for most of tonight; the history below is why.
//
// It is `-test.mjs` so it is discovered, which is deliberate: this describes
// something people are using tonight, not a feature that does not exist yet.
//
// ---------------------------------------------------------------------------
// What actually closed it, in order
//
// 1. The Overleaf pull was repointed at the new accept path
//    (server/lib/overleaf-sync.mjs, commit 1aaed25e9) -- fixed the plain
//    working-copy write and the client-manifest DB update gates.
// 2. `acceptedSourceMutationHandler` -- the fan-out to `apply-source-update`
//    -- was wired into the new accept for every carrier (commit 4d9dcbd06).
//    Before that commit, neither `acceptSourceSnapshot` nor
//    `applyAcceptedSourceEffects` ever set the field the fan-out checks for,
//    so nobody was told about ANY accepted push, not just an Overleaf pull.
// 3. Two unawaited-async calls in this file's own fixture (`bootstrap()`,
//    `readAuthority()`) silently returned Promises instead of values, which
//    hid the real result behind an assertion failure at fixture setup rather
//    than the fan-out assertion this file is named for.
//
// Separately, and never the reason this test was red: the OUTBOUND half --
// pushing a local edit back out to a linked Overleaf remote --
// (`pushSourceToOverleaf`, `server/lib/overleaf-sync.mjs`) already exists,
// already matches the no-rollback prepare-then-publish-last shape decided
// for tonight, and has never been called by anything, ever (unlike
// `prepareSourcePushToOverleaf`, which the dying `processProjectPushSerialized`
// still calls). Wiring never-executed code into the path Skip's paper
// travels, at this hour, was judged the wrong risk to take even though the
// gap is real. It stays unwired on purpose, alongside the WS handler, until
// something replaces the call site that still needs it.
import assert from 'assert/strict'
import { execFileSync } from 'child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import {
  closeProjectStore,
  createProject,
  initProjectStore,
  outputDir,
  projectDir,
  readSourceFile,
  sourceDir,
  sourceLifecycleStore,
  updateClientSourceManifest,
  updateProject,
} from '../server/lib/project-store.mjs'
import { syncOverleaf } from '../server/lib/overleaf-sync.mjs'
import { setAcceptedSourceMutationHandler, setSourceBindingTargetProvider } from '../server/routes/projects.mjs'

const root = mkdtempSync(join(tmpdir(), 'tlda-remote-pull-'))
await initProjectStore(root)

const git = (args, cwd) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
const write = (path, content) => writeFileSync(path, content)

const NAME = 'a-paper-with-a-collaborator'
const MANIFEST = ['main.tex', 'notes.tex']

function suppressBuilds(name) {
  mkdirSync(outputDir(name), { recursive: true })
  writeFileSync(join(outputDir(name), 'relevant-files.json'), JSON.stringify({ files: ['not-this-test.tex'] }))
}

// The same fixture shape bin/source-manifest-contract-test.mjs uses for its
// Overleaf stories: a bare remote, a seed clone, and a project wired to it.
async function paperWithARemote(name) {
  const remote = join(root, `${name}.git`)
  const seed = join(root, `${name}-seed`)
  mkdirSync(seed, { recursive: true })
  git(['init'], seed)
  git(['config', 'user.email', 'test@example.invalid'], seed)
  git(['config', 'user.name', 'test'], seed)
  write(join(seed, 'main.tex'), 'old main\n')
  write(join(seed, 'notes.tex'), 'old notes\n')
  git(['add', 'main.tex', 'notes.tex'], seed)
  git(['commit', '-m', 'seed'], seed)
  git(['init', '--bare', remote], root)
  git(['--git-dir', remote, 'symbolic-ref', 'HEAD', 'refs/heads/master'], root)
  git(['remote', 'add', 'origin', remote], seed)
  git(['push', '-u', 'origin', 'HEAD:master'], seed)

  createProject({ name, title: name, mainFile: 'main.tex', format: 'svg' })
  await updateProject(name, { pages: 1, buildStatus: 'success', overleafRemote: remote, autoSync: true })
  suppressBuilds(name)
  write(join(sourceDir(name), 'main.tex'), 'old main\n')
  write(join(sourceDir(name), 'notes.tex'), 'old notes\n')
  await updateClientSourceManifest(name, MANIFEST)
  const bootstrap = await (await sourceLifecycleStore(name)).bootstrap({
    expectedRevision: null,
    sourceManifest: MANIFEST,
    files: MANIFEST.map(path => ({ path, content: readSourceFile(name, path) })),
  })
  assert.equal(bootstrap.ok, true, 'the fixture needs a source authority to start from')

  const clone = join(projectDir(name), 'overleaf-clone')
  git(['clone', remote, clone], root)
  git(['config', 'user.email', 'test@example.invalid'], clone)
  git(['config', 'user.name', 'test'], clone)
  return { remote, startRevision: bootstrap.authority.currentRevision }
}

/** Someone who does not use tlda, pushing to the shared remote. */
function theCollaboratorPushes(remote) {
  const checkout = join(root, 'collaborators-machine')
  git(['clone', remote, checkout], root)
  git(['config', 'user.email', 'collaborator@example.invalid'], checkout)
  git(['config', 'user.name', 'collaborator'], checkout)
  write(join(checkout, 'main.tex'), 'the collaborator rewrote the introduction\n')
  git(['add', 'main.tex'], checkout)
  git(['commit', '-m', 'rewrite the introduction'], checkout)
  git(['push', 'origin', 'HEAD:master'], checkout)
}

// Every linked machine hears about an accepted change through this handler --
// unified-server registers one and fans `apply-source-update` out to every
// connected daemon. Standing in for that here, so "was anybody told" is a fact
// this test can observe rather than infer.
const toldTheMachines = []
setAcceptedSourceMutationHandler(async payload => { toldTheMachines.push(payload) })
const linkedBinding = { bindingId: 'alice-linked-checkout', daemonKey: 'alice-laptop:test' }
setSourceBindingTargetProvider(async project => project === NAME ? [linkedBinding] : [])

try {
  // ## A remote pull tells linked machines
  //
  // Alice has a paper linked to a git remote. A collaborator who does not use
  // tlda pushes to that remote. tlda pulls the change into the project, and
  // every linked machine has to be told about the accepted source revision.
  const { remote, startRevision } = await paperWithARemote(NAME)

  // ### The collaborator pushes to the remote
  theCollaboratorPushes(remote)
  assert.equal(
    git(['--git-dir', remote, 'show', 'master:main.tex'], root),
    'the collaborator rewrote the introduction\n',
    'the git remote — has the collaborator rewrite',
  )
  const before = toldTheMachines.length

  // ### tlda pulls the remote
  // tlda polls and pulls it in.
  await syncOverleaf(NAME)

  // The pull itself worked -- without this, the rest proves nothing, because
  // "nobody was told" and "nothing happened" look identical.
  assert.equal(
    readSourceFile(NAME, 'main.tex'),
    'the collaborator rewrote the introduction\n',
    'the project source — has the collaborator rewrite from the remote',
  )
  const authority = await (await sourceLifecycleStore(NAME)).readAuthority()
  assert.notEqual(
    authority.currentRevision,
    startRevision,
    'the source authority — moved to a new revision for the remote pull',
  )

  // ### Linked machines are notified
  // And every machine with this project linked has to hear about it.
  const told = toldTheMachines.slice(before)
  assert.ok(
    told.length > 0,
    "Alice's laptop — is told about the remote pull",
  )
  assert.equal(told[0].project, NAME)
  assert.equal(
    told[0].sourceRevision,
    authority.currentRevision,
    "Alice's laptop — is told the revision the remote pull landed on",
  )
  const lifecycle = await sourceLifecycleStore(NAME)
  const revision = lifecycle.readRevisionLifecycle(NAME, authority.currentRevision)
  assert.equal(
    revision.replicas[linkedBinding.bindingId].state,
    'pending',
    "Alice's laptop — has a retained source update command until her daemon receives it",
  )

  console.log('a remote pull tells every linked machine')
} finally {
  setAcceptedSourceMutationHandler(null)
  setSourceBindingTargetProvider(null)
  await closeProjectStore()
}
