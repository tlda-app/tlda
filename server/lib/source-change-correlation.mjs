import { createHash } from 'crypto'

function fingerprint(message) {
  return createHash('sha256').update(JSON.stringify({
    project: message.project,
    expectedRevision: message.expectedRevision,
    files: message.files || [],
    deletedFiles: message.deletedFiles || [],
    sourceManifest: message.sourceManifest || [],
    editedBy: message.editedBy || null,
  })).digest('hex')
}

export function createSourceChangeResultCache() {
  const results = new Map()
  return {
    lookup(message) {
      if (typeof message.requestId !== 'string' || !message.requestId.trim()) return { error: 'requestId is required' }
      const hash = fingerprint(message)
      const prior = results.get(message.requestId)
      if (!prior) return { hash }
      if (prior.hash !== hash) return { error: 'requestId was reused for a different source mutation' }
      return { replay: prior.result }
    },
    record(requestId, hash, result) {
      results.set(requestId, { hash, result })
      return result
    },
  }
}
