import { _Atom } from './Atom';
/**
 * Gets the current reaction epoch, which is used to track when reactions are running.
 * The reaction epoch is updated at the start of each reaction cycle.
 *
 * @returns The current reaction epoch number
 * @public
 */
export declare function getReactionEpoch(): number;
/**
 * Gets the current global epoch, which is incremented every time any atom changes.
 * This is used to track changes across the entire reactive system.
 *
 * @returns The current global epoch number
 * @public
 */
export declare function getGlobalEpoch(): number;
/**
 * Checks whether any reactions are currently executing.
 * When true, the system is in the middle of processing effects and side effects.
 *
 * @returns True if reactions are currently running, false otherwise
 * @public
 */
export declare function getIsReacting(): boolean;
/**
 * Handle a change to an atom.
 *
 * @param atom The atom that changed.
 * @param previousValue The atom's previous value.
 *
 * @internal
 */
export declare function atomDidChange(atom: _Atom, previousValue: any): void;
/**
 * Advances the global epoch counter by one.
 * This is used internally to track when changes occur across the reactive system.
 *
 * @internal
 */
export declare function advanceGlobalEpoch(): void;
/**
 * Batches state updates, deferring side effects until after the transaction completes.
 * Unlike {@link transact}, this function always creates a new transaction, allowing for nested transactions.
 *
 * @example
 * ```ts
 * const firstName = atom('firstName', 'John')
 * const lastName = atom('lastName', 'Doe')
 *
 * react('greet', () => {
 *   console.log(`Hello, ${firstName.get()} ${lastName.get()}!`)
 * })
 *
 * // Logs "Hello, John Doe!"
 *
 * transaction(() => {
 *  firstName.set('Jane')
 *  lastName.set('Smith')
 * })
 *
 * // Logs "Hello, Jane Smith!"
 * ```
 *
 * If the function throws, the transaction is aborted and any signals that were updated during the transaction revert to their state before the transaction began.
 *
 * @example
 * ```ts
 * const firstName = atom('firstName', 'John')
 * const lastName = atom('lastName', 'Doe')
 *
 * react('greet', () => {
 *   console.log(`Hello, ${firstName.get()} ${lastName.get()}!`)
 * })
 *
 * // Logs "Hello, John Doe!"
 *
 * transaction(() => {
 *  firstName.set('Jane')
 *  throw new Error('oops')
 * })
 *
 * // Does not log
 * // firstName.get() === 'John'
 * ```
 *
 * A `rollback` callback is passed into the function.
 * Calling this will prevent the transaction from committing and will revert any signals that were updated during the transaction to their state before the transaction began.
 *
 * @example
 * ```ts
 * const firstName = atom('firstName', 'John')
 * const lastName = atom('lastName', 'Doe')
 *
 * react('greet', () => {
 *   console.log(`Hello, ${firstName.get()} ${lastName.get()}!`)
 * })
 *
 * // Logs "Hello, John Doe!"
 *
 * transaction((rollback) => {
 *  firstName.set('Jane')
 *  lastName.set('Smith')
 *  rollback()
 * })
 *
 * // Does not log
 * // firstName.get() === 'John'
 * // lastName.get() === 'Doe'
 * ```
 *
 * @param fn - The function to run in a transaction, called with a function to roll back the change.
 * @returns The return value of the function
 * @public
 */
export declare function transaction<T>(fn: (rollback: () => void) => T): T;
/**
 * Like {@link transaction}, but does not create a new transaction if there is already one in progress.
 * This is the preferred way to batch state updates when you don't need the rollback functionality.
 *
 * @example
 * ```ts
 * const count = atom('count', 0)
 * const doubled = atom('doubled', 0)
 *
 * react('update doubled', () => {
 *   console.log(`Count: ${count.get()}, Doubled: ${doubled.get()}`)
 * })
 *
 * // This batches both updates into a single reaction
 * transact(() => {
 *   count.set(5)
 *   doubled.set(count.get() * 2)
 * })
 * // Logs: "Count: 5, Doubled: 10"
 * ```
 *
 * @param fn - The function to run in a transaction
 * @returns The return value of the function
 * @public
 */
export declare function transact<T>(fn: () => T): T;
/**
 * Defers the execution of asynchronous effects until they can be properly handled.
 * This function creates an asynchronous transaction context that batches state updates
 * across async operations while preventing conflicts with synchronous transactions.
 *
 * @example
 * ```ts
 * const data = atom('data', null)
 * const loading = atom('loading', false)
 *
 * await deferAsyncEffects(async () => {
 *   loading.set(true)
 *   const result = await fetch('/api/data')
 *   const json = await result.json()
 *   data.set(json)
 *   loading.set(false)
 * })
 * ```
 *
 * @param fn - The async function to execute within the deferred context
 * @returns A promise that resolves to the return value of the function
 * @throws Will throw if called during a synchronous transaction
 * @internal
 */
export declare function deferAsyncEffects<T>(fn: () => Promise<T>): Promise<T | undefined>;
//# sourceMappingURL=transactions.d.ts.map