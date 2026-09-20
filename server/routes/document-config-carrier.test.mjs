// The project fetch must carry the classroom credential, and a refusal must
// name the credential that is actually missing.
//
// `src/App.tsx:fetchDocConfig` used to load `/api/projects/:name` over a bare
// fetch: no classroom token, and a 401/403 handler prescribing `?token=`, which
// cannot help when the bearer admits but no classroom principal resolves. The
// app could not open any classroom-restricted project, and it sent the reader
// after the wrong credential.
//
// This proves it on the wire the defect lives on: the real
// `requireClassroomDocumentAccess` gate mounted the way `/api/projects/:name`
// mounts it (`router.use('/:name', requireRead, requireClassroomDocumentAccess)`
// in `routes/projects.mjs`), with the two requests the app can make —
// bearer-only and bearer plus classroom token. A full projects router cannot
// run in-process: `shared/config.mjs` freezes `CONFIG_DIR` at import time, so
// no in-process harness can turn gating on, and the router's document handler
// needs a project store on disk. The bearer half of the check below is the
// `requireRead` position in that mount line; the refusal message is worded by
// the gate itself, so asserting the gate's answer asserts the app's message.
// The app-side text is asserted too, because the wrong remedy in an error
// message is worse than no remedy: it sends people down a path that cannot
// work.
import test from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import { createServer } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readFile } from 'node:fs/promises'
import { ClassroomStore } from '../lib/classroom-store.mjs'
import { classroomPrincipal, requireClassroomDocumentAccess } from './classroom.mjs'

const COURSE = 'qtm285'
const OWNER = 'ada'
const ADA_TOKEN = 'ada-enrollment-token'
// The doc key is the submission's content ref, which is what
// `submissionDocumentOwner` looks the owner up by.
const SUBMISSION = 'hw1-ada'

function storeWithOneSubmission(root) {
  const store = new ClassroomStore(join(root, 'classroom.db'))
  store.upsertCourse({ id: COURSE, title: 'QTM 285', preferredName: 'Instructor' })
  store.upsertStudent({ id: OWNER, courseId: COURSE, displayName: 'Ada', enrollmentToken: ADA_TOKEN })
  store.upsertAssignment({ id: 'hw1', courseId: COURSE, title: 'Homework 1', dueAt: '2026-09-01T20:00:00Z' })
  store.submit({ assignmentId: 'hw1', studentId: OWNER, contentRef: 'hw1-ada' })
  return store
}

/**
 * The gate mounted the way `/api/projects/:name` mounts it, with the bearer
 * replaced by the position it holds in that mount line. `requireRead` admits
 * any caller the test hands a bearer to and refuses a caller with none — that
 * admission is what `a-link-does-not-lower-access-test.mjs` proves over real
 * HTTP, which this file does not re-prove.
 */
async function documentRequest(store, path, { bearer = true } = {}) {
  const admittedBearer = () => bearer
  const app = express()
  app.use(express.json())
  app.locals.classroomStore = store
  app.locals.resolveClassroomPrincipal = (req, classroomStore) => classroomPrincipal(req, classroomStore)
  app.use('/api/projects/:name',
    (req, res, next) => admittedBearer() ? next() : res.status(401).json({ error: 'Unauthorized' }),
    requireClassroomDocumentAccess,
    (req, res) => res.json({ ok: true }))
  const server = createServer(app)
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}${path}`)
    return { status: response.status, body: await response.json() }
  } finally {
    await new Promise(resolve => server.close(resolve))
  }
}

const appSource = await readFile(new URL('../../src/App.tsx', import.meta.url), 'utf8')

test('the project fetch carries the classroom credential on the URL', () => {
  // What the test below drives by hand, the app must do on every load: the
  // classroom token rides `appendToken` onto the project URL, alongside the
  // bearer the patched fetch injects as an Authorization header.
  assert.match(appSource, /appendToken\(\s*`\$\{ASSET_BASE\}\/api\/projects\/\$\{projectName\}/)
})

test('the refusal message names the missing credential, never ?token= for a classroom refusal', () => {
  // The old handler prescribed `?token=` for every 401/403 — the wrong remedy
  // for a classroom refusal. The message below must survive as the bearer-only
  // branch: no bearer, `?token=` is genuinely the fix.
  assert.match(appSource, /if \(!getToken\(\)\) \{\s*throw new Error\('Authentication required\. Add \?token=TOKEN to the URL\.'\)/)
  // And the branch below it must name the classroom sign-in, not a token.
  assert.match(appSource, /classroom sign-in/)
  // The load path must not rewrite the message back to `?token=` either —
  // that rewrite is what sent readers after a credential that could not help.
  assert.doesNotMatch(appSource, /message: isAuth \? 'Authentication required\. Add \?token=TOKEN/)
})

test('a bare fetch is refused; bearer-only is refused with the message; bearer plus classroom token is admitted', async () => {
  const root = mkdtempSync(join(tmpdir(), 'tlda-doc-config-carrier-'))
  const store = storeWithOneSubmission(root)
  try {
    const path = `/api/projects/${encodeURIComponent(SUBMISSION)}`

    const bare = await documentRequest(store, path, { bearer: false })
    assert.equal(bare.status, 401)

    const bearerOnly = await documentRequest(store, path)
    assert.equal(bearerOnly.status, 403)
    assert.match(bearerOnly.body.error, /readable by the student who handed it in/)

    const admitted = await documentRequest(store, `${path}?classroomToken=${ADA_TOKEN}`)
    assert.equal(admitted.status, 200)
    assert.deepEqual(admitted.body, { ok: true })
  } finally {
    store.db.close()
    rmSync(root, { recursive: true, force: true })
  }
})
