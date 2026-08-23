// chat-file-processing.mjs — shared file-upload logic for MCP chat() and daemon resolve-file RPC.
import fs from 'fs'
import path from 'path'
import os from 'os'

const MIME_MAP = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
  gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml',
  pdf: 'application/pdf', md: 'text/markdown', txt: 'text/plain',
}

export function guessMimeType(fileName) {
  const ext = (fileName.split('.').pop() || '').toLowerCase()
  return MIME_MAP[ext] || 'application/octet-stream'
}

// The directories tlda knows about, from the source bindings the daemon owns.
// Read fresh and cheaply; a miss returns [] rather than throwing, because a
// message must never fail to send because a binding file is absent.
function boundSourceDirs(configDir, envName) {
  try {
    const file = path.join(configDir, `source-bindings${envName ? '.' + envName : ''}.json`)
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
    // Values are objects carrying `sourceDir`; older entries were bare strings.
    const dirs = Object.values(raw || {}).map(v => (v && typeof v === 'object' ? v.sourceDir : v))
    return [...new Set(dirs.filter(d => typeof d === 'string' && d))]
  } catch { return [] }
}

// A BARE filename that is not in the author's own directory.
//
// Skip, 2026-08-23, after being handed a failure for a file that existed the
// whole time, one directory over: "IF THE FUCKING FILE WEREN'T THERE 'SAY THE
// FILENAME UNQUOTED' WOULD'VE GIVEN ME A BROKEN LINK". It was there. Resolution
// looked only where the author was standing, and the author was standing in a
// different repository from the document.
//
// So a bare name also gets looked up in the directories tlda has bindings for.
// UNIQUE MATCH ONLY: if two projects hold that filename there is no right
// answer, and guessing which one is worse than not resolving. A name containing
// a slash is a path and is left alone -- it says where it means.
function uniqueBoundFileNamed(basename, configDir, envName) {
  if (!basename || basename.includes('/')) return null
  const hits = []
  for (const dir of boundSourceDirs(configDir, envName)) {
    const candidate = path.join(dir, basename)
    try { if (fs.statSync(candidate).isFile()) hits.push(candidate) } catch { /* not there */ }
    if (hits.length > 1) return null
  }
  return hits.length === 1 ? hits[0] : null
}

export function resolveFilePath(filePath, cwd, options = {}) {
  const expanded = filePath.replace(/^~\//, os.homedir() + '/')
  if (path.isAbsolute(expanded)) return expanded
  const underCwd = cwd ? path.resolve(cwd, expanded) : expanded
  try { if (fs.existsSync(underCwd)) return underCwd } catch { /* fall through */ }
  const configDir = options.configDir || path.join(os.homedir(), '.config', 'tlda')
  const found = uniqueBoundFileNamed(expanded, configDir, options.envName || process.env.TLDA_ENV || null)
  return found || underCwd
}

// Upload bytes under a chosen name. Split out from uploadFileToServer because a
// markdown attachment is uploaded REWRITTEN -- its local image references
// replaced with uploaded URLs -- so the bytes that go up are not the bytes on
// disk. See rewriteMarkdownDepsToUrls in shared/markdown-deps.mjs.
// Returns { url, fileName, mimeType } or throws on failure.
export async function uploadBufferToServer(buf, fileName, serverBaseUrl, timeoutMs = 10000) {
  const res = await fetch(`${serverBaseUrl}/api/upload`, {
    method: 'POST',
    headers: { 'x-filename': encodeURIComponent(fileName) },
    body: buf,
    signal: AbortSignal.timeout(timeoutMs),
  })
  if (!res.ok) throw new Error(`upload failed: HTTP ${res.status}`)
  const data = await res.json()
  if (!data.url) throw new Error('upload returned no url')
  const url = new URL(data.url, serverBaseUrl).toString()
  return { url, fileName, mimeType: guessMimeType(fileName) }
}

// Upload a local file to the fleet server's /api/upload endpoint.
// Returns { url, fileName, mimeType } or throws on failure.
export async function uploadFileToServer(absPath, serverBaseUrl, timeoutMs = 10000) {
  return uploadBufferToServer(fs.readFileSync(absPath), path.basename(absPath), serverBaseUrl, timeoutMs)
}
