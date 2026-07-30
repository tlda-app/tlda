import { appendToken } from '../authToken'
import { getFleetWsBase } from './fleet-data.mjs'
import { createFleetOperationTransport } from '../../shared/fleet-operation-transport.mjs'

export type TerminalTransportFrame =
  | { type: 'output'; data: string; encoding?: string }
  | { type: 'size'; cols: number; rows: number }
  | { type: 'capabilities'; terminalInputAllowed?: boolean; capabilities?: { terminalInputAllowed?: boolean } }
  | { type: 'error'; message?: string }
  | { type: string; data?: string; encoding?: string; message?: string; cols?: number; rows?: number; terminalInputAllowed?: boolean; capabilities?: { terminalInputAllowed?: boolean } }

export interface TerminalTransport {
  close(): void
  input(data: string): boolean
  resize(cols: number, rows: number): boolean
  submit(text: string): boolean
  isOpen(): boolean
}

interface TerminalTransportOptions {
  agentId: string
  onOpen?: () => void
  onFrame?: (frame: TerminalTransportFrame) => void
  onError?: () => void
  onClose?: (event: CloseEvent) => void
}

/**
 * The terminal channel is intentionally ephemeral: input and resize frames are
 * meaningful only to the currently attached PTY and must never replay after a
 * reconnect. This adapter is the sole owner of its WebSocket wire format.
 */
export function openTerminalTransport(options: TerminalTransportOptions): TerminalTransport {
  const socket = new WebSocket(appendToken(
    `${getFleetWsBase()}/ws/terminal?agent=${encodeURIComponent(options.agentId)}`,
  ))

  const send = (frame: object) => {
    if (socket.readyState !== WebSocket.OPEN) return false
    socket.send(JSON.stringify(frame))
    return true
  }

  socket.onopen = () => options.onOpen?.()
  socket.onmessage = (event) => {
    try {
      options.onFrame?.(JSON.parse(event.data))
    } catch {
      // A malformed terminal frame cannot be applied to the current PTY.
    }
  }
  socket.onerror = () => options.onError?.()
  socket.onclose = (event) => options.onClose?.(event)

  const operationTransport = createFleetOperationTransport({
    name: 'browser-terminal',
    resolveDestination: () => options.agentId,
    sendEphemeral: (operation: string, frame: object, transportOptions: any) => {
      const sent = send({
        ...frame,
        operation_id: transportOptions.envelope.operation_id,
        fleet_operation: transportOptions.envelope,
      })
      if (!sent && (operation === 'terminal-input' || operation === 'terminal-submit')) {
        queueMicrotask(() => options.onFrame?.({
          type: 'error',
          message: 'Terminal connection unavailable; input was not sent.',
        }))
      }
      return sent
    },
  })

  return {
    close() {
      socket.close()
    },
    input(data) {
      return operationTransport.ephemeral('terminal-input', { type: 'input', data })
    },
    resize(cols, rows) {
      return operationTransport.ephemeral('terminal-resize', { type: 'resize', cols, rows })
    },
    submit(text) {
      return operationTransport.ephemeral('terminal-submit', { type: 'submit', text })
    },
    isOpen() {
      return socket.readyState === WebSocket.OPEN
    },
  }
}
