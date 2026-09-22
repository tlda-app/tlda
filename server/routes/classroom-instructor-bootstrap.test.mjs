// The first-instructor bootstrap: the setup CLI over the bearer mints the
// FIRST instructor for a course through the existing store/router contract,
// and nothing else does.
//
// The store comment says the setup CLI is the caller that mints the first
// instructor, but `POST /courses` only ever called `upsertCourse` and the
// instructors route sits behind the principal gate plus `instructorOf` — so
// no bearer caller could ever reach a first mint. These tests mount the real
// router and prove the wire: a bearer bootstrap with zero instructors mints
// exactly one row and returns its per-person token once; a bearer re-run
// against a bootstrapped course mints nothing; a bearer bootstrap missing
// the instructor identity fields is refused; and the gated instructors route
// still refuses a bearer caller once an instructor exists.

import test from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import { createServer } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ClassroomStore } from '../lib/classroom-store.mjs'
import { createClassroomRouter } from './classroom.mjs'

const COURSE = 'qtm285'

/** The real router, with the bearer admitted and no classroom identity. */
async function bootstrapCall(store, body) {
  return routerCall(store, () => null, 'POST', '/api/classroom/courses', body)
}

/**
 * One mounted router per call, so route ORDER is part of what is under test:
 * the bootstrap handler must sit ahead of the principal gate, and the
 * assignments route behind it. `resolvePrincipal` varies per call so the same
 * store sees the bearer-only setup caller first and the minted instructor
 * after — exactly the two identities one real setup run holds in sequence.
 */
async function routerCall(store, resolvePrincipal, method, path, body = null, headers = {}) {
  const app = express()
  app.use(express.json())
  app.use('/api/classroom', createClassroomRouter({ store, resolvePrincipal }))
  const server = createServer(app)
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}${path}`, {
      method,
      headers: { 'content-type': 'application/json', ...headers },
      body: body ? JSON.stringify(body) : undefined,
    })
    return { status: response.status, body: await response.json() }
  } finally {
    await new Promise(resolve => server.close(resolve))
  }
}

async function withStore(fn) {
  const root = mkdtempSync(join(tmpdir(), 'tlda-instructor-bootstrap-'))
  const store = new ClassroomStore(join(root, 'classroom.db'))
  try { return await fn(store) } finally { store.db.close(); rmSync(root, { recursive: true, force: true }) }
}

const setupBody = {
  id: COURSE, title: 'QTM 285', preferredName: 'Prof', pronouns: 'they/them',
  instructorDisplayName: 'Prof', instructorUniversityLogin: 'prof',
}

test('a bearer bootstrap on a fresh course mints the first instructor and returns its token once', async () => {
  await withStore(async store => {
    const { status, body } = await bootstrapCall(store, setupBody)
    assert.equal(status, 201)
    assert.equal(body.id, COURSE)
    assert.ok(body.token)
    assert.equal(body.instructor.id, `${COURSE}:prof`)
    // The minted token resolves to the instructor: the bootstrap produced a
    // working per-person identity, not just a row.
    const resolved = store.instructorForToken(body.token)
    assert.equal(resolved?.id, `${COURSE}:prof`)
    assert.equal(store.listInstructors(COURSE).length, 1)
  })
})

test('a bearer re-run against a bootstrapped course mints nothing and returns course-only', async () => {
  await withStore(async store => {
    const first = await bootstrapCall(store, setupBody)
    assert.equal(first.status, 201)
    assert.ok(first.body.token)
    const second = await bootstrapCall(store, { ...setupBody, title: 'QTM 285, retitled' })
    assert.equal(second.status, 201)
    assert.equal(second.body.token, undefined)
    assert.equal(second.body.instructor, undefined)
    assert.equal(second.body.title, 'QTM 285, retitled')
    assert.equal(store.listInstructors(COURSE).length, 1)
  })
})

test('a bearer bootstrap without the instructor identity fields is refused, not half-minted', async () => {
  await withStore(async store => {
    const { status, body } = await bootstrapCall(store, { id: COURSE, title: 'QTM 285', preferredName: 'Prof' })
    assert.equal(status, 400)
    assert.match(body.error, /instructorDisplayName and instructorUniversityLogin/)
    // Neither half of the mutation happened: no course row, no instructor.
    assert.equal(store.listInstructors(COURSE).length, 0)
    assert.equal(store.getCourse(COURSE), null)
  })
})

test('an instructor-gated call without the minted classroom identity is refused', async () => {
  await withStore(async store => {
    // Call one: the bearer-only setup caller, admitted at the operator
    // boundary and resolving to no classroom person.
    const bootstrapped = await routerCall(store, () => null, 'POST', '/api/classroom/courses', setupBody)
    assert.equal(bootstrapped.status, 201)
    assert.ok(bootstrapped.body.token)
    // Call two WITHOUT the minted token is what a reverted-to-bearer caller
    // does: bearer admitted, no principal, and the instructor gate refuses
    // it. This stays as the router's own 401 contrast — the CLI-path test in
    // tests/classroom-setup-command.test.mjs proves the repaired same-run
    // header carry through the actual helper, assignment and template freeze
    // both.
    const bearerOnly = await routerCall(store, () => null, 'POST', `/api/classroom/courses/${COURSE}/assignments`, {
      id: 'hw-1', title: 'Homework 1', dueAt: '2026-09-01T00:00:00.000Z',
    })
    assert.equal(bearerOnly.status, 401)
    assert.equal(store.listAssignments(COURSE).length, 0)
  })
})

test('the gated instructors route still refuses a bearer caller once an instructor exists', async () => {
  await withStore(async store => {
    const first = await bootstrapCall(store, setupBody)
    assert.equal(first.status, 201)
    const app = express()
    app.use(express.json())
    app.use('/api/classroom', createClassroomRouter({ store, resolvePrincipal: () => null }))
    const server = createServer(app)
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    try {
      const response = await fetch(`http://127.0.0.1:${server.address().port}/api/classroom/courses/${COURSE}/instructors`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ displayName: 'Second', universityLogin: 'second' }),
      })
      // The principal gate fires first: no resolving identity, no entry.
      assert.equal(response.status, 401)
    } finally {
      await new Promise(resolve => server.close(resolve))
    }
    assert.equal(store.listInstructors(COURSE).length, 1)
  })
})
