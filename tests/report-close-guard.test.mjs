import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import { decideReportClose } from '../bots/todd/report-close-guard.mjs'

const serverSource = fs.readFileSync(new URL('../server/unified-server.mjs', import.meta.url), 'utf8')
const reportCloseStart = serverSource.indexOf("if (type === 'report-close') {")
const reportCloseEnd = serverSource.indexOf("if (type === 'delete-task') {", reportCloseStart)
const reportCloseBlock = serverSource.slice(reportCloseStart, reportCloseEnd)

test('partial report with a close request is redirected to an open task', () => {
  const decision = decideReportClose('Implemented the first slice. Remaining: add the live-route test.')
  assert.equal(decision.allowClose, false)
  assert.equal(decision.reason, 'remaining-owned-work')
  assert.match(decision.message, /task remains open/i)
})

test('partial report permits a concrete continued owner or true authority boundary', () => {
  assert.deepEqual(
    decideReportClose('Remaining: browser proof. Owner: fleet:browser-qa.'),
    { allowClose: true, reason: 'continued-owner-or-task' },
  )
  assert.deepEqual(
    decideReportClose('Remaining: production deploy; requires Skip approval, a true authority boundary.'),
    { allowClose: true, reason: 'authority-boundary' },
  )
})

test('durable report-close records progress but guards the close transition', () => {
  assert.ok(reportCloseStart >= 0)
  assert.ok(reportCloseBlock.indexOf('const closeDecision = close ? decideReportClose(summary)') >= 0)
  assert.ok(reportCloseBlock.indexOf('const insertedReport') < reportCloseBlock.indexOf('if (close && closeDecision.allowClose && !closeEventId)'))
  assert.match(reportCloseBlock, /close_rejected: !!close && !closeDecision\.allowClose/)
})

test('complete report remains closable', () => {
  assert.deepEqual(decideReportClose('Implemented and verified the guard tests.'), {
    allowClose: true,
    reason: 'no-remaining-work',
  })
})
