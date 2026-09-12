import assert from 'node:assert/strict'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Duplex } from 'node:stream'
import test from 'node:test'
import { decideSubscriptionDelivery } from '../../shared/inbox-attention.mjs'
import { applyEmailPolicyDelivery, createEmailNotificationTransport, createReplyToken, createSmtpTransport, pollImapOnce, readReplyToken } from './email-notification-transport.mjs'

function protocolSocket(respond) {
  const writes = []
  const socket = new Duplex({
    read() {},
    write(chunk, encoding, callback) {
      const value = chunk.toString('utf8')
      writes.push(value)
      const reply = respond(value, writes)
      if (reply) setImmediate(() => socket.push(reply))
      callback()
    },
  })
  return { socket, writes }
}

function fixture(overrides = {}) {
  const sent = []
  const states = []
  const inbound = []
  const events = new Map([[41, { id: 41, from: 'fleet:agent', text: 'hello', metadata: {} }]])
  const service = createEmailNotificationTransport({
    account: 'agents@example.com',
    replyDomain: 'example.com',
    replySecret: 'test-only-secret',
    attachmentRoot: tmpdir(),
    identities: { 'fleet:human': { address: 'human@example.net', verified: true } },
  }, {
    transport: { send: async mail => { sent.push(mail) } },
    getEvent: async id => events.get(id),
    getAgent: async id => ({ id, friendly_name: 'Ada' }),
    patchDeliveryState: async (eventId, recipientId, state) => states.push({ eventId, recipientId, ...state }),
    insertInboundChat: async value => { inbound.push(value); return { id: 42 } },
    ...overrides,
  })
  return { service, sent, states, inbound, events }
}

test('signed reply routes reject tampering', () => {
  const token = createReplyToken('secret', { eventId: 1 })
  assert.equal(token.includes(Buffer.from('{"eventId":1}').toString('base64url')), false)
  assert.deepEqual(readReplyToken('secret', token), { eventId: 1 })
  assert.equal(readReplyToken('secret', `${token}x`), null)
})

test('actual SMTP protocol sends the envelope and raw MIME to an isolated sink', async () => {
  let inData = false
  const sink = protocolSocket(command => {
    if (inData) { inData = false; return '250 queued\r\n' }
    if (/^EHLO/.test(command)) return '250-local\r\n250 AUTH LOGIN\r\n'
    if (/^AUTH LOGIN/.test(command)) return '334 user\r\n'
    if (command.trim() === Buffer.from('user').toString('base64')) return '334 pass\r\n'
    if (command.trim() === Buffer.from('password').toString('base64')) return '235 authenticated\r\n'
    if (/^(MAIL FROM|RCPT TO)/.test(command)) return '250 ok\r\n'
    if (/^DATA/.test(command)) { inData = true; return '354 continue\r\n' }
    if (/^QUIT/.test(command)) return '221 bye\r\n'
    return null
  })
  const transport = createSmtpTransport({ secure: true, username: 'user', password: 'password' }, {
    connect: async () => { setImmediate(() => sink.socket.push('220 isolated sink\r\n')); return sink.socket },
  })
  await transport.send({
    envelopeFrom: 'agents@example.com', to: 'human@example.net',
    raw: 'From: Ada via tlda <agents@example.com>\r\n\r\nhello',
  })
  assert.ok(sink.writes.some(value => value === 'MAIL FROM:<agents@example.com>\r\n'))
  assert.ok(sink.writes.some(value => value === 'RCPT TO:<human@example.net>\r\n'))
  assert.ok(sink.writes.some(value => value.includes('From: Ada via tlda') && value.endsWith('\r\n.\r\n')))
})

test('actual SMTP sink refusal is surfaced by the transport', async () => {
  const sink = protocolSocket(command => {
    if (/^EHLO/.test(command)) return '250 ok\r\n'
    if (/^MAIL FROM/.test(command)) return '250 ok\r\n'
    if (/^RCPT TO/.test(command)) return '550 refused\r\n'
    return null
  })
  const transport = createSmtpTransport({ secure: true }, {
    connect: async () => { setImmediate(() => sink.socket.push('220 isolated sink\r\n')); return sink.socket },
  })
  await assert.rejects(() => transport.send({ envelopeFrom: 'agents@example.com', to: 'nobody@example.net', raw: 'x' }), /SMTP 550/)
})

test('delivery uses friendly authorship and records state on canonical event', async () => {
  const f = fixture()
  await f.service.deliver({ eventId: 41, recipientId: 'fleet:human' })
  assert.equal(f.sent.length, 1)
  assert.match(f.sent[0].raw, /From: Ada via tlda <agents@example.com>/)
  assert.equal(f.states[0].eventId, 41)
  assert.equal(f.states[0].state, 'delivered')
})

test('unverified or absent recipient binding denies email without exposing an address', async () => {
  const f = fixture()
  const result = await f.service.deliver({ eventId: 41, recipientId: 'fleet:none' })
  assert.equal(result.state, 'denied')
  assert.equal(result.reason, 'recipient has no verified email binding')
  assert.equal(f.sent.length, 0)
})

