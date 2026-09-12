import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import tls from 'node:tls'

function cleanHeader(value) {
  return String(value || '').replace(/[\r\n]+/g, ' ').trim()
}

function quoteImap(value) {
  return `"${String(value || '').replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

function decodeMimeBody(value, encoding) {
  if (/base64/i.test(encoding || '')) return Buffer.from(String(value).replace(/\s+/g, ''), 'base64')
  if (/quoted-printable/i.test(encoding || '')) {
    return Buffer.from(String(value).replace(/=\r?\n/g, '').replace(/=([0-9a-f]{2})/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16))), 'binary')
  }
  return Buffer.from(String(value).replace(/\r\n/g, '\n'), 'utf8')
}

export function parseInboundMime(raw) {
  const [headerText = '', ...bodyParts] = String(raw || '').split(/\r?\n\r?\n/)
  const headers = {}
  let last = null
  for (const line of headerText.split(/\r?\n/)) {
    if (/^[ \t]/.test(line) && last) headers[last] += ` ${line.trim()}`
    else {
      const at = line.indexOf(':')
      if (at > 0) { last = line.slice(0, at).toLowerCase(); headers[last] = line.slice(at + 1).trim() }
    }
  }
  const address = value => String(value || '').match(/<([^>]+)>/)?.[1] || String(value || '').trim()
  const boundary = headers['content-type']?.match(/boundary="?([^";]+)"?/i)?.[1]
  if (!boundary) {
    return { from: address(headers.from), to: address(headers.to), text: decodeMimeBody(bodyParts.join('\n\n'), headers['content-transfer-encoding']).toString('utf8'), attachments: [] }
  }
  let text = ''
  const attachments = []
  for (const rawPart of bodyParts.join('\r\n\r\n').split(`--${boundary}`).slice(1)) {
    if (rawPart.startsWith('--')) break
    const [partHeadersText = '', ...partBody] = rawPart.replace(/^\r?\n/, '').split(/\r?\n\r?\n/)
    const partHeaders = Object.fromEntries(partHeadersText.split(/\r?\n/).map(line => {
      const at = line.indexOf(':'); return at > 0 ? [line.slice(0, at).toLowerCase(), line.slice(at + 1).trim()] : [line, '']
    }))
    const content = decodeMimeBody(partBody.join('\r\n\r\n').replace(/\r?\n$/, ''), partHeaders['content-transfer-encoding'])
    const name = partHeaders['content-disposition']?.match(/filename="?([^";]+)"?/i)?.[1]
    if (name) attachments.push({ name, mimeType: partHeaders['content-type']?.split(';')[0] || 'application/octet-stream', contentBase64: content.toString('base64') })
    else if (/^text\/plain/i.test(partHeaders['content-type'] || '')) text = content.toString('utf8')
  }
  return { from: address(headers.from), to: address(headers.to), text, attachments }
}

function createTaggedReader(socket) {
  let buffer = ''
  let sequence = 0
  const waiting = []
  socket.on('data', chunk => {
    buffer += chunk.toString('utf8')
    for (const item of [...waiting]) {
      const match = buffer.match(new RegExp(`(?:^|\\r?\\n)${item.tag} (OK|NO|BAD)[^\\r\\n]*(?:\\r?\\n|$)`, 'i'))
      if (!match) continue
      waiting.splice(waiting.indexOf(item), 1)
      const response = buffer.slice(0, match.index + match[0].length)
      buffer = buffer.slice(match.index + match[0].length)
      if (match[1].toUpperCase() === 'OK') item.resolve(response)
      else item.reject(new Error(`IMAP ${match[1]}: ${response.trim()}`))
    }
  })
  return command => new Promise((resolve, reject) => {
    const tag = `A${++sequence}`
    waiting.push({ tag, resolve, reject })
    socket.write(`${tag} ${command}\r\n`)
  })
}

export async function pollImapOnce(config, onMessage, { connect = null } = {}) {
  if (config.secure !== true) throw new Error('IMAP email transport requires TLS from connect')
  const socket = connect ? await connect(config) : await new Promise((resolve, reject) => {
    const s = tls.connect({ host: config.host, port: config.port, servername: config.host }, () => resolve(s))
    s.once('error', reject)
  })
  const command = createTaggedReader(socket)
  try {
    await command(`LOGIN ${quoteImap(config.username)} ${quoteImap(config.password)}`)
    await command('SELECT INBOX')
    const search = await command('UID SEARCH UNSEEN TO "reply+"')
    const ids = search.match(/\* SEARCH([^\r\n]*)/i)?.[1]?.trim().split(/\s+/).filter(Boolean) || []
    const failures = []
    for (const uid of ids) {
      const fetched = await command(`UID FETCH ${uid} (BODY.PEEK[])`)
      const literal = fetched.match(/\{(\d+)\}\r?\n/)
      if (!literal) continue
      const start = literal.index + literal[0].length
      const raw = fetched.slice(start, start + Number(literal[1]))
      try {
        await onMessage(parseInboundMime(raw))
        await command(`UID STORE ${uid} +FLAGS (\\Seen)`)
      } catch (error) {
        failures.push(new Error(`IMAP UID ${uid}: ${error?.message || error}`))
      }
    }
    await command('LOGOUT')
    if (failures.length) throw new AggregateError(failures, `${failures.length} inbound email(s) were rejected`)
    return ids.length
  } finally {
    socket.destroy()
  }
}

export function startImapReceiver(config, onMessage, { poll = pollImapOnce, setTimer = setTimeout } = {}) {
  let stopped = false
  const run = async () => {
    if (stopped) return
    try { await poll(config, onMessage) } catch (error) {
      // A failed poll is recoverable: report it, then let the interval below schedule the next poll.
      console.error(`[email:imap] ${error?.message || error}`)
    }
    if (!stopped) {
      const timer = setTimer(run, config.pollIntervalMs)
      timer.unref?.()
    }
  }
  void run()
  return { stop() { stopped = true } }
}

export function applyEmailPolicyDelivery({ service, decision, eventId, recipientId, senderId, defer = setImmediate }) {
  if (!service || !decision) return
  if (decision.delivery === 'notified') {
    defer(() => { void service.deliver({ eventId, recipientId }) })
  } else if (decision.delivery === 'batched') {
    service.queue({ eventId, recipientId, senderId, batchKey: decision.batch_key, notifyBy: decision.notifyBy })
  } else if (decision.delivery === 'queued') {
    void service.hold({ eventId, recipientId })
  }
}

function b64url(value) {
  return Buffer.from(value).toString('base64url')
}

export function createReplyToken(secret, payload) {
  if (!secret) throw new Error('email reply secret is not configured')
  const iv = randomBytes(12)
  const key = createHash('sha256').update(secret).digest()
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(payload), 'utf8'), cipher.final()])
  return b64url(Buffer.concat([iv, cipher.getAuthTag(), ciphertext]))
}

export function readReplyToken(secret, token) {
  try {
    const packed = Buffer.from(String(token || ''), 'base64url')
    if (packed.length < 29) return null
    const iv = packed.subarray(0, 12)
    const tag = packed.subarray(12, 28)
    const ciphertext = packed.subarray(28)
    const key = createHash('sha256').update(secret).digest()
    const decipher = createDecipheriv('aes-256-gcm', key, iv)
    decipher.setAuthTag(tag)
    const payload = JSON.parse(Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8'))
    return payload && typeof payload === 'object' ? payload : null
  } catch {
    return null
  }
}

function parseReplyAddress(address, domain) {
  const match = String(address || '').trim().match(/^reply\+([^@]+)@(.+)$/i)
  if (!match || match[2].toLowerCase() !== String(domain || '').toLowerCase()) return null
  return match[1]
}

function dotStuff(value) {
  return String(value).replace(/\r?\n/g, '\r\n').replace(/^\./gm, '..')
}

async function readSmtpReply(socket) {
  return await new Promise((resolve, reject) => {
    let text = ''
    const onData = (chunk) => {
      text += chunk.toString('utf8')
      const lines = text.split(/\r?\n/).filter(Boolean)
      const last = lines.at(-1)
      if (!last || !/^\d{3} /.test(last)) return
      cleanup()
      const code = Number(last.slice(0, 3))
      if (code >= 400) reject(new Error(`SMTP ${code}: ${last.slice(4)}`))
      else resolve({ code, text })
    }
    const onError = (error) => { cleanup(); reject(error) }
    const cleanup = () => { socket.off('data', onData); socket.off('error', onError) }
    socket.on('data', onData)
    socket.on('error', onError)
  })
}

async function smtpCommand(socket, command, expected) {
  socket.write(`${command}\r\n`)
  const reply = await readSmtpReply(socket)
  if (expected && !expected.includes(reply.code)) throw new Error(`SMTP expected ${expected.join('/')} after ${command.split(' ')[0]}, got ${reply.code}`)
  return reply
}

export function createSmtpTransport(config, { connect = null } = {}) {
  if (config.secure !== true) throw new Error('SMTP email transport requires TLS from connect')
  return {
    async send(mail) {
      const socket = connect
        ? await connect(config)
        : await new Promise((resolve, reject) => {
          const s = tls.connect({ host: config.host, port: config.port, servername: config.host }, () => resolve(s))
          s.once('error', reject)
        })
      try {
        await readSmtpReply(socket)
        await smtpCommand(socket, `EHLO ${cleanHeader(config.helo || 'tlda.local')}`, [250])
        if (config.username) {
          await smtpCommand(socket, 'AUTH LOGIN', [334])
          await smtpCommand(socket, Buffer.from(config.username).toString('base64'), [334])
          await smtpCommand(socket, Buffer.from(config.password).toString('base64'), [235])
        }
        await smtpCommand(socket, `MAIL FROM:<${cleanHeader(mail.envelopeFrom)}>`, [250])
        await smtpCommand(socket, `RCPT TO:<${cleanHeader(mail.to)}>`, [250, 251])
        await smtpCommand(socket, 'DATA', [354])
        socket.write(`${dotStuff(mail.raw)}\r\n.\r\n`)
        await readSmtpReply(socket)
        await smtpCommand(socket, 'QUIT', [221])
      } finally {
        socket.destroy()
      }
    },
  }
}

function mimeMessage({ fromName, account, to, replyTo, subject, text, attachments }) {
  const boundary = `tlda-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
  const headers = [
    `From: ${cleanHeader(fromName)} via tlda <${cleanHeader(account)}>`,
    `To: ${cleanHeader(to)}`,
    `Reply-To: ${cleanHeader(replyTo)}`,
    `Subject: ${cleanHeader(subject)}`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
  ]
  const parts = [
    `--${boundary}\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: 8bit\r\n\r\n${text}`,
  ]
  for (const attachment of attachments) {
    parts.push(`--${boundary}\r\nContent-Type: ${cleanHeader(attachment.mimeType || 'application/octet-stream')}\r\nContent-Disposition: attachment; filename="${cleanHeader(attachment.name || 'attachment')}"\r\nContent-Transfer-Encoding: base64\r\n\r\n${attachment.content.toString('base64').replace(/(.{76})/g, '$1\r\n')}`)
  }
  parts.push(`--${boundary}--`)
  return `${headers.join('\r\n')}\r\n\r\n${parts.join('\r\n')}`
}

