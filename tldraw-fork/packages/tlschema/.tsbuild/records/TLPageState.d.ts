import { BaseRecord, RecordId } from '@tldraw/store';
import { JsonObject } from '@tldraw/utils';
import { T } from '@tldraw/validate';
import { TLPage } from './TLPage';
import { TLShapeId } from './TLShape';
/**
 * State that is unique to a particular page within a particular browser tab.
 * This record tracks all page-specific interaction state including selected shapes,
 * editing state, hover state, and other transient UI state that is tied to
 * both a specific page and a specific browser session.
 *
 * Each combination of page and browser tab has its own TLInstancePageState record.
 *
 * @example
 * ```ts
 * const pageState: TLInstancePageState = {
 *   id: 'instance_page_state:page1',
 *   typeName: 'instance_page_state',
 *   pageId: 'page:page1',
 *   selectedShapeIds: ['shape:rect1', 'shape:circle2'],
 *   hoveredShapeId: 'shape:text3',
 *   editingShapeId: null,
 *   focusedGroupId: null
 * }
 * ```
 *
 * @public
 */
export interface TLInstancePageState extends BaseRecord<'instance_page_state', TLInstancePageStateId> {
    pageId: RecordId<TLPage>;
    selectedShapeIds: TLShapeId[];
    hintingShapeIds: TLShapeId[];
    erasingShapeIds: TLShapeId[];
    hoveredShapeId: TLShapeId | null;
    editingShapeId: TLShapeId | null;
    croppingShapeId: TLShapeId | null;
    focusedGroupId: TLShapeId | null;
    meta: JsonObject;
}
/**
 * Runtime validator for TLInstancePageState records. Validates the structure
 * and types of all instance page state properties to ensure data integrity.
 *
 * @example
 * ```ts
 * const pageState = {
 *   id: 'instance_page_state:page1',
 *   typeName: 'instance_page_state',
 *   pageId: 'page:page1',
 *   selectedShapeIds: ['shape:rect1'],
 *   // ... other properties
 * }
 * const isValid = instancePageStateValidator.isValid(pageState) // true
 * ```
 *
 * @public
 */
export declare const instancePageStateValidator: T.Validator<TLInstancePageState>;
/**
 * Migration version identifiers for TLInstancePageState records. Each version
 * represents a schema change that requires data transformation when loading
 * older documents.
 *
 * @public
 */
export declare const instancePageStateVersions: {
    readonly AddCroppingId: "com.tldraw.instance_page_state/1";
    readonly RemoveInstanceIdAndCameraId: "com.tldraw.instance_page_state/2";
    readonly AddMeta: "com.tldraw.instance_page_state/3";
    readonly RenameProperties: "com.tldraw.instance_page_state/4";
    readonly RenamePropertiesAgain: "com.tldraw.instance_page_state/5";
};
/**
 * Migration sequence for TLInstancePageState records. Defines how to transform
 * instance page state records between different schema versions, ensuring data
 * compatibility when loading documents created with different versions.
 *
 * @example
 * ```ts
 * // Migrations are applied automatically when loading documents
 * const migrated = instancePageStateMigrations.migrate(oldState, targetVersion)
 * ```
 *
 * @public
 */
export declare const instancePageStateMigrations: import("@tldraw/store").MigrationSequence;
/**
 * The RecordType definition for TLInstancePageState records. Defines validation,
 * scope, and default properties for instance page state records.
 *
 * Instance page states are scoped to the session level, meaning they are
 * specific to a browser tab and don't persist across sessions or sync
 * in collaborative environments.
 *
 * @example
 * ```ts
 * const pageState = InstancePageStateRecordType.create({
 *   id: 'instance_page_state:page1',
 *   pageId: 'page:page1',
 *   selectedShapeIds: ['shape:rect1']
 * })
 * ```
 *
 * @public
 */
export declare const InstancePageStateRecordType: import("@tldraw/store").RecordType<TLInstancePageState, "pageId">;
/**
 * A unique identifier for TLInstancePageState records.
 *
 * Instance page state IDs follow the format 'instance_page_state:' followed
 * by a unique identifier, typically related to the page ID.
 *
 * @example
 * ```ts
 * const stateId: TLInstancePageStateId = 'instance_page_state:page1'
 * ```
 *
 * @public
 */
export type TLInstancePageStateId = RecordId<TLInstancePageState>;
//# sourceMappingURL=TLPageState.d.ts.map