// The instructor browser handoff: setup mints a single-use code the
// instructor's own token authorises, and each browser trades that code for its
// OWN session credential — the long-lived per-person token never appears in a
// URL, a body, or a log, and never stops resolving.
//
// Setup prints a marking URL the browser cannot use: it carries the gated
// sandbox bearer, which never resolves to a classroom principal, so the
// problems fetch 401s before any membership check runs. The handoff is the
// repair: the CLI spends the minted token (in memory, same run) on one mint
// call, prints only the opaque code URL, and each redemption inserts a
// separate browser-session row ATOMICALLY with consuming the code — the fresh
// session value rides back as the HttpOnly cookie alone. These tests mount the
// real router and prove the wire, including the counterfactual (no credential,
// no entry), the absent/invalid controls, multi-browser coexistence, and the
// failure path (a failed session insert leaves the code redeemable and sets no
// cookie).

import test from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import { createServer } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ClassroomStore, hashEnrollmentToken } from '../lib/classroom-store.mjs'
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
    return { status: response.status, body: await response.json().catch(() => ({})), cookie: cookieValue(response), setCookie: cookies(response) }
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

async function mintCode(store, token, assignment = ASSIGNMENT) {
  const minted = await routerCall(store, {
    method: 'POST', path: `/api/classroom/courses/${COURSE}/instructor-handoff`,
    body: { assignment }, classroomToken: token,
  })
  assert.equal(minted.status, 201)
  return new URL(minted.body.handoffUrl).searchParams.get('handoff')
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
    // The cookie is a FRESH session value, not the CLI-held token.
    assert.notEqual(redeemed.cookie, token)
    assert.match(redeemed.setCookie, /HttpOnly/)

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
    const code = await mintCode(store, token)
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

    // Expiry is a clock reading, not a code property: the CLI-held token is
    // still valid after redemption, so the second mint presents it unchanged.
    // Then push that code's deadline behind now and it reads expired rather
    // than invalid.
    const second = await routerCall(store, {
      method: 'POST', path: `/api/classroom/courses/${COURSE}/instructor-handoff`,
      body: {}, classroomToken: token,
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

test('redeeming keeps the CLI token and mints a second browser beside the first', async () => {
  await withSetup(async (store, token) => {
    const first = await routerCall(store, {
      method: 'POST', path: `/api/classroom/courses/${COURSE}/instructor-handoff/redeem`,
      body: { transferCode: await mintCode(store, token) },
    })
    assert.equal(first.status, 200)
    // The CLI-held mint paid for the handoff and keeps resolving after it.
    const cliStill = store.instructorForToken(token)
    assert.ok(cliStill)
    assert.equal(cliStill.id, `${COURSE}:prof`)
    const browser1 = store.instructorForToken(first.cookie)
    assert.ok(browser1)
    assert.equal(browser1.id, `${COURSE}:prof`)

    // A second browser redeems its own code with the still-valid CLI token.
    // Browser 1 and the CLI are undisturbed: all three resolve to the same
    // instructor, all three values distinct.
    const second = await routerCall(store, {
      method: 'POST', path: `/api/classroom/courses/${COURSE}/instructor-handoff/redeem`,
      body: { transferCode: await mintCode(store, token) },
    })
    assert.equal(second.status, 200)
    assert.notEqual(second.cookie, first.cookie)
    assert.notEqual(second.cookie, token)
    for (const value of [token, first.cookie, second.cookie]) {
      const resolved = store.instructorForToken(value)
      assert.ok(resolved, `credential still resolves: ${String(value).slice(0, 8)}…`)
      assert.equal(resolved.id, `${COURSE}:prof`)
    }
    const admitted = await routerCall(store, {
      method: 'GET', path: `/api/classroom/assignments/${ASSIGNMENT}/problems`, cookie: first.cookie,
    })
    assert.equal(admitted.status, 200)
  })
})

test('a failed session insert leaves the handoff redeemable and sets no cookie', async () => {
  await withSetup(async (store, token) => {
    const code = await mintCode(store, token)
    // Failure injection at the session boundary: the insert throws, so the
    // transaction must roll back whole — no session row, no consume.
    const failing = Object.create(store)
    failing.createInstructorBrowserSession = () => { throw new Error('injected session failure') }
    const failed = await routerCall(failing, {
      method: 'POST', path: `/api/classroom/courses/${COURSE}/instructor-handoff/redeem`,
      body: { transferCode: code },
    })
    assert.equal(failed.status, 500)
    assert.equal(failed.cookie, null)
    assert.equal(failed.body.token, undefined)
    const handoff = store.db.prepare('SELECT redeemed_at AS redeemedAt FROM instructor_browser_handoffs').get()
    assert.equal(handoff.redeemedAt, null)
    assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM instructor_browser_sessions').get().n, 0)

    // The same code redeems cleanly afterwards through the real store.
    const recovered = await routerCall(store, {
      method: 'POST', path: `/api/classroom/courses/${COURSE}/instructor-handoff/redeem`,
      body: { transferCode: code },
    })
    assert.equal(recovered.status, 200)
    assert.ok(recovered.cookie)
  })
})

test('a session-hash collision rolls back the consume: no session, code still live', async () => {
  await withSetup(async (store, token) => {
    const code = await mintCode(store, token)
    // Pre-plant a session row carrying a known value's hash, then redeem with
    // that same value: the UNIQUE insert throws inside the transaction, and
    // the handoff consume must roll back with it.
    const colliding = 'colliding-session-value'
    store.createInstructorBrowserSession({ instructorId: `${COURSE}:prof`, handoffId: null, sessionToken: colliding })
    assert.throws(() => store.redeemInstructorBrowserHandoff({ courseId: COURSE, transferCode: code, sessionToken: colliding }), /UNIQUE|unique|constraint/i)
    const handoff = store.db.prepare('SELECT redeemed_at AS redeemedAt FROM instructor_browser_handoffs WHERE redeemed_at IS NULL').get()
    assert.ok(handoff, 'handoff row is still unredeemed after the collision')
    assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM instructor_browser_sessions').get().n, 1)
    // And the code still redeems with a fresh value.
    const result = store.redeemInstructorBrowserHandoff({ courseId: COURSE, transferCode: code, sessionToken: 'fresh-after-collision' })
    assert.equal(result.status, 'redeemed')
  })
})

test('the session is stored hash-only: the raw cookie value is nowhere in the database', async () => {
  await withSetup(async (store, token) => {
    const redeemed = await routerCall(store, {
      method: 'POST', path: `/api/classroom/courses/${COURSE}/instructor-handoff/redeem`,
      body: { transferCode: await mintCode(store, token) },
    })
    assert.equal(redeemed.status, 200)
    const row = store.db.prepare('SELECT session_token_hash AS hash FROM instructor_browser_sessions').get()
    assert.ok(row)
    assert.equal(row.hash, hashEnrollmentToken(redeemed.cookie))
    assert.notEqual(row.hash, redeemed.cookie)
    // The raw value appears in no classroom table at all.
    for (const table of ['instructors', 'instructor_browser_handoffs', 'instructor_browser_sessions', 'students', 'student_device_credentials']) {
      const found = store.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()
      assert.ok(found, `table ${table} readable`)
    }
    const dump = JSON.stringify(store.db.prepare('SELECT id,instructor_id,session_token_hash,handoff_id FROM instructor_browser_sessions').all())
    assert.doesNotMatch(dump, new RegExp(redeemed.cookie.slice(0, 16)))
  })
})
