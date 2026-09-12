// Real assignment ZIP -> the extension's own Submit -> instructor receipt.
//
// Disposable: its own temp classroom.db, its own project store, its own course.
// Nothing here touches an existing project or an existing server.
//
// What is genuinely exercised: the extension's shipped submit path (its real
// archive builder, its real metadata parser, its real upload module), a real
// TCP socket, the real classroom router with the REAL principal resolver, so
// the student token is actually resolved rather than stubbed.
// Tokens and TLDA_CONFIG_DIR come from the environment: ES imports hoist above
// any assignment here, so setting them in-script would be too late for auth.mjs.
const RW = process.env.TLDA_TOKEN_RW

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Module from 'node:module'
import express from 'express'
import { unzipSync, strFromU8 } from 'fflate'
import { ClassroomStore } from '/Users/skip/worktrees/qtm285-positron/server/lib/classroom-store.mjs'
import { initProjectStore } from '/Users/skip/worktrees/qtm285-positron/server/lib/project-store.mjs'
import { createClassroomRouter } from '/Users/skip/worktrees/qtm285-positron/server/routes/classroom.mjs'
import { initAuth, isTokenGatingEnabled } from '/Users/skip/worktrees/qtm285-positron/server/lib/auth.mjs'

// Real gating, from a disposable config dir. Without this every caller resolves
// as instructor and the student path is never exercised at all.
initAuth()
if (!isTokenGatingEnabled()) throw new Error('FAIL: token gating did not turn on; roles would be inert')
console.log('token gating: ON')

const EXT = '/Users/skip/worktrees/qtm285-positron/extensions/tlda-classroom-positron/src/extension.js'
const HANDOUT = '/private/tmp/claude-501/-Users-skip-worktrees-qtm285-positron/3c1c0549-36d4-4cd7-8a19-09b33f0b7fae/scratchpad/handouts/unpacked/hw-minus-1-setup'

const log = (...a) => console.log(...a)
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tlda-e2e-submit-'))

// ---- a disposable classroom -------------------------------------------------
const store = new ClassroomStore(path.join(dir, 'classroom.db'))
await initProjectStore(path.join(dir, 'projects'))
const COURSE = 'disposable-course', ASSIGNMENT = 'disposable-hw', STUDENT = 'test-student'
const STUDENT_TOKEN = 'student-enrollment-secret'
store.upsertCourse({ id: COURSE, title: 'Disposable Course' })
store.upsertStudent({ id: STUDENT, courseId: COURSE, displayName: 'Test Student', enrollmentToken: STUDENT_TOKEN, layerScope: 'student' })
store.upsertAssignment({ id: ASSIGNMENT, courseId: COURSE, title: 'Disposable HW', dueAt: '2026-12-01T00:00:00Z' })

const received = []
const app = express()
app.use(express.json())
app.use('/api/classroom', createClassroomRouter({
  store, // resolvePrincipal left at its default: the real token resolver
  submitSubmissionSource: async contentRef => { received.push(contentRef); return { status: 200, body: { ok: true } } },
}))
const server = await new Promise(r => { const s = app.listen(0, '127.0.0.1', () => r(s)) })
const origin = `http://127.0.0.1:${server.address().port}`
log(`disposable server on ${origin}`)

// ---- the real handout, pointed at the disposable classroom -------------------
// Only the two coordinate lines change. Everything else is the bytes the course
// tooling produced, including shared-code.qmd and the .qmd.support directory.
const work = path.join(dir, 'student-folder')
fs.cpSync(HANDOUT, work, { recursive: true })
const qmdPath = path.join(work, 'hw-minus-1-setup.qmd')
const original = fs.readFileSync(qmdPath, 'utf8')
fs.writeFileSync(qmdPath, original
  .replace(/^tlda-classroom-server:.*$/m, `tlda-classroom-server: "${origin}"`)
  .replace(/^tlda-classroom-assignment:.*$/m, `tlda-classroom-assignment: "${ASSIGNMENT}"`))
log(`student folder: ${fs.readdirSync(work).join(', ')}`)

