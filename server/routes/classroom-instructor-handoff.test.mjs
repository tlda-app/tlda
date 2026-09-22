// The instructor browser handoff: setup mints a single-use code the
// instructor's own token authorises, and the browser trades that code for its
// classroom cookie — the per-person token never appears in a URL, a body, or
// a log.
//
// Setup prints a marking URL the browser cannot use: it carries the gated
// sandbox bearer, which never resolves to a classroom principal, so the
// problems fetch 401s before any membership check runs. The handoff is the
// repair: the CLI spends the minted token (in memory, same run) on one mint
// call, prints only the opaque code URL, and the first redemption rotates the
// instructor's token to a fresh secret that rides back as the HttpOnly cookie
// alone. These tests mount the real router and prove the wire, including the
// counterfactual (no credential, no entry) and the absent/invalid controls.

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
const ASSIGNMENT = 'descriptive-proof'

const setupBody = {
  id: COURSE, title: 'QTM 285', preferredName: 'Prof', pronouns: 'they/them',
  instructorDisplayName: 'Prof', instructorUniversityLogin: 'prof',
}

function cookies(response) {
  const raw = response.headers.getSetCookie?.() ?? []
  return raw.join('; ')
}

function cookieValue(response) {
  const match = cookies(response).match(/tlda_classroom_token=([^;]*)/)
  return match ? decodeURIComponent(match[1]) : null
}

async function routerCall(store, { method, path, body = null, classroomToken = null, cookie = null }) {
  const app = express()
  app.use(express.json())
  app.use('/api/classroom', createClassroomRouter({ store }))
  const server = createServer(app)
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  try {
    const headers = { 'content-type': 'application/json' }
    if (classroomToken) headers['x-tlda-student-token'] = classroomToken
    if (cookie) headers.cookie = `tlda_classroom_token=${encodeURIComponent(cookie)}`
    const response = await fetch(`http://127.0.0.1:${server.address().port}${path}`, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    })
    return { status: response.status, body: await response.json().catch(() => ({})), cookie: cookieValue(response) }
  } finally {
    await new Promise(resolve => server.close(resolve))
  }
}

async function withSetup(fn) {
  const root = mkdtempSync(join(tmpdir(), 'tlda-instructor-handoff-'))
  const store = new ClassroomStore(join(root, 'classroom.db'))
  try {
    // The real first run: bearer bootstrap mints, and the minted token is the
    // only instructor identity this course has.
    const bootstrapped = await routerCall(store, { method: 'POST', path: '/api/classroom/courses', body: setupBody })
    assert.equal(bootstrapped.status, 201)
    assert.ok(bootstrapped.body.token)
    store.upsertAssignment({
      id: ASSIGNMENT, courseId: COURSE, title: 'Descriptive proof', dueAt: '2026-09-01T00:00:00.000Z',
      sourceDocKey: 'hw-source', handoutDocKey: 'hw-handout', bookPageFile: 'homework/hw.html',
      handoutFilter: 'bin/make-handout.py', solutionFilter: 'homework/solution-callout.lua',
      solutionsDocKey: 'hw-solutions', solutionsVersion: 'solutions-rev',
    })
    return await fn(store, bootstrapped.body.token)
  } finally { store.db.close(); rmSync(root, { recursive: true, force: true }) }
}

test('the mint needs the instructor token: bearer-only gets 401 and nothing is minted', async () => {
  await withSetup(async store => {
    const denied = await routerCall(store, { method: 'POST', path: `/api/classroom/courses/${COURSE}/instructor-handoff`, body: { assignment: ASSIGNMENT } })
    assert.equal(denied.status, 401)
    const rows = store.db.prepare('SELECT COUNT(*) AS n FROM instructor_browser_handoffs').get()
    assert.equal(rows.n, 0)
  })
})

