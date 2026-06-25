import { RecordType, SerializedSchema, StoreSchema, UnknownRecord } from '@tldraw/store';
import { TLSocketClientSentEvent, TLSocketServerSentEvent } from './protocol';
import { RoomSession } from './RoomSession';
import { TLSyncLog } from './TLSocketRoom';
import { TLSyncErrorCloseEventReason } from './TLSyncClient';
import { TLSyncStorage } from './TLSyncStorage';
/**
 * WebSocket interface for server-side room connections. This defines the contract
 * that socket implementations must follow to work with TLSyncRoom.
 *
 * @internal
 */
export interface TLRoomSocket<R extends UnknownRecord> {
    /**
     * Whether the socket connection is currently open and ready to send messages.
     */
    isOpen: boolean;
    /**
     * Send a message to the connected client through this socket.
     *
     * @param msg - The server-sent event message to transmit
     */
    sendMessage(msg: TLSocketServerSentEvent<R>): void;
    /**
     * Close the socket connection with optional status code and reason.
     *
     * @param code - WebSocket close code (optional)
     * @param reason - Human-readable close reason (optional)
     */
    close(code?: number, reason?: string): void;
}
/**
 * The minimum time interval (in milliseconds) between sending batched data messages
 * to clients. This debouncing prevents overwhelming clients with rapid updates.
 * @public
 */
export declare const DATA_MESSAGE_DEBOUNCE_INTERVAL: number;
/**
 * Snapshot of a room's complete state that can be persisted and restored.
 * Contains all documents, tombstones, and metadata needed to reconstruct the room.
 *
 * @public
 */
export interface RoomSnapshot {
    /**
     * The current logical clock value for the room
     */
    clock?: number;
    /**
     * Clock value when document data was last changed (optional for backwards compatibility)
     */
    documentClock?: number;
    /**
     * Array of all document records with their last modification clocks
     */
    documents: Array<{
        state: UnknownRecord;
        lastChangedClock: number;
    }>;
    /**
     * Map of deleted record IDs to their deletion clock values (optional)
     */
    tombstones?: Record<string, number>;
    /**
     * Clock value where tombstone history begins - older deletions are not tracked (optional)
     */
    tombstoneHistoryStartsAtClock?: number;
    /**
     * Serialized schema used when creating this snapshot (optional)
     */
    schema?: SerializedSchema;
}
/**
 * A collaborative workspace that manages multiple client sessions and synchronizes
 * document changes between them. The room serves as the authoritative source for
 * all document state and handles conflict resolution, schema migrations, and
 * real-time data distribution.
 *
 * @example
 * ```ts
 * const room = new TLSyncRoom({
 *   schema: mySchema,
 *   onDataChange: () => saveToDatabase(room.getSnapshot()),
 *   onPresenceChange: () => updateLiveCursors()
 * })
 *
 * // Handle new client connections
 * room.handleNewSession({
 *   sessionId: 'user-123',
 *   socket: webSocketAdapter,
 *   meta: { userId: '123', name: 'Alice' },
 *   isReadonly: false
 * })
 * ```
 *
 * @internal
 */
