#!/usr/bin/env node
// A refusal that names what differed.
//
// bregman, 2026-08-18. Skip's source pushes failed all night on the same three
// lines, four times over two and a half hours:
//
//   source change rejected for bregman: Source transaction failed: stale-base
//   source change rejected for bregman: Source transaction failed: stale-base
//   source change rejected for bregman: Proposed snapshot does not match sourceManifest
//
// That message says the two sets differ and nothing else. Which WAY they differ
// is the entire diagnosis, and the two directions are opposite bugs: a path the
// manifest declares and the snapshot lacks is a file the daemon never sent; a
// path the snapshot holds and the manifest omits is one it should have deleted.
// Reconstructing that by hand off the live volume took hours, and it has to be
// redone from scratch every time the sets move.
//
// So the refusal carries the difference. This asserts the text, because the text
// is the instrument.
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createProject, initProjectStore, outputDir, sourceLifecycleStore, updateProject } from '../server/lib/project-store.mjs'
import { processProjectPush } from '../server/routes/projects.mjs'

const root = mkdtempSync(join(tmpdir(), 'tlda-named-refusal-'))
await initProjectStore(root)

const PROJECT = 'named-refusal'
const FILES = ['main.tex', 'intro.tex', 'method.tex', 'refs.bib']

let failures = 0
const check = (label, fn) => {
  try { fn(); console.log(`  ok   ${label}`) }
  catch (e) { failures++; console.error(`  FAIL ${label}: ${e.message}`) }
}

try {
  createProject({ name: PROJECT, title: PROJECT, mainFile: 'main.tex', format: 'svg' })
  await updateProject(PROJECT, { pages: 1, buildStatus: 'success' })
  mkdirSync(outputDir(PROJECT), { recursive: true })

  const bootstrap = await processProjectPush(PROJECT, {
    expectedRevision: null,
    sourceManifest: [...FILES].sort(),
    files: FILES.map(path => ({ path, content: `${path}\n` })),
  })
  check('the paper exists — without it there is nothing to refuse', () => {
    assert.equal(bootstrap.status, 200, `${bootstrap.status}: ${bootstrap.error}`)
  })

  const lifecycle = await sourceLifecycleStore(PROJECT)
  const held = lifecycle.readAuthority().currentRevision

  // A manifest that omits two files the snapshot holds. This is the direction
  // bregman failed in, and before this change the error was identical to the
  // direction below.
  const omitting = await processProjectPush(PROJECT, {
    expectedRevision: held,
    sourceManifest: ['main.tex', 'refs.bib'],
    files: [{ path: 'refs.bib', content: 'edited\n' }],
  })

  check('it is still refused — the check is not being relaxed here', () => {
    assert.ok(omitting.status === 409 || omitting.status === 400,
      `expected a refusal, got ${omitting.status}`)
  })

  check('and it names the path, rather than saying only that something differed', () => {
    assert.match(String(omitting.error), /intro\.tex/,
      `error did not name the offending path: ${omitting.error}`)
  })

  // WHAT THIS FIXTURE CANNOT REACH, said plainly rather than asserted around.
  //
  // The 409 whose message this change rewrites — `Proposed snapshot does not
  // match sourceManifest` — is not reachable from here. An omitted path is
  // caught first, and more specifically, by `missing surviving authored file`
  // above it. Reaching the 409 needs the stored client manifest and the current
  // revision to disagree, which no push in this fixture can produce.
  //
  // That is itself the finding: on bregman the earlier gate did NOT fire, so its
  // manifest was omitting nothing the server had stored — which means the live
  // divergence is the other direction, files DECLARED that the snapshot lacks.
  // The new text names those, and the live daemon log is where it gets read.

  const fine = await processProjectPush(PROJECT, {
    expectedRevision: lifecycle.readAuthority().currentRevision,
    sourceManifest: [...FILES].sort(),
    files: [{ path: 'intro.tex', content: 'a real edit\n' }],
  })
  check('— and it lands', () => {
    assert.equal(fine.status, 200, `${fine.status}: ${fine.error}`)
  })
} finally {
  rmSync(root, { recursive: true, force: true })
}

console.log(failures === 0 ? 'PASS a refusal that names what differed' : `FAIL a refusal that names what differed (${failures})`)
process.exit(failures === 0 ? 0 : 1)
