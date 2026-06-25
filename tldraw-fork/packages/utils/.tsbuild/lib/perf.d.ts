/**
 * Color scheme for performance indicators.
 * Provides consistent colors for performance measurement displays.
 *
 * @public
 */
export declare const PERFORMANCE_COLORS: {
    Good: string;
    Mid: string;
    Poor: string;
};
/**
 * Default color for performance measurement log prefixes.
 * Uses the 'Good' performance color for console output styling.
 *
 * @public
 */
export declare const PERFORMANCE_PREFIX_COLOR: string;
/**
 * Measures and logs the execution time of a callback function.
 * Executes the provided callback and logs the duration to the console with styled output.
 *
 * @param name - Descriptive name for the operation being measured
 * @param cb - Callback function to execute and measure
 * @returns The return value of the callback function
 *
 * @example
 * ```ts
 * const result = measureCbDuration('data processing', () => {
 *   return processLargeDataSet(data)
 * })
 * // Console output: "Perf data processing took 42.5ms"
 * ```
 *
 * @internal
 */
export declare function measureCbDuration(name: string, cb: () => any): any;
/**
 * Decorator that measures and logs the execution time of class methods.
 * Wraps the decorated method to automatically log its execution duration.
 *
 * @param _target - The class prototype (unused)
 * @param propertyKey - Name of the method being decorated
 * @param descriptor - Property descriptor of the method
 * @returns Modified property descriptor with timing measurement
 *
 * @example
 * ```ts
 * class DataProcessor {
 *   @measureDuration
 *   processData(data: unknown[]) {
 *     return data.map(item => transform(item))
 *   }
 * }
 * // When processData is called, logs: "Perf processData took: 15.2ms"
 * ```
 *
 * @internal
 */
export declare function measureDuration(_target: any, propertyKey: string, descriptor: PropertyDescriptor): PropertyDescriptor;
/**
 * Decorator that measures method execution time and tracks running averages.
 * Wraps the decorated method to log both current execution time and running average.
 * Maintains a running total and count for each decorated method to calculate averages.
 *
 * @param _target - The class prototype (unused)
 * @param propertyKey - Name of the method being decorated
 * @param descriptor - Property descriptor of the method
 * @returns Modified property descriptor with timing measurement and averaging
 *
 * @example
 * ```ts
 * class RenderEngine {
 *   @measureAverageDuration
 *   renderFrame() {
 *     // Rendering logic here
 *   }
 * }
 * // After multiple calls, logs: "Perf renderFrame took 16.67ms | average 15.83ms"
 * ```
 *
 * @internal
 */
export declare function measureAverageDuration(_target: any, propertyKey: string, descriptor: PropertyDescriptor): PropertyDescriptor;
//# sourceMappingURL=perf.d.ts.map