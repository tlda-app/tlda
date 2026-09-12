// Walk the submissions + marking path as both roles, against the real router
// and the real store over a real socket. In-memory store, zz- course: touches
// nothing live.
import express from 'express'
import { ClassroomStore } from '/Users/skip/work/tlda/server/lib/classroom-store.mjs'
import { createClassroomRouter } from '/Users/skip/work/tlda/server/routes/classroom.mjs'

let principal = { role: 'instructor' }

const store = new ClassroomStore(':memory:')
const app = express()
app.use(express.json())
app.use('/api/classroom', createClassroomRouter({
  store,
  resolvePrincipal: () => principal,
  resolveTemplateVersion: async () => 'v1',
  // The real server has a project store; this harness does not. Injecting the
  // build resolver is what makes the instructor path exercisable at all — the
  // 500 without it is the rig, not the route.
  resolveSubmissionBuild: async () => ({ buildStatus: 'success', buildAt: null }),
}))
const server = await new Promise(r => { const s = app.listen(0, '127.0.0.1', () => r(s)) })
const base = `http://127.0.0.1:${server.address().port}/api/classroom`
const get = p => fetch(base + p).then(async r => ({ status: r.status, body: await r.json().catch(() => null) }))
const post = p => fetch(base + p, { method: 'POST' }).then(async r => ({ status: r.status, body: await r.json().catch(() => null) }))

// A disposable course.
store.upsertCourse({ id: 'zz-walk', title: 'ZZ Walk' })
store.upsertStudent({ id: 'stu1', courseId: 'zz-walk', displayName: 'Student One', enrollmentToken: 't1' })
store.upsertStudent({ id: 'stu2', courseId: 'zz-walk', displayName: 'Student Two', enrollmentToken: 't2' })
store.upsertAssignment({ id: 'hw1', courseId: 'zz-walk', title: 'HW 1', dueAt: '2026-09-12' })
store.upsertAssignment({ id: 'hw2', courseId: 'zz-walk', title: 'HW 2', dueAt: '2026-09-19' })
// stu1 submits hw1 only. stu2 submits nothing. hw2 unsubmitted by all.
store.submit({ assignmentId: 'hw1', studentId: 'stu1', contentRef: 'sub-stu1-hw1' })

const line = (label, r) => console.log(`${label.padEnd(52)} ${String(r.status).padEnd(4)} ${JSON.stringify(r.body)?.slice(0, 200)}`)

console.log('\n=== AS INSTRUCTOR ===')
principal = { role: 'instructor' }
const istatus = await get('/courses/zz-walk/status')
line('GET /courses/zz-walk/status', istatus)
if (istatus.status === 200) {
  console.log('   rows:', istatus.body.rows.map(r => `${r.id}[${r.assignments.map(c => c.state).join(',')}]`).join(' '))
  console.log('   counts:', JSON.stringify(istatus.body.counts))
}
line('GET /assignments/hw1/submissions/stu1', await get('/assignments/hw1/submissions/stu1'))

console.log('\n=== AS STUDENT stu1 (submitted hw1) ===')
principal = { role: 'student', studentId: 'stu1', courseId: 'zz-walk' }
line('GET /courses/zz-walk/status   <-- the LIST page', await get('/courses/zz-walk/status'))
line('GET /courses/zz-walk/assignments', await get('/courses/zz-walk/assignments'))
line('GET /assignments/hw1/mine', await get('/assignments/hw1/mine'))
line('GET /assignments/hw2/mine   (not submitted)', await get('/assignments/hw2/mine'))
line('GET /assignments/hw1/submissions/stu2 (other)', await get('/assignments/hw1/submissions/stu2'))
line('GET /me', await get('/me?course=zz-walk'))

console.log('\n=== ASYMMETRIC /status ===')
principal = { role: 'instructor' }
const asInstructor = await get('/courses/zz-walk/status')
console.log('instructor  rows:', asInstructor.body.rows.map(r => r.id).join(','),
  '| counts:', JSON.stringify(asInstructor.body.counts), '| viewer:', JSON.stringify(asInstructor.body.viewer))

principal = { role: 'student', studentId: 'stu1', courseId: 'zz-walk' }
const asStu1 = await get('/courses/zz-walk/status')
console.log('student stu1 status:', asStu1.status, 'rows:', asStu1.body.rows?.map(r => r.id).join(','),
  '| counts:', JSON.stringify(asStu1.body.counts), '| viewer:', JSON.stringify(asStu1.body.viewer))
console.log('  assignments visible:', asStu1.body.assignments?.map(a => a.id).join(','),
  '| own cells:', JSON.stringify(asStu1.body.rows?.[0]?.assignments?.map(c => `${c.assignmentId}:${c.state}`)))
console.log('  LEAK CHECK other students present in payload:',
  JSON.stringify(asStu1.body).includes('stu2') || JSON.stringify(asStu1.body).includes('Student Two'))

principal = { role: 'student', studentId: 'stu2', courseId: 'zz-walk' }
const asStu2 = await get('/courses/zz-walk/status')
console.log('student stu2 (no submissions) rows:', asStu2.body.rows?.map(r => r.id).join(','),
  '| counts:', JSON.stringify(asStu2.body.counts))

principal = { role: 'student', studentId: 'other', courseId: 'other-course' }
line('student of ANOTHER course -> /courses/zz-walk/status', await get('/courses/zz-walk/status'))

console.log('\n=== MARKING: instructor marks, student re-reads ===')
principal = { role: 'instructor' }
line('POST .../hw1/submissions/stu1/feedback', await fetch(`${base}/assignments/hw1/submissions/stu1/feedback`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ title: 'note', text: 'a comment' }),
}).then(async r => ({ status: r.status, body: await r.json().catch(() => null) })))
line('POST .../hw1/submissions/stu1/grade', await post('/assignments/hw1/submissions/stu1/grade'))

principal = { role: 'student', studentId: 'stu1', courseId: 'zz-walk' }
const afterGrade = await get('/assignments/hw1/mine')
line('student /mine AFTER marking (pre-return)', afterGrade)
console.log('   gradingStatus student sees:', afterGrade.body?.gradingStatus, '| feedback count:', afterGrade.body?.feedback?.length)

principal = { role: 'instructor' }
line('POST .../hw1/submissions/stu1/return', await post('/assignments/hw1/submissions/stu1/return'))
principal = { role: 'student', studentId: 'stu1', courseId: 'zz-walk' }
const afterReturn = await get('/assignments/hw1/mine')
line('student /mine AFTER return', afterReturn)
console.log('   gradingStatus student sees:', afterReturn.body?.gradingStatus, '| feedback count:', afterReturn.body?.feedback?.length)

server.close()
