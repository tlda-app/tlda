/**
 * A utility class for measuring and tracking frame rate performance during operations.
 * Provides visual feedback in the browser console with color-coded FPS indicators.
 *
 * @example
 * ```ts
 * const tracker = new PerformanceTracker()
 *
 * tracker.start('render')
 * renderShapes()
 * tracker.stop() // Logs performance info to console
 *
 * // Check if tracking is active
 * if (tracker.isStarted()) {
 *   console.log('Still tracking performance')
 * }
 * ```
 *
 * @public
 */
export declare class PerformanceTracker {
    private startTime;
    private name;
    private frames;
    private started;
    private frame;
    /**
     * Records animation frames to calculate frame rate.
     * Called automatically during performance tracking.
     */
    recordFrame: () => void;
    /**
     * Starts performance tracking for a named operation.
     *
     * @param name - A descriptive name for the operation being tracked
     *
     * @example
     * ```ts
     * tracker.start('canvas-render')
     * // ... perform rendering operations
     * tracker.stop()
     * ```
     */
    start(name: string): void;
    /**
     * Stops performance tracking and logs results to the console.
     *
     * Displays the operation name, frame rate, and uses color coding:
     * - Green background: \> 55 FPS (good performance)
     * - Yellow background: 30-55 FPS (moderate performance)
     * - Red background: \< 30 FPS (poor performance)
     *
     * @example
     * ```ts
     * tracker.start('interaction')
     * handleUserInteraction()
     * tracker.stop() // Logs: "Perf Interaction 60 fps"
     * ```
     */
    stop(): void;
    /**
     * Checks whether performance tracking is currently active.
     *
     * @returns True if tracking is in progress, false otherwise
     *
     * @example
     * ```ts
     * if (!tracker.isStarted()) {
     *   tracker.start('new-operation')
     * }
     * ```
     */
    isStarted(): boolean;
}
//# sourceMappingURL=PerformanceTracker.d.ts.map