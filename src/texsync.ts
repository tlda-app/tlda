/**
 * texsync:// URL scheme helper.
 * Opens source files in the local editor (Zed) via the texsync URL handler.
 */

const sourceDirCache = new Map<string, string | null>()

/** Fetch and cache the sourceDir for a project. */
async function getSourceDir(docName: string): Promise<string | null> {
  if (sourceDirCache.has(docName)) return sourceDirCache.get(docName)!
  try {
    const base = import.meta.env.BASE_URL || '/'
    const res = await fetch(`${base}api/projects/${docName}`)
    if (!res.ok) return null
    const info = await res.json()
    const dir = info?.sourceDir ?? null
    sourceDirCache.set(docName, dir)
    return dir
  } catch {
    return null
  }
}

/** Open a source file at a line in the local editor via texsync:// URL. */
export async function openInEditor(docName: string, file: string, line: number) {
  const sourceDir = await getSourceDir(docName)
  const filePath = sourceDir
    ? `${sourceDir.replace(/\/$/, '')}/${file}`
    : file
  const url = `texsync://file${filePath}:${line}`
  console.log(`[texsync] ${url}`)
  const a = window.document.createElement('a')
  a.href = url
  a.click()
}