async function canonicalAttachments(metadata = {}, attachmentRoot = null) {
  const result = []
  for (const item of [...(metadata.attachments || []), ...(metadata.inline_attachments || [])]) {
    let itemPath = item?.path || null
    if ((!itemPath || !path.isAbsolute(itemPath)) && item?.url) {
      try { itemPath = new URL(item.url, 'http://tlda.local').searchParams.get('path') } catch { itemPath = null }
    }
    if (!itemPath || !path.isAbsolute(itemPath)) continue
    if (attachmentRoot) {
      const root = path.resolve(attachmentRoot)
      const resolved = path.resolve(itemPath)
      if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) continue
    }
    result.push({ name: item.name, mimeType: item.mimeType, content: await readFile(itemPath) })
  }
  return result
}

export function createEmailNotificationTransport(config, {
  transport,
  getEvent,
  getAgent,
  patchDeliveryState,
  insertInboundChat,
  now = () => Date.now(),
  setTimer = setTimeout,
} = {}) {
  if (!config) return null
  if (!config.attachmentRoot || !path.isAbsolute(config.attachmentRoot)) {
    throw new Error('email transport requires an absolute canonical attachment root')
  }
  const identities = new Map(Object.entries(config.identities || {}).filter(([, value]) => value?.verified === true && value?.address))
  const replySecret = config.replySecret
  const batches = new Map()
  let stateWrites = Promise.resolve()
  const patchState = (eventId, recipientId, state) => {
    stateWrites = stateWrites.then(() => patchDeliveryState(eventId, recipientId, state))
    return stateWrites
  }

  const deliverMany = async ({ eventIds, recipientId }) => {
    const binding = identities.get(recipientId)
    if (!binding) {
      const state = { state: 'denied', at: new Date(now()).toISOString(), reason: 'recipient has no verified email binding' }
      for (const eventId of eventIds) await patchState(eventId, recipientId, state)
      return state
    }
    const events = (await Promise.all(eventIds.map(id => getEvent(id)))).filter(Boolean)
    if (!events.length) return { state: 'failed', reason: 'canonical message not found' }
    const event = events.at(-1)
    if (events.some(item => item.from !== event.from)) throw new Error('one email batch cannot span tlda threads')
    const sender = await getAgent(event.from)
    const fromName = sender?.friendly_name || event.from || 'tlda agent'
    const token = createReplyToken(replySecret, { eventId: event.id, identity: recipientId, replyTo: event.from, issuedAt: now() })
    const replyTo = `reply+${token}@${config.replyDomain}`
    const attachments = (await Promise.all(events.map(item => canonicalAttachments(item.metadata, config.attachmentRoot)))).flat()
    const mail = {
      envelopeFrom: config.account,
      fromName,
      to: binding.address,
      replyTo,
      subject: `${fromName} via tlda`,
      text: `${fromName} sent ${events.length === 1 ? 'this' : `${events.length} messages`} through tlda:\n\n${events.map(item => item.text || '').join('\n\n---\n\n')}`,
      attachments,
    }
    mail.raw = mimeMessage({ ...mail, account: config.account })
    try {
      await transport.send(mail)
      const state = { state: 'delivered', at: new Date(now()).toISOString() }
      for (const eventId of eventIds) await patchState(eventId, recipientId, state)
      return state
    } catch (error) {
      const state = { state: 'failed', at: new Date(now()).toISOString(), reason: error?.message || String(error) }
      for (const eventId of eventIds) await patchState(eventId, recipientId, state)
      return state
    }
  }

  const deliver = ({ eventId, recipientId }) => deliverMany({ eventIds: [eventId], recipientId })

  const queue = ({ eventId, recipientId, senderId, batchKey, notifyBy }) => {
    if (!batchKey) throw new Error('email batch requires the existing subscription batch key')
    const key = `${recipientId}\0${senderId}\0${batchKey}`
    let batch = batches.get(key)
    if (!batch) {
      batch = { eventIds: new Set(), timer: null }
      batches.set(key, batch)
    }
    batch.eventIds.add(eventId)
    void patchState(eventId, recipientId, { state: 'batched', notifyBy })
    if (!batch.timer) {
      batch.timer = setTimer(() => {
        batches.delete(key)
        void deliverMany({ eventIds: [...batch.eventIds], recipientId })
      }, Math.max(0, Date.parse(notifyBy) - now()))
      batch.timer.unref?.()
    }
  }

  const hold = async ({ eventId, recipientId }) => {
    const state = { state: 'held' }
    await patchState(eventId, recipientId, state)
    return state
  }

  const receive = async ({ to, text, attachments = [], authenticated = false }) => {
    if (!authenticated) throw new Error('inbound provider request is not authenticated')
    const token = parseReplyAddress(to, config.replyDomain)
    const route = token && readReplyToken(replySecret, token)
    if (!route?.eventId || !route?.identity || !route?.replyTo) throw new Error('invalid reply route')
    if (!identities.has(route.identity)) throw new Error('reply route identity is no longer configured')
    return await insertInboundChat({
      from: route.identity,
      to: route.replyTo,
      text,
      attachments,
      metadata: { email_reply_to_event_id: route.eventId },
    })
  }

  return { deliver, queue, hold, receive }
}
