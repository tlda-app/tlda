import type { PerformanceManager } from './PerformanceManager';
/**
 * Optional adapter that pipes PerformanceManager events into browser
 * `performance.mark()` / `performance.measure()` for DevTools integration.
 *
 * Tree-shakeable — only included if imported.
 *
 * @example
 * ```ts
 * const adapter = new PerformanceApiAdapter(editor.performance)
 * // ... later
 * adapter.dispose()
 * ```
 *
 * @public
 */
export declare class PerformanceApiAdapter {
    private cleanups;
    constructor(perfManager: PerformanceManager);
    /** Remove all listeners and stop piping events. @public */
    dispose(): void;
}
//# sourceMappingURL=PerformanceApiAdapter.d.ts.map