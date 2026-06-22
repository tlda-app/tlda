import { Signal } from '@tldraw/state';
import { Store, UnknownRecord } from '@tldraw/store';
import { TLSocketClientSentEvent, TLSocketServerSentEvent } from './protocol';
/**
 * Function type for subscribing to events with a callback.
 * Returns an unsubscribe function to clean up the listener.
 *
 * @param cb - Callback function that receives the event value
 * @returns Function to call when you want to unsubscribe from the events
 *
 * @public
 */
export type SubscribingFn<T> = (cb: (val: T) => void) => () => void;
/**
 * WebSocket close code used by the server to signal a non-recoverable sync error.
 * This close code indicates that the connection is being terminated due to an error
 * that cannot be automatically recovered from, such as authentication failures,
 * incompatible client versions, or invalid data.
 *
 * @example
 * ```ts
 * // Server-side: Close connection with specific error reason
 * socket.close(TLSyncErrorCloseEventCode, TLSyncErrorCloseEventReason.NOT_FOUND)
 *
 * // Client-side: Handle the error in your sync error handler
 * const syncClient = new TLSyncClient({
 *   // ... other config
 *   onSyncError: (reason) => {
 *     console.error('Sync failed:', reason) // Will receive 'NOT_FOUND'
 *   }
 * })
 * ```
 *
 * @public
 */
export declare const TLSyncErrorCloseEventCode: 4099;
/**
 * Predefined reasons for server-initiated connection closures.
 * These constants represent different error conditions that can cause
 * the sync server to terminate a WebSocket connection.
 *
 * @example
 * ```ts
 * // Server usage
 * if (!user.hasPermission(roomId)) {
 *   socket.close(TLSyncErrorCloseEventCode, TLSyncErrorCloseEventReason.FORBIDDEN)
 * }
 *
 * // Client error handling
 * syncClient.onSyncError((reason) => {
 *   switch (reason) {
 *     case TLSyncErrorCloseEventReason.NOT_FOUND:
 *       showError('Room does not exist')
 *       break
 *     case TLSyncErrorCloseEventReason.FORBIDDEN:
 *       showError('Access denied')
 *       break
 *     case TLSyncErrorCloseEventReason.CLIENT_TOO_OLD:
 *       showError('Please update your app')
 *       break
 *   }
 * })
 * ```
 *
 * @public
 */
export declare const TLSyncErrorCloseEventReason: {
    /** Room or resource not found */
    readonly NOT_FOUND: "NOT_FOUND";
    /** User lacks permission to access the room */
    readonly FORBIDDEN: "FORBIDDEN";
    /** User authentication required or invalid */
    readonly NOT_AUTHENTICATED: "NOT_AUTHENTICATED";
    /** Unexpected server error occurred */
    readonly UNKNOWN_ERROR: "UNKNOWN_ERROR";
    /** Client protocol version too old */
    readonly CLIENT_TOO_OLD: "CLIENT_TOO_OLD";
    /** Server protocol version too old */
    readonly SERVER_TOO_OLD: "SERVER_TOO_OLD";
    /** Client sent invalid or corrupted record data */
    readonly INVALID_RECORD: "INVALID_RECORD";
    /** Client exceeded rate limits */
    readonly RATE_LIMITED: "RATE_LIMITED";
    /** Room has reached maximum capacity */
    readonly ROOM_FULL: "ROOM_FULL";
};
/**
 * @internal
 */
export declare class TLSyncError extends Error {
    reason: TLSyncErrorCloseEventReason;
    constructor(message: string, reason: TLSyncErrorCloseEventReason);
}
/**
 * Union type of all possible server connection close reasons.
 * Represents the string values that can be passed when a server closes
 * a sync connection due to an error condition.
 *
 * @public
 */
export type TLSyncErrorCloseEventReason = (typeof TLSyncErrorCloseEventReason)[keyof typeof TLSyncErrorCloseEventReason];
/**
 * Handler function for custom application messages sent through the sync protocol.
 * These are user-defined messages that can be sent between clients via the sync server,
 * separate from the standard document synchronization messages.
 *
 * @param data - Custom message payload (application-defined structure)
 *
 * @example
 * ```ts
 * const customMessageHandler: TLCustomMessageHandler = (data) => {
 *   if (data.type === 'user_joined') {
 *     console.log(`${data.username} joined the session`)
 *     showToast(`${data.username} is now collaborating`)
 *   }
 * }
 *
 * const syncClient = new TLSyncClient({
 *   // ... other config
 *   onCustomMessageReceived: customMessageHandler
 * })
 * ```
 *
 * @public
 */
export type TLCustomMessageHandler = (this: null, data: any) => void;
/**
 * Event object describing changes in socket connection status.
 * Contains either a basic status change or an error with details.
 *
 * @public
 */
