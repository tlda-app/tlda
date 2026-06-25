import { Signal } from '@tldraw/state';
import { HistoryEntry, MigrationSequence, SerializedStore, StoreSchema } from '@tldraw/store';
import { CustomRecordInfo, TLAssetStore, TLRecord, TLStore, TLStoreProps, TLStoreSnapshot, TLThemes, TLUserStore } from '@tldraw/tlschema';
import { Editor } from '../editor/Editor';
import { TLAnyAssetUtilConstructor } from './defaultAssets';
import { TLAnyBindingUtilConstructor } from './defaultBindings';
import { TLAnyShapeUtilConstructor } from './defaultShapes';
import { TLEditorSnapshot } from './TLEditorSnapshot';
/** @public */
export interface TLStoreBaseOptions {
    /** The initial data for the store. */
    initialData?: SerializedStore<TLRecord>;
    /** A snapshot of initial data to migrate and load into the store. */
    snapshot?: Partial<TLEditorSnapshot> | TLStoreSnapshot;
    /** The default name for the store. */
    defaultName?: string;
    /** How should this store upload & resolve assets? */
    assets?: TLAssetStore;
    /**
     * Named theme definitions. When provided, custom color names are automatically
     * registered before the store is constructed so persisted data with those
     * colors passes validation on load.
     */
    themes?: Partial<TLThemes>;
    /** How should this store resolve users for attribution? */
    users?: TLUserStore;
    /** Called when the store is connected to an {@link @tldraw/editor#Editor}. */
    onMount?(editor: Editor): (() => void) | void;
}
/** @public */
export type TLStoreSchemaOptions = {
    assetUtils?: readonly TLAnyAssetUtilConstructor[];
    bindingUtils?: readonly TLAnyBindingUtilConstructor[];
    migrations?: readonly MigrationSequence[];
    records?: Record<string, CustomRecordInfo>;
    shapeUtils?: readonly TLAnyShapeUtilConstructor[];
} | {
    schema?: StoreSchema<TLRecord, TLStoreProps>;
};
/** @public */
export type TLStoreOptions = TLStoreBaseOptions & {
    /** Collaboration options for the store. */
    collaboration?: {
        mode?: null | Signal<'readonly' | 'readwrite'>;
        status: null | Signal<'offline' | 'online'>;
    };
    id?: string;
} & TLStoreSchemaOptions;
/** @public */
export type TLStoreEventInfo = HistoryEntry<TLRecord>;
/** @public */
export declare const defaultUserStore: TLUserStore;
/** @public */
export declare const inlineBase64AssetStore: TLAssetStore;
/**
 * A helper for creating a TLStore schema from either an object with shapeUtils, bindingUtils, and
 * migrations, or a schema.
 *
 * @param opts - Options for creating the schema.
 *
 * @public
 */
export declare function createTLSchemaFromUtils(opts: TLStoreSchemaOptions): StoreSchema<TLRecord, TLStoreProps>;
/**
 * A helper for creating a TLStore.
 *
 * @param opts - Options for creating the store.
 *
 * @public
 */
export declare function createTLStore({ initialData, defaultName, id, assets, users, onMount, collaboration, themes, ...rest }?: TLStoreOptions): TLStore;
//# sourceMappingURL=createTLStore.d.ts.map