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
   * @param {number}        [options.connectAttemptTimeoutMs=0] — explicit deadline while socket is CONNECTING; 0 = disabled
   * @param {(ws, attemptId: string) => void}  [options.onOpen] — called after connection opens,
   *   with the immutable attempt id captured at mint time for THIS socket generation
   * @param {(msg, attemptId: string) => void} options.onMessage — called with parsed JSON
   *   message and the immutable attempt id of the socket generation it arrived on
   * @param {(reason: string, attemptId: string|null, meta: { established: boolean }) => void} [options.onClose] —
   *   called on connection loss (before retry); reason is one of
   *   'close' | 'error' | 'heartbeat-timeout' | 'connect-timeout' | 'manual-reconnect'; attemptId is the id minted
   *   for the socket that just ended (null if it ended before any socket was ever created,
   *   e.g. a URL-resolution failure).
   *   `meta.established` is true only if this socket reached OPEN. Anything you
   *   tear down because a connection was LOST must be gated on it — a failed
   *   connect attempt holds no connection state. Do not infer this from `reason`:
   *   'error' and 'close' both fire for a socket that died mid-handshake.
   * @param {(reason: string) => void} [options.onActivity] — called on open/message/ping liveness
   * @param {(s: string) => void} [options.log]  — log function (default: console.log)
   * @param {(attemptId: string|null, delayMs: number) => void} [options.onRetryScheduled] — the
   *   just-ended attempt's id (null if no socket was ever created for this cycle) and the
   *   computed backoff delay before the next connect() call
   * @param {(attemptId: string) => void} [options.onAttemptOpen] — fired on 'open', with the
   *   new attempt's immutable id, before onOpen (so callers can trace attempt-opened even if
   *   they don't otherwise act on open)
   * @param {typeof WebSocket} [options.WebSocketImpl] — injectable WebSocket constructor,
   *   defaults to the real `ws` library; test seam only, never used in production
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
    this._connectAttemptTimeoutMs = options.connectAttemptTimeoutMs ?? 0
    this._onOpen = options.onOpen
    this._onMessage = options.onMessage
    this._onClose = options.onClose
    this._onActivity = options.onActivity
    this._onRetryScheduled = options.onRetryScheduled
    this._onAttemptOpen = options.onAttemptOpen
    this._log = options.log ?? ((s) => console.log(s))
    this._WebSocketImpl = options.WebSocketImpl ?? WebSocket

    this._ws = null
    this._backoff = this._initialBackoff
    this._retryTimer = null
    this._connectAttemptTimer = null
    this._heartbeatTimer = null
    this._stableTimer = null
    this._closed = false
    // Monotone per-connect-attempt counter, scoped to this instance's
    // lifetime (i.e. one daemon/process boot). `_lastAttemptId` is the most
    // recent attempt minted, exposed via the `attemptId` getter for callers
    // that just want "the current/most-recent attempt" (e.g. synchronously
    // inside the open handler). Every event handler below, however, closes
    // over its OWN immutable `attemptId` captured at mint time rather than
    // rereading this field — a late close/error from a superseded socket
    // must stay labeled with the attempt it actually belongs to, not
    // whatever attempt happens to be current when the event fires.
    this._attemptSeq = 0
    this._lastAttemptId = null
  }

  get ws() { return this._ws }
  get connected() { return this._ws?.readyState === WebSocket.OPEN }
  get attemptId() { return this._lastAttemptId }

  send(obj) {
    if (!this.connected) return false
    try { this._ws.send(JSON.stringify(obj)); return true }
    catch (e) { this._log(`[${this._label}] send error: ${e.message}`); return false }
  }

  connect() {
    if (this._closed) return
    if (this._ws) return

    // Resolve the URL BEFORE minting an attempt id: a URL-resolution failure
    // (e.g. config not loaded yet) is not an actual connection attempt and
    // must not consume/advance the attempt sequence, and must not be
    // attributed to whatever the previous attempt id happened to be.
    let url
    try {
      url = this._getUrl()
    } catch (e) {
      this._log(`[${this._label}] connect failed: ${e.message}`)
      this._scheduleRetry(null)
      return
    }

    // Mint the attempt id as the FIRST thing inside this try block — this is
    // the real connection attempt, not a scheduling/URL-resolution step, so
    // any failure from here on (including the WebSocket constructor itself
    // throwing) belongs to this attempt and must carry its id in the retry
    // trace, not be reported as attemptId=null (that's reserved for the
    // URL-resolution failure above, which never got this far).
    this._attemptSeq += 1
    const attemptId = String(this._attemptSeq)
    this._lastAttemptId = attemptId

    try {
      // For wss:// with self-signed certs (local dev), skip cert validation.
      // External wss:// (production) should validate normally.
      const isLocalWss = url.startsWith('wss://127.0.0.1') || url.startsWith('wss://localhost')
      this._log(`[${this._label}] connecting to ${url.replace(/token=[^&]+/, 'token=***')} (attempt ${attemptId})`)
      const ws = new this._WebSocketImpl(url, isLocalWss ? { rejectUnauthorized: false } : undefined)
      this._ws = ws
      this._resetConnectAttemptTimer(ws, attemptId)

      ws.on('open', () => {
        this._clearConnectAttemptTimer()
        // Marks THIS socket as having reached OPEN. Lives on the socket rather
        // than on `this` so it is inherently per-generation: a late event from a
        // superseded attempt carries its own answer and cannot report the
        // current attempt's state. `_cleanup` reads it back to tell consumers
        // whether a connection was ever established.
        ws._tldaEstablished = true
        this._log(`[${this._label}] connected (attempt ${attemptId})`)
        this._onAttemptOpen?.(attemptId)
        if (this._stableTimer) clearTimeout(this._stableTimer)
        this._stableTimer = setTimeout(() => {
          this._stableTimer = null
          this._backoff = this._initialBackoff
        }, this._stableConnectionMs)
        this._resetHeartbeat(ws, attemptId)
        this._onActivity?.('open')
        this._onOpen?.(ws, attemptId)
      })

      ws.on('message', (raw) => {
        this._resetHeartbeat(ws, attemptId)
        this._onActivity?.('message')
        let msg
        try { msg = JSON.parse(raw.toString()) } catch (e) { this._log(`[${this._label}] bad JSON: ${e.message}`); return }
        this._onMessage(msg, attemptId)
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
        this._resetHeartbeat(ws, attemptId)
        this._onActivity?.('ping')
      })

      ws.on('close', (code, reason) => {
        this._log(`[${this._label}] closed (${code} ${reason || ''}) (attempt ${attemptId})`)
        // _cleanup only acts (and its result is only meaningful) if `ws` is
        // still the current socket. A late event from an already-superseded
        // generation must not schedule a retry on top of whatever the
        // current (possibly already-healthy) generation is doing.
        if (this._cleanup(ws, 'close', attemptId)) this._scheduleRetry(attemptId)
      })

      ws.on('error', (e) => {
        this._log(`[${this._label}] error: ${e.message} (attempt ${attemptId})`)
        if (this._cleanup(ws, 'error', attemptId)) this._scheduleRetry(attemptId)
      })
    } catch (e) {
      this._log(`[${this._label}] connect failed: ${e.message}`)
      this._scheduleRetry(attemptId)
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
    const ws = this._ws
    const attemptId = this._lastAttemptId
    if (ws) { try { ws.close() } catch (e) { this._log(`[${this._label}] close error: ${e.message}`) } }
    if (this._cleanup(ws, 'manual-reconnect', attemptId)) this._scheduleRetry(attemptId)
  }

  close() {
    this._closed = true
    if (this._retryTimer) { clearTimeout(this._retryTimer); this._retryTimer = null }
    this._clearConnectAttemptTimer()
    if (this._heartbeatTimer) { clearTimeout(this._heartbeatTimer); this._heartbeatTimer = null }
    if (this._stableTimer) { clearTimeout(this._stableTimer); this._stableTimer = null }
    if (this._ws) { try { this._ws.close() } catch (e) { this._log(`[${this._label}] close error: ${e.message}`) } }
    this._ws = null
  }

  /**
   * Returns true if this call actually tore down the current generation
   * (ws matched this._ws, or no ws was ever specified), false if `ws` was
   * already superseded (stale) and this was a no-op. Callers must gate any
   * consequence of "a generation just ended" — onClose, and scheduling a
   * retry — on this return value, not assume every close/error call site
   * corresponds to a real transition.
   */
  _cleanup(ws = this._ws, reason = null, attemptId = this._lastAttemptId) {
    if (ws && this._ws !== ws) return false
    // Did this attempt ever reach OPEN? Consumers hold state that belongs to an
    // established connection (the daemon's _serverReady, agent liveness, source
    // watchers). An attempt that never opened owns none of it and must not tear
    // it down. `reason` cannot answer this: 'error' and 'close' both fire for a
    // socket that died during the handshake -- which is exactly what a booting
    // server produces -- so only the socket itself knows.
    const established = !!ws?._tldaEstablished
    this._ws = null
    this._clearConnectAttemptTimer()
    if (this._heartbeatTimer) { clearTimeout(this._heartbeatTimer); this._heartbeatTimer = null }
    if (this._stableTimer) { clearTimeout(this._stableTimer); this._stableTimer = null }
    this._onClose?.(reason, attemptId, { established })
    return true
  }

  _scheduleRetry(attemptId) {
    if (this._closed) return
    if (this._retryTimer) return
    // Full jitter prevents every daemon that observed the same close from
    // reconnecting on the same millisecond.
    const delay = Math.floor(this._backoff * (0.5 + this._random() * 0.5))
    this._backoff = Math.min(this._backoff * 2, this._maxBackoff)
    this._log(`[${this._label}] reconnecting in ${delay}ms`)
    this._onRetryScheduled?.(attemptId, delay)
    this._retryTimer = setTimeout(() => {
      this._retryTimer = null
      this.connect()
    }, delay)
  }

  _resetHeartbeat(ws, attemptId) {
    if (!this._heartbeatTimeoutMs) return
    if (this._heartbeatTimer) clearTimeout(this._heartbeatTimer)
    const activityGeneration = (ws._tldaActivityGeneration || 0) + 1
    ws._tldaActivityGeneration = activityGeneration
    this._heartbeatTimer = setTimeout(() => {
      setImmediate(() => {
        if (this._ws !== ws) return
        if (ws._tldaActivityGeneration !== activityGeneration) return
        const openState = this._WebSocketImpl.OPEN ?? WebSocket.OPEN
        if (ws.readyState !== openState) return
        this._log(`[${this._label}] no heartbeat in ${this._heartbeatTimeoutMs}ms — reconnecting (attempt ${attemptId})`)
        try { ws.close() } catch (e) { this._log(`[${this._label}] close error: ${e.message}`) }
        if (this._cleanup(ws, 'heartbeat-timeout', attemptId)) this._scheduleRetry(attemptId)
      })
    }, this._heartbeatTimeoutMs)
  }

  _resetConnectAttemptTimer(ws, attemptId) {
    if (!this._connectAttemptTimeoutMs) return
    this._clearConnectAttemptTimer()
    this._connectAttemptTimer = setTimeout(() => {
      if (this._ws !== ws) return
      const connectingState = this._WebSocketImpl.CONNECTING ?? WebSocket.CONNECTING
      if (ws.readyState !== connectingState) return
      this._log(`[${this._label}] connection attempt timed out after ${this._connectAttemptTimeoutMs}ms — reconnecting (attempt ${attemptId})`)
      try {
        if (typeof ws.terminate === 'function') ws.terminate()
        else ws.close()
      } catch (e) {
        this._log(`[${this._label}] terminate error: ${e.message}`)
      }
      if (this._cleanup(ws, 'connect-timeout', attemptId)) this._scheduleRetry(attemptId)
    }, this._connectAttemptTimeoutMs)
  }

  _clearConnectAttemptTimer() {
    if (!this._connectAttemptTimer) return
    clearTimeout(this._connectAttemptTimer)
    this._connectAttemptTimer = null
  }
}
