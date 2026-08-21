#!/usr/bin/env node
// A paper with a figure in it, and two people editing different chapters.
//
// Every paper Skip cares about has figures. This is the story that separates
// "works on a probe" from "works on a paper": the probe projects in the rest of
// this suite are all text, and the whole clean-rebase path — the thing that
// makes two disjoint edits land without anybody being told — was unreachable
// the moment a .png existed in the project.
//
// The cause was a batch poisoned by a bystander. Classifications were derived
// for every path in the union of base, current and incoming; a binary file
// classified as `classification-unavailable` because there is no three-way
// merge for bytes; and a rebase required *every* classification to be a
// candidate. So a figure nobody had touched refused a push it had nothing to
// do with, and the two people who edited different chapters were told they had
// a conflict.
//
// A path only needs merging when both sides moved away from the base. One side
// moving is a choice with one option; neither side moving is not a question.

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  closeProjectStore,
  createProject,
  initProjectStore,
  sourceLifecycleStore,
} from '../server/lib/project-store.mjs'

const root = mkdtempSync(join(tmpdir(), 'tlda-figure-rebase-'))
await initProjectStore(root)

const b64 = value => Buffer.from(value).toString('base64')
const chapter = (path, text) => ({ path, content: b64(text), encoding: 'base64' })
const figure = bytes => ({ path: 'fig.png', content: Buffer.from(bytes).toString('base64'), encoding: 'base64' })

const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]
const MANIFEST = ['fig.png', 'main.tex', 'notes.tex']

async function paperWithAFigure(name) {
  createProject({ name, title: name, mainFile: 'main.tex', format: 'svg' })
  const lifecycle = await sourceLifecycleStore(name)
  const files = [figure(PNG), chapter('main.tex', 'opening\n'), chapter('notes.tex', 'notes\n')]
  const booted = lifecycle.bootstrap({ expectedRevision: null, sourceManifest: MANIFEST, files })
  assert.equal(booted.status, 'accepted',
    'the paper — starts with two chapters and a figure; otherwise nothing below is about a real paper')
  return { lifecycle, files, start: booted.authority.currentRevision }
}

try {
  // ## Two people edit different chapters of a paper with a figure in it

  // ### Alice edits notes.tex
  const { lifecycle, files, start } = await paperWithAFigure('figure-rebase')
  const alice = lifecycle.submit({
    expectedRevision: start,
    sourceManifest: MANIFEST,
    files: files.map(file => file.path === 'notes.tex' ? chapter('notes.tex', 'alice writes\n') : file),
  })
  assert.equal(alice.status, 'accepted',
    'the paper — has Alice\'s chapter; otherwise she never landed and Bob has nothing to rebase against')

  // ### Bob edits main.tex, still holding the revision Alice started from
  const bob = lifecycle.submit({
    expectedRevision: start,
    sourceManifest: MANIFEST,
    files: files.map(file => file.path === 'main.tex' ? chapter('main.tex', 'bob writes\n') : file),
  })
  assert.equal(bob.status, 'accepted-clean-rebase',
    'Bob — is not told he has a conflict; otherwise a figure neither of them touched refused a push it had nothing to do with')

  // ### The paper has both chapters and the figure is untouched
  const landed = lifecycle.readRevision(bob.authority.currentRevision)
  const text = path => lifecycle.readRevisionFile(landed.id, path).toString('utf8')
  assert.equal(text('notes.tex'), 'alice writes\n',
    'the paper — kept Alice\'s chapter through Bob\'s rebase')
  assert.equal(text('main.tex'), 'bob writes\n',
    'the paper — has Bob\'s chapter')
  assert.deepEqual([...lifecycle.readRevisionFile(landed.id, 'fig.png')], PNG,
    'the figure — is the bytes it always was, carried across the rebase rather than merged')

  // ## A figure both of them changed is still a conflict

  // ### Alice and Bob replace the same figure
  const second = await paperWithAFigure('figure-conflict')
  const hers = second.lifecycle.submit({
    expectedRevision: second.start,
    sourceManifest: MANIFEST,
    files: second.files.map(file => file.path === 'fig.png' ? figure([...PNG, 9, 9]) : file),
  })
  assert.equal(hers.status, 'accepted',
    'the paper — has Alice\'s figure; otherwise Bob is not colliding with anything')

  const his = second.lifecycle.submit({
    expectedRevision: second.start,
    sourceManifest: MANIFEST,
    files: second.files.map(file => file.path === 'fig.png' ? figure([...PNG, 7, 7]) : file),
  })
  assert.equal(his.status, 'stale-base',
    'Bob — is refused; otherwise two people replaced one image and the app picked a winner without telling either of them')
  assert.equal(his.evidence.classifications.find(item => item.path === 'fig.png')?.status, 'classification-unavailable',
    'the figure — is the file named as unmergeable, because bytes have no three-way merge')

  console.log('a figure does not refuse a rebase: bystanders are carried, collisions are still refused')
} finally {
  await closeProjectStore?.()
  rmSync(root, { recursive: true, force: true })
}