export declare class TLSyncRoom<R extends UnknownRecord, SessionMeta> {
    readonly sessions: Map<string, RoomSession<R, SessionMeta>>;
    private lastDocumentClock;
    private pruneTimer;
    pruneSessions: import("lodash").DebouncedFuncLeading<() => void>;
    private scheduleFollowUpPrune;
    readonly presenceStore: PresenceStore<R>;
    private disposables;
    private _isClosed;
    /**
     * Close the room and clean up all resources. Disconnects all sessions
     * and stops background processes.
     */
    close(): void;
    /**
     * Check if the room has been closed and is no longer accepting connections.
     *
     * @returns True if the room is closed
     */
    isClosed(): boolean;
    readonly events: import("nanoevents").Emitter<{
        room_became_empty(): void;
        session_removed(args: {
            sessionId: string;
            meta: SessionMeta;
        }): void;
    }>;
    private readonly storage;
    readonly serializedSchema: SerializedSchema;
    readonly documentTypes: Set<string>;
    readonly presenceType: RecordType<R, any> | null;
    private log?;
    readonly schema: StoreSchema<R, any>;
    private onPresenceChange;
    private readonly sessionIdleTimeout;
    constructor(opts: {
        log?: TLSyncLog;
        schema: StoreSchema<R, any>;
        onPresenceChange?(): void;
        storage: TLSyncStorage<R>;
        clientTimeout?: number;
    });
    private broadcastExternalStorageChanges;
    /**
     * Send a message to a particular client. Debounces data events
     *
     * @param sessionId - The id of the session to send the message to.
     * @param message - The message to send. UNSAFE Any diffs must have been downgraded already if necessary
     */
    private _unsafe_sendMessage;
    _flushDataMessages(sessionId: string): void;
    /** @internal */
    private removeSession;
    private cancelSession;
    readonly internalTxnId = "TLSyncRoom.txn";
    /**
     * Broadcast a patch to all connected clients except the one with the sessionId provided.
     *
     * @param diff - The TLSyncForwardDiff with full records (used for migration)
     * @param networkDiff - Optional pre-computed NetworkDiff for sessions not needing migration.
     *                      If not provided, will be computed from recordsDiff.
     * @param sourceSessionId - Optional session ID to exclude from the broadcast
     */
    private broadcastPatch;
    /**
     * Send a custom message to a connected client. Useful for application-specific
     * communication that doesn't involve document synchronization.
     *
     * @param sessionId - The ID of the session to send the message to
     * @param data - The custom payload to send (will be JSON serialized)
     * @example
     * ```ts
     * // Send a custom notification
     * room.sendCustomMessage('user-123', {
     *   type: 'notification',
     *   message: 'Document saved successfully'
     * })
     *
     * // Send user-specific data
     * room.sendCustomMessage('user-456', {
     *   type: 'user_permissions',
     *   canEdit: true,
     *   canDelete: false
     * })
     * ```
     */
    sendCustomMessage(sessionId: string, data: any): void;
    /**
     * Register a new client session with the room. The session will be in an awaiting
     * state until it sends a connect message with protocol handshake.
     *
     * @param opts - Session configuration
     *   - sessionId - Unique identifier for this session
     *   - socket - WebSocket adapter for communication
     *   - meta - Application-specific metadata for this session
     *   - isReadonly - Whether this session can modify documents
     * @returns This room instance for method chaining
     * @example
     * ```ts
     * room.handleNewSession({
     *   sessionId: crypto.randomUUID(),
     *   socket: new WebSocketAdapter(ws),
     *   meta: { userId: '123', name: 'Alice', avatar: 'url' },
     *   isReadonly: !hasEditPermission
     * })
     * ```
     *
     * @internal
     */
    handleNewSession(opts: {
        sessionId: string;
        socket: TLRoomSocket<R>;
        meta: SessionMeta;
        isReadonly: boolean;
    }): this;
    /**
     * Resume a previously-connected session directly into `Connected` state, bypassing the
     * connect handshake. Used after server hibernation when the WebSocket is still alive but
     * all in-memory state has been lost.
     *
     * @internal
     */
    handleResumedSession(opts: {
        sessionId: string;
        socket: TLRoomSocket<R>;
        meta: SessionMeta;
        isReadonly: boolean;
        serializedSchema: SerializedSchema;
        presenceId: string | null;
        presenceRecord: UnknownRecord | null;
        requiresLegacyRejection: boolean;
        supportsStringAppend: boolean;
    }): void;
    /**
     * Checks if all connected sessions support string append operations (protocol version 8+).
     * If any client is on an older version, returns false to enable legacy append mode.
     *
     * @returns True if all connected sessions are on protocol version 8 or higher
     */
    getCanEmitStringAppend(): boolean;
    /**
     * When we send a diff to a client, if that client is on a lower version than us, we need to make
     * the diff compatible with their version. This method takes a TLSyncForwardDiff (which has full
     * records) and migrates all records down to the client's schema version, returning a NetworkDiff.
     *
     * For updates (entries with [before, after] tuples), both records are migrated and a patch is
     * computed from the migrated versions, preserving efficient patch semantics even across versions.
     *
     * If a migration fails, the session will be rejected.
     *
     * @param sessionId - The session ID (for rejection on migration failure)
     * @param serializedSchema - The client's schema to migrate to
     * @param requiresDownMigrations - Whether the client needs down migrations
     * @param diff - The TLSyncForwardDiff containing full records to migrate
     * @param unmigrated - Optional pre-computed NetworkDiff for when no migration is needed
     * @returns A NetworkDiff with migrated records, or a migration failure
     */
    private migrateDiffOrRejectSession;
    /**
     * Process an incoming message from a client session. Handles connection requests,
     * data synchronization pushes, and ping/pong for connection health.
     *
     * @param sessionId - The ID of the session that sent the message
     * @param message - The client message to process
     * @example
     * ```ts
     * // Typically called by WebSocket message handlers
     * websocket.onMessage((data) => {
     *   const message = JSON.parse(data)
     *   room.handleMessage(sessionId, message)
     * })
     * ```
     */
    handleMessage(sessionId: string, message: TLSocketClientSentEvent<R>): Promise<void>;
    /**
     * Reject and disconnect a session due to incompatibility or other fatal errors.
     * Sends appropriate error messages before closing the connection.
     *
     * @param sessionId - The session to reject
     * @param fatalReason - The reason for rejection (optional)
     * @example
     * ```ts
     * // Reject due to version mismatch
     * room.rejectSession('user-123', TLSyncErrorCloseEventReason.CLIENT_TOO_OLD)
     *
     * // Reject due to permission issue
     * room.rejectSession('user-456', 'Insufficient permissions')
     * ```
     */
    rejectSession(sessionId: string, fatalReason?: TLSyncErrorCloseEventReason | string): void;
    private forceAllReconnect;
    private broadcastChanges;
    /**
     * Work out whether a client we can't reconcile schemas with is running a newer or older SDK
     * than us.
     */
    private getVersionMismatchReason;
    private handleConnectRequest;
    private handlePushRequest;
    /**
     * Handle the event when a client disconnects. Cleans up the session and
     * removes any presence information.
     *
     * @param sessionId - The session that disconnected
     * @example
     * ```ts
     * websocket.onClose(() => {
     *   room.handleClose(sessionId)
     * })
     * ```
     */
    handleClose(sessionId: string): void;
}
/** @internal */
export interface MinimalDocStore<R extends UnknownRecord> {
    get(id: string): UnknownRecord | undefined;
    set(id: string, record: R): void;
    delete(id: string): void;
}
/** @internal */
export declare class PresenceStore<R extends UnknownRecord> implements MinimalDocStore<R> {
    private readonly presences;
    get(id: string): UnknownRecord | undefined;
    set(id: string, state: R): void;
    delete(id: string): void;
    values(): Generator<R, undefined, unknown>;
}
//# sourceMappingURL=TLSyncRoom.d.ts.map