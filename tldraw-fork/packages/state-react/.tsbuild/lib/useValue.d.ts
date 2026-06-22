import { Signal } from '@tldraw/state';
/**
 * Extracts the current value from a signal and subscribes the component to changes.
 *
 * This is the most straightforward way to read signal values in React components.
 * When the signal changes, the component will automatically re-render with the new value.
 *
 * Note: You do not need to use this hook if you are wrapping the component with {@link track},
 * as tracked components automatically subscribe to any signals accessed with `.get()`.
 *
 * @param value - The signal to read the value from
 * @returns The current value of the signal
 *
 * @example
 * ```ts
 * import { atom } from '@tldraw/state'
 * import { useValue } from '@tldraw/state-react'
 *
 * const count = atom('count', 0)
 *
 * function Counter() {
 *   const currentCount = useValue(count)
 *   return (
 *     <button onClick={() => count.set(currentCount + 1)}>
 *       Count: {currentCount}
 *     </button>
 *   )
 * }
 * ```
 *
 * @public
 */
export declare function useValue<Value>(value: Signal<Value>): Value;
/**
 * Creates a computed value with automatic dependency tracking and subscribes to changes.
 *
 * This overload allows you to compute a value from one or more signals with automatic
 * memoization. The computed function will only re-execute when its dependencies change,
 * and the component will only re-render when the computed result changes.
 *
 * @param name - A descriptive name for debugging purposes
 * @param fn - Function that computes the value, should call `.get()` on any signals it depends on
 * @param deps - Array of signals that the computed function depends on
 * @returns The computed value
 *
 * @example
 * ```ts
 * import { atom } from '@tldraw/state'
 * import { useValue } from '@tldraw/state-react'
 *
 * const firstName = atom('firstName', 'John')
 * const lastName = atom('lastName', 'Doe')
 *
 * function UserGreeting() {
 *   const fullName = useValue('fullName', () => {
 *     return `${firstName.get()} ${lastName.get()}`
 *   }, [firstName, lastName])
 *
 *   return <div>Hello {fullName}!</div>
 * }
 * ```
 *
 * @public
 */
export declare function useValue<Value>(name: string, fn: () => Value, deps: unknown[]): Value;
//# sourceMappingURL=useValue.d.ts.map