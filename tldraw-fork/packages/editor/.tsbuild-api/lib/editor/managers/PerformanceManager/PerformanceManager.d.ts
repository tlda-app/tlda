import EventEmitter from 'eventemitter3';
import type { Editor } from '../../Editor';
import type { TLPerfEventMap } from './perf-types';
/**
 * Manages performance event subscriptions for the editor. Available as `editor.performance`.
 *
 * Listeners are lazy — internal editor hooks (frame, shape events) are only attached while
 * at least one subscriber exists, so there is zero overhead when unused.
 *
 * @example
 * ```ts
 * const unsub = editor.performance.on('interaction-end', (event) => {
 *   console.log(`${event.name}: ${event.fps.toFixed(1)} fps, p95=${event.p95FrameTime.toFixed(1)}ms`)
 * })
 * ```
 *
 * @public
 */
export declare class PerformanceManager {
    /** @internal */
    readonly emitter: EventEmitter<TLPerfEventMap, any>;
    private editor;
    private activeInteraction;
    private activeCamera;
    private frameCleanup;
    private shapeCreatedCleanup;
    private shapeEditedCleanup;
    private shapeDeletedCleanup;
    private loafObserver;
    constructor(editor: Editor);
    /**
     * Subscribe to a performance event. Returns an unsubscribe function.
     *
     * @example
     * ```ts
     * const unsub = editor.performance.on('interaction-end', (event) => {
     *   sendToAnalytics({ name: event.name, fps: event.fps, p95: event.p95FrameTime })
     * })
     * // later: unsub()
     * ```
     *
     * @public
     */
    on<K extends keyof TLPerfEventMap>(event: K, fn: (...args: TLPerfEventMap[K]) => void): () => void;
    /**
     * Subscribe to a performance event once. The listener is removed after the first invocation.
     * Returns an unsubscribe function for early removal.
     *
     * @public
     */
    once<K extends keyof TLPerfEventMap>(event: K, fn: (...args: TLPerfEventMap[K]) => void): () => void;
    /** @internal */
    dispose(): void;
    /** @internal */
    _notifyInteractionStart(name: string, path: string): void;
    /** @internal */
    _notifyInteractionEnd(): void;
    /** @internal */
    _notifyCameraOperation(type: 'panning' | 'zooming'): void;
    /** @internal */
    _notifyUndoRedo(type: 'redo' | 'undo', undoDepth: number, redoDepth: number): void;
    private _startCameraSession;
    private _endCameraSession;
    private _onFrame;
    private _onShapesCreated;
    private _onShapesEdited;
    private _onShapesDeleted;
    private _startLoafObserver;
    private _stopLoafObserver;
    private _needsFrameListener;
    private _needsLoafObserver;
    private _maybeAttachLazyListeners;
    private _maybeDetachLazyListeners;
}
//# sourceMappingURL=PerformanceManager.d.ts.map