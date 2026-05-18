// message-processing.mjs — shared pipeline for chat message text processing.
// Used by chat() in fleet.mjs and rechat daemon RPC.
import fs from 'fs'
import path from 'path'
import os from 'os'
import { uploadFileToServer } from './chat-file-processing.mjs'

const PATH_EXT = 'md|R|qmd|py|mjs|js|ts|tsx|jsx|css|html|tex|bib|rds|csv|tsv|txt|sh|yml|yaml|json|toml|cfg|log|svg|png|jpg|jpeg|gif|webp|pdf|sql|xml|rs|go|c|h|cpp|hpp|lua|rb|jl|rmd'
const pathRe = new RegExp(
  `(?<![\\/\\w])(~?\\/[\\w.\\-\\/]+\\.(?:${PATH_EXT})|[\\w][\\w.\\-\\/]*\\.(?:${PATH_EXT}))(?!\\w)`,
  'g'
)

// Detect file paths in message text and replace with {{att:N}} placeholders.
// Backtick-quoted spans/blocks are skipped (they are "quotes" per Skip's rule).
// Returns { resolvedMessage, inlineAttachments } where inlineAttachments entries
// have { type: 'file', id, path, name } — no url yet (call uploadAttachments next).
export function detectAttachments(message, agentCwd) {
  if (!agentCwd) return { resolvedMessage: message, inlineAttachments: [] }
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
  working = working.replace(pathRe, (match, filePath) => {
    const expanded = filePath.replace(/^~\//, os.homedir() + '/')
    if (expanded.startsWith('/')) {
      if (fs.existsSync(expanded)) {
        const id = attIdx++
        inlineAttachments.push({ type: 'file', id, path: expanded, name: path.basename(expanded) })
        return `{{att:${id}}}`
      }
      return match
    }
    const abs = path.resolve(agentCwd, expanded)
    if (fs.existsSync(abs)) {
      const id = attIdx++
      inlineAttachments.push({ type: 'file', id, path: abs, name: path.basename(abs) })
      return `{{att:${id}}}`
    }
    return match
  })
  // Restore masked regions (inline spans first, then fences — reverse of masking order)
  working = working.replace(/\x00I(\d+)\x00/g, (_, i) => masked[+i])
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
// Returns { resolvedMessage, inlineAttachments } with att.url populated.
export async function processMessageText(message, agentCwd, serverBaseUrl) {
  const { resolvedMessage, inlineAttachments } = detectAttachments(message, agentCwd)
  await uploadAttachments(inlineAttachments, serverBaseUrl)
  return { resolvedMessage, inlineAttachments }
}
