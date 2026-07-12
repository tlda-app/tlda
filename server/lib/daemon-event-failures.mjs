import { DAEMON_OUTBOX_ID_FIELD } from '../../shared/daemon-delivery.mjs'

function errorSummary(error) {
  if (!error) return null
  return {
    message: error.message || String(error),
    name: error.name || null,
    code: error.code || null,
    stack: error.stack || null,
  }
}

export function daemonEventFailureIncident(msg, operation, error) {
  const type = msg?.type || 'unknown'
  const agentId = msg?.agent_id || msg?.agentId || null
  const outboxId = msg?.[DAEMON_OUTBOX_ID_FIELD] || null
  return {
    severity: 'warning',
    component: 'daemon-events',
    operation,
    actors: {
      agentId,
      machineId: msg?.machine_id || null,
      envName: msg?.env_name || null,
      daemonOutboxId: outboxId,
    },
    impact: `Daemon ${type} delivery failed while storing ${operation}. The daemon durable outbox will retry unless the message is dead-lettered.`,
    evidence: {
      type,
      outboxId,
      agentId,
      timestamp: msg?.ts || null,
      sessionId: msg?.session_id || null,
      tool: msg?.tool || null,
      textBytes: typeof msg?.text === 'string' ? msg.text.length : null,
    },
    error: errorSummary(error),
  }
}
