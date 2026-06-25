import type { Child, Signal } from './types';
/**
 * Executes the given function without capturing any parents in the current capture context.
 *
 * This is mainly useful if you want to run an effect only when certain signals change while also
 * dereferencing other signals which should not cause the effect to rerun on their own.
 *
 * @example
 * ```ts
 * const name = atom('name', 'Sam')
 * const time = atom('time', () => new Date().getTime())
 *
 * setInterval(() => {
 *   time.set(new Date().getTime())
 * })
 *
 * react('log name changes', () => {
 * 	 print(name.get(), 'was changed at', unsafe__withoutCapture(() => time.get()))
 * })
 *
 * ```
 *
 * @public
 */
export declare function unsafe__withoutCapture<T>(fn: () => T): T;
/**
 * Begins capturing parent signal dependencies for the given child signal.
 *
 * This function initiates a capture session where any signal accessed via `.get()`
 * will be automatically registered as a dependency of the child signal. It sets up
 * the capture stack frame and clears the existing parent set to prepare for fresh
 * dependency tracking.
 *
 * @param child - The child signal (computed or effect) that will capture dependencies
 *
 * @example
 * ```ts
 * const effect = createEffect('myEffect', () => { /* ... *\/ })
 * startCapturingParents(effect)
 * // Now any signal.get() calls will be captured as dependencies
 * ```
 *
 * @internal
 */
export declare function startCapturingParents(child: Child): void;
/**
 * Completes the parent dependency capture session and finalizes the dependency graph.
 *
 * This function cleans up the capture session by removing dependencies that are no
 * longer needed, detaching signals that should no longer be parents, and updating
 * the dependency arrays to reflect the current set of captured parents. It must be
 * called after `startCapturingParents` to complete the capture cycle.
 *
 * @example
 * ```ts
 * startCapturingParents(effect)
 * // ... signal.get() calls happen here ...
 * stopCapturingParents() // Finalizes the dependency graph
 * ```
 *
 * @internal
 */
export declare function stopCapturingParents(): void;
/**
 * Conditionally captures a signal as a parent dependency during an active capture session.
 *
 * This function is called whenever a signal's `.get()` method is invoked during a
 * capture session. It checks if the signal should be added as a dependency and manages
 * the parent-child relationship in the reactive graph. The function handles deduplication,
 * attachment/detachment, and tracks changes in dependency order.
 *
 * Note: This must be called after the parent signal is up to date.
 *
 * @param p - The signal that might be captured as a parent dependency
 *
 * @example
 * ```ts
 * // This is called internally when you do:
 * const value = someAtom.get() // maybeCaptureParent(someAtom) is called
 * ```
 *
 * @internal
 */
export declare function maybeCaptureParent(p: Signal<any, any>): void;
/**
 * A debugging tool that tells you why a computed signal or effect is running.
 * Call in the body of a computed signal or effect function.
 *
 * @example
 * ```ts
 * const name = atom('name', 'Bob')
 * react('greeting', () => {
 * 	whyAmIRunning()
 *	print('Hello', name.get())
 * })
 *
 * name.set('Alice')
 *
 * // 'greeting' is running because:
 * //     'name' changed => 'Alice'
 * ```
 *
 * @public
 */
export declare function whyAmIRunning(): void;
//# sourceMappingURL=capture.d.ts.map