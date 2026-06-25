import { RecordType, UnknownRecord } from '@tldraw/store';
import { ObjectDiff } from './diff';
/**
 * Validate a record and compute the diff between two states.
 * Returns null if the states are identical.
 *
 * @param prevState - The previous record state
 * @param newState - The new record state
 * @param recordType - The record type definition for validation
 * @param legacyAppendMode - If true, string append operations will be converted to Put operations
 * @returns Result containing the diff and new state, or null if no changes, or validation error
 *
 * @internal
 */
export declare function diffAndValidateRecord<R extends UnknownRecord>(prevState: R, newState: R, recordType: RecordType<R, any>, legacyAppendMode?: boolean): ObjectDiff | undefined;
/**
 * Apply a diff to a record state, validate the result, and compute the final diff.
 * Returns null if the diff produces no changes.
 *
 * @param prevState - The previous record state
 * @param diff - The object diff to apply
 * @param recordType - The record type definition for validation
 * @param legacyAppendMode - If true, string append operations will be converted to Put operations
 * @returns Result containing the final diff and new state, or null if no changes, or validation error
 *
 * @internal
 */
export declare function applyAndDiffRecord<R extends UnknownRecord>(prevState: R, diff: ObjectDiff, recordType: RecordType<R, any>, legacyAppendMode?: boolean): [ObjectDiff, R] | undefined;
/**
 * Validate a record without computing a diff. Used when creating new records.
 *
 * @param state - The record state to validate
 * @param recordType - The record type definition for validation
 * @returns Result indicating success or validation error
 *
 * @internal
 */
export declare function validateRecord<R extends UnknownRecord>(state: R, recordType: RecordType<R, any>): void;
//# sourceMappingURL=recordDiff.d.ts.map