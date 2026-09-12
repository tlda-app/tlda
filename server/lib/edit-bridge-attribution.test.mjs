// Who edited each build, pinned.
//
// This is the only step of the edit bridge that decides rather than reads, and
// what it decides is an attribution -- so a wrong answer here is the feature
// lying about the one thing a person opens it to learn. Every case below is a
// way of being confidently wrong, not a way of erroring.
import test from 'node:test'
import assert from 'node:assert/strict'

import { attributeEditsToBuilds, editsFromActivity } from './edit-bridge-attribution.mjs'

const at = (iso) => new Date(iso).getTime()
const build = (hash, iso, files) => ({ hash, timestamp: at(iso), files })
const edit = (agentId, taskId, file, iso) => ({ agentId, taskId, file, timestampMs: at(iso) })

test('an edit is credited to the first build that changed its file', () => {
  const builds = attributeEditsToBuilds(
    [build('b1', '2026-09-12T12:00:00Z', ['main.md'])],
    [edit('a1', 't1', 'main.md', '2026-09-12T11:55:00Z')],
  )
  assert.deepEqual(builds[0].editors, [{ agentId: 'a1', taskId: 't1', files: ['main.md'] }])
})

test('a build with no activity behind it reports no editors, never a guess', () => {
  const builds = attributeEditsToBuilds(
    [build('b1', '2026-09-12T12:00:00Z', ['main.md'])],
    [],
  )
  assert.deepEqual(builds[0].editors, [])
})

test('a build is not credited with an edit that happened after it', () => {
  const builds = attributeEditsToBuilds(
    [build('b1', '2026-09-12T12:00:00Z', ['main.md'])],
    [edit('a1', 't1', 'main.md', '2026-09-12T12:05:00Z')],
  )
  assert.deepEqual(builds[0].editors, [], 'a later edit cannot belong to an earlier build')
})

test('an edit is NOT absorbed by an earlier build that did not touch its file', () => {
  // The case that is easy to get wrong and expensive when wrong: b2 is the
  // first build after the edit, but it did not change main.md, so the edit
  // belongs to b3 -- which did.
  const builds = attributeEditsToBuilds(
    [
      build('b1', '2026-09-12T12:00:00Z', ['main.md']),
      build('b2', '2026-09-12T12:20:00Z', ['notes.md']),
      build('b3', '2026-09-12T12:30:00Z', ['main.md']),
    ],
    [edit('a2', 't2', 'main.md', '2026-09-12T12:12:00Z')],
  )
  assert.deepEqual(builds[1].editors, [], 'b2 did not touch main.md')
  assert.deepEqual(builds[2].editors, [{ agentId: 'a2', taskId: 't2', files: ['main.md'] }])
})

test('one agent and task with several files reads as one editor', () => {
  const builds = attributeEditsToBuilds(
    [build('b1', '2026-09-12T12:10:00Z', ['main.md', 'notes.md'])],
    [
      edit('a1', 't1', 'main.md', '2026-09-12T12:05:00Z'),
      edit('a1', 't1', 'notes.md', '2026-09-12T12:06:00Z'),
    ],
  )
  assert.equal(builds[0].editors.length, 1)
  assert.deepEqual(builds[0].editors[0].files.sort(), ['main.md', 'notes.md'])
})

test('the same agent under two tasks is two editors', () => {
  const builds = attributeEditsToBuilds(
    [build('b1', '2026-09-12T12:10:00Z', ['main.md'])],
    [
      edit('a1', 't1', 'main.md', '2026-09-12T12:05:00Z'),
      edit('a1', 't2', 'main.md', '2026-09-12T12:06:00Z'),
    ],
  )
  assert.equal(builds[0].editors.length, 2, 'task is part of what identifies a run')
})

test('an edit is claimed once, not by every later build touching that file', () => {
  const builds = attributeEditsToBuilds(
    [
      build('b1', '2026-09-12T12:10:00Z', ['main.md']),
      build('b2', '2026-09-12T12:20:00Z', ['main.md']),
    ],
    [edit('a1', 't1', 'main.md', '2026-09-12T12:05:00Z')],
  )
  assert.equal(builds[0].editors.length, 1)
  assert.deepEqual(builds[1].editors, [], 'the edit already belongs to b1')
})

test('an edit whose file no build ever changed is attributed to nobody', () => {
  const builds = attributeEditsToBuilds(
    [build('b1', '2026-09-12T12:10:00Z', ['main.md'])],
    [edit('a1', 't1', 'untracked.md', '2026-09-12T12:05:00Z')],
  )
  assert.deepEqual(builds[0].editors, [])
})

test('activity rows without a sourceFile contribute nothing', () => {
  // The skill-dismiss activity is the other thing of this type and it names a
  // file the agent never edited. Attributing it would invent an author.
  const edits = editsFromActivity([
    { from: 'a1', task_id: 't1', timestamp: '2026-09-12T12:05:00Z', metadata: '{"tool":"Edit","sourceFile":"main.md"}' },
    { from: 'a2', task_id: 't2', timestamp: '2026-09-12T12:06:00Z', metadata: '{"kind":"skill-dismiss","trigger":"main.tex"}' },
    { from: 'a3', task_id: 't3', timestamp: '2026-09-12T12:07:00Z', metadata: 'not json' },
    { from: 'a4', task_id: 't4', timestamp: '2026-09-12T12:08:00Z', metadata: null },
  ])
  assert.deepEqual(edits.map(e => e.agentId), ['a1'])
})

test('activity metadata is accepted already parsed as well as as text', () => {
  const edits = editsFromActivity([
    { from: 'a1', task_id: null, timestamp: '2026-09-12T12:05:00Z', metadata: { sourceFile: 'main.md' } },
  ])
  assert.equal(edits.length, 1)
  assert.equal(edits[0].taskId, null)
})
