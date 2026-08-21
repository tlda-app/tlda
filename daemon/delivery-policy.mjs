export const DELIVERY_DURABLE_FIFO = 'durable-fifo'
export const DELIVERY_EPHEMERAL_FIFO = 'ephemeral-fifo'
export const DELIVERY_LATEST_WINS = 'latest-wins'
export const DELIVERY_DIRECT = 'direct'

const DURABLE_TYPES = new Set([
  'activity-event',
  // NOT activity-health -- see LATEST_WINS_TYPES. It is a heartbeat, and the
  // name is the only thing it shares with activity-event.
  'agent-route',
  'daemon-roster',
  'agent-compacting',
  'agent-context',
  'agent-status',
  'agent-thinking',
  'daemon-warning',
  'jsonl-index',
  'native-task-event',
  'plan-mode-prompt',
  'prompt-auto-accepted',
  'spawn-startup-failed',
  'terminal-chat',
  'terminal-dead',
  'terminal_attention',
])

const EPHEMERAL_FIFO_TYPES = new Set([
  'terminal-data',
])

const LATEST_WINS_TYPES = new Set([
  'agent-liveness',
  // A snapshot is a complete description of what is running right now, so a
  // newer one wholly supersedes an older one — queueing stale snapshots behind a
  // reconnect would replay a past state over the present one.
  'agent-liveness-snapshot',
  'terminal-size',
  // A heartbeat, not activity. Skip: "a heartbeat is not activity", and on the
  // rest: "we dont drop activity dude" -- a lost activity event is data loss,
  // "mostly ignorable but if its the wrong event not good", and you cannot know
  // at write time which one you will need. A heartbeat is the opposite: the
  // server assigns it to a single overwritten field, so every one but the newest
  // per agent is superseded before anything reads it.
  //
  // Measured 2026-08-18: 4,940 queued heartbeats carrying 18 agents' state, and
  // ~70/min production -- back to 119 within 90 seconds of wiping 5,339 of them.
  // The backlog was never the problem; the rate is. Retrying a claim about a
  // moment that has passed cost a durable write, a delivery slot and a retry
  // budget, ahead of the activity events that are Skip's cards.
  //
  // Latest-wins keys on `${type}:${agent_id}`, so the newest heartbeat per agent
  // supersedes the queued one rather than accumulating behind it, and a drop
  // goes through warnDropped -- counted in `daemonDropped`, not silent.
  'activity-health',
])

const DIRECT_TYPES = new Set([
  'daemon-hello',
])

export function daemonDeliveryPolicy(message) {
  const type = message?.type
  if (!type) return DELIVERY_DIRECT

  // Completion is durable even though the request is correlated: the daemon
  // may finish after the websocket closes.
  if (type === 'rpc-reply' && message.id) return DELIVERY_DURABLE_FIFO

  // Correlated request/response messages are governed by their caller's timeout.
  if (message.id) return DELIVERY_DIRECT

  if (DURABLE_TYPES.has(type)) return DELIVERY_DURABLE_FIFO
  if (EPHEMERAL_FIFO_TYPES.has(type)) return DELIVERY_EPHEMERAL_FIFO
  if (LATEST_WINS_TYPES.has(type)) return DELIVERY_LATEST_WINS
  if (DIRECT_TYPES.has(type)) return DELIVERY_DIRECT

  return DELIVERY_DIRECT
}

export function isDurableDaemonMessage(message) {
  return daemonDeliveryPolicy(message) === DELIVERY_DURABLE_FIFO
}
