import { Atom } from '@tldraw/state';
import { TLRecord } from '@tldraw/tlschema';
import { TLSocketClientSentEvent, TLSocketServerSentEvent } from './protocol';
import { TLPersistentClientSocket, TLPersistentClientSocketStatus, TLSocketStatusListener } from './TLSyncClient';
/**
 * A WebSocket adapter that provides persistent connection management for tldraw synchronization.
 * This adapter handles connection establishment, reconnection logic, and message routing between
 * the sync client and server. It implements automatic reconnection with exponential backoff
 * and supports connection loss detection.
 *
 * Note: This adapter requires users to implement their own connection loss detection (e.g., pings)
 * as browser WebSocket APIs don't reliably surface protocol-level ping/pong frames.
 *
 * @internal
 * @example
 * ```ts
 * // Create a WebSocket adapter with connection URI
 * const adapter = new ClientWebSocketAdapter(() => 'ws://localhost:3000/sync')
 *
 * // Listen for connection status changes
 * adapter.onStatusChange((status) => {
 *   console.log('Connection status:', status)
 * })
 *
 * // Listen for incoming messages
 * adapter.onReceiveMessage((message) => {
 *   console.log('Received:', message)
 * })
 *
 * // Send a message when connected
 * if (adapter.connectionStatus === 'online') {
 *   adapter.sendMessage({ type: 'ping' })
 * }
 * ```
 */
export declare class ClientWebSocketAdapter implements TLPersistentClientSocket<TLSocketClientSentEvent<TLRecord>, TLSocketServerSentEvent<TLRecord>> {
    _ws: WebSocket | null;
    isDisposed: boolean;
    /** @internal */
    readonly _reconnectManager: ReconnectManager;
    /**
     * Permanently closes the WebSocket adapter and disposes of all resources.
     * Once closed, the adapter cannot be reused and should be discarded.
     * This method is idempotent - calling it multiple times has no additional effect.
     */
    close(): void;
    /**
     * Creates a new ClientWebSocketAdapter instance.
     *
     * @param getUri - Function that returns the WebSocket URI to connect to.
     *                 Can return a string directly or a Promise that resolves to a string.
     *                 This function is called each time a connection attempt is made,
     *                 allowing for dynamic URI generation (e.g., for authentication tokens).
     */
    constructor(getUri: () => Promise<string> | string);
    private _handleConnect;
    private _handleDisconnect;
    _setNewSocket(ws: WebSocket): void;
    _closeSocket(): void;
    _connectionStatus: Atom<TLPersistentClientSocketStatus | 'initial'>;
    /**
     * Gets the current connection status of the WebSocket.
     *
     * @returns The current connection status: 'online', 'offline', or 'error'
     */
    get connectionStatus(): TLPersistentClientSocketStatus;
    /**
     * Sends a message to the server through the WebSocket connection.
     * Messages are automatically chunked if they exceed size limits.
     *
     * @param msg - The message to send to the server
     *
     * @example
     * ```ts
     * adapter.sendMessage({
     *   type: 'push',
     *   diff: { 'shape:abc123': [2, { x: [1, 150] }] }
     * })
     * ```
     */
    sendMessage(msg: TLSocketClientSentEvent<TLRecord>): void;
    private messageListeners;
    /**
     * Registers a callback to handle incoming messages from the server.
     *
     * @param cb - Callback function that will be called with each received message
     * @returns A cleanup function to remove the message listener
     *
     * @example
     * ```ts
     * const unsubscribe = adapter.onReceiveMessage((message) => {
     *   switch (message.type) {
     *     case 'connect':
     *       console.log('Connected to room')
     *       break
     *     case 'data':
     *       console.log('Received data:', message.diff)
     *       break
     *   }
     * })
     *
     * // Later, remove the listener
     * unsubscribe()
     * ```
     */
    onReceiveMessage(cb: (val: TLSocketServerSentEvent<TLRecord>) => void): () => void;
    private statusListeners;
    /**
     * Registers a callback to handle connection status changes.
     *
     * @param cb - Callback function that will be called when the connection status changes
     * @returns A cleanup function to remove the status listener
     *
     * @example
     * ```ts
     * const unsubscribe = adapter.onStatusChange((status) => {
     *   if (status.status === 'error') {
     *     console.error('Connection error:', status.reason)
     *   } else {
     *     console.log('Status changed to:', status.status)
     *   }
     * })
     *
     * // Later, remove the listener
     * unsubscribe()
     * ```
     */
    onStatusChange(cb: TLSocketStatusListener): () => void;
    /**
     * Manually restarts the WebSocket connection.
     * This closes the current connection (if any) and attempts to establish a new one.
     * Useful for implementing connection loss detection and recovery.
     *
     * @example
     * ```ts
     * // Restart connection after detecting it's stale
     * if (lastPongTime < Date.now() - 30000) {
     *   adapter.restart()
     * }
     * ```
     */
    restart(): void;
}
/**
 * Minimum reconnection delay in milliseconds when the browser tab is active and focused.
 *
 * @internal
 */
