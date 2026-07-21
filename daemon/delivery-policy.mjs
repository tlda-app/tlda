export const DELIVERY_DURABLE_FIFO = 'durable-fifo'
export const DELIVERY_EPHEMERAL_FIFO = 'ephemeral-fifo'
export const DELIVERY_LATEST_WINS = 'latest-wins'
export const DELIVERY_DIRECT = 'direct'

const DURABLE_TYPES = new Set([
  'activity-event',
  'activity-health',
  'agent-compacting',
  'agent-context',
  'agent-status',
  'agent-thinking',
  'daemon-warning',
  'jsonl-index',
  'native-task-event',
  'plan-mode-prompt',
  'prompt-auto-accepted',
  'source-change',
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
  'reaper-status',
  'terminal-size',
])

const DIRECT_TYPES = new Set([
  'backing-file-status',
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