export type TLSocketStatusChangeEvent = {
    /** Connection came online or went offline */
    status: 'online' | 'offline';
} | {
    /** Connection encountered an error */
    status: 'error';
    /** Description of the error that occurred */
    reason: string;
};
/**
 * Callback function type for listening to socket status changes.
 *
 * @param params - Event object containing the new status and optional error details
 *
 * @internal
 */
export type TLSocketStatusListener = (params: TLSocketStatusChangeEvent) => void;
/**
 * Possible connection states for a persistent client socket.
 * Represents the current connectivity status between client and server.
 *
 * @internal
 */
export type TLPersistentClientSocketStatus = 'online' | 'offline' | 'error';
/**
 * Mode for handling presence information in sync sessions.
 * Controls whether presence data (cursors, selections) is shared with other clients.
 *
 * @public
 */
export type TLPresenceMode = 
/** No presence sharing - client operates independently */
'solo'
/** Full presence sharing - cursors and selections visible to others */
 | 'full';
/**
 * Interface for persistent WebSocket-like connections used by TLSyncClient.
 * Handles automatic reconnection and provides event-based communication with the sync server.
 * Implementations should maintain connection resilience and handle network interruptions gracefully.
 *
 * @example
 * ```ts
 * class MySocketAdapter implements TLPersistentClientSocket {
 *   connectionStatus: 'offline' | 'online' | 'error' = 'offline'
 *
 *   sendMessage(msg: TLSocketClientSentEvent) {
 *     if (this.ws && this.ws.readyState === WebSocket.OPEN) {
 *       this.ws.send(JSON.stringify(msg))
 *     }
 *   }
 *
 *   onReceiveMessage = (callback) => {
 *     // Set up message listener and return cleanup function
 *   }
 *
 *   restart() {
 *     this.disconnect()
 *     this.connect()
 *   }
 * }
 * ```
 *
 * @public
 */
export interface TLPersistentClientSocket<ClientSentMessage extends object = object, ServerSentMessage extends object = object> {
    /** Current connection state - online means actively connected and ready */
    connectionStatus: 'online' | 'offline' | 'error';
    /**
     * Send a protocol message to the sync server
     * @param msg - Message to send (connect, push, ping, etc.)
     */
    sendMessage(msg: ClientSentMessage): void;
    /**
     * Subscribe to messages received from the server
     * @param callback - Function called for each received message
     * @returns Cleanup function to remove the listener
     */
    onReceiveMessage: SubscribingFn<ServerSentMessage>;
    /**
     * Subscribe to connection status changes
     * @param callback - Function called when connection status changes
     * @returns Cleanup function to remove the listener
     */
    onStatusChange: SubscribingFn<TLSocketStatusChangeEvent>;
    /**
     * Force a connection restart (disconnect then reconnect)
     * Used for error recovery or when connection health checks fail
     */
    restart(): void;
    /**
     * Close the connection
     */
    close(): void;
}
/**
 * Main client-side synchronization engine for collaborative tldraw applications.
 *
 * TLSyncClient manages bidirectional synchronization between a local tldraw Store
 * and a remote sync server. It uses an optimistic update model where local changes
 * are immediately applied for responsive UI, then sent to the server for validation
 * and distribution to other clients.
 *
 * The synchronization follows a git-like push/pull/rebase model:
 * - **Push**: Local changes are sent to server as diff operations
 * - **Pull**: Server changes are received and applied locally
 * - **Rebase**: Conflicting changes are resolved by undoing local changes,
 *   applying server changes, then re-applying local changes on top
 *
 * @example
 * ```ts
 * import { TLSyncClient, ClientWebSocketAdapter } from '@tldraw/sync-core'
 * import { createTLStore } from '@tldraw/store'
 *
 * // Create store and socket
 * const store = createTLStore({ schema: mySchema })
 * const socket = new ClientWebSocketAdapter('ws://localhost:3000/sync')
 *
 * // Create sync client
 * const syncClient = new TLSyncClient({
 *   store,
 *   socket,
 *   presence: atom(null),
 *   onLoad: () => console.log('Connected and loaded'),
 *   onSyncError: (reason) => console.error('Sync failed:', reason)
 * })
 *
 * // Changes to store are now automatically synchronized
 * store.put([{ id: 'shape1', type: 'geo', x: 100, y: 100 }])
 * ```
 *
 * @example
 * ```ts
 * // Advanced usage with presence and custom messages
 * const syncClient = new TLSyncClient({
 *   store,
 *   socket,
 *   presence: atom({ cursor: { x: 0, y: 0 }, userName: 'Alice' }),
 *   presenceMode: atom('full'),
 *   onCustomMessageReceived: (data) => {
 *     if (data.type === 'chat') {
 *       showChatMessage(data.message, data.from)
 *     }
 *   },
 *   onAfterConnect: (client, { isReadonly }) => {
 *     if (isReadonly) {
 *       showNotification('Connected in read-only mode')
 *     }
 *   }
 * })
 * ```
 *
 * @public
 */
