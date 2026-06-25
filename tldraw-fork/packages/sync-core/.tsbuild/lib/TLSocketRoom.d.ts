import type { SerializedSchema, StoreSchema, UnknownRecord } from '@tldraw/store';
import { TLStoreSnapshot } from '@tldraw/tlschema';
import { TLSocketServerSentEvent } from './protocol';
import { WebSocketMinimal } from './ServerSocketAdapter';
import { TLSyncErrorCloseEventReason } from './TLSyncClient';
import { RoomSnapshot } from './TLSyncRoom';
import { TLSyncStorage } from './TLSyncStorage';
/**
 * Logging interface for TLSocketRoom operations. Provides optional methods
 * for warning and error logging during synchronization operations.
 *
 * @example
 * ```ts
 * const logger: TLSyncLog = {
 *   warn: (...args) => console.warn('[SYNC]', ...args),
 *   error: (...args) => console.error('[SYNC]', ...args)
 * }
 *
 * const room = new TLSocketRoom({ log: logger })
 * ```
 *
 * @public
 */
export interface TLSyncLog {
    /**
     * Optional warning logger for non-fatal sync issues
     * @param args - Arguments to log
     */
    warn?(...args: any[]): void;
    /**
     * Optional error logger for sync errors and failures
     * @param args - Arguments to log
     */
    error?(...args: any[]): void;
}
/**
 * A snapshot of per-session state that can be persisted and used to resume a session
 * after the server restarts (e.g., after Cloudflare Durable Object hibernation).
 *
 * Obtain via {@link TLSocketRoom.getSessionSnapshot} and restore via
 * {@link TLSocketRoom.handleSocketResume}.
 *
 * @public
 */
export interface SessionStateSnapshot {
    serializedSchema: SerializedSchema;
    isReadonly: boolean;
    presenceId: string | null;
    presenceRecord: UnknownRecord | null;
    requiresLegacyRejection: boolean;
    supportsStringAppend: boolean;
}
/**
 * Base options for TLSocketRoom.
 * @public
 */
export interface TLSocketRoomOptions<R extends UnknownRecord, SessionMeta> {
    storage?: TLSyncStorage<R>;
    /**
     * @deprecated use the storage option instead
     */
    initialSnapshot?: RoomSnapshot | TLStoreSnapshot;
    /**
     * @deprecated use the storage option with an onChange callback instead
     */
    onDataChange?(): void;
    schema?: StoreSchema<R, any>;
    clientTimeout?: number;
    log?: TLSyncLog;
    onSessionRemoved?: (room: TLSocketRoom<R, SessionMeta>, args: {
        sessionId: string;
        numSessionsRemaining: number;
        meta: SessionMeta;
    }) => void;
    onBeforeSendMessage?: (args: {
        sessionId: string;
        /** @internal keep the protocol private for now */
        message: TLSocketServerSentEvent<R>;
        stringified: string;
        meta: SessionMeta;
    }) => void;
    onAfterReceiveMessage?: (args: {
        sessionId: string;
        /** @internal keep the protocol private for now */
        message: TLSocketServerSentEvent<R>;
        stringified: string;
        meta: SessionMeta;
    }) => void;
    /** @internal */
    onPresenceChange?(): void;
    /**
     * When set, the room will call {@link TLSocketRoom.getSessionSnapshot} after
     * no message activity for a session for 5s and pass the result to this callback.
     * Use for persisting snapshots to WebSocket attachments (e.g. Cloudflare hibernation).
     * The room clears any pending snapshot when the session closes.
     */
    onSessionSnapshot?: (sessionId: string, snapshot: SessionStateSnapshot) => void;
}
/**
 * A server-side room that manages WebSocket connections and synchronizes tldraw document state
 * between multiple clients in real-time. Each room represents a collaborative document space
 * where users can work together on drawings with automatic conflict resolution.
 *
 * TLSocketRoom handles:
 * - WebSocket connection lifecycle management
 * - Real-time synchronization of document changes
 * - Session management and presence tracking
 * - Message chunking for large payloads
 * - Automatic client timeout and cleanup
 *
 * @example
 * ```ts
 * // Basic room setup
 * const room = new TLSocketRoom({
 *   onSessionRemoved: (room, { sessionId, numSessionsRemaining }) => {
 *     console.log(`Client ${sessionId} disconnected, ${numSessionsRemaining} remaining`)
 *     if (numSessionsRemaining === 0) {
 *       room.close()
 *     }
 *   },
 *   onDataChange: () => {
 *     console.log('Document data changed, consider persisting')
 *   }
 * })
 *
 * // Handle new client connections
 * room.handleSocketConnect({
 *   sessionId: 'user-session-123',
 *   socket: webSocket,
 *   isReadonly: false
 * })
 * ```
 *
 * @example
 * ```ts
 * // Room with initial snapshot and schema
 * const room = new TLSocketRoom({
 *   initialSnapshot: existingSnapshot,
 *   schema: myCustomSchema,
 *   clientTimeout: 30000,
 *   log: {
 *     warn: (...args) => logger.warn('SYNC:', ...args),
 *     error: (...args) => logger.error('SYNC:', ...args)
 *   }
 * })
 *
 * // Update document programmatically
 * await room.updateStore(store => {
 *   const shape = store.get('shape:abc123')
 *   if (shape) {
 *     shape.x = 100
 *     store.put(shape)
 *   }
 * })
 * ```
 *
 * @public
 */
