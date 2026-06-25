import { BaseRecord, RecordId } from '@tldraw/store';
import { JsonObject } from '@tldraw/utils';
import { T } from '@tldraw/validate';
import { BoxModel } from '../misc/geometry-types';
import { TLCursor } from '../misc/TLCursor';
import { TLScribble } from '../misc/TLScribble';
import { TLPageId } from './TLPage';
import { TLShapeId } from './TLShape';
import { TLUserId } from './TLUser';
/**
 * Represents the presence state of a user in a collaborative tldraw session.
 * This record tracks what another user is doing: their cursor position, selected
 * shapes, current page, and other real-time activity indicators.
 *
 * Instance presence records are used in multiplayer environments to show
 * where other collaborators are working and what they're doing.
 *
 * @example
 * ```ts
 * const presence: TLInstancePresence = {
 *   id: 'instance_presence:user123',
 *   typeName: 'instance_presence',
 *   userId: 'user123',
 *   userName: 'Alice',
 *   color: '#FF6B6B',
 *   cursor: { x: 100, y: 150, type: 'default', rotation: 0 },
 *   currentPageId: 'page:main',
 *   selectedShapeIds: ['shape:rect1']
 * }
 * ```
 *
 * @public
 */
export interface TLInstancePresence extends BaseRecord<'instance_presence', TLInstancePresenceID> {
    userId: TLUserId;
    userName: string;
    lastActivityTimestamp: number | null;
    color: string;
    camera: {
        x: number;
        y: number;
        z: number;
    } | null;
    selectedShapeIds: TLShapeId[];
    currentPageId: TLPageId;
    brush: BoxModel | null;
    scribbles: TLScribble[];
    screenBounds: BoxModel | null;
    followingUserId: TLUserId | null;
    cursor: {
        x: number;
        y: number;
        type: TLCursor['type'];
        rotation: number;
    } | null;
    chatMessage: string;
    meta: JsonObject;
}
/**
 * A unique identifier for TLInstancePresence records.
 *
 * Instance presence IDs follow the format 'instance_presence:' followed
 * by a unique identifier, typically the user ID.
 *
 * @example
 * ```ts
 * const presenceId: TLInstancePresenceID = 'instance_presence:user123'
 * ```
 *
 * @public
 */
export type TLInstancePresenceID = RecordId<TLInstancePresence>;
/**
 * Runtime validator for TLInstancePresence records. Validates the structure
 * and types of all instance presence properties to ensure data integrity.
 *
 * @example
 * ```ts
 * const presence = {
 *   id: 'instance_presence:user1',
 *   typeName: 'instance_presence',
 *   userId: 'user1',
 *   userName: 'John',
 *   color: '#007AFF',
 *   cursor: { x: 0, y: 0, type: 'default', rotation: 0 },
 *   currentPageId: 'page:main',
 *   selectedShapeIds: []
 * }
 * const isValid = instancePresenceValidator.isValid(presence) // true
 * ```
 *
 * @public
 */
export declare const instancePresenceValidator: T.Validator<TLInstancePresence>;
/**
 * Migration version identifiers for TLInstancePresence records. Each version
 * represents a schema change that requires data transformation when loading
 * older documents.
 *
 * @public
 */
export declare const instancePresenceVersions: {
    readonly AddScribbleDelay: "com.tldraw.instance_presence/1";
    readonly RemoveInstanceId: "com.tldraw.instance_presence/2";
    readonly AddChatMessage: "com.tldraw.instance_presence/3";
    readonly AddMeta: "com.tldraw.instance_presence/4";
    readonly RenameSelectedShapeIds: "com.tldraw.instance_presence/5";
    readonly NullableCameraCursor: "com.tldraw.instance_presence/6";
};
/**
 * Migration sequence for TLInstancePresence records. Defines how to transform
 * instance presence records between different schema versions, ensuring data
 * compatibility when loading documents created with different versions.
 *
 * @example
 * ```ts
 * // Migrations are applied automatically when loading documents
 * const migrated = instancePresenceMigrations.migrate(oldPresence, targetVersion)
 * ```
 *
 * @public
 */
export declare const instancePresenceMigrations: import("@tldraw/store").MigrationSequence;
/**
 * The RecordType definition for TLInstancePresence records. Defines validation,
 * scope, and default properties for instance presence records.
 *
 * Instance presence records are scoped to the presence level, meaning they
 * represent real-time collaborative state that is ephemeral and tied to
 * active user sessions.
 *
 * @example
 * ```ts
 * const presence = InstancePresenceRecordType.create({
 *   id: 'instance_presence:user1',
 *   userId: 'user1',
 *   userName: 'Alice',
 *   color: '#FF6B6B',
 *   currentPageId: 'page:main'
 * })
 * ```
 *
 * @public
 */
export declare const InstancePresenceRecordType: import("@tldraw/store").RecordType<TLInstancePresence, "currentPageId" | "userId" | "userName">;
//# sourceMappingURL=TLPresence.d.ts.map