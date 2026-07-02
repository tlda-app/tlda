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

export function resolveFilePath(filePath, cwd) {
  const expanded = filePath.replace(/^~\//, os.homedir() + '/')
  if (path.isAbsolute(expanded)) return expanded
  return cwd ? path.resolve(cwd, expanded) : expanded
}

// Upload a local file to the fleet server's /api/upload endpoint.
// Returns { url, fileName, mimeType } or throws on failure.
export async function uploadFileToServer(absPath, serverBaseUrl, timeoutMs = 10000) {
  const buf = fs.readFileSync(absPath)
  const fileName = path.basename(absPath)
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
