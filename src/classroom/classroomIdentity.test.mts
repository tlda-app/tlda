import { classroomFleetIdentity } from './classroomIdentity'

function equal(actual: unknown, expected: unknown, label: string) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(`${label}: ${JSON.stringify(actual)}`)
}

const student = { role: 'student' as const, studentId: 'qtm285:kjohn42', courseId: 'qtm285', preferredName: 'Katherine Johnson' }
const freshDevice = classroomFleetIdentity(student)
const returningDevice = classroomFleetIdentity(student)
equal(returningDevice, freshDevice, 'the same student authority resolves identically on every device')
equal(freshDevice.prettyName, 'Katherine Johnson', 'student preferred name')
if (/big-bird|cookie|grover|oscar|snuffy|abby|bert|ernie|count/.test(freshDevice.name)) throw new Error('temporary identity leaked')

const instructor = classroomFleetIdentity({ role: 'instructor', courseId: 'qtm285', preferredName: 'Skip' })
equal(instructor.prettyName, 'Skip', 'instructor preferred name')
if (instructor.agentId === freshDevice.agentId) throw new Error('instructor and student identities collided')

console.log('classroom server-owned identity: PASS')
