import { createHash } from 'node:crypto'
import { rejectWsRequests, startWsRequest } from '../shared/fleet-transport.mjs'

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

export function rpcRequestFingerprint(msg) {
  const payload = {}
  for (const [key, value] of Object.entries(msg || {})) {
    if (key === 'type' || key === 'id') continue
    payload[key] = value
  }
  return createHash('sha256').update(canonicalJson(payload)).digest('hex')
}

export function createMachineRpc({
  sendMsg,
  getPid = () => process.pid,
  now = () => Date.now(),
  replayTtlMs = 2 * 60_000,
  replayLimit = 500,
} = {}) {
  if (typeof sendMsg !== 'function') throw new Error('createMachineRpc requires sendMsg')

  let requestSeq = 0
  const maxExecutions = Math.max(0, Math.floor(Number(replayLimit) || 0))
  const pendingReplies = new Map()
  const handlers = new Map()
  const executions = new Map()

  function pruneExecutions() {
    const cutoff = now() - replayTtlMs
    for (const [id, entry] of executions) {
      if (entry.settledAt != null && entry.settledAt < cutoff) executions.delete(id)
    }
  }

  function makeExecutionCapacity() {
    pruneExecutions()
    while (executions.size >= maxExecutions) {
      const oldestSettled = [...executions].find(([, entry]) => entry.settledAt != null)?.[0]
      if (oldestSettled == null) return false
      executions.delete(oldestSettled)
    }
    return true
  }

  function replyFor(identity, fields) {
    return {
      type: 'rpc-reply',
      id: identity.id,
      request_fingerprint: identity.fingerprint,
      ...fields,
    }
  }

  function register(entries) {
    for (const [op, handler] of Object.entries(entries || {})) {
      if (typeof handler !== 'function') throw new Error(`RPC handler for ${op} must be a function`)
      handlers.set(op, handler)
    }
  }

  async function handleRpc(msg) {
    const { id, op } = msg || {}
    if (!id) return
    const identity = { id, op, fingerprint: rpcRequestFingerprint(msg) }
    pruneExecutions()
    const existing = executions.get(id)
    if (existing) {
      if (existing.op !== op || existing.fingerprint !== identity.fingerprint) {
        sendMsg(replyFor(identity, { error: 'rpc request id reused with different operation or payload' }))
        return
      }
      sendMsg(existing.reply || await existing.promise)
      return
    }
    if (!makeExecutionCapacity()) {
      sendMsg(replyFor(identity, { error: 'daemon rpc execution capacity reached; request was not executed' }))
      return
    }
    const handler = handlers.get(op)
    if (!handler) {
      const reply = replyFor(identity, { error: `unknown op: ${op}` })
      executions.set(id, { ...identity, promise: Promise.resolve(reply), reply, settledAt: now() })
      sendMsg(reply)
      return
    }
    const entry = { ...identity, promise: null, reply: null, settledAt: null }
    entry.promise = Promise.resolve()
      .then(() => handler(msg))
      .then(
        result => replyFor(identity, { result }),
        e => replyFor(identity, { error: e.message || String(e) }),
      )
      .then(reply => {
        entry.reply = reply
        entry.settledAt = now()
        return reply
      })
    executions.set(id, entry)
    sendMsg(await entry.promise)
  }

  function handleReply(msg) {
    if (!msg?.id || !pendingReplies.has(msg.id)) return false
    const pending = pendingReplies.get(msg.id)
    if (msg.error) pending.reject(new Error(msg.error?.message || msg.error))
    else pending.resolve(msg.result)
    return true
  }

  function requestWithReply(obj, { timeoutMs = 15000 } = {}) {
    const id = `daemon:${getPid()}:${++requestSeq}`
    const type = obj?.type || 'unknown'
    return startWsRequest({
      pending: pendingReplies,
      id,
      type,
      deadlineMs: timeoutMs,
      makeDeadlineError: () => new Error(`daemon request timed out: ${type}`),
      makeSendError: () => new Error('daemon websocket is not connected'),
      send: () => sendMsg({ ...obj, id }),
    })
  }

  function clearPending(reason = 'machine RPC closed') {
    rejectWsRequests(pendingReplies, () => new Error(reason))
  }

  return {
    register,
    handleRpc,
    handleReply,
    requestWithReply,
    clearPending,
  }
}
