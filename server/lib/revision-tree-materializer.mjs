import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, posix } from 'node:path'

function admittedPath(value) {
  const path = String(value || '').replace(/\\/g, '/')
  if (!path || path.startsWith('/') || posix.normalize(path) !== path || path.split('/').includes('..')) {
    throw new Error(`source link escapes accepted revision: ${value}`)
  }
  return path
}

function modeFor(entry) {
  return entry.mode === '100755' ? 0o755 : 0o644
}

export async function materializeAcceptedRevision({ revision, lifecycle, destination, omitted = new Set(['.mcp.json']) }) {
  const entries = new Map((revision?.files || []).map(entry => [admittedPath(entry.path), entry]))

  async function materialize(targetPath, outputPath, stack = []) {
    const target = admittedPath(targetPath)
    if (stack.includes(target)) throw new Error(`source link cycle: ${[...stack, target].join(' -> ')}`)
    const entry = entries.get(target)
    if (entry) {
      if (entry.mode === '120000') {
        const bytes = await lifecycle.readRevisionFile(revision.id, target)
        if (!bytes) throw new Error(`accepted revision is missing ${target}`)
        const link = bytes.toString('utf8').replace(/\\/g, '/')
        if (link.startsWith('/')) throw new Error(`source link has external target: ${target}`)
        const resolved = admittedPath(posix.normalize(posix.join(posix.dirname(target), link)))
        return materialize(resolved, outputPath, [...stack, target])
      }
      if (entry.mode !== '100644' && entry.mode !== '100755') {
        throw new Error(`source member is not a regular file: ${target}`)
      }
      const bytes = await lifecycle.readRevisionFile(revision.id, target)
      if (!bytes) throw new Error(`accepted revision is missing ${target}`)
      await mkdir(dirname(outputPath), { recursive: true })
      await writeFile(outputPath, bytes, { mode: modeFor(entry) })
      return
    }

    const prefix = `${target}/`
    const children = [...entries].filter(([path]) => path.startsWith(prefix))
    if (children.length === 0) throw new Error(`source link target is not admitted: ${target}`)
    await mkdir(outputPath, { recursive: true })
    const immediate = new Set(children.map(([path]) => path.slice(prefix.length).split('/')[0]))
    for (const child of [...immediate].sort()) {
      await materialize(`${target}/${child}`, `${outputPath}/${child}`, [...stack, target])
    }
  }

  for (const [path, entry] of [...entries].sort(([a], [b]) => a.localeCompare(b))) {
    if (omitted.has(path)) continue
    const parentLink = path.split('/').slice(0, -1).some((_, index, parts) => entries.get(parts.slice(0, index + 1).join('/'))?.mode === '120000')
    if (parentLink) continue
    await materialize(path, `${destination}/${path}`)
  }
}
