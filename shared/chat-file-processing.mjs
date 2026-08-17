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
