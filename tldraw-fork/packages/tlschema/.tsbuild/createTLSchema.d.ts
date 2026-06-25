import { LegacyMigrations, MigrationSequence, StoreSchema, StoreValidator } from '@tldraw/store';
import { T } from '@tldraw/validate';
import { CustomRecordInfo } from './records/TLCustomRecord';
import { TLRecord } from './records/TLRecord';
import { RecordProps, TLPropsMigrations } from './recordsWithProps';
import { TLStoreProps } from './TLStore';
/**
 * Configuration information for a schema type (shape, binding, or asset), including its properties,
 * metadata, and migration sequences for data evolution over time.
 *
 * @public
 * @example
 * ```ts
 * import { arrowShapeMigrations, arrowShapeProps } from './shapes/TLArrowShape'
 *
 * const myShapeSchema: SchemaPropsInfo = {
 *   migrations: arrowShapeMigrations,
 *   props: arrowShapeProps,
 *   meta: {
 *     customField: T.string,
 *   },
 * }
 * ```
 */
export interface SchemaPropsInfo {
    /**
     * Migration sequences for handling data evolution over time. Can be legacy migrations,
     * props-specific migrations, or general migration sequences.
     */
    migrations?: LegacyMigrations | TLPropsMigrations | MigrationSequence;
    /**
     * Validation schema for the shape, binding, or asset properties.
     */
    props?: Record<string, StoreValidator<any>>;
    /**
     * Validation schema for metadata fields.
     */
    meta?: Record<string, StoreValidator<any>>;
}
/**
 * The complete schema definition for a tldraw store, encompassing all record types,
 * validation rules, and migration sequences. This schema defines the structure of
 * the persistent data model used by tldraw.
 *
 * @public
 * @example
 * ```ts
 * import { createTLSchema, defaultShapeSchemas } from '@tldraw/tlschema'
 * import { Store } from '@tldraw/store'
 *
 * const schema: TLSchema = createTLSchema({
 *   shapes: defaultShapeSchemas,
 * })
 *
 * const store = new Store({ schema })
 * ```
 */
export type TLSchema = StoreSchema<TLRecord, TLStoreProps>;
/**
 * Default shape schema configurations for all built-in tldraw shape types.
 * Each shape type includes its validation props and migration sequences.
 *
 * This object contains schema information for:
 * - arrow: Directional lines that can bind to other shapes
 * - bookmark: Website bookmark cards with preview information
 * - draw: Freehand drawing paths created with drawing tools
 * - embed: Embedded content from external services (YouTube, Figma, etc.)
 * - frame: Container shapes for organizing content
 * - geo: Geometric shapes (rectangles, ellipses, triangles, etc.)
 * - group: Logical groupings of multiple shapes
 * - highlight: Highlighting strokes from the highlighter tool
 * - image: Raster image shapes referencing image assets
 * - line: Multi-point lines and splines
 * - note: Sticky note shapes with text content
 * - text: Rich text shapes with formatting support
 * - video: Video shapes referencing video assets
 *
 * @public
 * @example
 * ```ts
 * import { createTLSchema, defaultShapeSchemas } from '@tldraw/tlschema'
 *
 * // Use all default shapes
 * const schema = createTLSchema({
 *   shapes: defaultShapeSchemas,
 * })
 *
 * // Use only specific default shapes
 * const minimalSchema = createTLSchema({
 *   shapes: {
 *     geo: defaultShapeSchemas.geo,
 *     text: defaultShapeSchemas.text,
 *   },
 * })
 * ```
 */
export declare const defaultShapeSchemas: {
    arrow: {
        migrations: MigrationSequence;
        props: RecordProps<import(".").TLArrowShape>;
    };
    bookmark: {
        migrations: TLPropsMigrations;
        props: RecordProps<import(".").TLBookmarkShape>;
    };
    draw: {
        migrations: TLPropsMigrations;
        props: RecordProps<import(".").TLDrawShape>;
    };
    embed: {
        migrations: TLPropsMigrations;
        props: RecordProps<import(".").TLEmbedShape>;
    };
    frame: {
        migrations: TLPropsMigrations;
        props: RecordProps<import(".").TLFrameShape>;
    };
    geo: {
        migrations: TLPropsMigrations;
        props: RecordProps<import(".").TLGeoShape>;
    };
    group: {
        migrations: TLPropsMigrations;
        props: RecordProps<import(".").TLGroupShape>;
    };
    highlight: {
        migrations: TLPropsMigrations;
        props: RecordProps<import(".").TLHighlightShape>;
    };
    image: {
        migrations: TLPropsMigrations;
        props: RecordProps<import(".").TLImageShape>;
    };
    line: {
        migrations: TLPropsMigrations;
        props: RecordProps<import(".").TLLineShape>;
    };
    note: {
        migrations: TLPropsMigrations;
        props: RecordProps<import(".").TLNoteShape>;
    };
    text: {
        migrations: TLPropsMigrations;
        props: RecordProps<import(".").TLTextShape>;
    };
    video: {
        migrations: TLPropsMigrations;
        props: RecordProps<import(".").TLVideoShape>;
    };
};
/**
 * Default binding schema configurations for all built-in tldraw binding types.
 * Bindings represent relationships between shapes, such as arrows connected to shapes.
 *
 * Currently includes:
 * - arrow: Bindings that connect arrow shapes to other shapes at specific anchor points
 *
 * @public
 * @example
 * ```ts
 * import { createTLSchema, defaultBindingSchemas } from '@tldraw/tlschema'
 *
 * // Use default bindings
 * const schema = createTLSchema({
 *   bindings: defaultBindingSchemas,
 * })
 *
 * // Add custom binding alongside defaults
 * const customSchema = createTLSchema({
 *   bindings: {
 *     ...defaultBindingSchemas,
 *     myCustomBinding: {
 *       props: myCustomBindingProps,
 *       migrations: myCustomBindingMigrations,
 *     },
 *   },
 * })
 * ```
 */
