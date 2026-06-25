import { RecordId } from '@tldraw/store';
import { TLBaseAsset } from '../assets/TLBaseAsset';
import { TLBookmarkAsset } from '../assets/TLBookmarkAsset';
import { TLImageAsset } from '../assets/TLImageAsset';
import { TLVideoAsset } from '../assets/TLVideoAsset';
import { SchemaPropsInfo } from '../createTLSchema';
import { TLPropsMigrations } from '../recordsWithProps';
import { ExtractShapeByProps } from './TLShape';
/**
 * The default set of asset types that are available in the editor.
 *
 * @example
 * ```ts
 * const imageAsset: TLDefaultAsset = {
 *   id: 'asset:image123',
 *   typeName: 'asset',
 *   type: 'image',
 *   props: {
 *     src: 'https://example.com/image.jpg',
 *     w: 800,
 *     h: 600,
 *     mimeType: 'image/jpeg',
 *     isAnimated: false,
 *     name: 'image.jpg',
 *   },
 *   meta: {},
 * }
 * ```
 *
 * @public
 */
export type TLDefaultAsset = TLImageAsset | TLVideoAsset | TLBookmarkAsset;
/**
 * A type for an asset that is available in the editor but whose type is
 * unknown—either one of the editor's default assets or else a custom asset.
 *
 * @public
 */
export type TLUnknownAsset = TLBaseAsset<string, object>;
/** @public */
export interface TLGlobalAssetPropsMap {
}
/** @public */
export type TLIndexedAssets = {
    [K in keyof TLGlobalAssetPropsMap | TLDefaultAsset['type'] as K extends TLDefaultAsset['type'] ? K extends keyof TLGlobalAssetPropsMap ? TLGlobalAssetPropsMap[K] extends null | undefined ? never : K : K : K]: K extends TLDefaultAsset['type'] ? K extends keyof TLGlobalAssetPropsMap ? TLBaseAsset<K, TLGlobalAssetPropsMap[K]> : Extract<TLDefaultAsset, {
        type: K;
    }> : TLBaseAsset<K, TLGlobalAssetPropsMap[K & keyof TLGlobalAssetPropsMap]>;
};
/**
 * The set of all assets that are available in the editor.
 *
 * This is the primary asset type used throughout tldraw. It includes both the
 * built-in default assets and any custom assets registered via
 * {@link TLGlobalAssetPropsMap} augmentation.
 *
 * You can use this type without a type argument to work with any asset, or pass
 * a specific asset type string (e.g., `'image'`, `'video'`, `'bookmark'`) to
 * narrow down to that specific asset type.
 *
 * @example
 * ```ts
 * // Register a custom asset type
 * declare module '@tldraw/tlschema' {
 *   interface TLGlobalAssetPropsMap {
 *     file: { name: string; size: number; mimeType: string; src: string | null }
 *   }
 * }
 * ```
 *
 * @public
 */
export type TLAsset<K extends keyof TLIndexedAssets = keyof TLIndexedAssets> = TLIndexedAssets[K];
/**
 * Migration version identifiers for asset record schema evolution.
 * Each version represents a breaking change that requires data migration.
 *
 * @example
 * ```ts
 * // Check if a migration is needed
 * const needsMigration = currentVersion < assetVersions.AddMeta
 * ```
 *
 * @public
 */
export declare const assetVersions: {
    readonly AddMeta: "com.tldraw.asset/1";
};
/**
 * Migration sequence for evolving asset record structure over time.
 * Handles converting asset records from older schema versions to current format.
 *
 * @example
 * ```ts
 * // Migration is applied automatically when loading old documents
 * const migratedStore = migrator.migrateStoreSnapshot({
 *   schema: oldSchema,
 *   store: oldStoreSnapshot,
 * })
 * ```
 *
 * @public
 */
