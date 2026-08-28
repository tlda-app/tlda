function unquoteYamlScalar(value) {
  const trimmed = value.trim()
  if (trimmed.length >= 2 && trimmed[0] === '"' && trimmed.at(-1) === '"') {
    return trimmed.slice(1, -1).replace(/\\([\\"])/g, '$1')
  }
  if (trimmed.length >= 2 && trimmed[0] === "'" && trimmed.at(-1) === "'") {
    return trimmed.slice(1, -1).replace(/''/g, "'")
  }
  return trimmed
}

function classroomSubmissionMetadata(source) {
  const match = String(source).match(/^---\s*\r?\n([\s\S]*?)\r?\n---\s*(?:\r?\n|$)/)
  if (!match) return null
  const values = new Map()
  for (const line of match[1].split(/\r?\n/)) {
    const field = line.match(/^([A-Za-z0-9_-]+)\s*:\s*(.*?)\s*$/)
    if (field) values.set(field[1], unquoteYamlScalar(field[2]))
  }
  const serverValue = values.get('tlda-classroom-server')
  const assignmentId = values.get('tlda-classroom-assignment')
  if (!serverValue || !assignmentId) return null
  let server
  try {
    server = new URL(serverValue)
  } catch {
    throw new Error('tlda-classroom-server must be a complete http or https URL.')
  }
  if (!['http:', 'https:'].includes(server.protocol) || server.username || server.password) {
    throw new Error('tlda-classroom-server must be a complete http or https URL without credentials.')
  }
  return { server: server.origin, assignmentId }
}

class ClassroomUploadError extends Error {
  constructor(message, status) {
    super(message)
    this.name = 'ClassroomUploadError'
    this.status = status
  }
}

async function submitSubmissionArchive({ server, assignmentId, classroomToken, archiveBytes, fetchImpl = globalThis.fetch }) {
  const endpoint = new URL(`/api/classroom/assignments/${encodeURIComponent(assignmentId)}/mine/upload`, server)
  const response = await fetchImpl(endpoint, {
    method: 'POST',
    headers: {
      'content-type': 'application/zip',
      'x-tlda-student-token': classroomToken,
    },
    body: archiveBytes,
  })
  let result
  try {
    result = await response.json()
  } catch {
    result = null
  }
  if (!response.ok) {
    const problems = Array.isArray(result?.problems) ? ` ${result.problems.join(' ')}` : ''
    throw new ClassroomUploadError(`${result?.error || `The server refused the submission (${response.status}).`}${problems}`, response.status)
  }
  return result
}

module.exports = { ClassroomUploadError, classroomSubmissionMetadata, submitSubmissionArchive }
