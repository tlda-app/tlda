import fs from 'fs'
import path from 'path'
import { resolveFilePath, uploadFileToServer } from '../shared/chat-file-processing.mjs'
import { checkChatRender } from '../shared/chat-render-check.mjs'
import { MATERIALIZATION_MAX_BYTES, materializeAttachmentBytes } from '../shared/inbox-reference-materialization.mjs'
import { processMessageText } from '../shared/message-processing.mjs'

export function createLocalArtifacts({ getServerUrl, getFleetServerUrl, resolveAgentCwd }) {
  async function readDocumentText({ path: filePath, agent_id }) {
    const cwd = resolveAgentCwd?.(agent_id)
    if (!cwd) throw new Error(`agent cwd unavailable for ${agent_id || 'unknown agent'}`)
    const abs = resolveFilePath(filePath, cwd)
    const stat = await fs.promises.stat(abs)
    if (!stat.isFile()) throw new Error(`Document is not a file: ${abs}`)
    if (stat.size > 1_000_000) throw new Error(`Document exceeds similarity index limit: ${stat.size}`)
    return { text: (await fs.promises.readFile(abs, 'utf8')).slice(0, 240_000) }
  }

  async function resolveFile({ path: filePath, cwd, server_url }) {
    const abs = resolveFilePath(filePath, cwd)
    if (!fs.existsSync(abs)) throw new Error(`File not found: ${abs}`)
    const serverBase = server_url || getServerUrl()
    return await uploadFileToServer(abs, serverBase)
  }

  // No `server_url` parameter. The only sender — server/routes/fleet.mjs — has
  // never passed one, so `server_url || getServerUrl()` always took the
  // fallback: a field that existed to be ignored. Which server this daemon
  // talks to is the daemon's own configuration, not something the server tells
  // it, so the fallback was the real behaviour and the parameter was the lie.
  async function rechat({ text, agent_id }) {
    const cwd = resolveAgentCwd?.(agent_id)
    if (!cwd) throw new Error(`agent cwd unavailable for ${agent_id || 'unknown agent'}`)
    const serverBase = getServerUrl()
    const result = await processMessageText(text, cwd, serverBase)
    const markdownRenderIssues = []
    for (const att of result.inlineAttachments || []) {
      const name = String(att?.name || att?.path || '')
      if (att?.broken || !att?.path || !/\.(?:md|markdown)$/i.test(name)) continue
      try {
        const body = fs.readFileSync(att.path, 'utf8')
        const { validity } = checkChatRender(body)
        if (validity.length) {
          markdownRenderIssues.push({
            id: att.id,
            name: att.name || path.basename(att.path),
            path: att.path,
            issues: validity,
          })
        }
      } catch (e) {
        markdownRenderIssues.push({
          id: att.id,
          name: att.name || path.basename(att.path),
          path: att.path,
          issues: [`Could not read markdown file for render check: ${e.message}`],
        })
      }
    }
    return { ...result, markdownRenderIssues }
  }

  async function materializeAttachment({ event_id, attachment_id, source_agent, server_url, url, name, size, sha256 }) {
    if (!url) throw new Error('attachment url required')
    if (Number.isFinite(Number(size)) && Number(size) > MATERIALIZATION_MAX_BYTES) {
      throw new Error(`attachment exceeds max size (${size} > ${MATERIALIZATION_MAX_BYTES})`)
    }
    const serverBase = server_url || getFleetServerUrl()
    const target = new URL(url, serverBase).toString()
    const res = await fetch(target, { signal: AbortSignal.timeout(10000) })
    if (!res.ok) throw new Error(`attachment fetch failed: HTTP ${res.status}`)
    const len = Number(res.headers.get('content-length') || 0)
    if (len > MATERIALIZATION_MAX_BYTES) {
      throw new Error(`attachment exceeds max size (${len} > ${MATERIALIZATION_MAX_BYTES})`)
    }
    const ab = await res.arrayBuffer()
    return await materializeAttachmentBytes({
      bytes: Buffer.from(ab),
      eventId: event_id,
      attachmentId: attachment_id,
      sourceAgent: source_agent,
      name,
      expectedSha256: sha256 || null,
    })
  }

  return {
    handlers: {
      'resolve-file': resolveFile,
      'read-document-text': readDocumentText,
      'rechat': rechat,
      'materialize-attachment': materializeAttachment,
    },
  }
}
