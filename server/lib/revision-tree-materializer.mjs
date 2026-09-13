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

// Returns what it wrote: { files, bytes }. Every byte passes through here
// already, so the count is exact and free, and without it the caller's timing
// reports milliseconds with nothing to divide them by. A phase that says "13
// seconds" and not how much it moved cannot tell a slow copy from a big one,
// and those want opposite fixes. This is the link-materializing path, which is
// the one qmd projects take — so it is precisely the path a chapter build uses.
export async function materializeAcceptedRevision({ revision, lifecycle, destination, omitted = new Set(['.mcp.json']) }) {
  const entries = new Map((revision?.files || []).map(entry => [admittedPath(entry.path), entry]))
  // Not `files`/`bytes`: `bytes` is already the file buffer inside materialize(),
  // and the shadow makes the counter assign to a const at runtime only.
  let fileCount = 0
  let byteCount = 0

  // ONE spawn for every blob, rather than one per file.
  //
  // Measured on testing 2026-09-12, materialising the same 1.5MB of source:
  // 49 files took 434ms, 800 files took 6755ms. Same bytes, 15.6x apart. The
  // per-file `git cat-file blob` subprocess was ~8.5ms and the file COUNT was
  // the whole cost, which is why a whole-book project made every edit slower
  // however small the edit -- the thing this repository promised it would not
  // do.
  //
  // Every admitted blob is read, including any a link happens to shadow. The
  // walk below visits nearly all of them anyway, and one spawn for a superset
  // beats two passes to compute an exact set.
  const blobs = await lifecycle.readRevisionFiles(
    revision.id,
    [...entries].filter(([, entry]) => entry.mode !== '160000').map(([path]) => path),
  )
  // A batched read that silently yields `undefined` for a path would write an
  // empty file where content belongs, so absence is resolved to null here and
  // the existing `if (!bytes) throw` below catches it exactly as it always did.
  const readBlob = path => blobs.get(path) ?? null

  async function materialize(targetPath, outputPath, stack = []) {
    const target = admittedPath(targetPath)
    if (stack.includes(target)) throw new Error(`source link cycle: ${[...stack, target].join(' -> ')}`)
    const entry = entries.get(target)
    if (entry) {
      if (entry.mode === '120000') {
        const bytes = readBlob(target)
        if (!bytes) throw new Error(`accepted revision is missing ${target}`)
        const link = bytes.toString('utf8').replace(/\\/g, '/')
        if (link.startsWith('/')) throw new Error(`source link has external target: ${target}`)
        const resolved = admittedPath(posix.normalize(posix.join(posix.dirname(target), link)))
        return materialize(resolved, outputPath, [...stack, target])
      }
      if (entry.mode !== '100644' && entry.mode !== '100755') {
        throw new Error(`source member is not a regular file: ${target}`)
      }
      const bytes = readBlob(target)
      if (!bytes) throw new Error(`accepted revision is missing ${target}`)
      await mkdir(dirname(outputPath), { recursive: true })
      await writeFile(outputPath, bytes, { mode: modeFor(entry) })
      fileCount += 1
      byteCount += bytes.length
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

  return { files: fileCount, bytes: byteCount }
}
