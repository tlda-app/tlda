import { BaseRecord, RecordId } from '@tldraw/store';
import { JsonObject } from '@tldraw/utils';
import { T } from '@tldraw/validate';
import { BoxModel } from '../misc/geometry-types';
import { TLCursor } from '../misc/TLCursor';
import { TLOpacityType } from '../misc/TLOpacity';
import { TLScribble } from '../misc/TLScribble';
import { StyleProp } from '../styles/StyleProp';
import { TLPageId } from './TLPage';
import { TLShapeId } from './TLShape';
import { TLUserId } from './TLUser';
/**
 * State that is particular to a single browser tab. The TLInstance record stores
 * all session-specific state including cursor position, selected tools, UI preferences,
 * and temporary interaction state.
 *
 * Each browser tab has exactly one TLInstance record that persists for the duration
 * of the session and tracks the user's current interaction state.
 *
 * @example
 * ```ts
 * const instance: TLInstance = {
 *   id: 'instance:instance',
 *   typeName: 'instance',
 *   currentPageId: 'page:page1',
 *   cursor: { type: 'default', rotation: 0 },
 *   screenBounds: { x: 0, y: 0, w: 1920, h: 1080 },
 *   isFocusMode: false,
 *   isGridMode: true
 * }
 * ```
 *
 * @public
 */
export interface TLInstance extends BaseRecord<'instance', TLInstanceId> {
    currentPageId: TLPageId;
    opacityForNextShape: TLOpacityType;
    stylesForNextShape: Record<string, unknown>;
    followingUserId: TLUserId | null;
    highlightedUserIds: TLUserId[];
    brush: BoxModel | null;
    cursor: TLCursor;
    scribbles: TLScribble[];
    isFocusMode: boolean;
    isDebugMode: boolean;
    isToolLocked: boolean;
    exportBackground: boolean;
    screenBounds: BoxModel;
    insets: boolean[];
    zoomBrush: BoxModel | null;
    chatMessage: string;
    isChatting: boolean;
    isPenMode: boolean;
    isGridMode: boolean;
    isFocused: boolean;
    devicePixelRatio: number;
    /**
     * This is whether the primary input mechanism includes a pointing device of limited accuracy,
     * such as a finger on a touchscreen.
     */
    isCoarsePointer: boolean;
    /**
     * Will be null if the pointer doesn't support hovering (e.g. touch), but true or false
     * otherwise
     */
    isHoveringCanvas: boolean | null;
    openMenus: string[];
    isChangingStyle: boolean;
    isReadonly: boolean;
    meta: JsonObject;
    duplicateProps: {
        shapeIds: TLShapeId[];
        offset: {
            x: number;
            y: number;
        };
    } | null;
    /**
     * Whether the camera is currently moving or idle. Used to optimize rendering
     * and hit-testing during panning/zooming.
     */
    cameraState: 'idle' | 'moving';
}
/**
 * Configuration object defining which TLInstance properties should be preserved
 * when loading snapshots across browser sessions. Properties marked as `true`
 * represent user preferences that should persist, while `false` indicates
 * temporary state that should reset.
 *
 * @internal
 */
export declare const shouldKeyBePreservedBetweenSessions: {
    readonly id: false;
    readonly typeName: false;
    readonly currentPageId: false;
    readonly opacityForNextShape: false;
    readonly stylesForNextShape: false;
    readonly followingUserId: false;
    readonly highlightedUserIds: false;
    readonly brush: false;
    readonly cursor: false;
    readonly scribbles: false;
    readonly isFocusMode: true;
    readonly isDebugMode: true;
    readonly isToolLocked: true;
    readonly exportBackground: true;
    readonly screenBounds: true;
    readonly insets: true;
    readonly zoomBrush: false;
    readonly chatMessage: false;
    readonly isChatting: false;
    readonly isPenMode: false;
    readonly isGridMode: true;
    readonly isFocused: true;
    readonly devicePixelRatio: true;
    readonly isCoarsePointer: true;
    readonly isHoveringCanvas: false;
    readonly openMenus: false;
    readonly isChangingStyle: false;
    readonly isReadonly: true;
    readonly meta: false;
    readonly duplicateProps: false;
    readonly cameraState: false;
};
/**
 * Extracts only the properties from a TLInstance that should be preserved
 * between browser sessions, filtering out temporary state.
 *
 * @param val - The TLInstance to filter, or null/undefined
 * @returns A partial TLInstance containing only preservable properties, or null
 *
 * @internal
 */
export declare function pluckPreservingValues(val?: TLInstance | null): null | Partial<TLInstance>;
/**
 * A unique identifier for TLInstance records.
 *
 * TLInstance IDs are always the constant 'instance:instance' since there
 * is exactly one instance record per browser tab.
 *
 * @public
 */
