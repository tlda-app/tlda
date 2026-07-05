process.env.FLEET_ID = process.env.FLEET_ID || 'fleet:test-inbox-status'

import assert from 'node:assert/strict'
import test from 'node:test'

import { formatInboxText, formatRecipientStatusSummary, getFleetTools, handleFleetTool } from '../mcp-server/fleet-tools.mjs'
import { decideInboxDelivery, parsePriorityPhrase } from '../shared/inbox-attention.mjs'

test('set_inbox_status is exposed as the explicit status-control tool', () => {
  const tool = getFleetTools().find(t => t.name === 'set_inbox_status')
  assert.ok(tool)
  assert.match(tool.description, /without reading or marking inbox items/)
  assert.deepEqual(tool.inputSchema.required, ['status'])
  assert.deepEqual(tool.inputSchema.properties.status.enum, ['available', 'busy', 'dnd'])
  assert.equal(tool.inputSchema.properties.tag.type, 'string')
})

test('set_inbox_status rejects invalid statuses before publishing', async () => {
  const res = await handleFleetTool('set_inbox_status', { status: 'vacation' })
  assert.equal(res.isError, true)
  assert.match(res.content[0].text, /Bad inbox status: vacation/)
  assert.match(res.content[0].text, /available, busy, dnd/)
})

test('inbox exposes read-time views, not notification statuses', () => {
  const tool = getFleetTools().find(t => t.name === 'inbox')
  assert.ok(tool)
  assert.deepEqual(tool.inputSchema.properties.view.enum, ['default', 'review', 'monitoring', 'current-task', 'all'])
  assert.equal(tool.inputSchema.properties.mode, undefined)
})

test('priority phrase parser uses exact V1 phrases only', () => {
  assert.equal(parsePriorityPhrase('This is important. I need a decision.'), 'important')
  assert.equal(parsePriorityPhrase('ok this is urgent for release'), 'urgent')
  assert.equal(parsePriorityPhrase('important update but not the literal phrase'), null)
  assert.equal(parsePriorityPhrase('this is not urgent'), null)
})

test('priority threshold decides delivery by status', () => {
  const now = Date.parse('2026-07-05T12:00:00Z')
  assert.deepEqual(decideInboxDelivery({ status: 'available', priority: 'normal', now }), {
    delivery: 'notified',
    wokeRecipient: 'yes',
    notifyBy: null,
  })
  assert.deepEqual(decideInboxDelivery({ status: 'busy', priority: 'normal', now }), {
    delivery: 'batched',
    wokeRecipient: 'not_yet',
    notifyBy: '2026-07-05T12:02:00.000Z',
  })
  assert.deepEqual(decideInboxDelivery({ status: 'busy', priority: 'important', now }), {
    delivery: 'notified',
    wokeRecipient: 'yes',
    notifyBy: null,
  })
  assert.deepEqual(decideInboxDelivery({ status: 'dnd', priority: 'important', now }), {
    delivery: 'queued',
    wokeRecipient: 'no',
    notifyBy: null,
  })
  assert.deepEqual(decideInboxDelivery({ status: 'dnd', priority: 'urgent', now }), {
    delivery: 'notified',
    wokeRecipient: 'yes',
    notifyBy: null,
  })
})

test('fleet_table renders visible inbox statuses', async () => {
  const prevFetch = globalThis.fetch
  globalThis.fetch = async () => ({
    ok: true,
    json: async () => ({
      totals: { awake: 1, hibernating: 0, dead: 0, total: 1 },
      matched: 1,
      shown: 1,
      summary: { inbox_statuses: [{ value: 'busy', count: 1 }] },
      agents: [{
        name: 'status-agent',
        status: 'awake',
        last_seen_ago_s: 10,
        inbox_status: 'busy',
        model: 'gpt-test',
        activity: null,
        tool: null,
        cwd: '/tmp/project',
      }],
    }),
  })
  try {
    const res = await handleFleetTool('fleet_table', {})
    assert.equal(res.isError, undefined)
    assert.match(res.content[0].text, /Inbox statuses: busy/)
    assert.match(res.content[0].text, /agent\s+status\s+seen\s+inbox\s+model\s+activity\s+cwd/)
    assert.match(res.content[0].text, /status-agent\s+awake\s+10s\s+busy\s+gpt-test/)
  } finally {
    globalThis.fetch = prevFetch
  }
})

test('chat recipient summaries expose exact recipient status labels', () => {
  const text = formatRecipientStatusSummary(['fleet:a', 'fleet:b', 'fleet:c'], [
    { id: 'fleet:a', friendly_name: 'chief:day', metadata: { inboxStatus: 'busy', inboxStatusTag: 'RC' } },
    { id: 'fleet:b', friendly_name: 'worker', metadata: { inboxStatus: 'dnd' } },
  ])
  assert.equal(text, 'chief:day [status:busy (RC)], worker [status:dnd], fleet:c')
})

test('chat recipient summaries prefer server attention receipts', () => {
  const text = formatRecipientStatusSummary(['fleet:a'], [
    { id: 'fleet:a', friendly_name: 'worker', metadata: { inboxStatus: 'busy' } },
  ], [
    { recipient: 'fleet:a', status: 'busy', priority: 'normal', delivery: 'batched', notifyBy: '2026-07-05T12:02:00.000Z' },
  ])
  assert.match(text, /Batched for worker \[busy\]\./)
  assert.match(text, /Say "this is important"/)
})

test('default inbox view buckets explicit delivery metadata', () => {
  const now = Date.parse('2026-07-05T12:00:00Z')
  const text = formatInboxText({
    mode: 'default',
    task: { id: '1', description: 'Keep inbox modes moving', status: 'pending' },
    tasks: null,
    now,
    messages: [
      {
        from: 'fleet:skip',
        fromLabel: 'skip',
        kind: 'user',
        priority: 'urgent',
        inboxDelivery: 'notified',
        line: '[from skip] this is urgent: can you check this?',
      },
      {
        from: 'fleet:peer',
        fromLabel: 'peer',
        kind: 'message',
        priority: 'normal',
        inboxDelivery: 'batched',
        notifyBy: '2026-07-05T12:02:00.000Z',
        inboxStatus: 'busy',
        inboxStatusTag: 'spawn broken',
        line: '[from peer] FYI for later',
      },
      {
        from: 'fleet:watch',
        fromLabel: 'watch',
        kind: 'watch',
        priority: 'normal',
        inboxDelivery: 'queued',
        line: '[from watch] background signal',
      },
    ],
  })

  assert.match(text, /INBOX MODE: default/)
  assert.match(text, /NOW\n\[1\] \[from skip\] this is urgent: can you check this\? \[urgent\]/)
  assert.match(text, /ACTIVE WORK\n\[task:1\] Keep inbox modes moving/)
  assert.match(text, /BATCHED\n\[1\] \[from peer\] FYI for later \[delivers in 120s\] \[recipient was busy \(spawn broken\)\]/)
  assert.match(text, /BACKGROUND\n\[1\] \[from watch\] background signal/)
})
