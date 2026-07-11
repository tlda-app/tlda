import { existsSync, realpathSync } from 'node:fs'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'

export function resolveContainedPath(root, targetPath) {
  if (!root) throw new Error('Invalid root path')
  const text = String(targetPath || '')
  if (!text || text.includes('\0')) throw new Error('Invalid file path')

  const rootReal = realpathIfExists(root) || resolve(root)
  const full = isAbsolute(text) ? resolve(text) : resolve(rootReal, text)
  const ancestor = nearestExistingAncestor(full)
  if (ancestor) {
    const ancestorReal = realpathSync(ancestor)
    const canonicalFull = resolve(ancestorReal, relative(ancestor, full))
    assertInside(rootReal, canonicalFull, { allowSame: false })
  }

  return full
}

export function isSameOrInsidePath(child, parent) {
  if (!child || !parent) return false
  const a = resolve(child)
  const b = resolve(parent)
  return a === b || a.startsWith(`${b}${sep}`)
}

function assertInside(root, candidate, { allowSame }) {
  const rel = relative(root, candidate)
  if ((!allowSame && !rel) || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error('Invalid file path')
  }
}

function nearestExistingAncestor(path) {
  let current = path
  while (current && current !== dirname(current)) {
    if (existsSync(current)) return current
    current = dirname(current)
  }
  return existsSync(current) ? current : null
}

function realpathIfExists(path) {
  try {
    return existsSync(path) ? realpathSync(path) : null
  } catch {
    return null
  }
}
