process.env.FLEET_ID = process.env.FLEET_ID || 'fleet:test-inbox-status'

import assert from 'node:assert/strict'
import test from 'node:test'

import { formatInboxText, formatNudgeAgentText, formatRecipientStatusSummary, getFleetTools, handleFleetTool } from '../mcp-server/fleet-tools.mjs'
import { decideInboxDelivery, parsePriorityPhrase, shouldWakeBatchedMessage, validateDeliveryChannel } from '../shared/inbox-attention.mjs'

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

test('set_delivery_channel is exposed as the explicit agent-owned channel tool', () => {
  const tool = getFleetTools().find(t => t.name === 'set_delivery_channel')
  assert.ok(tool)
  assert.match(tool.description, /Agent-owned only/)
  assert.deepEqual(tool.inputSchema.required, ['channel'])
  assert.deepEqual(tool.inputSchema.properties.channel.enum, ['channel', 'tmux'])
})

test('set_delivery_channel rejects invalid channels before publishing', async () => {
  const res = await handleFleetTool('set_delivery_channel', { channel: 'pager' })
  assert.equal(res.isError, true)
  assert.match(res.content[0].text, /Bad delivery channel: pager/)
  assert.match(res.content[0].text, /channel, tmux/)
})

test('inbox exposes read-time views, not notification statuses', () => {
  const tool = getFleetTools().find(t => t.name === 'inbox')
  assert.ok(tool)
  assert.deepEqual(tool.inputSchema.properties.view.enum, ['default', 'review', 'monitoring', 'current-task', 'all'])
  assert.equal(tool.inputSchema.properties.mode, undefined)
})

test('my_task is not exposed as a public MCP tool', () => {
  assert.equal(getFleetTools().some(t => t.name === 'my_task'), false)
})

test('nudge_agent is exposed as out-of-band tmux recovery, not chat', () => {
  const tool = getFleetTools().find(t => t.name === 'nudge_agent')
  assert.ok(tool)
  assert.match(tool.description, /out-of-band tmux nudge/)
  assert.match(tool.description, /not chat delivery/)
  assert.deepEqual(tool.inputSchema.required, ['agent', 'message'])
  assert.equal(tool.inputSchema.properties.agent.type, 'string')
  assert.equal(tool.inputSchema.properties.message.type, 'string')
})

test('nudge_agent text appends the inbox recovery footer', () => {
  assert.equal(
    formatNudgeAgentText('Your fleet channel may be broken. Please re-register.'),
    'Your fleet channel may be broken. Please re-register.\n\nCall inbox() to catch up.',
  )
  assert.equal(
    formatNudgeAgentText(''),
    'Your fleet notification channel may be broken.\n\nCall inbox() to catch up.',
  )
})

test('nudge_agent validates required args before server routing', async () => {
  const noAgent = await handleFleetTool('nudge_agent', { message: 'wake up' })
  assert.equal(noAgent.isError, true)
  assert.match(noAgent.content[0].text, /Specify an agent/)

  const noMessage = await handleFleetTool('nudge_agent', { agent: 'release-train' })
  assert.equal(noMessage.isError, true)
  assert.match(noMessage.content[0].text, /Specify a message/)
})

test('priority phrase parser uses exact V1 phrases only', () => {
  assert.equal(parsePriorityPhrase('This is important. I need a decision.'), 'important')
  assert.equal(parsePriorityPhrase('ok this is urgent for release'), 'urgent')
  assert.equal(parsePriorityPhrase('important update but not the literal phrase'), null)
  assert.equal(parsePriorityPhrase('this is not urgent'), null)
})

test('delivery channel validation uses the explicit V1 channel names', () => {
  assert.equal(validateDeliveryChannel('channel'), 'channel')
  assert.equal(validateDeliveryChannel('tmux'), 'tmux')
  assert.equal(validateDeliveryChannel('fleet'), null)
  assert.equal(validateDeliveryChannel('auto'), null)
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

test('batched wake only fires while recipient is still busy and unread is pending', () => {
  assert.equal(shouldWakeBatchedMessage({ status: 'busy', unreadPending: true }), true)
  assert.equal(shouldWakeBatchedMessage({ status: 'busy', unreadPending: false }), false)
  assert.equal(shouldWakeBatchedMessage({ status: 'available', unreadPending: true }), false)
  assert.equal(shouldWakeBatchedMessage({ status: 'dnd', unreadPending: true }), false)
})

test('fleet_table renders visible inbox statuses', async () => {
  const prevFetch = globalThis.fetch
  globalThis.fetch = async () => ({
    ok: true,
    json: async () => ({
      totals: { awake: 1, hibernating: 0, dead: 0, total: 1 },
      matched: 1,
      shown: 1,
      summary: {
        inbox_statuses: [{ value: 'busy', count: 1 }],
        delivery_channels: [{ value: 'tmux', count: 1 }],
      },
      agents: [{
        name: 'status-agent',
        status: 'awake',
        last_seen_ago_s: 10,
        inbox_status: 'busy',
        delivery_channel: 'tmux',
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
    assert.match(res.content[0].text, /Delivery channels: tmux/)
    assert.match(res.content[0].text, /agent\s+status\s+seen\s+inbox\s+delivery\s+model\s+activity\s+cwd/)
    assert.match(res.content[0].text, /status-agent\s+awake\s+10s\s+busy\s+tmux\s+gpt-test/)
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

test('current-task inbox view puts owned task before direct unread', () => {
  const text = formatInboxText({
    mode: 'current-task',
    task: { id: '1', description: 'Keep inbox modes moving', status: 'pending' },
    tasks: null,
    messages: [
      { kind: 'watch', line: '[from watch] background signal' },
      { kind: 'message', line: '[from peer] direct question' },
    ],
  })

  assert.match(text, /INBOX MODE: current-task/)
  assert.match(text, /CURRENT TASK\n\[task:1\] Keep inbox modes moving/)
  assert.match(text, /RELATED UNREAD\n\[1\] \[from peer\] direct question/)
  assert.match(text, /BACKGROUND: 1 watch item\(s\)\./)
})

test('all inbox view keeps the broad grouped queue explicit', () => {
  const text = formatInboxText({
    mode: 'all',
    task: null,
    tasks: null,
    messages: [
      { kind: 'user', line: '[from skip] user message' },
      { kind: 'task', line: '[from chief] task update' },
      { kind: 'message', line: '[from peer] direct message' },
      { kind: 'watch', line: '[from wiretap] watch item' },
    ],
  })

  assert.match(text, /INBOX MODE: all/)
  assert.match(text, /ALL ACTIVE INBOX/)
  assert.match(text, /USER \/ SKIP\n\[1\] \[from skip\] user message/)
  assert.match(text, /TASK UPDATES\n\[1\] \[from chief\] task update/)
  assert.match(text, /DIRECT MESSAGES\n\[1\] \[from peer\] direct message/)
  assert.match(text, /WATCH \/ WIRETAP\n\[1\] \[from wiretap\] watch item/)
})