export declare class TLSyncClient<R extends UnknownRecord, S extends Store<R> = Store<R>> {
    /** The last clock time from the most recent server update */
    private lastServerClock;
    private lastServerInteractionTimestamp;
    /** The queue of in-flight push requests that have not yet been acknowledged by the server */
    private pendingPushRequests;
    private unsentChanges;
    /**
     * The diff of 'unconfirmed', 'optimistic' changes that have been made locally by the user if we
     * take this diff, reverse it, and apply that to the store, our store will match exactly the most
     * recent state of the server that we know about
     */
    private speculativeChanges;
    private disposables;
    /** Separate scheduler instance for network sync operations */
    private readonly fpsScheduler;
    /** Send any unsent push requests to the server */
    private readonly sendUnsentChanges;
    /** Schedule a rebase operation */
    private readonly scheduleRebase;
    /** @internal */
    readonly store: S;
    /** @internal */
    readonly socket: TLPersistentClientSocket<TLSocketClientSentEvent<R>, TLSocketServerSentEvent<R>>;
    /** @internal */
    readonly presenceState: Signal<R | null> | undefined;
    /** @internal */
    readonly presenceMode: Signal<TLPresenceMode> | undefined;
    /** @internal */
    isConnectedToRoom: boolean;
    /**
     * The client clock is essentially a counter for push requests Each time a push request is created
     * the clock is incremented. This clock is sent with the push request to the server, and the
     * server returns it with the response so that we can match up the response with the request.
     *
     * The clock may also be used at one point in the future to allow the client to re-send push
     * requests idempotently (i.e. the server will keep track of each client's clock and not execute
     * requests it has already handled), but at the time of writing this is neither needed nor
     * implemented.
     */
    private clientClock;
    /**
     * Callback executed immediately after successful connection to sync room.
     * Use this to perform any post-connection setup required for your application,
     * such as initializing default content or updating UI state.
     *
     * @param self - The TLSyncClient instance that connected
     * @param details - Connection details
     *   - isReadonly - Whether the connection is in read-only mode
     */
    private readonly onAfterConnect?;
    private readonly onCustomMessageReceived?;
    private isDebugging;
    private debug;
    private readonly presenceType;
    private didCancel?;
    /**
     * Creates a new TLSyncClient instance to manage synchronization with a remote server.
     *
     * @param config - Configuration object for the sync client
     *   - store - The local tldraw store to synchronize
     *   - socket - WebSocket adapter for server communication
     *   - presence - Reactive signal containing current user's presence data
     *   - presenceMode - Optional signal controlling presence sharing (defaults to 'full')
     *   - onLoad - Callback fired when initial sync completes successfully
     *   - onSyncError - Callback fired when sync fails with error reason
     *   - onCustomMessageReceived - Optional handler for custom messages
     *   - onAfterConnect - Optional callback fired after successful connection
     *   - self - The TLSyncClient instance
     *   - details - Connection details including readonly status
     *   - didCancel - Optional function to check if sync should be cancelled
     */
    constructor(config: {
        store: S;
        socket: TLPersistentClientSocket<any, any>;
        presence: Signal<R | null>;
        presenceMode?: Signal<TLPresenceMode>;
        onLoad(self: TLSyncClient<R, S>): void;
        onSyncError(reason: string): void;
        onCustomMessageReceived?: TLCustomMessageHandler;
        onAfterConnect?(self: TLSyncClient<R, S>, details: {
            isReadonly: boolean;
        }): void;
        didCancel?(): boolean;
    });
    /** @internal */
    latestConnectRequestId: string | null;
    /**
     * This is the first message that is sent over a newly established socket connection. And we need
     * to wait for the response before this client can be used.
     */
    private sendConnectMessage;
    /** Switch to offline mode */
    private resetConnection;
    /**
     * Invoked when the socket connection comes online, either for the first time or as the result of
     * a reconnect. The goal is to rebase on the server's state and fire off a new push request for
     * any local changes that were made while offline.
     */
    private didReconnect;
    private incomingDiffBuffer;
    /** Handle events received from the server */
    private handleServerEvent;
    /**
     * Closes the sync client and cleans up all resources.
     *
     * Call this method when you no longer need the sync client to prevent
     * memory leaks and close the WebSocket connection. After calling close(),
     * the client cannot be reused.
     *
     * @example
     * ```ts
     * // Clean shutdown
     * syncClient.close()
     * ```
     */
    close(): void;
    private lastPushedPresenceState;
    private pushPresence;
    /** Push a change to the server, or stash it locally if we're offline */
    private push;
    /** Get the target FPS for network operations based on presence mode */
    private getSyncFps;
    /**
     * Applies a 'network' diff to the store this does value-based equality checking so that if the
     * data is the same (as opposed to merely identical with ===), then no change is made and no
     * changes will be propagated back to store listeners
     */
    private applyNetworkDiff;
    private rebase;
}
//# sourceMappingURL=TLSyncClient.d.ts.map