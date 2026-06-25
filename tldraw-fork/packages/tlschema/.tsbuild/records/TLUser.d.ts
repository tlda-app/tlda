import { BaseRecord, RecordId } from '@tldraw/store';
import { JsonObject } from '@tldraw/utils';
import { T } from '@tldraw/validate';
/**
 * A user record in a tldraw store. User records are document-scoped and
 * persist alongside shapes, assets, and pages. They are automatically
 * included in snapshots, clipboard content, and `.tldr` files so that
 * attribution display names survive across boards and sessions.
 *
 * User records are populated from the {@link @tldraw/tlschema#TLUserStore}
 * when the editor stamps attribution metadata onto shapes.
 *
 * Extend user records with custom metadata by passing validators to
 * {@link @tldraw/tlschema#createTLSchema} or {@link createUserRecordType}.
 *
 * @public
 */
export interface TLUser extends BaseRecord<'user', TLUserId> {
    name: string;
    color: string;
    imageUrl: string;
    meta: JsonObject;
}
/** @public */
export type TLUserId = RecordId<TLUser>;
/** @public */
export declare const userIdValidator: T.Validator<TLUserId>;
/** @public */
export declare const userVersions: {
    readonly Initial: "com.tldraw.user/1";
};
/** @public */
export declare const userMigrations: import("@tldraw/store").MigrationSequence;
/**
 * Creates a user record type with optional custom meta validation.
 *
 * When `meta` validators are provided, the user record's `meta` field will
 * validate those specific fields (when present) while still allowing
 * arbitrary additional JSON properties. Custom meta fields are treated as
 * optional so that user records created without them remain valid.
 *
 * @param config - Optional configuration for custom meta validators
 * @returns A configured user record type
 *
 * @example
 * ```ts
 * import { createUserRecordType } from '@tldraw/tlschema'
 * import { T } from '@tldraw/validate'
 *
 * const CustomUserRecordType = createUserRecordType({
 *   meta: {
 *     isAdmin: T.boolean,
 *     department: T.string,
 *   },
 * })
 * ```
 *
 * @public
 */
export declare function createUserRecordType(config?: {
    meta?: Record<string, T.Validatable<any>>;
}): import("@tldraw/store").RecordType<TLUser, never>;
/** @public */
export declare const userValidator: T.Validator<TLUser>;
/** @public */
export declare const UserRecordType: import("@tldraw/store").RecordType<TLUser, never>;
/** @public */
export declare function isUserId(id: string): id is TLUserId;
/** @public */
export declare function createUserId(id: string): TLUserId;
//# sourceMappingURL=TLUser.d.ts.map