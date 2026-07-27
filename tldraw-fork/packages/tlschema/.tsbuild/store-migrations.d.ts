/**
 * Migration version constants for store-level schema changes.
 * Each version represents a breaking change that requires data transformation.
 *
 * @internal
 */
declare const Versions: {
    readonly RemoveCodeAndIconShapeTypes: "com.tldraw.store/1";
    readonly AddInstancePresenceType: "com.tldraw.store/2";
    readonly RemoveTLUserAndPresenceAndAddPointer: "com.tldraw.store/3";
    readonly RemoveUserDocument: "com.tldraw.store/4";
    readonly FixIndexKeys: "com.tldraw.store/5";
};
/**
 * Migration version identifiers for store-level migrations.
 * These versions track changes to the overall store structure and data model.
 *
 * @example
 * ```ts
 * import { storeVersions } from '@tldraw/tlschema'
 *
 * // Check if a specific migration version exists
 * const hasRemoveCodeShapes = storeVersions.RemoveCodeAndIconShapeTypes
 * ```
 *
 * @public
 */
export { Versions as storeVersions };
/**
 * Store-level migration sequence that handles evolution of the tldraw data model.
 * These migrations run when the store schema version changes and ensure backward
 * compatibility by transforming old data structures to new formats.
 *
 * The migrations handle:
 * - Removal of deprecated shape types (code, icon)
 * - Addition of new record types (instance presence)
 * - Cleanup of obsolete user and presence data
 * - Removal of deprecated user document records
 *
 * @example
 * ```ts
 * import { storeMigrations } from '@tldraw/tlschema'
 * import { migrate } from '@tldraw/store'
 *
 * // Apply store migrations to old data
 * const migratedStore = migrate({
 *   store: oldStoreData,
 *   migrations: storeMigrations,
 *   fromVersion: 0,
 *   toVersion: storeMigrations.currentVersion
 * })
 * ```
 *
 * @public
 */
export declare const storeMigrations: import("@tldraw/store").MigrationSequence;
//# sourceMappingURL=store-migrations.d.ts.map