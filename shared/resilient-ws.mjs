/**
 * Resilient WebSocket client with reconnect, backoff, and heartbeat.
 *
 * Shared by the fleet daemon and fleet MCP server. Handles the
 * boilerplate that both implementations duplicate: connect, parse,
 * exponential backoff, heartbeat timeout, error/close dedup.
 */

import { WebSocket } from 'ws'

export class ResilientWS {
  /**
   * @param {object} options
   * @param {() => string}  options.url          — called on each connect (URL may change)
   * @param {string}        options.label        — log prefix (e.g. 'daemon', 'fleet-channel')
   * @param {number}        [options.initialBackoffMs=1000]
   * @param {number}        [options.maxBackoffMs=30000]
   * @param {number}        [options.stableConnectionMs=10000] — reset retry ramp only after this long connected
   * @param {() => number}  [options.random=Math.random] — injected by tests
   * @param {number}        [options.heartbeatTimeoutMs=0] — 0 = disabled
   * @param {(ws) => void}  [options.onOpen]     — called after connection opens
   * @param {(msg) => void} options.onMessage    — called with parsed JSON message
   * @param {() => void}    [options.onClose]    — called on connection loss (before retry)
   * @param {(reason: string) => void} [options.onActivity] — called on open/message/ping liveness
   * @param {(s: string) => void} [options.log]  — log function (default: console.log)
   */
  constructor(options) {
    this._getUrl = options.url
    this._label = options.label
    this._initialBackoff = options.initialBackoffMs ?? 1000
    // A reconnect that opens briefly and immediately drops is still a failed
    // reconnect.  Keep increasing the delay until a connection has stayed up
    // long enough to be useful; otherwise every daemon restarts at 1s forever.
    this._maxBackoff = options.maxBackoffMs ?? 30_000
    this._stableConnectionMs = options.stableConnectionMs ?? 10_000
    this._random = options.random ?? Math.random
    this._heartbeatTimeoutMs = options.heartbeatTimeoutMs ?? 0
    this._onOpen = options.onOpen
    this._onMessage = options.onMessage
    this._onClose = options.onClose
    this._onActivity = options.onActivity
    this._log = options.log ?? ((s) => console.log(s))

    this._ws = null
    this._backoff = this._initialBackoff
    this._retryTimer = null
    this._heartbeatTimer = null
    this._stableTimer = null
    this._closed = false
  }

  get ws() { return this._ws }
  get connected() { return this._ws?.readyState === WebSocket.OPEN }

  send(obj) {
    if (!this.connected) return false
    try { this._ws.send(JSON.stringify(obj)); return true }
    catch (e) { this._log(`[${this._label}] send error: ${e.message}`); return false }
  }

