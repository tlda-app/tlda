import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'

const server = readFileSync(join(import.meta.dirname, '..', 'unified-server.mjs'), 'utf8')

test('canonical chat policy branch invokes email with its existing delivery decision', () => {
  const chatStart = server.indexOf("if (type === 'chat')")
  const chatEnd = server.indexOf('// Plan mode approval routing', chatStart)
  const branch = server.slice(chatStart, chatEnd)
  assert.match(branch, /applyEmailPolicyDelivery\(\{ service: emailNotifications, decision: r\.deliveryDecision, eventId, recipientId: r\.to, senderId: from \}\)/)
  assert.match(branch, /reserveSubscriptionBatch\(deliveryDecision\)/)
})

test('authenticated IMAP receiver re-enters the normal canonical chat dispatcher', () => {
  assert.match(server, /startImapReceiver\(emailRuntimeConfig\.inbound, message => emailNotifications\.receive\(\{ \.\.\.message, authenticated: true \}\)\)/)
  const setupStart = server.indexOf('insertInboundChat: async')
  const setupEnd = server.indexOf('}) : null', setupStart)
  assert.match(server.slice(setupStart, setupEnd), /dispatchInternalChat\(/)
  const helperStart = server.indexOf('async function dispatchInternalChat')
  assert.match(server.slice(helperStart, helperStart + 700), /dispatchFleetWsMessage\(ws, \{ id, type: 'chat'/)
})
