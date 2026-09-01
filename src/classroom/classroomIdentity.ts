import type { ClassroomIdentity } from './api'

function slug(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9_-]/g, '')
}

export function classroomFleetIdentity(identity: ClassroomIdentity) {
  const course = slug(identity.courseId)
  const owner = identity.role === 'student' ? slug(identity.studentId) : 'instructor'
  return {
    agentId: `fleet:classroom-${course}-${owner}`,
    name: `classroom-${course}-${owner}`,
    prettyName: identity.preferredName,
  }
}
