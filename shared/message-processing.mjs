// message-processing.mjs — shared pipeline for chat message text processing.
// Used by MCP chat()/compose(), daemon rechat RPC, and server unquote-file.
import fs from 'fs'
import path from 'path'
import { resolveFilePath, uploadFileToServer } from './chat-file-processing.mjs'

const PATH_EXT = 'md|R|qmd|py|mjs|js|ts|tsx|jsx|css|html|tex|bib|rds|csv|tsv|txt|sh|yml|yaml|json|toml|cfg|log|svg|png|jpg|jpeg|gif|webp|pdf|sql|xml|rs|go|c|h|cpp|hpp|lua|rb|jl|rmd'
const pathRe = new RegExp(
  `(?<![\\/\\w])((?:~?\\/|\\.\\.?\\/|\\.[\\w\\-]+\\/|[\\w])[\\w.\\-\\/]*\\.(?:${PATH_EXT}))(?!\\w)`,
  'g'
)

// Detect file paths in message text and replace with {{att:N}} placeholders.
// Backtick-quoted spans/blocks are skipped (they are "quotes" per Skip's rule).
// Returns { resolvedMessage, inlineAttachments } where inlineAttachments entries
// have { type: 'file', id, path, name } — no url yet (call uploadAttachments next).
export function detectAttachments(message, agentCwd) {
  const inlineAttachments = []
  const masked = []
  const maskToken = (kind, raw) => {
    const i = masked.length
    masked.push(raw)
    return `\x00${kind}${i}\x00`
  }
  // 1. Triple-backtick fenced code blocks (may contain newlines)
  let working = message.replace(/```[\s\S]*?```/g, (m) => maskToken('F', m))
  // 2. Single-backtick inline spans (no newlines, non-empty interior)
  working = working.replace(/`[^`\n]+`/g, (m) => maskToken('I', m))
  let attIdx = 0
  // 3a. Markdown images with localhost file API URLs: ![...](http://localhost:.../api/file?path=...)
  const mdImageRe = /!\[([^\]]*)\]\((https?:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?\/api\/file\?path=([^)]+))\)/g
  working = working.replace(mdImageRe, (match, _alt, _url, encodedPath) => {
    const filePath = decodeURIComponent(encodedPath)
    if (fs.existsSync(filePath)) {
      const id = attIdx++
      inlineAttachments.push({ type: 'file', id, path: filePath, name: path.basename(filePath) })
      return `{{att:${id}}}`
    }
    const id = attIdx++
    inlineAttachments.push({ type: 'file', id, path: filePath, name: path.basename(filePath), broken: true })
    return `{{att:${id}}}`
  })
  // 3a-bis. Mask remaining http(s) URLs so the bare-path pass never reads a URL
  // as a file. Without this, a host like `cormorant-matrix.ts.net` matches the
  // `.ts` extension (pathRe's `(?!\w)` allows the following `.`), mangling the
  // link into `https:{{att:N}}.net/...`. (api-file markdown images were already
  // consumed in 3a above; this only masks plain URLs.)
  working = working.replace(/\bhttps?:\/\/[^\s)]+/g, (m) => maskToken('U', m))
  // 3b. Bare file paths — any match enters the pipeline; missing files are marked broken.
  working = working.replace(pathRe, (match, filePath) => {
    const resolved = resolveFilePath(filePath, agentCwd)
    const id = attIdx++
    if (fs.existsSync(resolved)) {
      inlineAttachments.push({ type: 'file', id, path: resolved, name: path.basename(resolved) })
    } else {
      inlineAttachments.push({ type: 'file', id, path: resolved, name: path.basename(resolved), broken: true })
    }
    return `{{att:${id}}}`
  })
  // Restore masked regions (inline spans first, then fences — reverse of masking order)
  working = working.replace(/\x00I(\d+)\x00/g, (_, i) => masked[+i])
  working = working.replace(/\x00U(\d+)\x00/g, (_, i) => masked[+i])
  working = working.replace(/\x00F(\d+)\x00/g, (_, i) => masked[+i])
  return { resolvedMessage: working, inlineAttachments }
}

// Upload all attachments to the server. Mutates att.url / att.broken in place.
// If upload fails, marks att.broken = true so the renderer shows a broken-chip style.
export async function uploadAttachments(inlineAttachments, serverBaseUrl) {
  for (const att of inlineAttachments) {
    if (att.path && fs.existsSync(att.path)) {
      try {
        const { url } = await uploadFileToServer(att.path, serverBaseUrl)
        att.url = url
      } catch (err) {
        console.error('[message-processing] upload failed:', att.path, err.message)
        att.broken = true
      }
    } else {
      att.broken = true
    }
  }
}

// Full pipeline: detect paths, replace with {{att:N}}, upload files.
// Returns { resolvedMessage, inlineAttachments, brokenPaths } with att.url populated.
// brokenPaths lists files that were referenced but don't exist or failed upload.
export async function processMessageText(message, agentCwd, serverBaseUrl) {
  const { resolvedMessage, inlineAttachments } = detectAttachments(message, agentCwd)
  await uploadAttachments(inlineAttachments, serverBaseUrl)
  const brokenPaths = inlineAttachments.filter(a => a.broken).map(a => a.path)
  return { resolvedMessage, inlineAttachments, brokenPaths }
}
