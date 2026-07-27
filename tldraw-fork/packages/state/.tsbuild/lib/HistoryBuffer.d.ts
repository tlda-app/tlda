import { RESET_VALUE } from './types';
/**
 * A tuple representing a range of epochs and the associated diff.
 * Used internally by HistoryBuffer to store change information.
 *
 * @internal
 */
type RangeTuple<Diff> = [fromEpoch: number, toEpoch: number, diff: Diff];
/**
 * A circular buffer that stores diffs between sequential values of an atom or computed signal.
 * This enables efficient change tracking and history retrieval for features like undo/redo.
 *
 * The buffer uses a wrap-around strategy to maintain a fixed-size history of the most recent
 * changes, automatically overwriting older entries when the capacity is exceeded.
 *
 * @example
 * ```ts
 * const buffer = new HistoryBuffer<string>(5)
 * buffer.pushEntry(0, 1, 'first change')
 * buffer.pushEntry(1, 2, 'second change')
 * const changes = buffer.getChangesSince(0) // ['first change', 'second change']
 * ```
 *
 * @internal
 */
export declare class HistoryBuffer<Diff> {
    private readonly capacity;
    /**
     * Current write position in the circular buffer.
     * @internal
     */
    private index;
    /**
     * Circular buffer storing range tuples. Uses undefined to represent empty slots.
     * @internal
     */
    buffer: Array<RangeTuple<Diff> | undefined>;
    /**
     * Creates a new HistoryBuffer with the specified capacity.
     *
     * capacity - Maximum number of diffs to store in the buffer
     * @example
     * ```ts
     * const buffer = new HistoryBuffer<number>(10) // Store up to 10 diffs
     * ```
     */
    constructor(capacity: number);
    /**
     * Adds a diff entry to the history buffer, representing a change between two epochs.
     *
     * If the diff is undefined, the operation is ignored. If the diff is RESET_VALUE,
     * the entire buffer is cleared to indicate that historical tracking should restart.
     *
     * @param lastComputedEpoch - The epoch when the previous value was computed
     * @param currentEpoch - The epoch when the current value was computed
     * @param diff - The diff representing the change, or RESET_VALUE to clear history
     * @example
     * ```ts
     * const buffer = new HistoryBuffer<string>(5)
     * buffer.pushEntry(0, 1, 'added text')
     * buffer.pushEntry(1, 2, RESET_VALUE) // Clears the buffer
     * ```
     */
    pushEntry(lastComputedEpoch: number, currentEpoch: number, diff: Diff | RESET_VALUE): void;
    /**
     * Clears all entries from the history buffer and resets the write position.
     * This is called when a RESET_VALUE diff is encountered.
     *
     * @example
     * ```ts
     * const buffer = new HistoryBuffer<string>(5)
     * buffer.pushEntry(0, 1, 'change')
     * buffer.clear()
     * console.log(buffer.getChangesSince(0)) // RESET_VALUE
     * ```
     */
    clear(): void;
    /**
     * Retrieves all diffs that occurred since the specified epoch.
     *
     * The method searches backwards through the circular buffer to find changes
     * that occurred after the given epoch. If insufficient history is available
     * or the requested epoch is too old, returns RESET_VALUE indicating that
     * a complete state rebuild is required.
     *
     * @param sinceEpoch - The epoch from which to retrieve changes
     * @returns Array of diffs since the epoch, or RESET_VALUE if history is insufficient
     * @example
     * ```ts
     * const buffer = new HistoryBuffer<string>(5)
     * buffer.pushEntry(0, 1, 'first')
     * buffer.pushEntry(1, 2, 'second')
     * const changes = buffer.getChangesSince(0) // ['first', 'second']
     * const recentChanges = buffer.getChangesSince(1) // ['second']
     * const tooOld = buffer.getChangesSince(-100) // RESET_VALUE
     * ```
     */
    getChangesSince(sinceEpoch: number): RESET_VALUE | Diff[];
}
export {};
//# sourceMappingURL=HistoryBuffer.d.ts.map