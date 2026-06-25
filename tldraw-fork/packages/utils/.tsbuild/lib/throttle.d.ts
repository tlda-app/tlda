/**
 * A scheduler class that manages a queue of functions to be executed at a target frame rate.
 * Each instance maintains its own queue and state, allowing for separate throttling contexts
 * (e.g., UI operations vs network sync operations).
 *
 * @public
 */
export declare class FpsScheduler {
    private targetFps;
    private targetTimePerFrame;
    private fpsQueue;
    private frameRaf;
    private flushRaf;
    private lastFlushTime;
    constructor(targetFps?: number);
    updateTargetFps(targetFps: number): void;
    private flush;
    private tick;
    /**
     * Creates a throttled version of a function that executes at most once per frame.
     * The default target frame rate is set by the FpsScheduler instance.
     * Subsequent calls within the same frame are ignored, ensuring smooth performance
     * for high-frequency events like mouse movements or scroll events.
     *
     * @param fn - The function to throttle, optionally with a cancel method
     * @returns A throttled function with an optional cancel method to remove pending calls
     *
     * @public
     */
    fpsThrottle(fn: {
        (): void;
        cancel?(): void;
    }): {
        (): void;
        cancel?(): void;
    };
    /**
     * Schedules a function to execute on the next animation frame.
     * If the same function is passed multiple times before the frame executes,
     * it will only be called once, effectively batching multiple calls.
     *
     * @param fn - The function to execute on the next frame
     * @returns A cancel function that can prevent execution if called before the next frame
     *
     * @public
     */
    throttleToNextFrame(fn: () => void): () => void;
}
/**
 * Creates a throttled version of a function that executes at most once per frame.
 * The default target frame rate is 120fps, but can be customized per function.
 * Subsequent calls within the same frame are ignored, ensuring smooth performance
 * for high-frequency events like mouse movements or scroll events.
 *
 * Uses the default throttle instance for UI operations. If you need a separate
 * throttling queue (e.g., for network operations), create your own Throttle instance.
 *
 * @param fn - The function to throttle, optionally with a cancel method
 * @returns A throttled function with an optional cancel method to remove pending calls
 *
 * @example
 * ```ts
 * // Default 120fps throttling
 * const updateCanvas = fpsThrottle(() => {
 *   // This will run at most once per frame (~8.33ms)
 *   redrawCanvas()
 * })
 *
 * // Call as often as you want - automatically throttled to 120fps
 * document.addEventListener('mousemove', updateCanvas)
 *
 * // Cancel pending calls if needed
 * updateCanvas.cancel?.()
 * ```
 *
 * @internal
 */
export declare function fpsThrottle(fn: {
    (): void;
    cancel?(): void;
}): {
    (): void;
    cancel?(): void;
};
/**
 * Schedules a function to execute on the next animation frame, targeting 120fps.
 * If the same function is passed multiple times before the frame executes,
 * it will only be called once, effectively batching multiple calls.
 *
 * Uses the default throttle instance for UI operations.
 *
 * @param fn - The function to execute on the next frame
 * @returns A cancel function that can prevent execution if called before the next frame
 *
 * @example
 * ```ts
 * const updateUI = throttleToNextFrame(() => {
 *   // Batches multiple calls into the next animation frame
 *   updateStatusBar()
 *   refreshToolbar()
 * })
 *
 * // Multiple calls within the same frame are batched
 * updateUI() // Will execute
 * updateUI() // Ignored (same function already queued)
 * updateUI() // Ignored (same function already queued)
 *
 * // Get cancel function to prevent execution
 * const cancel = updateUI()
 * cancel() // Prevents execution if called before next frame
 * ```
 *
 * @internal
 */
export declare function throttleToNextFrame(fn: () => void): () => void;
//# sourceMappingURL=throttle.d.ts.map