test('transport failure is recorded on the canonical event', async () => {
  const f = fixture({ transport: { send: async () => { throw new Error('sink refused') } } })
  await f.service.deliver({ eventId: 41, recipientId: 'fleet:human' })
  assert.equal(f.states[0].state, 'failed')
  assert.equal(f.states[0].reason, 'sink refused')
})

test('batch waits for its policy deadline and then sends', async () => {
  let callback
  const f = fixture({ setTimer: fn => { callback = fn; return { unref() {} } } })
  f.service.queue({ eventId: 41, recipientId: 'fleet:human', senderId: 'fleet:agent', batchKey: 'subscription-1', notifyBy: new Date(Date.now() + 1000).toISOString() })
  assert.equal(f.sent.length, 0)
  callback()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(f.sent.length, 1)
})

test('existing immediate, batch, and hold decisions govern the transport', async () => {
  const callbacks = []
  const f = fixture({ setTimer: fn => { callbacks.push(fn); return { unref() {} } } })
  f.events.set(42, { id: 42, from: 'fleet:agent', text: 'second', metadata: {} })
  const immediate = decideSubscriptionDelivery({ policy: 'immediate', priority: 'normal' })
  const held = decideSubscriptionDelivery({ policy: 'hold', priority: 'normal' })
  const batched = decideSubscriptionDelivery({ policy: 'batch(1s)', priority: 'normal' })
  assert.equal(immediate.delivery, 'notified')
  applyEmailPolicyDelivery({ service: f.service, decision: immediate, eventId: 41, recipientId: 'fleet:human', senderId: 'fleet:agent', defer: fn => fn() })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(held.delivery, 'queued')
  applyEmailPolicyDelivery({ service: f.service, decision: held, eventId: 42, recipientId: 'fleet:human', senderId: 'fleet:agent' })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(batched.delivery, 'batched')
  const batchDecision = { ...batched, batch_key: 'subscription-1' }
  applyEmailPolicyDelivery({ service: f.service, decision: batchDecision, eventId: 41, recipientId: 'fleet:human', senderId: 'fleet:agent' })
  applyEmailPolicyDelivery({ service: f.service, decision: { ...batchDecision, notifyBy: new Date(Date.parse(batched.notifyBy) + 500).toISOString() }, eventId: 42, recipientId: 'fleet:human', senderId: 'fleet:agent' })
  assert.equal(f.sent.length, 1)
  callbacks[0]()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(f.sent.length, 2)
  assert.match(f.sent[1].text, /2 messages/)
  assert.equal(f.states.find(item => item.eventId === 42 && item.state === 'held')?.state, 'held')
})

test('inbound reply requires an authenticated mailbox and opaque reply token', async () => {
  const f = fixture()
  await f.service.deliver({ eventId: 41, recipientId: 'fleet:human' })
  await assert.rejects(() => f.service.receive({ from: 'human@example.net', to: f.sent[0].replyTo, text: 'reply' }), /not authenticated/)
  await f.service.receive({ authenticated: true, from: 'spoofable-header@example.net', to: f.sent[0].replyTo, text: 'reply' })
  assert.deepEqual(f.inbound[0], {
    from: 'fleet:human', to: 'fleet:agent', text: 'reply', attachments: [],
    metadata: { email_reply_to_event_id: 41 },
  })
  assert.doesNotMatch(JSON.stringify(f.inbound[0].metadata), /@/)
  const forged = f.sent[0].replyTo.replace(/reply\+./, 'reply+x')
  await assert.rejects(() => f.service.receive({ authenticated: true, from: 'human@example.net', to: forged, text: 'no' }), /invalid reply route/)
})

test('inbound attachment payload remains attached to the canonical reply', async () => {
  const f = fixture()
  await f.service.deliver({ eventId: 41, recipientId: 'fleet:human' })
  const attachments = [{ name: 'answer.pdf', mimeType: 'application/pdf', contentBase64: Buffer.from([1, 2, 3]).toString('base64') }]
  await f.service.receive({ authenticated: true, from: 'human@example.net', to: f.sent[0].replyTo, text: 'attached', attachments })
  assert.deepEqual(f.inbound[0].attachments, attachments)
})

test('actual IMAP protocol receives unseen mail and marks it seen only after ingestion', async () => {
  const raw = 'From: Human <human@example.net>\r\nTo: reply+opaque@example.com\r\nContent-Type: text/plain\r\n\r\nhello from mail'
  const sink = protocolSocket(command => {
    const [tag] = command.split(' ')
    if (/ LOGIN /.test(command)) return `${tag} OK login\r\n`
    if (/ SELECT /.test(command)) return `${tag} OK selected\r\n`
    if (/UID SEARCH/.test(command)) return `* SEARCH 7\r\n${tag} OK search\r\n`
    if (/UID FETCH/.test(command)) return `* 1 FETCH (BODY[] {${Buffer.byteLength(raw)}}\r\n${raw})\r\n${tag} OK fetch\r\n`
    if (/UID STORE/.test(command)) return `${tag} OK stored\r\n`
    if (/LOGOUT/.test(command)) return `${tag} OK logout\r\n`
    return null
  })
  const received = []
  await pollImapOnce({ secure: true, username: 'user', password: 'password' }, message => received.push(message), {
    connect: async () => sink.socket,
  })
  assert.equal(received[0].text, 'hello from mail')
  assert.equal(received[0].from, 'human@example.net')
  assert.ok(sink.writes.some(value => /UID STORE 7 \+FLAGS \(\\Seen\)/.test(value)))
})