  connect() {
    if (this._closed) return
    if (this._ws) return

    const url = this._getUrl()
    this._log(`[${this._label}] connecting to ${url.replace(/token=[^&]+/, 'token=***')}`)

    try {
      // For wss:// with self-signed certs (local dev), skip cert validation.
      // External wss:// (production) should validate normally.
      const isLocalWss = url.startsWith('wss://127.0.0.1') || url.startsWith('wss://localhost')
      const ws = new WebSocket(url, isLocalWss ? { rejectUnauthorized: false } : undefined)
      this._ws = ws

      ws.on('open', () => {
        this._log(`[${this._label}] connected`)
        if (this._stableTimer) clearTimeout(this._stableTimer)
        this._stableTimer = setTimeout(() => {
          this._stableTimer = null
          this._backoff = this._initialBackoff
        }, this._stableConnectionMs)
        this._resetHeartbeat()
        this._onActivity?.('open')
        this._onOpen?.(ws)
      })

      ws.on('message', (raw) => {
        this._resetHeartbeat()
        this._onActivity?.('message')
        let msg
        try { msg = JSON.parse(raw.toString()) } catch (e) { this._log(`[${this._label}] bad JSON: ${e.message}`); return }
        this._onMessage(msg)
      })

      // A protocol-level ping is liveness evidence just like an application
      // message, so it resets the watchdog too. The server's WS heartbeat
      // (unified-server.mjs WS_HEARTBEAT_INTERVAL_MS = 30_000) pings every 30s
      // even when there's no app traffic, so this keeps an idle-but-healthy
      // connection from being falsely torn down. COUPLING: that 30s interval
      // must stay below every consumer's heartbeatTimeoutMs (fleet daemon 90s,
      // MCP fleet-channel 45s) — if anyone raises the server ping interval past
      // a consumer's timeout, that consumer will false-reconnect. Purely
      // additive: a reset only ever pushes the deadline later, so it can never
      // shorten an existing reconnect.
      ws.on('ping', () => {
        this._resetHeartbeat()
        this._onActivity?.('ping')
      })

      ws.on('close', (code, reason) => {
        this._log(`[${this._label}] closed (${code} ${reason || ''})`)
        this._cleanup()
        this._scheduleRetry()
      })

      ws.on('error', (e) => {
        this._log(`[${this._label}] error: ${e.message}`)
        this._cleanup()
        this._scheduleRetry()
      })
    } catch (e) {
      this._log(`[${this._label}] connect failed: ${e.message}`)
      this._scheduleRetry()
    }
  }

  /**
   * Force-drop the current socket and reconnect (with backoff), WITHOUT marking
   * the client permanently closed. Use this when the server asks us to reconnect
   * (e.g. a server-restart eviction): unlike close(), the retry loop stays armed.
   * Calling close() instead would set _closed and silently kill all reconnects —
   * that was the latent bug behind the daemon's `scheduleReconnect is not defined`
   * crash, where the eviction path both referenced a missing function AND, had it
   * existed, would have followed a _rws.close() that wedges reconnects.
   */
  reconnect() {
    if (this._closed) return
    if (this._ws) { try { this._ws.close() } catch (e) { this._log(`[${this._label}] close error: ${e.message}`) } }
    this._cleanup()
    this._scheduleRetry()
  }

  close() {
    this._closed = true
    if (this._retryTimer) { clearTimeout(this._retryTimer); this._retryTimer = null }
    if (this._heartbeatTimer) { clearTimeout(this._heartbeatTimer); this._heartbeatTimer = null }
    if (this._stableTimer) { clearTimeout(this._stableTimer); this._stableTimer = null }
    if (this._ws) { try { this._ws.close() } catch (e) { this._log(`[${this._label}] close error: ${e.message}`) } }
    this._ws = null
  }

  _cleanup() {
    this._ws = null
    if (this._heartbeatTimer) { clearTimeout(this._heartbeatTimer); this._heartbeatTimer = null }
    if (this._stableTimer) { clearTimeout(this._stableTimer); this._stableTimer = null }
    this._onClose?.()
  }

  _scheduleRetry() {
    if (this._closed) return
    if (this._retryTimer) return
    // Full jitter prevents every daemon that observed the same close from
    // reconnecting on the same millisecond.
    const delay = Math.floor(this._backoff * (0.5 + this._random() * 0.5))
    this._backoff = Math.min(this._backoff * 2, this._maxBackoff)
    this._log(`[${this._label}] reconnecting in ${delay}ms`)
    this._retryTimer = setTimeout(() => {
      this._retryTimer = null
      this.connect()
    }, delay)
  }

  _resetHeartbeat() {
    if (!this._heartbeatTimeoutMs) return
    if (this._heartbeatTimer) clearTimeout(this._heartbeatTimer)
    this._heartbeatTimer = setTimeout(() => {
      this._log(`[${this._label}] no heartbeat in ${this._heartbeatTimeoutMs}ms — reconnecting`)
      if (this._ws) { try { this._ws.close() } catch (e) { this._log(`[${this._label}] close error: ${e.message}`) } }
      this._cleanup()
      this._scheduleRetry()
    }, this._heartbeatTimeoutMs)
  }
}
