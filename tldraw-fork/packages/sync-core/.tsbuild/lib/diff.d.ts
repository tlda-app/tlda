import { RecordsDiff, UnknownRecord } from '@tldraw/store';
/**
 * Constants representing the types of operations that can be applied to records in network diffs.
 * These operations describe how a record has been modified during synchronization.
 *
 * @internal
 */
export declare const RecordOpType: {
    readonly Put: "put";
    readonly Patch: "patch";
    readonly Remove: "remove";
};
/**
 * Union type of all possible record operation types.
 *
 * @internal
 */
export type RecordOpType = (typeof RecordOpType)[keyof typeof RecordOpType];
/**
 * Represents a single operation to be applied to a record during synchronization.
 *
 * @param R - The record type being operated on
 *
 * @internal
 */
export type RecordOp<R extends UnknownRecord> = [typeof RecordOpType.Put, R] | [typeof RecordOpType.Patch, ObjectDiff] | [typeof RecordOpType.Remove];
/**
 * A one-way (non-reversible) diff designed for small json footprint. These are mainly intended to
 * be sent over the wire. Either as push requests from the client to the server, or as patch
 * operations in the opposite direction.
 *
 * Each key in this object is the id of a record that has been added, updated, or removed.
 *
 * @internal
 */
export interface NetworkDiff<R extends UnknownRecord> {
    [id: string]: RecordOp<R>;
}
/**
 * Converts a (reversible, verbose) RecordsDiff into a (non-reversible, concise) NetworkDiff
 * suitable for transmission over the network. This function optimizes the diff representation
 * for minimal bandwidth usage while maintaining all necessary change information.
 *
 * @param diff - The RecordsDiff containing added, updated, and removed records
 * @returns A compact NetworkDiff for network transmission, or null if no changes exist
 *
 * @example
 * ```ts
 * const recordsDiff = {
 *   added: { 'shape:1': newShape },
 *   updated: { 'shape:2': [oldShape, updatedShape] },
 *   removed: { 'shape:3': removedShape }
 * }
 *
 * const networkDiff = getNetworkDiff(recordsDiff)
 * // Returns: {
 * //   'shape:1': ['put', newShape],
 * //   'shape:2': ['patch', { x: ['put', 100] }],
 * //   'shape:3': ['remove']
 * // }
 * ```
 *
 * @internal
 */
export declare function getNetworkDiff<R extends UnknownRecord>(diff: RecordsDiff<R>): NetworkDiff<R> | null;
/**
 * Constants representing the types of operations that can be applied to individual values
 * within object diffs. These operations describe how object properties have changed.
 *
 * @internal
 */
export declare const ValueOpType: {
    readonly Put: "put";
    readonly Delete: "delete";
    readonly Append: "append";
    readonly Patch: "patch";
};
/**
 * Union type of all possible value operation types.
 *
 * @internal
 */
export type ValueOpType = (typeof ValueOpType)[keyof typeof ValueOpType];
/**
 * Operation that replaces a value entirely with a new value.
 *
 * @internal
 */
export type PutOp = [type: typeof ValueOpType.Put, value: unknown];
/**
 * Operation that appends new values to the end of an array or string.
 *
 * @internal
 */
export type AppendOp = [type: typeof ValueOpType.Append, value: unknown[] | string, offset: number];
/**
 * Operation that applies a nested diff to an object or array.
 *
 * @internal
 */
export type PatchOp = [type: typeof ValueOpType.Patch, diff: ObjectDiff];
/**
 * Operation that removes a property from an object.
 *
 * @internal
 */
export type DeleteOp = [type: typeof ValueOpType.Delete];
/**
 * Union type representing any value operation that can be applied during diffing.
 *
 * @internal
 */
export type ValueOp = PutOp | AppendOp | PatchOp | DeleteOp;
/**
 * Represents the differences between two objects as a mapping of property names
 * to the operations needed to transform one object into another.
 *
 * @internal
 */
export interface ObjectDiff {
    [k: string]: ValueOp;
}
/**
 * Computes the difference between two record objects, generating an ObjectDiff
 * that describes how to transform the previous record into the next record.
 * This function is optimized for tldraw records and treats 'props' as a nested object.
 *
 * @param prev - The previous version of the record
 * @param next - The next version of the record
 * @param legacyAppendMode - If true, string append operations will be converted to Put operations
 * @returns An ObjectDiff describing the changes, or null if no changes exist
 *
 * @example
 * ```ts
 * const oldShape = { id: 'shape:1', x: 100, y: 200, props: { color: 'red' } }
 * const newShape = { id: 'shape:1', x: 150, y: 200, props: { color: 'blue' } }
 *
 * const diff = diffRecord(oldShape, newShape)
 * // Returns: {
 * //   x: ['put', 150],
 * //   props: ['patch', { color: ['put', 'blue'] }]
 * // }
 * ```
 *
 * @internal
 */
export declare function diffRecord(prev: object, next: object, legacyAppendMode?: boolean): ObjectDiff | null;
/**
 * Applies an ObjectDiff to an object, returning a new object with the changes applied.
 * This function handles all value operation types and creates a shallow copy when modifications
 * are needed. If no changes are required, the original object is returned.
 *
 * @param object - The object to apply the diff to
 * @param objectDiff - The ObjectDiff containing the operations to apply
 * @returns A new object with the diff applied, or the original object if no changes were needed
 *
 * @example
 * ```ts
 * const original = { x: 100, y: 200, props: { color: 'red' } }
 * const diff = {
 *   x: ['put', 150],
 *   props: ['patch', { color: ['put', 'blue'] }]
 * }
 *
 * const updated = applyObjectDiff(original, diff)
 * // Returns: { x: 150, y: 200, props: { color: 'blue' } }
 * ```
 *
 * @internal
 */
export declare function applyObjectDiff<T extends object>(object: T, objectDiff: ObjectDiff): T;
//# sourceMappingURL=diff.d.ts.map