/**
 * ClassroomIdentityBadge — "Logged in as X" in the top right of the classroom.
 *
 * X is the classroom identity: the name a student registered under, answered by
 * `/api/classroom/me` from the enrolment token they are carrying. It is never
 * browser-selected identity. Classroom chat and presence use this same
 * server-owned course identity.
 *
 * A reader the classroom cannot name gets no badge. "Logged in as" over an
 * empty name would be a claim about who is reading that nobody made.
 */

import type { ClassroomIdentity } from './api'
import './ClassroomIdentityBadge.css'

export function ClassroomIdentityBadge({ identity }: { identity: ClassroomIdentity | null }) {
  const who = identity?.role === 'student'
    ? identity.displayName
    : identity?.role === 'instructor'
      ? identity.preferredName
      : null
  if (!who) return null
  return <div className="classroom-identity-badge">Logged in as {who}</div>
}
