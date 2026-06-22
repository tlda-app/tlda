import { UnknownRecord } from './BaseRecord';
import { SerializedStore } from './Store';
import { SerializedSchema } from './StoreSchema';
/**
 * Creates a migration sequence that defines how to transform data as your schema evolves.
 *
 * A migration sequence contains a series of migrations that are applied in order to transform
 * data from older versions to newer versions. Each migration is identified by a unique ID
 * and can operate at either the record level (transforming individual records) or store level
 * (transforming the entire store structure).
 *
 * See the [migration guide](https://tldraw.dev/docs/persistence#Migrations) for more info on how to use this API.
 * @param options - Configuration for the migration sequence
 *   - sequenceId - Unique identifier for this migration sequence (e.g., 'com.myapp.book')
 *   - sequence - Array of migrations or dependency declarations to include in the sequence
 *   - retroactive - Whether migrations should apply to snapshots created before this sequence was added (defaults to true)
 * @returns A validated migration sequence that can be included in a store schema
 * @example
 * ```ts
 * const bookMigrations = createMigrationSequence({
 *   sequenceId: 'com.myapp.book',
 *   sequence: [
 *     {
 *       id: 'com.myapp.book/1',
 *       scope: 'record',
 *       up: (record) => ({ ...record, newField: 'default' })
 *     }
 *   ]
 * })
 * ```
 * @public
 */
export declare function createMigrationSequence({ sequence, sequenceId, retroactive }: {
    sequenceId: string;
    retroactive?: boolean;
    sequence: Array<Migration | StandaloneDependsOn>;
}): MigrationSequence;
/**
 * Creates a named set of migration IDs from version numbers and a sequence ID.
 *
 * This utility function helps generate properly formatted migration IDs that follow
 * the required `sequenceId/version` pattern. It takes a sequence ID and a record
 * of named versions, returning migration IDs that can be used in migration definitions.
 *
 * See the [migration guide](https://tldraw.dev/docs/persistence#Migrations) for more info on how to use this API.
 * @param sequenceId - The sequence identifier (e.g., 'com.myapp.book')
 * @param versions - Record mapping version names to numbers
 * @returns Record mapping version names to properly formatted migration IDs
 * @example
 * ```ts
 * const migrationIds = createMigrationIds('com.myapp.book', {
 *   addGenre: 1,
 *   addPublisher: 2,
 *   removeOldField: 3
 * })
 * // Result: {
 * //   addGenre: 'com.myapp.book/1',
 * //   addPublisher: 'com.myapp.book/2',
 * //   removeOldField: 'com.myapp.book/3'
 * // }
 * ```
 * @public
 */
export declare function createMigrationIds<const ID extends string, const Versions extends Record<string, number>>(sequenceId: ID, versions: Versions): {
    [K in keyof Versions]: `${ID}/${Versions[K]}`;
};
/**
 * Creates a migration sequence specifically for record-level migrations.
 *
 * This is a convenience function that creates a migration sequence where all migrations
 * operate at the record scope and are automatically filtered to apply only to records
 * of a specific type. Each migration in the sequence will be enhanced with the record
 * scope and appropriate filtering logic.
 * @param opts - Configuration for the record migration sequence
 *   - recordType - The record type name these migrations should apply to
 *   - filter - Optional additional filter function to determine which records to migrate
 *   - retroactive - Whether migrations should apply to snapshots created before this sequence was added
 *   - sequenceId - Unique identifier for this migration sequence
 *   - sequence - Array of record migration definitions (scope will be added automatically)
 * @returns A migration sequence configured for record-level operations
 * @internal
 */
export declare function createRecordMigrationSequence(opts: {
    recordType: string;
    filter?(record: UnknownRecord): boolean;
    retroactive?: boolean;
    sequenceId: string;
    sequence: Omit<Extract<Migration, {
        scope: 'record';
    }>, 'scope'>[];
}): MigrationSequence;
/**
 * Legacy migration interface for backward compatibility.
 *
 * This interface represents the old migration format that included both `up` and `down`
 * transformation functions. While still supported, new code should use the `Migration`
 * type which provides more flexibility and better integration with the current system.
 * @public
 */
export interface LegacyMigration<Before = any, After = any> {
    up: (oldState: Before) => After;
    down: (newState: After) => Before;
}
/**
 * Unique identifier for a migration in the format `sequenceId/version`.
 *
 * Migration IDs follow a specific pattern where the sequence ID identifies the migration
 * sequence and the version number indicates the order within that sequence. For example:
 * 'com.myapp.book/1', 'com.myapp.book/2', etc.
 * @public
 */
