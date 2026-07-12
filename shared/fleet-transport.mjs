export {
  SqliteTransportOutbox,
  parseTransportOutboxRow,
} from './sqlite-transport-outbox.mjs'
export {
  FleetTransportOutbox,
  isRetryableTransportError,
} from './fleet-transport-outbox.mjs'
export { ResilientWS } from './resilient-ws.mjs'
export {
  rejectMatchingWsRequests,
  rejectWsRequests,
  resetWsRequestIdleTimers,
  startWsRequest,
} from './ws-request-policy.mjs'
export { WsReconnectBuffer } from './ws-reconnect-buffer.mjs'

export const FLEET_TRANSPORT_PRIMITIVES = Object.freeze({
  DURABLE_OPERATION: 'durable-operation',
  REQUEST_RESPONSE: 'request-response',
  TRANSIENT_SIGNAL: 'transient-signal',
  LATEST_WINS_STATE: 'latest-wins-state',
  NOTIFICATION_ATTEMPT: 'notification-attempt',
})