test('IMAP leaves a rejected spoof unseen', async () => {
  const raw = 'From: Forged <human@example.net>\r\nTo: reply+fabricated@example.com\r\nContent-Type: text/plain\r\n\r\nspoof'
  const sink = protocolSocket(command => {
    const [tag] = command.split(' ')
    if (/ LOGIN | SELECT /.test(command)) return `${tag} OK ready\r\n`
    if (/UID SEARCH/.test(command)) return `* SEARCH 9\r\n${tag} OK search\r\n`
    if (/UID FETCH/.test(command)) return `* 1 FETCH (BODY[] {${Buffer.byteLength(raw)}}\r\n${raw})\r\n${tag} OK fetch\r\n`
    if (/LOGOUT/.test(command)) return `${tag} OK logout\r\n`
    return null
  })
  await assert.rejects(() => pollImapOnce({ secure: true, username: 'user', password: 'password' }, async () => {
    throw new Error('invalid reply route')
  }, { connect: async () => sink.socket }), /1 inbound email/)
  assert.equal(sink.writes.some(value => /UID STORE/.test(value)), false)
})

test('one rejected IMAP reply does not starve a later valid reply', async () => {
  const invalid = 'From: X <x@example.net>\r\nTo: reply+bad@example.com\r\nContent-Type: text/plain\r\n\r\nbad'
  const valid = 'From: Y <y@example.net>\r\nTo: reply+good@example.com\r\nContent-Type: text/plain\r\n\r\ngood'
  const sink = protocolSocket(command => {
    const [tag] = command.split(' ')
    if (/ LOGIN | SELECT /.test(command)) return `${tag} OK ready\r\n`
    if (/UID SEARCH/.test(command)) return `* SEARCH 9 10\r\n${tag} OK search\r\n`
    if (/UID FETCH 9 /.test(command)) return `* 1 FETCH (BODY[] {${Buffer.byteLength(invalid)}}\r\n${invalid})\r\n${tag} OK fetch\r\n`
    if (/UID FETCH 10 /.test(command)) return `* 2 FETCH (BODY[] {${Buffer.byteLength(valid)}}\r\n${valid})\r\n${tag} OK fetch\r\n`
    if (/UID STORE/.test(command)) return `${tag} OK stored\r\n`
    if (/LOGOUT/.test(command)) return `${tag} OK logout\r\n`
    return null
  })
  const ingested = []
  await assert.rejects(() => pollImapOnce({ secure: true, username: 'user', password: 'password' }, async message => {
    if (message.text === 'bad') throw new Error('invalid reply route')
    ingested.push(message.text)
  }, { connect: async () => sink.socket }), /1 inbound email/)
  assert.deepEqual(ingested, ['good'])
  assert.equal(sink.writes.some(value => /UID STORE 9 /.test(value)), false)
  assert.equal(sink.writes.some(value => /UID STORE 10 /.test(value)), true)
})

test('outbound attachment bytes are the canonical stored artifact', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tlda-email-'))
  const path = join(dir, 'artifact.pdf')
  const bytes = Buffer.from([0, 1, 2, 255])
  await writeFile(path, bytes)
  const f = fixture()
  f.events.get(41).metadata.attachments = [{ path, name: 'artifact.pdf', mimeType: 'application/pdf' }]
  await f.service.deliver({ eventId: 41, recipientId: 'fleet:human' })
  assert.deepEqual(f.sent[0].attachments[0].content, bytes)
  assert.ok(f.sent[0].raw.includes(bytes.toString('base64')))
})

test('inline attachment bytes are included from the canonical upload', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tlda-email-inline-'))
  const path = join(dir, 'plot.png')
  const bytes = Buffer.from([137, 80, 78, 71])
  await writeFile(path, bytes)
  const f = fixture()
  f.events.get(41).metadata.inline_attachments = [{ url: `/api/file?path=${encodeURIComponent(path)}`, name: 'plot.png', mimeType: 'image/png' }]
  await f.service.deliver({ eventId: 41, recipientId: 'fleet:human' })
  assert.deepEqual(f.sent[0].attachments[0].content, bytes)
})

test('attachment metadata cannot make email read outside the canonical upload root', async () => {
  const f = fixture()
  f.events.get(41).metadata.attachments = [{ path: '/etc/hosts', name: 'stolen.txt', mimeType: 'text/plain' }]
  await f.service.deliver({ eventId: 41, recipientId: 'fleet:human' })
  assert.deepEqual(f.sent[0].attachments, [])
  assert.doesNotMatch(f.sent[0].raw, /stolen\.txt/)
})
