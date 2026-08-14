import { createHash } from 'node:crypto'
const sha = value => createHash('sha256').update(String(value ?? '')).digest('hex')
const lines = value => String(value ?? '').split('\n').filter(line => line.trim()).slice(0,512).map(sha)
export function textChange(path, before, after) {
  return { path, removed_line_sha256: lines(before), added_line_sha256: lines(after), before_sha256: sha(before), after_sha256: sha(after) }
}
export function editOperation(kind, operationId, paths, changes = []) {
  const files = [...new Set(paths.filter(Boolean))].map(path => ({ path }))
  return operationId && files.length ? { operation_id: operationId, kind: String(kind).toLowerCase(), files, ...(changes.length ? { changes } : {}) } : null
}
