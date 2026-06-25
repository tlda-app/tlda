import { ArraySet } from './ArraySet';
import { HistoryBuffer } from './HistoryBuffer';
import { Child, ComputeDiff, RESET_VALUE, Signal } from './types';
/**
 * A special symbol used to indicate that a computed signal has not been initialized yet.
 * This is passed as the `previousValue` parameter to a computed signal function on its first run.
 *
 * @example
 * ```ts
 * const count = atom('count', 0)
 * const double = computed('double', (prevValue) => {
 *   if (isUninitialized(prevValue)) {
 *     console.log('First computation!')
 *   }
 *   return count.get() * 2
 * })
 * ```
 *
 * @public
 */
export declare const UNINITIALIZED: unique symbol;
/**
 * The type of the first value passed to a computed signal function as the 'prevValue' parameter.
 * This type represents the uninitialized state of a computed signal before its first calculation.
 *
 * @see {@link isUninitialized}
 * @public
 */
export type UNINITIALIZED = typeof UNINITIALIZED;
/**
 * Call this inside a computed signal function to determine whether it is the first time the function is being called.
 *
 * Mainly useful for incremental signal computation.
 *
 * @example
 * ```ts
 * const count = atom('count', 0)
 * const double = computed('double', (prevValue) => {
 *   if (isUninitialized(prevValue)) {
 *     print('First time!')
 *   }
 *   return count.get() * 2
 * })
 * ```
 *
 * @param value - The value to check.
 * @public
 */
export declare function isUninitialized(value: any): value is UNINITIALIZED;
/**
 * A singleton class used to wrap computed signal values along with their diffs.
 * This class is used internally by the {@link withDiff} function to provide both
 * the computed value and its diff to the signal system.
 *
 * @example
 * ```ts
 * const count = atom('count', 0)
 * const double = computed('double', (prevValue) => {
 *   const nextValue = count.get() * 2
 *   if (isUninitialized(prevValue)) {
 *     return nextValue
 *   }
 *   return withDiff(nextValue, nextValue - prevValue)
 * })
 * ```
 *
 * @public
 */
export declare const WithDiff: {
    new <Value, Diff>(value: Value, diff: Diff): {
        value: Value;
        diff: Diff;
    };
};
/**
 * Interface representing a value wrapped with its corresponding diff.
 * Used in incremental computation to provide both the new value and the diff from the previous value.
 *
 * @public
 */
export interface WithDiff<Value, Diff> {
    /**
     * The computed value.
     */
    value: Value;
    /**
     * The diff between the previous and current value.
     */
    diff: Diff;
}
/**
 * When writing incrementally-computed signals it is convenient (and usually more performant) to incrementally compute the diff too.
 *
 * You can use this function to wrap the return value of a computed signal function to indicate that the diff should be used instead of calculating a new one with {@link AtomOptions.computeDiff}.
 *
 * @example
 * ```ts
 * const count = atom('count', 0)
 * const double = computed('double', (prevValue) => {
 *   const nextValue = count.get() * 2
 *   if (isUninitialized(prevValue)) {
 *     return nextValue
 *   }
 *   return withDiff(nextValue, nextValue - prevValue)
 * }, { historyLength: 10 })
 * ```
 *
 *
 * @param value - The value.
 * @param diff - The diff.
 * @public
 */
export declare function withDiff<Value, Diff>(value: Value, diff: Diff): WithDiff<Value, Diff>;
/**
 * Options for configuring computed signals. Used when calling `computed` or using the `@computed` decorator.
 *
 * @example
 * ```ts
 * const greeting = computed('greeting', () => `Hello ${name.get()}!`, {
 *   historyLength: 10,
 *   isEqual: (a, b) => a === b,
 *   computeDiff: (oldVal, newVal) => ({ type: 'change', from: oldVal, to: newVal })
 * })
 * ```
 *
 * @public
 */
