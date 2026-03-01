/**
 * Viewer role state: 'presenter' or 'viewer'.
 *
 * Presenter: broadcasts camera, annotations synced immediately,
 *   visibility pill controls how foreign annotations appear.
 * Viewer: follows presenter's camera, annotations start as drafts,
 *   draft pill controls when annotations go live.
 */

export type Role = 'presenter' | 'viewer'

let docName = ''
let role: Role = 'viewer'
const listeners = new Set<() => void>()

export function initRole(doc: string) {
  docName = doc
  role = (localStorage.getItem(`tlda-role:${doc}`) as Role) || 'viewer'
}

export function getRole(): Role { return role }

export function setRole(r: Role) {
  if (r === role) return
  role = r
  localStorage.setItem(`tlda-role:${docName}`, r)
  listeners.forEach(fn => fn())
}

export function toggleRole() {
  setRole(role === 'presenter' ? 'viewer' : 'presenter')
}

export function subscribeRole(fn: () => void): () => void {
  listeners.add(fn)
  return () => { listeners.delete(fn) }
}
