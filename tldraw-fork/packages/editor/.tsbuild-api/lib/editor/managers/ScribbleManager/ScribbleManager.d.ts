import { TLScribble, VecModel } from '@tldraw/tlschema';
import type { Editor } from '../../Editor';
/** @public */
export interface ScribbleItem {
    id: string;
    scribble: TLScribble;
    timeoutMs: number;
    delayRemaining: number;
    prev: null | VecModel;
    next: null | VecModel;
}
/** @public */
export interface ScribbleSessionOptions {
    /** Session id. Auto-generated if not provided. */
    id?: string;
    /**
     * Whether scribbles self-consume (shrink from start) while drawing.
     * - true: scribbles eat their own tail as you draw (default, used for eraser/select)
     * - false: scribbles persist until session stops (used for laser)
     */
    selfConsume?: boolean;
    /**
     * How long to wait after last activity before auto-stopping the session.
     * Only applies when selfConsume is false.
     */
    idleTimeoutMs?: number;
    /**
     * How scribbles fade when stopping.
     * - 'individual': each scribble fades on its own (default)
     * - 'grouped': all scribbles fade together as one sequence
     */
    fadeMode?: 'grouped' | 'individual';
    /**
     * Easing for grouped fade.
     */
    fadeEasing?: 'ease-in' | 'linear';
    /**
     * Duration of the fade in milliseconds.
     */
    fadeDurationMs?: number;
}
/** @public */
export declare class ScribbleManager {
    private editor;
    private sessions;
    constructor(editor: Editor);
    /**
     * Start a new session for grouping scribbles.
     * Returns a session ID that can be used with other session methods.
     *
     * @param options - Session configuration
     * @returns Session ID
     * @public
     */
    startSession(options?: ScribbleSessionOptions): string;
    /**
     * Add a scribble to a session.
     *
     * @param sessionId - The session ID
     * @param scribble - Partial scribble properties
     * @param scribbleId - Optional scribble ID
     * @public
     */
    addScribbleToSession(sessionId: string, scribble: Partial<TLScribble>, scribbleId?: string): ScribbleItem;
    /**
     * Add a point to a scribble in a session.
     *
     * @param sessionId - The session ID
     * @param scribbleId - The scribble ID
     * @param x - X coordinate
     * @param y - Y coordinate
     * @param z - Z coordinate (pressure)
     * @public
     */
    addPointToSession(sessionId: string, scribbleId: string, x: number, y: number, z?: number): ScribbleItem;
    /**
     * Extend a session, resetting its idle timeout.
     *
     * @param sessionId - The session ID
     * @public
     */
    extendSession(sessionId: string): void;
    /**
     * Stop a session, triggering fade-out.
     *
     * @param sessionId - The session ID
     * @public
     */
    stopSession(sessionId: string): void;
    /**
     * Clear all scribbles in a session immediately.
     *
     * @param sessionId - The session ID
     * @public
     */
    clearSession(sessionId: string): void;
    /**
     * Check if a session is active.
     *
     * @param sessionId - The session ID
     * @public
     */
    isSessionActive(sessionId: string): boolean;
    /**
     * Add a scribble using the default self-consuming behavior.
     * Creates an implicit session for the scribble.
     *
     * @param scribble - Partial scribble properties
     * @param id - Optional scribble id
     * @returns The created scribble item
     * @public
     */
    addScribble(scribble: Partial<TLScribble>, id?: string): ScribbleItem;
    /**
     * Add a point to a scribble. Searches all sessions.
     *
     * @param id - The scribble id
     * @param x - X coordinate
     * @param y - Y coordinate
     * @param z - Z coordinate (pressure)
     * @public
     */
    addPoint(id: string, x: number, y: number, z?: number): ScribbleItem;
    /**
     * Mark a scribble as complete (done being drawn but not yet fading).
     * Searches all sessions.
     *
     * @param id - The scribble id
     * @public
     */
    complete(id: string): ScribbleItem;
    /**
     * Stop a scribble. Searches all sessions.
     *
     * @param id - The scribble id
     * @public
     */
    stop(id: string): ScribbleItem;
    /**
     * Stop and remove all sessions.
     *
     * @public
     */
    reset(): void;
    /**
     * Update on each animation frame.
     *
     * @param elapsed - The number of milliseconds since the last tick.
     * @public
     */
    tick(elapsed: number): void;
    private resetIdleTimeout;
    private clearIdleTimeout;
    private tickSession;
    private tickSessionItems;
    private tickPersistentItem;
    private tickSelfConsumingItem;
    private tickGroupedFade;
}
//# sourceMappingURL=ScribbleManager.d.ts.map