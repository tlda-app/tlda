import { Computed, ComputedOptions } from '@tldraw/state';
/**
 * Creates a new computed signal that automatically tracks its dependencies and recalculates when they change.
 * This overload is for basic computed values without custom options.
 *
 * @param name - A descriptive name for the computed signal, used for debugging and identification
 * @param compute - A function that computes the value, automatically tracking any signal dependencies
 * @param deps - React dependency array that controls when the computed signal is recreated
 * @returns A computed signal containing the calculated value
 *
 * @example
 * ```ts
 * const firstName = atom('firstName', 'John')
 * const lastName = atom('lastName', 'Doe')
 *
 * function UserProfile() {
 *   const fullName = useComputed(
 *     'fullName',
 *     () => `${firstName.get()} ${lastName.get()}`,
 *     [firstName, lastName]
 *   )
 *
 *   return <div>Welcome, {fullName.get()}!</div>
 * }
 * ```
 *
 * @public
 */
export declare function useComputed<Value>(name: string, compute: () => Value, deps: any[]): Computed<Value>;
/**
 * Creates a new computed signal with custom options for advanced behavior like custom equality checking,
 * diff computation, and history tracking. The computed signal will be created only once.
 *
 * @param name - A descriptive name for the computed signal, used for debugging and identification
 * @param compute - A function that computes the value, automatically tracking any signal dependencies
 * @param opts - Configuration options for the computed signal
 *   - isEqual - Custom equality function to determine if the computed value has changed
 *   - computeDiff - Function to compute diffs between old and new values for history tracking
 *   - historyLength - Maximum number of diffs to keep in history buffer for time-travel functionality
 * @param deps - React dependency array that controls when the computed signal is recreated
 * @returns A computed signal containing the calculated value with the specified options
 *
 * @example
 * ```ts
 * function ShoppingCart() {
 *   const items = useAtom('items', [])
 *
 *   // Computed with custom equality to avoid recalculation for equivalent arrays
 *   const sortedItems = useComputed(
 *     'sortedItems',
 *     () => items.get().sort((a, b) => a.name.localeCompare(b.name)),
 *     {
 *       isEqual: (a, b) => a.length === b.length && a.every((item, i) => item.id === b[i].id)
 *     },
 *     [items]
 *   )
 *
 *   return <ItemList items={sortedItems.get()} />
 * }
 * ```
 *
 * @public
 */
export declare function useComputed<Value, Diff = unknown>(name: string, compute: () => Value, opts: ComputedOptions<Value, Diff>, deps: any[]): Computed<Value>;
//# sourceMappingURL=useComputed.d.ts.map