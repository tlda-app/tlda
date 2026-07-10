import { rejectWsRequests, startWsRequest } from '../shared/ws-request-policy.mjs'

export function createMachineRpc({ sendMsg, getPid = () => process.pid }) {
  if (typeof sendMsg !== 'function') throw new Error('createMachineRpc requires sendMsg')

  let requestSeq = 0
  const pendingReplies = new Map()
  const handlers = new Map()

  function register(entries) {
    for (const [op, handler] of Object.entries(entries || {})) {
      if (typeof handler !== 'function') throw new Error(`RPC handler for ${op} must be a function`)
      handlers.set(op, handler)
    }
  }

  async function handleRpc(msg) {
    const { id, op } = msg || {}
    const handler = handlers.get(op)
    if (!handler) {
      sendMsg({ type: 'rpc-reply', id, error: `unknown op: ${op}` })
      return
    }
    try {
      const result = await handler(msg)
      sendMsg({ type: 'rpc-reply', id, result })
    } catch (e) {
      sendMsg({ type: 'rpc-reply', id, error: e.message || String(e) })
    }
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