// ---- a Positron stand-in ----------------------------------------------------
// Only the editor chrome is faked. The extension's own logic is untouched.
const shown = { info: [], error: [], warn: [] }
const secrets = new Map()
let promptedForToken = false
const vscodeStub = {
  window: {
    activeTextEditor: { document: { fileName: qmdPath, isDirty: false, save: async () => true } },
    showInformationMessage: async m => { shown.info.push(m); return undefined },
    showErrorMessage: async m => { shown.error.push(m); return undefined },
    showWarningMessage: async m => { shown.warn.push(m); return undefined },
    showInputBox: async () => { promptedForToken = true; return STUDENT_TOKEN },
    withProgress: async (_o, task) => task(),
  },
  commands: { registerCommand: (id, fn) => ({ id, fn, dispose() {} }), executeCommand: async () => {} },
  languages: { registerDocumentPasteEditProvider: () => ({ dispose() {} }), registerDocumentDropEditProvider: () => ({ dispose() {} }) },
  ProgressLocation: { Notification: 15 },
  Uri: { file: p => ({ fsPath: p }) },
  DocumentDropOrPasteEditKind: { Text: 'text' },
  DocumentPasteEdit: class {}, DocumentDropEdit: class {},
}
const resolveFilename = Module._resolveFilename
Module._resolveFilename = function (request, ...rest) {
  if (request === 'vscode') return 'vscode'
  return resolveFilename.call(this, request, ...rest)
}
const requireCjs = Module.createRequire(import.meta.url)
requireCjs.cache.vscode = new Module('vscode', null)
requireCjs.cache.vscode.exports = vscodeStub
requireCjs.cache.vscode.loaded = true

const extension = requireCjs(EXT)

// Tee what actually goes on the wire, without standing in front of it.
let sentBytes = null
const realFetch = globalThis.fetch
globalThis.fetch = async (url, init) => { if (init?.body) sentBytes = init.body; return realFetch(url, init) }

// ---- activate, exactly as Positron would ------------------------------------
const registered = []
const context = {
  subscriptions: { push: (...cs) => registered.push(...cs) },
  secrets: {
    get: async k => secrets.get(k),
    store: async (k, v) => { secrets.set(k, v) },
    delete: async k => { secrets.delete(k) },
  },
}
extension.activate(context)
const ids = registered.filter(c => c && c.id).map(c => c.id)
log(`activate() registered: ${ids.join(', ')}`)
if (!ids.includes('tldaClassroom.submit')) throw new Error('FAIL: submit command was not registered')

// ---- run Submit -------------------------------------------------------------
const submit = registered.find(c => c.id === 'tldaClassroom.submit')
await submit.fn()

log(`\nprompted for token: ${promptedForToken}`)
log(`errors shown:  ${JSON.stringify(shown.error)}`)
log(`info shown:    ${JSON.stringify(shown.info)}`)
if (shown.error.length) throw new Error('FAIL: the extension reported an error')
if (!shown.info.some(m => /^Handed in /.test(m))) throw new Error('FAIL: no hand-in confirmation')

// ---- the instructor's receipt ------------------------------------------------
const asInstructor = r => fetch(`${origin}/api/classroom${r}`, { headers: { authorization: `Bearer ${RW}` } })
const receiptRes = await asInstructor(`/assignments/${ASSIGNMENT}/submissions/${STUDENT}`)
const receipt = await receiptRes.json()
log(`\ninstructor GET submission -> ${receiptRes.status}`)
log(JSON.stringify({ studentId: receipt.studentId, assignmentId: receipt.assignmentId, contentRef: receipt.contentRef, submittedAt: receipt.submittedAt, answerIds: receipt.answerIds }, null, 2))
if (receiptRes.status !== 200 || !receipt.submittedAt) throw new Error('FAIL: no instructor-visible receipt')

const status = await (await asInstructor(`/courses/${COURSE}/status`)).json()
const cell = status.rows.find(r => r.id === STUDENT)?.assignments.find(a => a.assignmentId === ASSIGNMENT)
log(`gradebook cell: ${JSON.stringify(cell)}`)
if (cell.state === 'not-submitted') throw new Error('FAIL: gradebook still shows not-submitted')

// ---- what actually travelled -------------------------------------------------
const stored = store.getSubmission(ASSIGNMENT, STUDENT)
log(`\nserver recorded contentRef: ${stored.contentRef}; build queued for: ${JSON.stringify(received)}`)
const sent = unzipSync(new Uint8Array(sentBytes))
log(`files the extension put on the wire: ${Object.keys(sent).sort().join(', ')}`)
const carriedQmd = strFromU8(sent['hw-minus-1-setup.qmd'])
log(`archive carries shared-code.qmd:      ${'shared-code.qmd' in sent}`)
log(`archive carries the .qmd.support dir: ${Object.keys(sent).some(n => n.includes('.qmd.support/'))}`)
log(`archive's qmd is the student's file:  ${carriedQmd === fs.readFileSync(qmdPath, 'utf8')}`)

server.close()
fs.rmSync(dir, { recursive: true, force: true })
log('\nPASS')