export interface ComputedOptions<Value, Diff> {
    /**
     * The maximum number of diffs to keep in the history buffer.
     *
     * If you don't need to compute diffs, or if you will supply diffs manually via {@link Atom.set}, you can leave this as `undefined` and no history buffer will be created.
     *
     * If you expect the value to be part of an active effect subscription all the time, and to not change multiple times inside of a single transaction, you can set this to a relatively low number (e.g. 10).
     *
     * Otherwise, set this to a higher number based on your usage pattern and memory constraints.
     *
     */
    historyLength?: number;
    /**
     * A method used to compute a diff between the computed's old and new values. If provided, it will not be used unless you also specify {@link ComputedOptions.historyLength}.
     */
    computeDiff?: ComputeDiff<Value, Diff>;
    /**
     * If provided, this will be used to compare the old and new values of the computed to determine if the value has changed.
     * By default, values are compared using first using strict equality (`===`), then `Object.is`, and finally any `.equals` method present in the object's prototype chain.
     * @param a - The old value
     * @param b - The new value
     * @returns True if the values are equal, false otherwise.
     */
    isEqual?(a: any, b: any): boolean;
}
/**
 * A computed signal created via the `computed` function or `@computed` decorator.
 * Computed signals derive their values from other signals and automatically update when their dependencies change.
 * They use lazy evaluation, only recalculating when accessed and dependencies have changed.
 *
 * @example
 * ```ts
 * const firstName = atom('firstName', 'John')
 * const lastName = atom('lastName', 'Doe')
 * const fullName = computed('fullName', () => `${firstName.get()} ${lastName.get()}`)
 *
 * console.log(fullName.get()) // "John Doe"
 * firstName.set('Jane')
 * console.log(fullName.get()) // "Jane Doe"
 * ```
 *
 * @public
 */
export interface Computed<Value, Diff = unknown> extends Signal<Value, Diff> {
    /**
     * Whether this computed signal is involved in an actively-running effect graph.
     * Returns true if there are any reactions or other computed signals depending on this one.
     * @public
     */
    readonly isActivelyListening: boolean;
    /** @internal */
    readonly parentSet: ArraySet<Signal<any, any>>;
    /** @internal */
    readonly parents: Signal<any, any>[];
    /** @internal */
    readonly parentEpochs: number[];
}
/**
 * @internal
 */
declare class __UNSAFE__Computed<Value, Diff = unknown> implements Computed<Value, Diff> {
    /**
     * The name of the signal. This is used for debugging and performance profiling purposes. It does not need to be globally unique.
     */
    readonly name: string;
    /**
     * The function that computes the value of the signal.
     */
    private readonly derive;
    readonly __isComputed: true;
    lastChangedEpoch: number;
    lastTraversedEpoch: number;
    __debug_ancestor_epochs__: Map<Signal<any, any>, number> | null;
    /**
     * The epoch when the reactor was last checked.
     */
    private lastCheckedEpoch;
    parentSet: ArraySet<Signal<any, any>>;
    parents: Signal<any, any>[];
    parentEpochs: number[];
    children: ArraySet<Child>;
    get isActivelyListening(): boolean;
    historyBuffer?: HistoryBuffer<Diff>;
    private state;
    private error;
    private computeDiff?;
    private readonly isEqual;
    constructor(
    /**
     * The name of the signal. This is used for debugging and performance profiling purposes. It does not need to be globally unique.
     */
    name: string, 
    /**
     * The function that computes the value of the signal.
     */
    derive: (previousValue: Value | UNINITIALIZED, lastComputedEpoch: number) => Value | WithDiff<Value, Diff>, options?: ComputedOptions<Value, Diff>);
    __unsafe__getWithoutCapture(ignoreErrors?: boolean): Value;
    get(): Value;
    getDiffSince(epoch: number): RESET_VALUE | Diff[];
}
/**
 * Singleton reference to the computed signal implementation class.
 * Used internally by the library to create computed signal instances.
 *
 * @internal
 */
export declare const _Computed: typeof __UNSAFE__Computed;
/**
 * Type alias for the computed signal implementation class.
 *
 * @internal
 */