export declare const assetMigrations: import("@tldraw/store").MigrationSequence;
/**
 * Partial type for TLAsset allowing optional properties except id and type.
 * Useful for creating or updating assets where not all properties need to be specified.
 *
 * @example
 * ```ts
 * // Create a partial asset for updating
 * const partialAsset: TLAssetPartial<TLImageAsset> = {
 *   id: 'asset:image123',
 *   type: 'image',
 *   props: {
 *     w: 800, // Only updating width
 *   },
 * }
 *
 * // Use in asset updates
 * editor.updateAssets([partialAsset])
 * ```
 *
 * @public
 */
export type TLAssetPartial<T extends TLAsset = TLAsset> = T extends T ? {
    id: TLAssetId;
    type: T['type'];
    props?: Partial<T['props']>;
    meta?: Partial<T['meta']>;
} & Partial<Omit<T, 'type' | 'id' | 'props' | 'meta'>> : never;
/**
 * Creates the record type definition for assets based on registered asset schemas.
 * This function follows the same pattern as `createShapeRecordType` and `createBindingRecordType`.
 *
 * @param assets - Record of asset type names to their schema configuration
 * @returns A configured record type for assets with validation
 *
 * @example
 * ```ts
 * const AssetRecordType = createAssetRecordType({
 *   image: { migrations: imageAssetMigrations, props: imageAssetProps },
 *   video: { migrations: videoAssetMigrations, props: videoAssetProps },
 *   bookmark: { migrations: bookmarkAssetMigrations, props: bookmarkAssetProps },
 * })
 * ```
 *
 * @internal
 */
export declare function createAssetRecordType(assets: Record<string, SchemaPropsInfo>): import("@tldraw/store").RecordType<{
    id: TLAssetId;
    meta: import("@tldraw/utils").JsonObject;
    props: {
        [x: string]: /*elided*/ any;
    };
    type: string;
    typeName: "asset";
}, "props" | "type">;
/**
 * Record type definition for default TLAsset records with document scope and default metadata.
 *
 * @public
 */
export declare const AssetRecordType: import("@tldraw/store").RecordType<TLAsset<"bookmark" | "image" | "video">, "props" | "type">;
/**
 * Branded string type for asset record identifiers.
 * Prevents mixing asset IDs with other record IDs at compile time.
 *
 * @example
 * ```ts
 * const imageShape = {
 *   type: 'image',
 *   props: {
 *     assetId: 'asset:image123' as TLAssetId,
 *   },
 * }
 * ```
 *
 * @public
 */
export type TLAssetId = RecordId<TLBaseAsset<any, any>>;
/**
 * Union type of all shapes that reference assets through an assetId property.
 * Includes image shapes, video shapes, and any other shapes that depend on external assets.
 *
 * @example
 * ```ts
 * function handleAssetShape(shape: TLAssetShape) {
 *   const assetId = shape.props.assetId
 *   if (!assetId) return
 *   const asset = editor.getAsset(assetId)
 *   // Handle the asset...
 * }
 * ```
 *
 * @public
 */
export type TLAssetShape = ExtractShapeByProps<{
    assetId: TLAssetId;
}>;
/**
 * Creates a migration sequence for asset properties.
 *
 * @example
 * ```ts
 * const migrations = createAssetPropsMigrationSequence({
 *   sequence: [
 *     { id: 'com.myapp.asset.custom/1', up: (props) => { props.newField = '' } },
 *   ],
 * })
 * ```
 *
 * @public
 */
export declare function createAssetPropsMigrationSequence(migrations: TLPropsMigrations): TLPropsMigrations;
/**
 * Creates properly formatted migration IDs for asset properties.
 *
 * @example
 * ```ts
 * const assetPropsVersions = createAssetPropsMigrationIds('file', {
 *   AddFoo: 1,
 *   RenameBar: 2,
 * })
 * // => { AddFoo: 'com.tldraw.asset.file/1', RenameBar: 'com.tldraw.asset.file/2' }
 * ```
 *
 * @public
 */
export declare function createAssetPropsMigrationIds<S extends string, T extends Record<string, number>>(assetType: S, ids: T): {
    [k in keyof T]: `com.tldraw.asset.${S}/${T[k]}`;
};
//# sourceMappingURL=TLAsset.d.ts.map