export declare const defaultBindingSchemas: {
    arrow: {
        migrations: TLPropsMigrations;
        props: RecordProps<import(".").TLArrowBinding>;
    };
};
/**
 * Default asset schema configurations for all built-in tldraw asset types.
 *
 * @public
 * @example
 * ```ts
 * import { createTLSchema, defaultAssetSchemas } from '@tldraw/tlschema'
 *
 * const schema = createTLSchema({
 *   assets: defaultAssetSchemas,
 * })
 * ```
 */
export declare const defaultAssetSchemas: {
    image: {
        migrations: MigrationSequence;
        props: {
            w: T.Validator<number>;
            h: T.Validator<number>;
            name: T.Validator<string>;
            isAnimated: T.Validator<boolean>;
            mimeType: T.Validator<string | null>;
            src: T.Validator<string | null>;
            fileSize: T.Validator<number | undefined>;
            pixelRatio: T.Validator<number | undefined>;
        };
    };
    video: {
        migrations: MigrationSequence;
        props: {
            w: T.Validator<number>;
            h: T.Validator<number>;
            name: T.Validator<string>;
            isAnimated: T.Validator<boolean>;
            mimeType: T.Validator<string | null>;
            src: T.Validator<string | null>;
            fileSize: T.Validator<number | undefined>;
        };
    };
    bookmark: {
        migrations: MigrationSequence;
        props: {
            title: T.Validator<string>;
            description: T.Validator<string>;
            image: T.Validator<string>;
            favicon: T.Validator<string>;
            src: T.Validator<string | null>;
        };
    };
};
/**
 * Configuration for extending the user record type with custom metadata
 * validators and migration sequences.
 *
 * @example
 * ```ts
 * import { T } from '@tldraw/validate'
 *
 * const userSchema: UserSchemaInfo = {
 *   meta: {
 *     isAdmin: T.boolean,
 *     department: T.string,
 *   },
 * }
 * ```
 *
 * @public
 */
export interface UserSchemaInfo {
    /**
     * Validators for custom metadata fields on user records. Each field is
     * treated as optional — user records without these fields remain valid,
     * but when present, values are validated against the provided validators.
     */
    meta?: Record<string, T.Validatable<any>>;
    /**
     * Additional migration sequences for evolving custom user data over time.
     */
    migrations?: readonly MigrationSequence[];
}
/**
 * Creates a complete TLSchema for use with tldraw stores. This schema defines the structure,
 * validation, and migration sequences for all record types in a tldraw application.
 *
 * The schema includes all core record types (pages, cameras, instances, etc.) plus the
 * shape, binding, asset, and custom record types you specify. Style properties are
 * automatically collected from all shapes to ensure consistency across the application.
 *
 * @param options - Configuration options for the schema
 *   - shapes - Shape schema configurations. Defaults to defaultShapeSchemas if not provided
 *   - bindings - Binding schema configurations. Defaults to defaultBindingSchemas if not provided
 *   - assets - Asset schema configurations. Defaults to defaultAssetSchemas if not provided
 *   - user - Custom user record configuration with meta validators and migrations
 *   - records - Custom record type configurations. These are additional record types beyond
 *     the built-in shapes, bindings, assets, etc.
 *   - migrations - Additional migration sequences to include in the schema
 * @returns A complete TLSchema ready for use with Store creation
 *
 * @public
 * @example
 * ```ts
 * import {
 *   createTLSchema,
 *   defaultShapeSchemas,
 *   defaultBindingSchemas,
 *   defaultAssetSchemas,
 * } from '@tldraw/tlschema'
 * import { Store } from '@tldraw/store'
 *
 * // Create schema with all default shapes, bindings, and assets
 * const schema = createTLSchema()
 *
 * // Create schema with custom shapes added
 * const customSchema = createTLSchema({
 *   shapes: {
 *     ...defaultShapeSchemas,
 *     myCustomShape: {
 *       props: myCustomShapeProps,
 *       migrations: myCustomShapeMigrations,
 *     },
 *   },
 *   bindings: defaultBindingSchemas,
 *   assets: defaultAssetSchemas,
 * })
 *
 * // Create schema with custom user metadata
 * const schemaWithCustomUser = createTLSchema({
 *   user: {
 *     meta: {
 *       isAdmin: T.boolean,
 *       department: T.string,
 *     },
 *   },
 * })
 *
 * // Create schema with custom record types
 * const schemaWithCustomRecords = createTLSchema({
 *   records: {
 *     comment: {
 *       scope: 'document',
 *       validator: T.object({
 *         id: T.string,
 *         typeName: T.literal('comment'),
 *         text: T.string,
 *         shapeId: T.string,
 *       }),
 *     },
 *   },
 * })
 *
 * // Use the schema with a store
 * const store = new Store({
 *   schema: customSchema,
 *   props: {
 *     defaultName: 'My Drawing',
 *   },
 * })
 * ```
 */
export declare function createTLSchema({ shapes, bindings, assets, user, records, migrations }?: {
    shapes?: Record<string, SchemaPropsInfo>;
    bindings?: Record<string, SchemaPropsInfo>;
    assets?: Record<string, SchemaPropsInfo>;
    user?: UserSchemaInfo;
    records?: Record<string, CustomRecordInfo>;
    migrations?: readonly MigrationSequence[];
}): TLSchema;
//# sourceMappingURL=createTLSchema.d.ts.map