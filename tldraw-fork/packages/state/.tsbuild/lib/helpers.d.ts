import { Child, Signal } from './types';
/**
 * Checks if any of a child's parent signals have changed by comparing their current epochs
 * with the child's cached view of those epochs.
 *
 * This function is used internally to determine if a computed signal or effect needs to
 * be re-evaluated because one of its dependencies has changed.
 *
 * @param child - The child (computed signal or effect) to check for parent changes
 * @returns `true` if any parent signal has changed since the child last observed it, `false` otherwise
 * @example
 * ```ts
 * const childSignal = computed('child', () => parentAtom.get())
 * // Check if the child needs to recompute
 * if (haveParentsChanged(childSignal)) {
 *   // Recompute the child's value
 * }
 * ```
 * @internal
 */
export declare function haveParentsChanged(child: Child): boolean;
/**
 * Detaches a child signal from its parent signal, removing the parent-child relationship
 * in the reactive dependency graph. If the parent has no remaining children and is itself
 * a child, it will recursively detach from its own parents.
 *
 * This function is used internally to clean up the dependency graph when signals are no
 * longer needed or when dependencies change.
 *
 * @param parent - The parent signal to detach from
 * @param child - The child signal to detach
 * @example
 * ```ts
 * // When a computed signal's dependencies change
 * const oldParent = atom('old', 1)
 * const child = computed('child', () => oldParent.get())
 * // Later, detach the child from the old parent
 * detach(oldParent, child)
 * ```
 * @internal
 */
export declare function detach(parent: Signal<any>, child: Child): void;
/**
 * Attaches a child signal to its parent signal, establishing a parent-child relationship
 * in the reactive dependency graph. If the parent is itself a child, it will recursively
 * attach to its own parents to maintain the dependency chain.
 *
 * This function is used internally when dependencies are captured during computed signal
 * evaluation or effect execution.
 *
 * @param parent - The parent signal to attach to
 * @param child - The child signal to attach
 * @example
 * ```ts
 * // When a computed signal captures a new dependency
 * const parentAtom = atom('parent', 1)
 * const child = computed('child', () => parentAtom.get())
 * // Internally, attach is called to establish the dependency
 * attach(parentAtom, child)
 * ```
 * @internal
 */
export declare function attach(parent: Signal<any>, child: Child): void;
/**
 * Checks if two values are equal using the equality semantics of @tldraw/state.
 *
 * This function performs equality checks in the following order:
 * 1. Reference equality (`===`)
 * 2. `Object.is()` equality (handles NaN and -0/+0 cases)
 * 3. Custom `.equals()` method when the left-hand value provides one
 *
 * This is used internally to determine if a signal's value has actually changed
 * when setting new values, preventing unnecessary updates and re-computations.
 *
 * @param a - The first value to compare
 * @param b - The second value to compare
 * @returns `true` if the values are considered equal, `false` otherwise
 * @example
 * ```ts
 * equals(1, 1) // true
 * equals(NaN, NaN) // true (unlike === which returns false)
 * equals({ equals: (other: any) => other.id === 1 }, { id: 1 }) // Uses custom equals method
 * ```
 * @internal
 */
export declare function equals(a: any, b: any): boolean;
/**
 * A TypeScript utility function for exhaustiveness checking in switch statements and
 * conditional branches. This function should never be called at runtime—it exists
 * purely for compile-time type checking and is `undefined` in emitted JavaScript.
 *
 * @param x - A value that should be of type `never`
 * @throws Always at runtime because the identifier is undefined
 * @example
 * ```ts
 * type Color = 'red' | 'blue'
 *
 * function handleColor(color: Color) {
 *   switch (color) {
 *     case 'red':
 *       return 'Stop'
 *     case 'blue':
 *       return 'Go'
 *     default:
 *       return assertNever(color) // TypeScript error if not all cases handled
 *   }
 * }
 * ```
 * @public
 */
export declare function assertNever(x: never): never;
/**
 * Creates or retrieves a singleton instance using a global symbol registry.
 * This ensures that the same instance is shared across all code that uses
 * the same key, even across different module boundaries.
 *
 * The singleton is stored on `globalThis` using a symbol created with
 * `Symbol.for()`, which ensures global uniqueness across realms.
 *
 * @param key - A unique string identifier for the singleton
 * @param init - A function that creates the initial value if it doesn't exist
 * @returns The singleton instance
 * @example
 * ```ts
 * // Create a singleton logger
 * const logger = singleton('logger', () => new Logger())
 *
 * // Elsewhere in the codebase, get the same logger instance
 * const sameLogger = singleton('logger', () => new Logger())
 * // logger === sameLogger
 * ```
 * @internal
 */
export declare function singleton<T>(key: string, init: () => T): T;
/**
 * @public
 */
export declare const EMPTY_ARRAY: [];
/**
 * Checks if a signal has any active reactors (effects or computed signals) that are
 * currently listening to it. This determines whether changes to the signal will
 * cause any side effects or recomputations to occur.
 *
 * A signal is considered to have active reactors if any of its child dependencies
 * are actively listening for changes.
 *
 * @param signal - The signal to check for active reactors
 * @returns `true` if the signal has active reactors, `false` otherwise
 * @example
 * ```ts
 * const count = atom('count', 0)
 *
 * console.log(hasReactors(count)) // false - no effects listening
 *
 * const stop = react('logger', () => console.log(count.get()))
 * console.log(hasReactors(count)) // true - effect is listening
 *
 * stop()
 * console.log(hasReactors(count)) // false - effect stopped
 * ```
 * @public
 */
export declare function hasReactors(signal: Signal<any>): boolean;
//# sourceMappingURL=helpers.d.ts.map