export declare const ACTIVE_MIN_DELAY = 500;
/**
 * Maximum reconnection delay in milliseconds when the browser tab is active and focused.
 *
 * @internal
 */
export declare const ACTIVE_MAX_DELAY = 2000;
/**
 * Minimum reconnection delay in milliseconds when the browser tab is inactive or hidden.
 * This longer delay helps reduce battery drain and server load when users aren't actively viewing the tab.
 *
 * @internal
 */
export declare const INACTIVE_MIN_DELAY = 1000;
/**
 * Maximum reconnection delay in milliseconds when the browser tab is inactive or hidden.
 * Set to 5 minutes to balance between maintaining sync and conserving resources.
 *
 * @internal
 */
export declare const INACTIVE_MAX_DELAY: number;
/**
 * Exponential backoff multiplier for calculating reconnection delays.
 * Each failed connection attempt increases the delay by this factor until max delay is reached.
 *
 * @internal
 */
export declare const DELAY_EXPONENT = 1.5;
/**
 * Maximum time in milliseconds to wait for a connection attempt before considering it failed.
 * This helps detect connections stuck in the CONNECTING state and retry with fresh attempts.
 *
 * @internal
 */
export declare const ATTEMPT_TIMEOUT = 1000;
/**
 * Manages automatic reconnection logic for WebSocket connections with intelligent backoff strategies.
 * This class handles connection attempts, tracks connection state, and implements exponential backoff
 * with different delays based on whether the browser tab is active or inactive.
 *
 * The ReconnectManager responds to various browser events like network status changes,
 * tab visibility changes, and connection events to optimize reconnection timing and
 * minimize unnecessary connection attempts.
 *
 * @internal
 *
 * @example
 * ```ts
 * const manager = new ReconnectManager(
 *   socketAdapter,
 *   () => 'ws://localhost:3000/sync'
 * )
 *
 * // Manager automatically handles:
 * // - Initial connection
 * // - Reconnection on disconnect
 * // - Exponential backoff on failures
 * // - Tab visibility-aware delays
 * // - Network status change responses
 * ```
 */
export declare class ReconnectManager {
    private socketAdapter;
    private getUri;
    private isDisposed;
    private disposables;
    private reconnectTimeout;
    private recheckConnectingTimeout;
    private lastAttemptStart;
    intendedDelay: number;
    private state;
    /**
     * Creates a new ReconnectManager instance.
     *
     * socketAdapter - The ClientWebSocketAdapter instance to manage
     * getUri - Function that returns the WebSocket URI for connection attempts
     */
    constructor(socketAdapter: ClientWebSocketAdapter, getUri: () => Promise<string> | string);
    private subscribeToReconnectHints;
    private scheduleAttempt;
    private getMaxDelay;
    private getMinDelay;
    private clearReconnectTimeout;
    private clearRecheckConnectingTimeout;
    /**
     * Checks if reconnection should be attempted and initiates it if appropriate.
     * This method is called in response to network events, tab visibility changes,
     * and other hints that connectivity may have been restored.
     *
     * The method intelligently handles various connection states:
     * - Already connected: no action needed
     * - Currently connecting: waits or retries based on attempt age
     * - Disconnected: initiates immediate reconnection attempt
     *
     * @example
     * ```ts
     * // Called automatically on network/visibility events, but can be called manually
     * manager.maybeReconnected()
     * ```
     */
    maybeReconnected(): void;
    /**
     * Handles disconnection events and schedules reconnection attempts with exponential backoff.
     * This method is called when the WebSocket connection is lost or fails to establish.
     *
     * It implements intelligent delay calculation based on:
     * - Previous attempt timing
     * - Current tab visibility (active vs inactive delays)
     * - Exponential backoff for repeated failures
     *
     * @example
     * ```ts
     * // Called automatically when connection is lost
     * // Schedules reconnection with appropriate delay
     * manager.disconnected()
     * ```
     */
    disconnected(): void;
    /**
     * Handles successful connection events and resets reconnection state.
     * This method is called when the WebSocket successfully connects to the server.
     *
     * It clears any pending reconnection attempts and resets the delay back to minimum
     * for future connection attempts.
     *
     * @example
     * ```ts
     * // Called automatically when WebSocket opens successfully
     * manager.connected()
     * ```
     */
    connected(): void;
    /**
     * Permanently closes the reconnection manager and cleans up all resources.
     * This stops all pending reconnection attempts and removes event listeners.
     * Once closed, the manager cannot be reused.
     */
    close(): void;
}
//# sourceMappingURL=ClientWebSocketAdapter.d.ts.map