export type MigrationId = `${string}/${number}`;
/**
 * Declares dependencies for migrations without being a migration itself.
 *
 * This interface allows you to specify that future migrations in a sequence depend on
 * migrations from other sequences, without defining an actual migration transformation.
 * It's used to establish cross-sequence dependencies in the migration graph.
 * @public
 */
export interface StandaloneDependsOn {
    readonly dependsOn: readonly MigrationId[];
}
/**
 * Defines a single migration that transforms data from one schema version to another.
 *
 * A migration can operate at two different scopes:
 * - `record`: Transforms individual records, with optional filtering to target specific records
 * - `store`: Transforms the entire serialized store structure
 *
 * Each migration has a unique ID and can declare dependencies on other migrations that must
 * be applied first. The `up` function performs the forward transformation, while the optional
 * `down` function can reverse the migration if needed.
 * @public
 */
export type Migration = {
    readonly id: MigrationId;
    readonly dependsOn?: readonly MigrationId[] | undefined;
} & ({
    readonly scope: 'record';
    readonly filter?: (record: UnknownRecord) => boolean;
    readonly up: (oldState: UnknownRecord) => void | UnknownRecord;
    readonly down?: (newState: UnknownRecord) => void | UnknownRecord;
} | {
    readonly scope: 'store';
    readonly up: (oldState: SerializedStore<UnknownRecord>) => void | SerializedStore<UnknownRecord>;
    readonly down?: (newState: SerializedStore<UnknownRecord>) => void | SerializedStore<UnknownRecord>;
} | {
    readonly scope: 'storage';
    readonly up: (storage: SynchronousRecordStorage<UnknownRecord>) => void;
    readonly down?: never;
});
/**
 * Abstraction over the store that can be used to perform migrations.
 * @public
 */
export interface SynchronousRecordStorage<R extends UnknownRecord> {
    get(id: string): R | undefined;
    set(id: string, record: R): void;
    delete(id: string): void;
    keys(): Iterable<string>;
    values(): Iterable<R>;
    entries(): Iterable<[string, R]>;
}
/**
 * Abstraction over the storage that can be used to perform migrations.
 * @public
 */
export interface SynchronousStorage<R extends UnknownRecord> extends SynchronousRecordStorage<R> {
    getSchema(): SerializedSchema;
    setSchema(schema: SerializedSchema): void;
}
/**
 * Base interface for legacy migration information.
 *
 * Contains the basic structure used by the legacy migration system, including version
 * range information and the migration functions indexed by version number. This is
 * maintained for backward compatibility with older migration definitions.
 * @public
 */
export interface LegacyBaseMigrationsInfo {
    firstVersion: number;
    currentVersion: number;
    migrators: {
        [version: number]: LegacyMigration;
    };
}
/**
 * Legacy migration configuration with support for sub-type migrations.
 *
 * This interface extends the base legacy migration info to support migrations that
 * vary based on a sub-type key within records. This allows different migration paths
 * for different variants of the same record type, which was useful in older migration
 * systems but is now handled more elegantly by the current Migration system.
 * @public
 */
export interface LegacyMigrations extends LegacyBaseMigrationsInfo {
    subTypeKey?: string;
    subTypeMigrations?: Record<string, LegacyBaseMigrationsInfo>;
}
/**
 * A complete sequence of migrations that can be applied to transform data.
 *
 * A migration sequence represents a series of ordered migrations that belong together,
 * typically for a specific part of your schema. The sequence includes metadata about
 * whether it should be applied retroactively to existing data and contains the actual
 * migration definitions in execution order.
 * @public
 */