export declare class TLSocketRoom<R extends UnknownRecord = UnknownRecord, SessionMeta = void> {
    readonly opts: TLSocketRoomOptions<R, SessionMeta>;
    private room;
    private readonly sessions;
    readonly log?: TLSyncLog;
    storage: TLSyncStorage<R>;
    private disposables;
    private readonly snapshotTimers;
    /**
     * Creates a new TLSocketRoom instance for managing collaborative document synchronization.
     *
     * opts - Configuration options for the room
     *   - initialSnapshot - Optional initial document state to load
     *   - schema - Store schema defining record types and validation
     *   - clientTimeout - Milliseconds to wait before disconnecting inactive clients
     *   - log - Optional logger for warnings and errors
     *   - onSessionRemoved - Called when a client session is removed
     *   - onBeforeSendMessage - Called before sending messages to clients
     *   - onAfterReceiveMessage - Called after receiving messages from clients
     *   - onDataChange - Called when document data changes
     *   - onPresenceChange - Called when presence data changes
     */
    constructor(opts: TLSocketRoomOptions<R, SessionMeta>);
    /**
     * Returns the number of active sessions.
     * Note that this is not the same as the number of connected sockets!
     * Sessions time out a few moments after sockets close, to smooth over network hiccups.
     *
     * @returns the number of active sessions
     */
    getNumActiveSessions(): number;
    /**
     * Handles a new client WebSocket connection, creating a session within the room.
     * This should be called whenever a client establishes a WebSocket connection to join
     * the collaborative document.
     *
     * @param opts - Connection options
     *   - sessionId - Unique identifier for the client session (typically from browser tab)
     *   - socket - WebSocket-like object for client communication
     *   - isReadonly - Whether the client can modify the document (defaults to false)
     *   - meta - Additional session metadata (required if SessionMeta is not void)
     *
     * @example
     * ```ts
     * // Handle new WebSocket connection
     * room.handleSocketConnect({
     *   sessionId: 'user-session-abc123',
     *   socket: webSocketConnection,
     *   isReadonly: !userHasEditPermission
     * })
     * ```
     *
     * @example
     * ```ts
     * // With session metadata
     * room.handleSocketConnect({
     *   sessionId: 'session-xyz',
     *   socket: ws,
     *   meta: { userId: 'user-123', name: 'Alice' }
     * })
     * ```
     */
    handleSocketConnect(opts: {
        sessionId: string;
        socket: WebSocketMinimal;
        isReadonly?: boolean;
    } & (SessionMeta extends void ? object : {
        meta: SessionMeta;
    })): void;
    private clearSnapshotTimer;
    private scheduleDebouncedSnapshot;
    /**
     * Processes a message received from a client WebSocket. Use this method in server
     * environments where WebSocket event listeners cannot be attached directly to socket
     * instances (e.g., Bun.serve, Cloudflare Workers with WebSocket hibernation).
     *
     * The method handles message chunking/reassembly and forwards complete messages
     * to the underlying sync room for processing.
     *
     * @param sessionId - Session identifier matching the one used in handleSocketConnect
     * @param message - Raw message data from the client (string or binary)
     *
     * @example
     * ```ts
     * // In a Bun.serve handler
     * server.upgrade(req, {
     *   data: { sessionId, room },
     *   upgrade(res, req) {
     *     // Connection established
     *   },
     *   message(ws, message) {
     *     const { sessionId, room } = ws.data
     *     room.handleSocketMessage(sessionId, message)
     *   }
     * })
     * ```
     */
    handleSocketMessage(sessionId: string, message: string | AllowSharedBufferSource): void;
    /**
     * Handles a WebSocket error for the specified session. Use this in server environments
     * where socket event listeners cannot be attached directly. This will initiate cleanup
     * and session removal for the affected client.
     *
     * @param sessionId - Session identifier matching the one used in handleSocketConnect
     *
     * @example
     * ```ts
     * // In a custom WebSocket handler
     * socket.addEventListener('error', () => {
     *   room.handleSocketError(sessionId)
     * })
     * ```
     */
    handleSocketError(sessionId: string): void;
    /**
     * Handles a WebSocket close event for the specified session. Use this in server
     * environments where socket event listeners cannot be attached directly. This will
     * initiate cleanup and session removal for the disconnected client.
     *
     * @param sessionId - Session identifier matching the one used in handleSocketConnect
     *
     * @example
     * ```ts
     * // In a custom WebSocket handler
     * socket.addEventListener('close', () => {
     *   room.handleSocketClose(sessionId)
     * })
     * ```
     */
    handleSocketClose(sessionId: string): void;
    /**
     * Resumes a previously-connected session directly into `Connected` state, bypassing
     * the connect handshake. Use this after server hibernation (e.g., Cloudflare Durable
     * Object hibernation) when WebSocket connections survived but all in-memory state was lost.
     *
     * The session is restored using a {@link SessionStateSnapshot} previously obtained
     * via {@link TLSocketRoom.getSessionSnapshot}. The client is unaware the server restarted and
     * continues sending messages normally.
     *
     * Unlike {@link TLSocketRoom.handleSocketConnect}, this method does NOT attach WebSocket event
     * listeners. In hibernation environments, events are delivered via class methods
     * (e.g., `webSocketMessage`) rather than `addEventListener`.
     *
     * @param opts - Resume options
     *   - sessionId - Unique identifier for the client session
     *   - socket - WebSocket-like object for client communication
     *   - snapshot - Session state snapshot from {@link TLSocketRoom.getSessionSnapshot}
     *   - meta - Additional session metadata (required if SessionMeta is not void)
     *
     * @example
     * ```ts
     * // After Cloudflare DO hibernation wake
     * for (const ws of ctx.getWebSockets()) {
     *   const data = ws.deserializeAttachment()
     *   room.handleSocketResume({
     *     sessionId: data.sessionId,
     *     socket: ws,
     *     snapshot: data.snapshot,
     *   })
     * }
     * ```
     */
    handleSocketResume(opts: {
        sessionId: string;
        socket: WebSocketMinimal;
        snapshot: SessionStateSnapshot;
    } & (SessionMeta extends void ? object : {
        meta: SessionMeta;
    })): void;
    /**
     * Returns a snapshot of a connected session's state that can be persisted and later
     * used with {@link TLSocketRoom.handleSocketResume} to restore the session after hibernation.
     *
     * Returns `null` if the session doesn't exist or isn't in the `Connected` state.
     *
     * @param sessionId - The session to snapshot
     *
     * @example
     * ```ts
     * // Store snapshot in a Cloudflare WebSocket attachment
     * const snapshot = room.getSessionSnapshot(sessionId)
     * if (snapshot) {
     *   ws.serializeAttachment({ sessionId, snapshot })
     * }
     * ```
     */
    getSessionSnapshot(sessionId: string): SessionStateSnapshot | null;
    /**
     * Returns the current document clock value. The clock is a monotonically increasing
     * integer that increments with each document change, providing a consistent ordering
     * of changes across the distributed system.
     *
     * @returns The current document clock value
     *
     * @example
     * ```ts
     * const clock = room.getCurrentDocumentClock()
     * console.log(`Document is at version ${clock}`)
     * ```
     */
    getCurrentDocumentClock(): number;
    /**
     * Retrieves a deeply cloned copy of a record from the document store.
     * Returns undefined if the record doesn't exist. The returned record is
     * safe to mutate without affecting the original store data.
     *
     * @param id - Unique identifier of the record to retrieve
     * @returns Deep clone of the record, or undefined if not found
     *
     * @example
     * ```ts
     * const shape = room.getRecord('shape:abc123')
     * if (shape) {
     *   console.log('Shape position:', shape.x, shape.y)
     *   // Safe to modify without affecting store
     *   shape.x = 100
     * }
     * ```
     */
    getRecord(id: string): R;
    /**
     * Returns information about all active sessions in the room. Each session
     * represents a connected client with their current connection status and metadata.
     *
     * @returns Array of session information objects containing:
     *   - sessionId - Unique session identifier
     *   - isConnected - Whether the session has an active WebSocket connection
     *   - isReadonly - Whether the session can modify the document
     *   - meta - Custom session metadata
     *
     * @example
     * ```ts
     * const sessions = room.getSessions()
     * console.log(`Room has ${sessions.length} active sessions`)
     *
     * for (const session of sessions) {
     *   console.log(`${session.sessionId}: ${session.isConnected ? 'online' : 'offline'}`)
     *   if (session.isReadonly) {
     *     console.log('  (read-only access)')
     *   }
     * }
     * ```
     */
    getSessions(): Array<{
        sessionId: string;
        isConnected: boolean;
        isReadonly: boolean;
        meta: SessionMeta;
    }>;
    /**
     * Creates a complete snapshot of the current document state, including all records
     * and synchronization metadata. This snapshot can be persisted to storage and used
     * to restore the room state later or revert to a previous version.
     *
     * @returns Complete room snapshot including documents, clock values, and tombstones
     * @deprecated if you need to do this use
     *
     * @example
     * ```ts
     * // Capture current state for persistence
     * const snapshot = room.getCurrentSnapshot()
     * await saveToDatabase(roomId, JSON.stringify(snapshot))
     *
     * // Later, restore from snapshot
     * const savedSnapshot = JSON.parse(await loadFromDatabase(roomId))
     * const newRoom = new TLSocketRoom({ initialSnapshot: savedSnapshot })
     * ```
     */
    getCurrentSnapshot(): RoomSnapshot;
    /**
     * Retrieves all presence records from the document store. Presence records
     * contain ephemeral user state like cursor positions and selections.
     *
     * @returns Object mapping record IDs to presence record data
     * @internal
     */
    getPresenceRecords(): Record<string, UnknownRecord>;
    /**
     * Loads a document snapshot, completely replacing the current room state.
     * This will disconnect all current clients and update the document to match
     * the provided snapshot. Use this for restoring from backups or implementing
     * document versioning.
     *
     * @param snapshot - Room or store snapshot to load
     *
     * @example
     * ```ts
     * // Restore from a saved snapshot
     * const backup = JSON.parse(await loadBackup(roomId))
     * room.loadSnapshot(backup)
     *
     * // All clients will be disconnected and need to reconnect
     * // to see the restored document state
     * ```
     */
    loadSnapshot(snapshot: RoomSnapshot | TLStoreSnapshot): void;
    /**
     * Executes a transaction to modify the document store. Changes made within the
     * transaction are atomic and will be synchronized to all connected clients.
     * The transaction provides isolation from concurrent changes until it commits.
     *
     * @param updater - Function that receives store methods to make changes
     *   - store.get(id) - Retrieve a record (safe to mutate, but must call put() to commit)
     *   - store.put(record) - Save a modified record
     *   - store.getAll() - Get all records in the store
     *   - store.delete(id) - Remove a record from the store
     * @returns Promise that resolves when the transaction completes
     *
     * @example
     * ```ts
     * // Update multiple shapes in a single transaction
     * await room.updateStore(store => {
     *   const shape1 = store.get('shape:abc123')
     *   const shape2 = store.get('shape:def456')
     *
     *   if (shape1) {
     *     shape1.x = 100
     *     store.put(shape1)
     *   }
     *
     *   if (shape2) {
     *     shape2.meta.approved = true
     *     store.put(shape2)
     *   }
     * })
     * ```
     *
     * @example
     * ```ts
     * // Async transaction with external API call
     * await room.updateStore(async store => {
     *   const doc = store.get('document:main')
     *   if (doc) {
     *     doc.lastModified = await getCurrentTimestamp()
     *     store.put(doc)
     *   }
     * })
     * ```
     * @deprecated use the storage.transaction method instead
     */
    updateStore(updater: (store: RoomStoreMethods<R>) => void | Promise<void>): Promise<void>;
    /**
     * Sends a custom message to a specific client session. This allows sending
     * application-specific data that doesn't modify the document state, such as
     * notifications, chat messages, or custom commands.
     *
     * @param sessionId - Target session identifier
     * @param data - Custom payload to send (will be JSON serialized)
     *
     * @example
     * ```ts
     * // Send a notification to a specific user
     * room.sendCustomMessage('session-123', {
     *   type: 'notification',
     *   message: 'Your changes have been saved'
     * })
     *
     * // Send a chat message
     * room.sendCustomMessage('session-456', {
     *   type: 'chat',
     *   from: 'Alice',
     *   text: 'Great work on this design!'
     * })
     * ```
     */
    sendCustomMessage(sessionId: string, data: any): void;
    /**
     * Immediately removes a session from the room and closes its WebSocket connection.
     * The client will attempt to reconnect automatically unless a fatal reason is provided.
     *
     * @param sessionId - Session identifier to remove
     * @param fatalReason - Optional fatal error reason that prevents reconnection
     *
     * @example
     * ```ts
     * // Kick a user (they can reconnect)
     * room.closeSession('session-troublemaker')
     *
     * // Permanently ban a user
     * room.closeSession('session-banned', 'PERMISSION_DENIED')
     *
     * // Close session due to inactivity
     * room.closeSession('session-idle', 'TIMEOUT')
     * ```
     */
    closeSession(sessionId: string, fatalReason?: TLSyncErrorCloseEventReason | string): void;
    /**
     * Closes the room and disconnects all connected clients. This should be called
     * when shutting down the room permanently, such as during server shutdown or
     * when the room is no longer needed. Once closed, the room cannot be reopened.
     *
     * @example
     * ```ts
     * // Clean shutdown when no users remain
     * if (room.getNumActiveSessions() === 0) {
     *   await persistSnapshot(room.getCurrentSnapshot())
     *   room.close()
     * }
     *
     * // Server shutdown
     * process.on('SIGTERM', () => {
     *   for (const room of activeRooms.values()) {
     *     room.close()
     *   }
     * })
     * ```
     */
    close(): void;
    /**
     * Checks whether the room has been permanently closed. Closed rooms cannot
     * accept new connections or process further changes.
     *
     * @returns True if the room is closed, false if still active
     *
     * @example
     * ```ts
     * if (room.isClosed()) {
     *   console.log('Room has been shut down')
     *   // Create a new room or redirect users
     * } else {
     *   // Room is still accepting connections
     *   room.handleSocketConnect({ sessionId, socket })
     * }
     * ```
     */
    isClosed(): boolean;
}
/**
 * Utility type that removes properties with void values from an object type.
 * This is used internally to conditionally require session metadata based on
 * whether SessionMeta extends void.
 *
 * @example
 * ```ts
 * type Example = { a: string, b: void, c: number }
 * type Result = OmitVoid<Example> // { a: string, c: number }
 * ```
 *
 * @public
 */
