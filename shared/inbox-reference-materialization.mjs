import crypto from 'crypto'
import fs from 'fs'
import os from 'os'
import path from 'path'

export const MATERIALIZATION_MAX_BYTES = 25 * 1024 * 1024
export const MATERIALIZATION_STATES = new Set(['pending', 'available', 'failed', 'skipped'])

export function sha256Buffer(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex')
}

export function sanitizeAttachmentName(name) {
  const base = path.basename(String(name || 'attachment')).replace(/[^\w.\-]+/g, '_')
  return base && base !== '.' && base !== '..' ? base : 'attachment'
}

export function sanitizePathSegment(value) {
  const cleaned = String(value || 'unknown')
    .replace(/[^\w.\-:]+/g, '_')
    .replace(/\.\.+/g, '.')
    .replace(/^\.+$/, '_')
    .replace(/^\./, '_')
    .slice(0, 120)
  return cleaned || 'unknown'
}

export function inboxRefsRoot(env = process.env) {
  return env.TLDA_INBOX_REFS_DIR || path.join(os.homedir(), '.config', 'tlda', 'inbox-refs')
}

export function buildInboxRefPath({ root = inboxRefsRoot(), sourceAgent, date, eventId, name }) {
  const day = (date || new Date().toISOString()).slice(0, 10)
  return path.join(
    root,
    sanitizePathSegment(sourceAgent),
    sanitizePathSegment(day),
    `event-${sanitizePathSegment(eventId)}`,
    sanitizeAttachmentName(name)
  )
}

export function ensureRecipientRefs(metadata = {}) {
  const next = { ...(metadata || {}) }
  const refs = next.recipient_refs && typeof next.recipient_refs === 'object' ? next.recipient_refs : {}
  next.recipient_refs = { ...refs }
  return next
}

export function setRecipientAttachmentState(metadata = {}, recipientId, attachmentId, record) {
  if (!recipientId) throw new Error('recipientId required')
  if (attachmentId == null) throw new Error('attachmentId required')
  const state = record?.state
  if (!MATERIALIZATION_STATES.has(state)) throw new Error(`invalid materialization state: ${state}`)
  const next = ensureRecipientRefs(metadata)
  const currentRecipient = next.recipient_refs[recipientId] || {}
  const currentAttachments = currentRecipient.attachments || {}
  next.recipient_refs[recipientId] = {
    ...currentRecipient,
    attachments: {
      ...currentAttachments,
      [String(attachmentId)]: {
        ...(currentAttachments[String(attachmentId)] || {}),
        ...record,
      },
    },
  }
  return next
}

export function initializeRecipientRefs(metadata = {}, recipientId, attachments = [], { sourceAgent = null } = {}) {
  let next = metadata
  for (const att of attachments || []) {
    if (!isMaterializableAttachment(att)) continue
    next = setRecipientAttachmentState(next, recipientId, att.id, {
      kind: 'attachment',
      state: 'pending',
      status: 'pending',
      title: att.name || null,
      name: att.name || null,
      url: att.url || null,
      localPath: null,
      projectPath: null,
      projectArtifactId: null,
      contentType: att.mimeType || null,
      hash: att.sha256 || null,
      sourceAgent,
      provenance: {
        eventId: metadata?.event_id || null,
        attachmentId: String(att.id),
        url: att.url || null,
      },
      queued_at: new Date().toISOString(),
    })
  }
  return next
}

export function isMaterializableAttachment(att) {
  return !!att && att.type === 'file' && att.id != null && !att.broken && !!att.url
}

export function recipientAttachmentRef(metadata, recipientId, attachmentId) {
  return metadata?.recipient_refs?.[recipientId]?.attachments?.[String(attachmentId)] || null
}

export function formatRecipientAttachmentRef(ref) {
  if (!ref) return ''
  if (ref.state === 'available' && (ref.localPath || ref.path)) return ref.localPath || ref.path
  if (ref.state === 'pending') return `materializing on this machine...`
  if (ref.state === 'failed') return `materialization failed${ref.error ? `: ${ref.error}` : ''}`
  if (ref.state === 'skipped') return `materialization skipped${ref.reason ? `: ${ref.reason}` : ''}`
  return ''
}

export async function materializeAttachmentBytes({ bytes, eventId, attachmentId, sourceAgent, name, expectedSha256, maxBytes = MATERIALIZATION_MAX_BYTES, root }) {
  const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes)
  if (buf.length > maxBytes) throw new Error(`attachment exceeds max size (${buf.length} > ${maxBytes})`)
  const sha256 = sha256Buffer(buf)
  if (expectedSha256 && expectedSha256 !== sha256) throw new Error('attachment sha256 mismatch')
  const dest = buildInboxRefPath({ root, sourceAgent, date: new Date().toISOString(), eventId, name })
  fs.mkdirSync(path.dirname(dest), { recursive: true })
  const tmp = `${dest}.tmp-${process.pid}-${Date.now()}`
  fs.writeFileSync(tmp, buf, { mode: 0o600 })
  fs.renameSync(tmp, dest)
  return { localPath: dest, path: dest, size: buf.length, hash: sha256, sha256, attachment_id: attachmentId }
}
