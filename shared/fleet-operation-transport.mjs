export const FLEET_DELIVERY = Object.freeze({
  DURABLE: 'durable',
  EPHEMERAL: 'ephemeral',
})

function requireOperation(operation) {
  if (typeof operation !== 'string' || !operation.trim()) {
    throw new TypeError('fleet transport operation must be a non-empty string')
  }
  return operation
}

function emitStage(observe, stage, operation, mode, detail = {}) {
  observe?.({
    stage,
    operation,
    mode,
    at: new Date().toISOString(),
    ...detail,
  })
}

function mintOperationId(name, operation) {
  const uuid = globalThis.crypto?.randomUUID?.()
  return uuid
    ? `${name}:${operation}:${uuid}`
    : `${name}:${operation}:${Date.now().toString(36)}:${Math.random().toString(36).slice(2)}`
}

export function createFleetOperationEnvelope({
  operation,
  mode,
  operationId,
  sender = null,
  destination = null,
  createdAt = null,
  attempt = 1,
  parentOperationId = null,
  name = 'fleet',
}) {
  return Object.freeze({
    operation_id: operationId || mintOperationId(name, operation),
    operation_type: operation,
    delivery_class: mode,
    sender,
    destination,
    created_at: createdAt || new Date().toISOString(),
    attempt,
    parent_operation_id: parentOperationId,
  })
}

/**
 * The feature-facing fleet transport boundary.
 *
 * Callers choose the delivery contract; adapters own the wire, persistence,
 * reconnect, acknowledgement, and terminal-result mechanics. This keeps raw
 * WebSocket/RPC primitives out of feature code without pretending durable and
 * ephemeral operations have the same semantics.
 *
 * @param {{
 *   sendEphemeral: (operation: string, payload: any, options: any) => any,
 *   sendDurable?: (operation: string, payload: any, options: any) => any,
 *   observe?: ((event: any) => void) | null,
 *   resolveSender?: ((context: any) => string | null) | null,
 *   resolveDestination?: ((context: any) => string | null) | null,
 *   name?: string,
 * }} adapters
 */
export function createFleetOperationTransport({
  sendEphemeral,
  sendDurable,
  observe = null,
  resolveSender = null,
  resolveDestination = null,
  name = 'fleet',
}) {
  if (typeof sendEphemeral !== 'function') {
    throw new TypeError(`${name} transport requires sendEphemeral`)
  }

  function send(operation, payload = {}, options = {}) {
    const op = requireOperation(operation)
    const mode = options.mode
    if (mode !== FLEET_DELIVERY.DURABLE && mode !== FLEET_DELIVERY.EPHEMERAL) {
      throw new TypeError(`${name} transport ${op} requires an explicit durable or ephemeral mode`)
    }

    const envelopeContext = { operation: op, payload, mode, options }
    const envelope = options.envelope || createFleetOperationEnvelope({
      operation: op,
      mode,
      operationId: options.operationId,
      sender: options.sender ?? resolveSender?.(envelopeContext) ?? null,
      destination: options.destination ?? resolveDestination?.(envelopeContext) ?? null,
      createdAt: options.createdAt,
      attempt: options.attempt,
      parentOperationId: options.parentOperationId,
      name,
    })
    const adapterOptions = { ...options, operationId: envelope.operation_id, envelope }
    const startedAt = Date.now()
    emitStage(observe, 'started', op, mode, { operation_id: envelope.operation_id, envelope })
    try {
      const result = mode === FLEET_DELIVERY.DURABLE
        ? (() => {
            if (typeof sendDurable !== 'function') {
              throw new Error(`${name} transport does not support durable operation ${op}`)
            }
            return sendDurable(op, payload, adapterOptions)
          })()
        : sendEphemeral(op, payload, adapterOptions)
      if (result && typeof result.then === 'function') {
        return result.then((resolved) => {
          const accepted = resolved !== false
          emitStage(observe, 'terminal', op, mode, {
            ok: accepted,
            duration_ms: Date.now() - startedAt,
            queued: resolved?.queued === true,
            operation_id: resolved?.operation_id || envelope.operation_id,
            envelope,
            ...(!accepted ? { error: 'transport adapter did not accept operation' } : {}),
          })
          return resolved
        }, (error) => {
          emitStage(observe, 'terminal', op, mode, {
            ok: false,
            duration_ms: Date.now() - startedAt,
            operation_id: envelope.operation_id,
            envelope,
            error: String(error?.message || error),
          })
          throw error
        })
      }
      const accepted = result !== false
      emitStage(observe, 'terminal', op, mode, {
        ok: accepted,
        duration_ms: Date.now() - startedAt,
        queued: result?.queued === true,
        operation_id: result?.operation_id || envelope.operation_id,
        envelope,
        ...(!accepted ? { error: 'transport adapter did not accept operation' } : {}),
      })
      return result
    } catch (error) {
      emitStage(observe, 'terminal', op, mode, {
        ok: false,
        duration_ms: Date.now() - startedAt,
        operation_id: envelope.operation_id,
        envelope,
        error: String(error?.message || error),
      })
      throw error
    }
  }

  return Object.freeze({
    send,
    durable(operation, payload = {}, options = {}) {
      return send(operation, payload, { ...options, mode: FLEET_DELIVERY.DURABLE })
    },
    ephemeral(operation, payload = {}, options = {}) {
      return send(operation, payload, { ...options, mode: FLEET_DELIVERY.EPHEMERAL })
    },
  })
}