export type OmitVoid<T, KS extends keyof T = keyof T> = {
    [K in KS extends any ? (void extends T[KS] ? never : KS) : never]: T[K];
};
/**
 * Interface for making transactional changes to room store data. Used within
 * updateStore transactions to modify documents atomically.
 *
 * @example
 * ```ts
 * await room.updateStore((store) => {
 *   const shape = store.get('shape:123')
 *   if (shape) {
 *     store.put({ ...shape, x: shape.x + 10 })
 *   }
 *   store.delete('shape:456')
 * })
 * ```
 *
 * @public
 * @deprecated use the storage.transaction method instead
 */
export interface RoomStoreMethods<R extends UnknownRecord = UnknownRecord> {
    /**
     * Add or update a record in the store.
     *
     * @param record - The record to store
     */
    put(record: R): void;
    /**
     * Delete a record from the store.
     *
     * @param recordOrId - The record or record ID to delete
     */
    delete(recordOrId: R | string): void;
    /**
     * Get a record by its ID.
     *
     * @param id - The record ID
     * @returns The record or null if not found
     */
    get(id: string): R | null;
    /**
     * Get all records in the store.
     *
     * @returns Array of all records
     */
    getAll(): R[];
}
//# sourceMappingURL=TLSocketRoom.d.ts.map