export type TLInstanceId = RecordId<TLInstance>;
/**
 * Validator for TLInstanceId values. Ensures the ID follows the correct
 * format for instance records.
 *
 * @example
 * ```ts
 * const isValid = instanceIdValidator.isValid('instance:instance') // true
 * const isValid2 = instanceIdValidator.isValid('invalid') // false
 * ```
 *
 * @public
 */
export declare const instanceIdValidator: T.Validator<TLInstanceId>;
/**
 * Creates the record type definition for TLInstance records, including validation
 * and default properties. The function takes a map of available style properties
 * to configure validation for the stylesForNextShape field.
 *
 * @param stylesById - Map of style property IDs to their corresponding StyleProp definitions
 * @returns A configured RecordType for TLInstance records
 *
 * @example
 * ```ts
 * const stylesMap = new Map([['color', DefaultColorStyle]])
 * const InstanceRecordType = createInstanceRecordType(stylesMap)
 *
 * const instance = InstanceRecordType.create({
 *   id: 'instance:instance',
 *   currentPageId: 'page:page1'
 * })
 * ```
 *
 * @public
 */
export declare function createInstanceRecordType(stylesById: Map<string, StyleProp<unknown>>): import("@tldraw/store").RecordType<TLInstance, "currentPageId">;
/**
 * Migration version identifiers for TLInstance records. Each version represents
 * a schema change that requires data transformation when loading older documents.
 *
 * The versions track the evolution of the instance record structure over time,
 * enabling backward and forward compatibility.
 *
 * @public
 */
export declare const instanceVersions: {
    readonly AddTransparentExportBgs: "com.tldraw.instance/1";
    readonly RemoveDialog: "com.tldraw.instance/2";
    readonly AddToolLockMode: "com.tldraw.instance/3";
    readonly RemoveExtraPropsForNextShape: "com.tldraw.instance/4";
    readonly AddLabelColor: "com.tldraw.instance/5";
    readonly AddFollowingUserId: "com.tldraw.instance/6";
    readonly RemoveAlignJustify: "com.tldraw.instance/7";
    readonly AddZoom: "com.tldraw.instance/8";
    readonly AddVerticalAlign: "com.tldraw.instance/9";
    readonly AddScribbleDelay: "com.tldraw.instance/10";
    readonly RemoveUserId: "com.tldraw.instance/11";
    readonly AddIsPenModeAndIsGridMode: "com.tldraw.instance/12";
    readonly HoistOpacity: "com.tldraw.instance/13";
    readonly AddChat: "com.tldraw.instance/14";
    readonly AddHighlightedUserIds: "com.tldraw.instance/15";
    readonly ReplacePropsForNextShapeWithStylesForNextShape: "com.tldraw.instance/16";
    readonly AddMeta: "com.tldraw.instance/17";
    readonly RemoveCursorColor: "com.tldraw.instance/18";
    readonly AddLonelyProperties: "com.tldraw.instance/19";
    readonly ReadOnlyReadonly: "com.tldraw.instance/20";
    readonly AddHoveringCanvas: "com.tldraw.instance/21";
    readonly AddScribbles: "com.tldraw.instance/22";
    readonly AddInset: "com.tldraw.instance/23";
    readonly AddDuplicateProps: "com.tldraw.instance/24";
    readonly RemoveCanMoveCamera: "com.tldraw.instance/25";
    readonly AddCameraState: "com.tldraw.instance/26";
};
/**
 * Migration sequence for TLInstance records. Defines how to transform instance
 * records between different schema versions, ensuring data compatibility when
 * loading documents created with different versions of tldraw.
 *
 * Each migration includes an 'up' function to migrate forward and optionally
 * a 'down' function for reverse migration.
 *
 * @example
 * ```ts
 * // Migrations are applied automatically when loading documents
 * const migratedInstance = instanceMigrations.migrate(oldInstance, targetVersion)
 * ```
 *
 * @public
 */
export declare const instanceMigrations: import("@tldraw/store").MigrationSequence;
/**
 * The constant ID used for the singleton TLInstance record.
 *
 * Since each browser tab has exactly one instance, this constant ID
 * is used universally across the application.
 *
 * @example
 * ```ts
 * const instance = store.get(TLINSTANCE_ID)
 * if (instance) {
 *   console.log('Current page:', instance.currentPageId)
 * }
 * ```
 *
 * @public
 */
export declare const TLINSTANCE_ID: TLInstanceId;
//# sourceMappingURL=TLInstance.d.ts.map