export type _Computed = InstanceType<typeof __UNSAFE__Computed>;
/**
 * Retrieves the underlying computed instance for a given property created with the `computed`
 * decorator.
 *
 * @example
 * ```ts
 * class Counter {
 *   max = 100
 *   count = atom(0)
 *
 *   @computed getRemaining() {
 *     return this.max - this.count.get()
 *   }
 * }
 *
 * const c = new Counter()
 * const remaining = getComputedInstance(c, 'getRemaining')
 * remaining.get() === 100 // true
 * c.count.set(13)
 * remaining.get() === 87 // true
 * ```
 *
 * @param obj - The object
 * @param propertyName - The property name
 * @public
 */
export declare function getComputedInstance<Obj extends object, Prop extends keyof Obj>(obj: Obj, propertyName: Prop): Computed<Obj[Prop]>;
/**
 * Creates a computed signal that derives its value from other signals.
 * Computed signals automatically update when their dependencies change and use lazy evaluation
 * for optimal performance.
 *
 * @example
 * ```ts
 * const name = atom('name', 'John')
 * const greeting = computed('greeting', () => `Hello ${name.get()}!`)
 * console.log(greeting.get()) // 'Hello John!'
 * ```
 *
 * `computed` may also be used as a decorator for creating computed getter methods.
 *
 * @example
 * ```ts
 * class Counter {
 *   max = 100
 *   count = atom<number>(0)
 *
 *   @computed getRemaining() {
 *     return this.max - this.count.get()
 *   }
 * }
 * ```
 *
 * You may optionally pass in a {@link ComputedOptions} when used as a decorator:
 *
 * @example
 * ```ts
 * class Counter {
 *   max = 100
 *   count = atom<number>(0)
 *
 *   @computed({isEqual: (a, b) => a === b})
 *   getRemaining() {
 *     return this.max - this.count.get()
 *   }
 * }
 * ```
 *
 * @param name - The name of the signal for debugging purposes
 * @param compute - The function that computes the value of the signal. Receives the previous value and last computed epoch
 * @param options - Optional configuration for the computed signal
 * @returns A new computed signal
 * @public
 */
export declare function computed<Value, Diff = unknown>(name: string, compute: (previousValue: Value | typeof UNINITIALIZED, lastComputedEpoch: number) => Value | WithDiff<Value, Diff>, options?: ComputedOptions<Value, Diff>): Computed<Value, Diff>;
/**
 * TC39 decorator for creating computed methods in classes.
 *
 * @example
 * ```ts
 * class MyClass {
 *   value = atom('value', 10)
 *
 *   @computed
 *   doubled() {
 *     return this.value.get() * 2
 *   }
 * }
 * ```
 *
 * @param compute - The method to be decorated
 * @param context - The decorator context provided by TypeScript
 * @returns The decorated method
 * @public
 */
export declare function computed<This extends object, Value>(compute: () => Value, context: ClassMethodDecoratorContext<This, () => Value>): () => Value;
/**
 * Legacy TypeScript decorator for creating computed methods in classes.
 *
 * @example
 * ```ts
 * class MyClass {
 *   value = atom('value', 10)
 *
 *   @computed
 *   doubled() {
 *     return this.value.get() * 2
 *   }
 * }
 * ```
 *
 * @param target - The class prototype
 * @param key - The property key
 * @param descriptor - The property descriptor
 * @returns The modified property descriptor
 * @public
 */
export declare function computed(target: any, key: string, descriptor: PropertyDescriptor): PropertyDescriptor;
/**
 * Decorator factory for creating computed methods with options.
 *
 * @example
 * ```ts
 * class MyClass {
 *   items = atom('items', [1, 2, 3])
 *
 *   @computed({ historyLength: 10 })
 *   sum() {
 *     return this.items.get().reduce((a, b) => a + b, 0)
 *   }
 * }
 * ```
 *
 * @param options - Configuration options for the computed signal
 * @returns A decorator function that can be applied to methods
 * @public
 */
export declare function computed<Value, Diff = unknown>(options?: ComputedOptions<Value, Diff>): ((target: any, key: string, descriptor: PropertyDescriptor) => PropertyDescriptor) & (<This>(compute: () => Value, context: ClassMethodDecoratorContext<This, () => Value>) => () => Value);
/**
 * Returns true if the given value is a computed signal.
 * @public
 */
export declare function isComputed(value: any): value is Computed<any>;
export {};
//# sourceMappingURL=Computed.d.ts.map