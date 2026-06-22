/**
 * A utility class for managing timeouts, intervals, and animation frames with context-based organization and automatic cleanup.
 * Helps prevent memory leaks by organizing timers into named contexts that can be cleared together.
 * @example
 * ```ts
 * const timers = new Timers()
 *
 * // Set timers with context organization
 * timers.setTimeout('ui', () => console.log('Auto save'), 5000)
 * timers.setInterval('ui', () => console.log('Refresh'), 1000)
 * timers.requestAnimationFrame('ui', () => console.log('Render'))
 *
 * // Clear all timers for a context
 * timers.dispose('ui')
 *
 * // Or get context-bound functions
 * const uiTimers = timers.forContext('ui')
 * uiTimers.setTimeout(() => console.log('Contextual timeout'), 1000)
 * ```
 * @public
 */
export declare class Timers {
    private timeouts;
    private intervals;
    private rafs;
    /**
     * Creates a new Timers instance with bound methods for safe callback usage.
     * @example
     * ```ts
     * const timers = new Timers()
     * // Methods are pre-bound, safe to use as callbacks
     * element.addEventListener('click', timers.dispose)
     * ```
     */
    constructor();
    /**
     * Creates a timeout that will be tracked under the specified context.
     * @param contextId - The context identifier to group this timer under.
     * @param handler - The function to execute when the timeout expires.
     * @param timeout - The delay in milliseconds (default: 0).
     * @param args - Additional arguments to pass to the handler.
     * @returns The timer ID that can be used with clearTimeout.
     * @example
     * ```ts
     * const timers = new Timers()
     * const id = timers.setTimeout('autosave', () => save(), 5000)
     * // Timer will be automatically cleared when 'autosave' context is disposed
     * ```
     * @public
     */
    setTimeout(contextId: string, handler: TimerHandler, timeout?: number, ...args: any[]): number;
    /**
     * Creates an interval that will be tracked under the specified context.
     * @param contextId - The context identifier to group this timer under.
     * @param handler - The function to execute repeatedly.
     * @param timeout - The delay in milliseconds between executions (default: 0).
     * @param args - Additional arguments to pass to the handler.
     * @returns The interval ID that can be used with clearInterval.
     * @example
     * ```ts
     * const timers = new Timers()
     * const id = timers.setInterval('refresh', () => updateData(), 1000)
     * // Interval will be automatically cleared when 'refresh' context is disposed
     * ```
     * @public
     */
    setInterval(contextId: string, handler: TimerHandler, timeout?: number, ...args: any[]): number;
    /**
     * Requests an animation frame that will be tracked under the specified context.
     * @param contextId - The context identifier to group this animation frame under.
     * @param callback - The function to execute on the next animation frame.
     * @returns The request ID that can be used with cancelAnimationFrame.
     * @example
     * ```ts
     * const timers = new Timers()
     * const id = timers.requestAnimationFrame('render', () => draw())
     * // Animation frame will be automatically cancelled when 'render' context is disposed
     * ```
     * @public
     */
    requestAnimationFrame(contextId: string, callback: FrameRequestCallback): number;
    /**
     * Disposes of all timers associated with the specified context.
     * Clears all timeouts, intervals, and animation frames for the given context ID.
     * @param contextId - The context identifier whose timers should be cleared.
     * @returns void
     * @example
     * ```ts
     * const timers = new Timers()
     * timers.setTimeout('ui', () => console.log('timeout'), 1000)
     * timers.setInterval('ui', () => console.log('interval'), 500)
     *
     * // Clear all 'ui' context timers
     * timers.dispose('ui')
     * ```
     * @public
     */
    dispose(contextId: string): void;
    /**
     * Disposes of all timers across all contexts.
     * Clears every timeout, interval, and animation frame managed by this instance.
     * @returns void
     * @example
     * ```ts
     * const timers = new Timers()
     * timers.setTimeout('ui', () => console.log('ui'), 1000)
     * timers.setTimeout('background', () => console.log('bg'), 2000)
     *
     * // Clear everything
     * timers.disposeAll()
     * ```
     * @public
     */
    disposeAll(): void;
    /**
     * Returns an object with timer methods bound to a specific context.
     * Convenient for getting context-specific timer functions without repeatedly passing the contextId.
     * @param contextId - The context identifier to bind the returned methods to.
     * @returns An object with setTimeout, setInterval, requestAnimationFrame, and dispose methods bound to the context.
     * @example
     * ```ts
     * const timers = new Timers()
     * const uiTimers = timers.forContext('ui')
     *
     * // These are equivalent to calling timers.setTimeout('ui', ...)
     * uiTimers.setTimeout(() => console.log('timeout'), 1000)
     * uiTimers.setInterval(() => console.log('interval'), 500)
     * uiTimers.requestAnimationFrame(() => console.log('frame'))
     *
     * // Dispose only this context
     * uiTimers.dispose()
     * ```
     * @public
     */
    forContext(contextId: string): {
        setTimeout: (handler: TimerHandler, timeout?: number | undefined, ...args: any[]) => number;
        setInterval: (handler: TimerHandler, timeout?: number | undefined, ...args: any[]) => number;
        requestAnimationFrame: (callback: FrameRequestCallback) => number;
        dispose: () => void;
    };
}
//# sourceMappingURL=timers.d.ts.map