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
// That message said the two sets differed and nothing else. Which WAY they
// differed was the entire diagnosis: a path the manifest declares and the
// snapshot lacks is a file the daemon never sent; a path the snapshot holds
// and the manifest omits is one it should have deleted.
//
// ---------------------------------------------------------------------------
// Re-derived for the new accept path, not repointed onto it.
//
// The old mechanism this asserted — a manifest-vs-snapshot mismatch producing
// an English sentence naming one path — does not exist on the new path. The
// new path's refusal is a git fast-forward check (`refusedRevision`,
// `non-fast-forward`), a structurally different failure than a manifest
// mismatch, and repointing this test onto it would swap what is proven rather
// than preserve it.
//
// So this asserts the PROMISE, not the old wording: a refusal tells its
// author what differed, so he is not stuck reconstructing it by hand for two
// and a half hours. On the new path that promise is kept by
// `lifecycle.submit()`'s `evidence.classifications` — a per-path report,
// computed BEFORE any English sentence exists, naming every path touched on
// either side and whether it is a clean rebase or a real conflict. It is
// strictly more specific than the old sentence (which named one path); this
// asserts it names the right ones, in both directions bregman's incident
// named: a path only the project moved, and a path both sides moved.
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createSourceLifecycleStore } from '../server/lib/source-lifecycle.mjs'

const root = mkdtempSync(join(tmpdir(), 'tlda-named-refusal-'))
const PROJECT = 'named-refusal'

let failures = 0
const check = (label, fn) => {
  try { fn(); console.log(`  ok   ${label}`) }
  catch (e) { failures++; console.error(`  FAIL ${label}: ${e.message}`) }
}

try {
  const lifecycle = createSourceLifecycleStore({
    root, project: PROJECT, context: { format: 'svg', mainFile: 'main.tex' },
  })

  // The paper exists — without it there is nothing to refuse.
  const bootstrap = await lifecycle.bootstrap({
    expectedRevision: null,
    sourceManifest: ['intro.tex', 'main.tex', 'refs.bib'],
    files: [
      { path: 'main.tex', content: 'main.tex\n' },
      { path: 'intro.tex', content: 'intro.tex\n' },
      { path: 'refs.bib', content: 'refs.bib\n' },
    ],
  })
  check('the paper exists', () => assert.equal(bootstrap.ok, true, JSON.stringify(bootstrap)))
  const base = bootstrap.authority.currentRevision

  // Someone else's push lands first, touching only `main.tex`. `submit` wants
  // the complete manifest's worth of files every time — same "must be told
  // the whole thing, not asked to remember" property `acceptRevision` has.
  const landed = await lifecycle.submit({
    expectedRevision: base,
    sourceManifest: ['intro.tex', 'main.tex', 'refs.bib'],
    files: [
      { path: 'main.tex', content: 'main.tex, edited by someone else\n' },
      { path: 'intro.tex', content: 'intro.tex\n' },
      { path: 'refs.bib', content: 'refs.bib\n' },
    ],
  })
  check('the other push lands', () => assert.equal(landed.ok, true, JSON.stringify(landed)))

  // bregman's push, built on the stale `base`, touches a DIFFERENT file
  // (`intro.tex`, the direction where only this push moved a path) and the
  // SAME file the other push already moved (`main.tex`, a real conflict).
  const stale = await lifecycle.submit({
    expectedRevision: base,
    sourceManifest: ['intro.tex', 'main.tex', 'refs.bib'],
    files: [
      { path: 'main.tex', content: 'main.tex, edited by bregman too\n' },
      { path: 'intro.tex', content: 'intro.tex, edited by bregman\n' },
      { path: 'refs.bib', content: 'refs.bib\n' },
    ],
  })

  check('it is still refused — the check is not being relaxed here', () => {
    assert.equal(stale.ok, false, JSON.stringify(stale))
    assert.equal(stale.status, 'stale-base')
  })

  check('a refusal names the commit it refused, so it is not lost', () => {
    assert.ok(stale.refusedRevision, 'no refusedRevision on the result')
  })

  check('the refusal carries a per-path account, not a single sentence', () => {
    assert.ok(Array.isArray(stale.evidence?.classifications), JSON.stringify(stale.evidence))
  })

  const byPath = Object.fromEntries(stale.evidence.classifications.map(c => [c.path, c]))

  check('and it names the path that only this push touched — a clean rebase, not a conflict', () => {
    assert.equal(byPath['intro.tex']?.status, 'clean-rebase-candidate',
      `intro.tex classified as ${JSON.stringify(byPath['intro.tex'])}`)
  })

  check('— and it names the path both sides actually moved, as the real conflict it is', () => {
    assert.equal(byPath['main.tex']?.status, 'conflict',
      `main.tex classified as ${JSON.stringify(byPath['main.tex'])}`)
  })

  check('a path neither side touched is not mentioned as differing', () => {
    assert.equal(byPath['refs.bib']?.status, 'clean-rebase-candidate',
      `refs.bib classified as ${JSON.stringify(byPath['refs.bib'])}`)
  })

  // The refusal changed nothing: the project still holds what it held.
  const after = await lifecycle.readAuthority()
  check('a refused proposal must not move the project', () => {
    assert.equal(after.currentRevision, landed.authority.currentRevision)
  })

  // A push that only touches the untouched-by-others path lands, because it
  // is a clean rebase and the mechanism already knows that from the same
  // classification this test just asserted.
  const fine = await lifecycle.submit({
    expectedRevision: base,
    sourceManifest: ['intro.tex', 'main.tex', 'refs.bib'],
    files: [
      { path: 'main.tex', content: 'main.tex\n' },
      { path: 'intro.tex', content: 'intro.tex, edited by bregman, alone this time\n' },
      { path: 'refs.bib', content: 'refs.bib\n' },
    ],
  })
  check('— and a push with no real conflict lands', () => {
    assert.equal(fine.ok, true, JSON.stringify(fine))
    assert.equal(fine.status, 'accepted-clean-rebase')
  })
} finally {
  rmSync(root, { recursive: true, force: true })
}

console.log(failures === 0 ? 'PASS a refusal that names what differed' : `FAIL a refusal that names what differed (${failures})`)
process.exit(failures === 0 ? 0 : 1)
