import { ArraySet } from './ArraySet';
import { Signal } from './types';
/** @public */
export interface EffectSchedulerOptions {
    /**
     * scheduleEffect is a function that will be called when the effect is scheduled.
     *
     * It can be used to defer running effects until a later time, for example to batch them together with requestAnimationFrame.
     *
     *
     * @example
     * ```ts
     * let isRafScheduled = false
     * const scheduledEffects: Array<() => void> = []
     * const scheduleEffect = (runEffect: () => void) => {
     * 	scheduledEffects.push(runEffect)
     * 	if (!isRafScheduled) {
     * 		isRafScheduled = true
     * 		requestAnimationFrame(() => {
     * 			isRafScheduled = false
     * 			scheduledEffects.forEach((runEffect) => runEffect())
     * 			scheduledEffects.length = 0
     * 		})
     * 	}
     * }
     * const stop = react('set page title', () => {
     * 	document.title = doc.title,
     * }, scheduleEffect)
     * ```
     *
     * @param execute - A function that will execute the effect.
     * @returns void
     */
    scheduleEffect?: (execute: () => void) => void;
}
/**
 * An EffectScheduler is responsible for executing side effects in response to changes in state.
 *
 * You probably don't need to use this directly unless you're integrating this library with a framework of some kind.
 *
 * Instead, use the {@link react} and {@link reactor} functions.
 *
 * @example
 * ```ts
 * const render = new EffectScheduler('render', drawToCanvas)
 *
 * render.attach()
 * render.execute()
 * ```
 *
 * @public
 */
export declare const EffectScheduler: new <Result>(name: string, runEffect: (lastReactedEpoch: number) => Result, options?: EffectSchedulerOptions | undefined) => EffectScheduler<Result>;
/** @public */
export interface EffectScheduler<Result> {
    /**
     * Whether this scheduler is attached and actively listening to its parents.
     * @public
     */
    readonly isActivelyListening: boolean;
    /** @internal */
    readonly lastTraversedEpoch: number;
    /** @public */
    readonly name: string;
    /** @internal */
    __debug_ancestor_epochs__: Map<Signal<any, any>, number> | null;
    /**
     * The number of times this effect has been scheduled.
     * @public
     */
    readonly scheduleCount: number;
    /** @internal */
    readonly parentSet: ArraySet<Signal<any, any>>;
    /** @internal */
    readonly parentEpochs: number[];
    /** @internal */
    readonly parents: Signal<any, any>[];
    /** @internal */
    maybeScheduleEffect(): void;
    /** @internal */
    scheduleEffect(): void;
    /** @internal */
    maybeExecute(): void;
    /**
     * Makes this scheduler become 'actively listening' to its parents.
     * If it has been executed before it will immediately become eligible to receive 'maybeScheduleEffect' calls.
     * If it has not executed before it will need to be manually executed once to become eligible for scheduling, i.e. by calling `EffectScheduler.execute`.
     * @public
     */
    attach(): void;
    /**
     * Makes this scheduler stop 'actively listening' to its parents.
     * It will no longer be eligible to receive 'maybeScheduleEffect' calls until `EffectScheduler.attach` is called again.
     * @public
     */
    detach(): void;
    /**
     * Executes the effect immediately and returns the result.
     * @returns The result of the effect.
     * @public
     */
    execute(): Result;
}
/**
 * Starts a new effect scheduler, scheduling the effect immediately.
 *
 * Returns a function that can be called to stop the scheduler.
 *
 * @example
 * ```ts
 * const color = atom('color', 'red')
 * const stop = react('set style', () => {
 *   divElem.style.color = color.get()
 * })
 * color.set('blue')
 * // divElem.style.color === 'blue'
 * stop()
 * color.set('green')
 * // divElem.style.color === 'blue'
 * ```
 *
 *
 * Also useful in React applications for running effects outside of the render cycle.
 *
 * @example
 * ```ts
 * useEffect(() => react('set style', () => {
 *   divRef.current.style.color = color.get()
 * }), [])
 * ```
 *
 * @public
 */
export declare function react(name: string, fn: (lastReactedEpoch: number) => any, options?: EffectSchedulerOptions): () => void;
/**
 * The reactor is a user-friendly interface for starting and stopping an `EffectScheduler`.
 *
 * Calling `.start()` will attach the scheduler and execute the effect immediately the first time it is called.
 *
 * If the reactor is stopped, calling `.start()` will re-attach the scheduler but will only execute the effect if any of its parents have changed since it was stopped.
 *
 * You can create a reactor with {@link reactor}.
 * @public
 */
export interface Reactor<T = unknown> {
    /**
     * The underlying effect scheduler.
     * @public
     */
    scheduler: EffectScheduler<T>;
    /**
     * Start the scheduler. The first time this is called the effect will be scheduled immediately.
     *
     * If the reactor is stopped, calling this will start the scheduler again but will only execute the effect if any of its parents have changed since it was stopped.
     *
     * If you need to force re-execution of the effect, pass `{ force: true }`.
     * @public
     */
    start(options?: {
        force?: boolean;
    }): void;
    /**
     * Stop the scheduler.
     * @public
     */
    stop(): void;
}
/**
 * Creates a {@link Reactor}, which is a thin wrapper around an `EffectScheduler`.
 *
 * @public
 */
export declare function reactor<Result>(name: string, fn: (lastReactedEpoch: number) => Result, options?: EffectSchedulerOptions): Reactor<Result>;
//# sourceMappingURL=EffectScheduler.d.ts.map