export interface MigrationSequence {
    sequenceId: string;
    /**
     * retroactive should be true if the migrations should be applied to snapshots that were created before
     * this migration sequence was added to the schema.
     *
     * In general:
     *
     * - retroactive should be true when app developers create their own new migration sequences.
     * - retroactive should be false when library developers ship a migration sequence. When you install a library for the first time, any migrations that were added in the library before that point should generally _not_ be applied to your existing data.
     */
    retroactive: boolean;
    sequence: Migration[];
}
/**
 * Sorts migrations using a distance-minimizing topological sort.
 *
 * This function respects two types of dependencies:
 * 1. Implicit sequence dependencies (foo/1 must come before foo/2)
 * 2. Explicit dependencies via `dependsOn` property
 *
 * The algorithm minimizes the total distance between migrations and their explicit
 * dependencies in the final ordering, while maintaining topological correctness.
 * This means when migration A depends on migration B, A will be scheduled as close
 * as possible to B (while respecting all constraints).
 *
 * Implementation uses Kahn's algorithm with priority scoring:
 * - Builds dependency graph and calculates in-degrees
 * - Uses priority queue that prioritizes migrations which unblock explicit dependencies
 * - Processes migrations in urgency order while maintaining topological constraints
 * - Detects cycles by ensuring all migrations are processed
 *
 * @param migrations - Array of migrations to sort
 * @returns Sorted array of migrations in execution order
 * @throws Assertion error if circular dependencies are detected
 * @example
 * ```ts
 * const sorted = sortMigrations([
 *   { id: 'app/2', scope: 'record', up: (r) => r },
 *   { id: 'app/1', scope: 'record', up: (r) => r },
 *   { id: 'lib/1', scope: 'record', up: (r) => r, dependsOn: ['app/1'] }
 * ])
 * // Result: [app/1, app/2, lib/1] (respects both sequence and explicit deps)
 * ```
 * @public
 */
export declare function sortMigrations(migrations: Migration[]): Migration[];
/**
 * Parses a migration ID to extract the sequence ID and version number.
 *
 * Migration IDs follow the format `sequenceId/version`, and this function splits
 * them into their component parts. This is used internally for sorting migrations
 * and understanding their relationships.
 * @param id - The migration ID to parse
 * @returns Object containing the sequence ID and numeric version
 * @example
 * ```ts
 * const { sequenceId, version } = parseMigrationId('com.myapp.book/5')
 * // sequenceId: 'com.myapp.book', version: 5
 * ```
 * @internal
 */
export declare function parseMigrationId(id: MigrationId): {
    sequenceId: string;
    version: number;
};
/**
 * Validates that a migration sequence is correctly structured.
 *
 * Performs several validation checks to ensure the migration sequence is valid:
 * - Sequence ID doesn't contain invalid characters
 * - All migration IDs belong to the expected sequence
 * - Migration versions start at 1 and increment by 1
 * - Migration IDs follow the correct format
 * @param migrations - The migration sequence to validate
 * @throws Assertion error if any validation checks fail
 * @example
 * ```ts
 * const sequence = createMigrationSequence({
 *   sequenceId: 'com.myapp.book',
 *   sequence: [{ id: 'com.myapp.book/1', scope: 'record', up: (r) => r }]
 * })
 * validateMigrations(sequence) // Passes validation
 * ```
 * @public
 */
export declare function validateMigrations(migrations: MigrationSequence): void;
/**
 * Result type returned by migration operations.
 *
 * Migration operations can either succeed and return the transformed value,
 * or fail with a specific reason. This discriminated union type allows for
 * safe handling of both success and error cases when applying migrations.
 * @public
 */
export type MigrationResult<T> = {
    type: 'success';
    value: T;
} | {
    type: 'error';
    reason: MigrationFailureReason;
};
/** @public */
export declare const MigrationFailureReason: {
    readonly IncompatibleSubtype: "incompatible-subtype";
    readonly UnknownType: "unknown-type";
    readonly TargetVersionTooNew: "target-version-too-new";
    readonly TargetVersionTooOld: "target-version-too-old";
    readonly MigrationError: "migration-error";
    readonly UnrecognizedSubtype: "unrecognized-subtype";
};
/** @public */
export type MigrationFailureReason = (typeof MigrationFailureReason)[keyof typeof MigrationFailureReason];
/** @public */
export declare namespace MigrationFailureReason {
    type IncompatibleSubtype = typeof MigrationFailureReason.IncompatibleSubtype;
    type UnknownType = typeof MigrationFailureReason.UnknownType;
    type TargetVersionTooNew = typeof MigrationFailureReason.TargetVersionTooNew;
    type TargetVersionTooOld = typeof MigrationFailureReason.TargetVersionTooOld;
    type MigrationError = typeof MigrationFailureReason.MigrationError;
    type UnrecognizedSubtype = typeof MigrationFailureReason.UnrecognizedSubtype;
}
//# sourceMappingURL=migrate.d.ts.map