test('mint with the instructor token returns a code URL with no token in it, and the code redeems to a cookie', async () => {
  await withSetup(async (store, token) => {
    const minted = await routerCall(store, {
      method: 'POST', path: `/api/classroom/courses/${COURSE}/instructor-handoff`,
      body: { assignment: ASSIGNMENT }, classroomToken: token,
    })
    assert.equal(minted.status, 201)
    assert.ok(minted.body.handoffUrl)
    assert.ok(minted.body.expiresAt)
    assert.match(minted.body.handoffUrl, /workspace=classroom-problems/)
    assert.match(minted.body.handoffUrl, new RegExp(`assignment=${ASSIGNMENT}`))
    // The URL carries the opaque code, never the per-person token.
    assert.doesNotMatch(minted.body.handoffUrl, new RegExp(token.slice(0, 8)))
    assert.equal(minted.body.token, undefined)
    const code = new URL(minted.body.handoffUrl).searchParams.get('handoff')
    assert.ok(code)

    const redeemed = await routerCall(store, {
      method: 'POST', path: `/api/classroom/courses/${COURSE}/instructor-handoff/redeem`,
      body: { transferCode: code },
    })
    assert.equal(redeemed.status, 200)
    assert.equal(redeemed.body.instructor.id, `${COURSE}:prof`)
    // No token value rides back in the body — the cookie is the identity.
    assert.equal(redeemed.body.token, undefined)
    assert.equal(redeemed.body.enrollmentToken, undefined)
    assert.ok(redeemed.cookie)

    // The counterfactual, proved rather than asserted: the problems route is
    // what 401s without a credential and what the handoff opens.
    const bare = await routerCall(store, { method: 'GET', path: `/api/classroom/assignments/${ASSIGNMENT}/problems` })
    assert.equal(bare.status, 401)
    const admitted = await routerCall(store, {
      method: 'GET', path: `/api/classroom/assignments/${ASSIGNMENT}/problems`, cookie: redeemed.cookie,
    })
    assert.equal(admitted.status, 200)
    assert.equal(admitted.body.assignment.id, ASSIGNMENT)
  })
})

test('minting for another course, or an assignment outside the course, is refused', async () => {
  await withSetup(async (store, token) => {
    const crossCourse = await routerCall(store, {
      method: 'POST', path: '/api/classroom/courses/other/instructor-handoff',
      body: {}, classroomToken: token,
    })
    assert.equal(crossCourse.status, 401)
    const crossAssignment = await routerCall(store, {
      method: 'POST', path: `/api/classroom/courses/${COURSE}/instructor-handoff`,
      body: { assignment: 'elsewhere' }, classroomToken: token,
    })
    assert.equal(crossAssignment.status, 400)
  })
})

test('a redeemed code is spent, an unknown code is invalid, and an expired code is gone', async () => {
  await withSetup(async (store, token) => {
    const minted = await routerCall(store, {
      method: 'POST', path: `/api/classroom/courses/${COURSE}/instructor-handoff`,
      body: {}, classroomToken: token,
    })
    assert.equal(minted.status, 201)
    const code = new URL(minted.body.handoffUrl).searchParams.get('handoff')
    const first = await routerCall(store, {
      method: 'POST', path: `/api/classroom/courses/${COURSE}/instructor-handoff/redeem`,
      body: { transferCode: code },
    })
    assert.equal(first.status, 200)
    const replay = await routerCall(store, {
      method: 'POST', path: `/api/classroom/courses/${COURSE}/instructor-handoff/redeem`,
      body: { transferCode: code },
    })
    assert.equal(replay.status, 409)
    const unknown = await routerCall(store, {
      method: 'POST', path: `/api/classroom/courses/${COURSE}/instructor-handoff/redeem`,
      body: { transferCode: 'no-such-code' },
    })
    assert.equal(unknown.status, 404)
    const missing = await routerCall(store, {
      method: 'POST', path: `/api/classroom/courses/${COURSE}/instructor-handoff/redeem`,
      body: {},
    })
    assert.equal(missing.status, 400)

    // Expiry is a clock reading, not a code property: the first redemption
    // rotated the setup-held token out, so the second mint presents the fresh
    // cookie as the instructor identity. Then push that code's deadline behind
    // now and it reads expired rather than invalid.
    const second = await routerCall(store, {
      method: 'POST', path: `/api/classroom/courses/${COURSE}/instructor-handoff`,
      body: {}, classroomToken: first.cookie,
    })
    assert.equal(second.status, 201)
    const expiring = new URL(second.body.handoffUrl).searchParams.get('handoff')
    const past = new Date(Date.now() - 60_000).toISOString()
    store.db.prepare('UPDATE instructor_browser_handoffs SET expires_at=? WHERE redeemed_at IS NULL').run(past)
    const expired = await routerCall(store, {
      method: 'POST', path: `/api/classroom/courses/${COURSE}/instructor-handoff/redeem`,
      body: { transferCode: expiring },
    })
    assert.equal(expired.status, 410)
  })
})

test('redeeming rotates the setup-held token out: the old value stops resolving', async () => {
  await withSetup(async (store, token) => {
    const minted = await routerCall(store, {
      method: 'POST', path: `/api/classroom/courses/${COURSE}/instructor-handoff`,
      body: {}, classroomToken: token,
    })
    const code = new URL(minted.body.handoffUrl).searchParams.get('handoff')
    const redeemed = await routerCall(store, {
      method: 'POST', path: `/api/classroom/courses/${COURSE}/instructor-handoff/redeem`,
      body: { transferCode: code },
    })
    assert.equal(redeemed.status, 200)
    // The CLI-held mint paid for the handoff and nothing after it.
    assert.equal(store.instructorForToken(token), null)
    assert.ok(store.instructorForToken(redeemed.cookie))
  })
})
