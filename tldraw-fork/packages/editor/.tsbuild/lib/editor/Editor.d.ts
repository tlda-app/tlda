import { StoreSideEffects } from '@tldraw/store';
import { StyleProp, StylePropValue, TLAsset, TLAssetId, TLAssetPartial, TLBinding, TLBindingCreate, TLBindingId, TLBindingUpdate, TLCamera, TLCreateShapePartial, TLCursor, TLDocument, TLGroupShape, TLHandle, TLImageAsset, TLInstance, TLInstancePageState, TLInstancePresence, TLPage, TLPageId, TLParentId, TLRecord, TLShape, TLShapeId, TLShapePartial, TLStore, TLStoreSnapshot, TLTheme, TLThemeId, TLThemes, TLUser, TLUserId, TLVideoAsset } from '@tldraw/tlschema';
import { IndexKey, JsonObject } from '@tldraw/utils';
import EventEmitter from 'eventemitter3';
import { TLCurrentUser } from '../config/createTLCurrentUser';
import { TLAnyAssetUtilConstructor } from '../config/defaultAssets';
import { TLAnyBindingUtilConstructor } from '../config/defaultBindings';
import { TLAnyShapeUtilConstructor } from '../config/defaultShapes';
import { TLEditorSnapshot, TLLoadSnapshotOptions } from '../config/TLEditorSnapshot';
import { TldrawOptions } from '../options';
import { Box, BoxLike } from '../primitives/Box';
import { Geometry2d } from '../primitives/geometry/Geometry2d';
import { Mat, MatLike } from '../primitives/Mat';
import { Vec, VecLike } from '../primitives/Vec';
import { TLDeepLink, TLDeepLinkOptions } from '../utils/deepLinks';
import { TLTextOptions, TiptapEditor } from '../utils/richText';
import { ReadonlySharedStyleMap, SharedStyle } from '../utils/SharedStylesMap';
import { AssetUtil } from './assets/AssetUtil';
import { BindingUtil } from './bindings/BindingUtil';
import { ClickManager } from './managers/ClickManager/ClickManager';
import { CollaboratorsManager } from './managers/CollaboratorsManager/CollaboratorsManager';
import { EdgeScrollManager } from './managers/EdgeScrollManager/EdgeScrollManager';
import { FontManager } from './managers/FontManager/FontManager';
import { HistoryManager } from './managers/HistoryManager/HistoryManager';
import { InputsManager } from './managers/InputsManager/InputsManager';
import { PerformanceManager } from './managers/PerformanceManager/PerformanceManager';
import { ScribbleManager } from './managers/ScribbleManager/ScribbleManager';
import { SnapManager } from './managers/SnapManager/SnapManager';
import { TextManager } from './managers/TextManager/TextManager';
import { UserPreferencesManager } from './managers/UserPreferencesManager/UserPreferencesManager';
import { OverlayManager } from './overlays/OverlayManager';
import { TLAnyOverlayUtilConstructor } from './overlays/OverlayUtil';
import { ShapeUtil, TLEditStartInfo, TLGeometryOpts, TLResizeMode } from './shapes/ShapeUtil';
import { StateNode, TLStateNodeConstructor } from './tools/StateNode';
import { TLContent } from './types/clipboard-types';
import { TLEventMap } from './types/emit-types';
import { TLEventInfo } from './types/event-types';
import { TLExternalAsset, TLExternalContent } from './types/external-content';
import { TLHistoryBatchOptions } from './types/history-types';
import { OptionalKeys, RequiredKeys, TLCameraMoveOptions, TLCameraOptions, TLGetShapeAtPointOptions, TLImageExportOptions, TLSvgExportOptions, TLUpdatePointerOptions } from './types/misc-types';
import { TLAdjacentDirection, TLResizeHandle } from './types/selection-types';
import { TLViewport, TLViewportId, TLViewportOptions } from './viewports/TLViewport';
/** @public */
export type TLResizeShapeOptions = Partial<{
    initialBounds: Box;
    scaleOrigin: VecLike;
    scaleAxisRotation: number;
    initialShape: TLShape;
    initialPageTransform: MatLike;
    dragHandle: TLResizeHandle;
    isAspectRatioLocked: boolean;
    mode: TLResizeMode;
    skipStartAndEndCallbacks: boolean;
}>;
/** @public */
export interface TLEditorOptions {
    /**
     * The Store instance to use for keeping the editor's data. This may be prepopulated, e.g. by loading
     * from a server or database.
     */
    store: TLStore;
    /**
     * An array of shapes to use in the editor. These will be used to create and manage shapes in the editor.
     */
    shapeUtils: readonly TLAnyShapeUtilConstructor[];
    /**
     * An array of bindings to use in the editor. These will be used to create and manage bindings in the editor.
     */
    bindingUtils: readonly TLAnyBindingUtilConstructor[];
    /**
     * An array of asset utils to use in the editor. These will be used to handle asset-type-specific behavior.
     */
    assetUtils?: readonly TLAnyAssetUtilConstructor[];
    /**
     * An array of overlay utils to use in the editor. These define canvas overlay UI elements
     * like selection handles, rotation corners, shape handles, etc.
     */
    overlayUtils?: readonly TLAnyOverlayUtilConstructor[];
    /**
     * An array of tools to use in the editor. These will be used to handle events and manage user interactions in the editor.
     */
    tools: readonly TLStateNodeConstructor[];
    /**
     * A user defined externally to replace the default user.
     */
    user?: TLCurrentUser;
    /**
     * The editor's initial active tool (or other state node id).
     */
    initialState?: string;
    /**
     * Whether to automatically focus the editor when it mounts.
     */
    autoFocus?: boolean;
    licenseKey?: string;
    fontAssetUrls?: {
        [key: string]: string | undefined;
    };
    /**
     * Should return a containing html element which has all the styles applied to the editor. If not
     * given, the body element will be used.
     */
    getContainer(): HTMLElement;
    /**
     * Provides a way to hide shapes.
     *
     * @example
     * ```ts
     * getShapeVisibility={(shape, editor) => shape.meta.hidden ? 'hidden' : 'inherit'}
     * ```
     *
     * - `'inherit' | undefined` - (default) The shape will be visible unless its parent is hidden.
     * - `'hidden'` - The shape will be hidden.
     * - `'visible'` - The shape will be visible.
     *
     * @param shape - The shape to check.
     * @param editor - The editor instance.
     */
    getShapeVisibility?(shape: TLShape, editor: Editor): 'visible' | 'hidden' | 'inherit' | null | undefined;
    /**
     * Named theme definitions for the editor. Each theme contains shared
     * properties (font size, line height, stroke width) and color palettes
     * for both light and dark modes.
     */
    themes?: Partial<TLThemes>;
    /**
     * The id of the initially active theme. Defaults to `'default'`.
     */
    initialTheme?: TLThemeId;
    /**
     * The editor's color scheme preference, controls the default color mode. Defaults to `'light'`.
     *
     * - `'light'` - Always use light mode.
     * - `'dark'` - Always use dark mode.
     * - `'system'` - Follow the OS color scheme preference.
     */
    colorScheme?: 'light' | 'dark' | 'system';
    /**
     * Additional configuration options for the tldraw editor.
     */
    options?: Partial<TldrawOptions>;
    /**
     * Options for the editor's camera.
     *
     * @deprecated Use `options.cameraOptions` instead. This will be removed in a future release.
     */
    cameraOptions?: Partial<TLCameraOptions>;
    /**
     * Text options for the editor.
     *
     * @deprecated Use `options.text` instead. This prop will be removed in a future release.
     */
    textOptions?: TLTextOptions;
}
/**
 * Options for {@link Editor.(run:1)}.
 * @public
 */
export interface TLEditorRunOptions extends TLHistoryBatchOptions {
    ignoreShapeLock?: boolean;
}
/** @public */
export interface TLRenderingShape {
    id: TLShapeId;
    shape: TLShape;
    util: ShapeUtil;
    index: number;
    backgroundIndex: number;
    opacity: number;
}
/** @public */
export declare class Editor extends EventEmitter<TLEventMap> {
    readonly id: string;
    constructor({ store, user, shapeUtils, bindingUtils, assetUtils: assetUtilConstructors, overlayUtils: overlayUtilConstructors, tools, getContainer, cameraOptions, initialState, autoFocus, options: _options, textOptions: _textOptions, getShapeVisibility, colorScheme, fontAssetUrls, themes, initialTheme }: TLEditorOptions);
    private readonly _getShapeVisibility?;
    private getIsShapeHiddenCache;
    isShapeHidden(shapeOrId: TLShape | TLShapeId): boolean;
    readonly options: TldrawOptions;
    readonly contextId: string;
    /**
     * The editor's store
     *
     * @public
     */
    readonly store: TLStore;
    /**
     * The root state of the statechart.
     *
     * @public
     */
    readonly root: StateNode;
    /**
     * Set a tool. Useful if you need to add a tool to the state chart on demand,
     * after the editor has already been initialized.
     *
     * @param Tool - The tool to set.
     * @param parent - The parent state node to set the tool on.
     *
     * @public
     */
    setTool(Tool: TLStateNodeConstructor, parent?: StateNode): void;
    /**
     * Remove a tool. Useful if you need to remove a tool from the state chart on demand,
     * after the editor has already been initialized.
     *
     * @param Tool - The tool to delete.
     * @param parent - The parent state node to remove the tool from.
     *
     * @public
     */
    removeTool(Tool: TLStateNodeConstructor, parent?: StateNode): void;
    /**
     * A set of functions to call when the editor is disposed.
     *
     * @public
     */
    readonly disposables: Set<() => void>;
    /**
     * Whether the editor is disposed.
     *
     * @public
     */
    isDisposed: boolean;
    /**
     * A manager for the editor's tick events.
     *
     * @internal */
    private readonly _tickManager;
    /**
     * A manager for the editor's input state.
     *
     * @public
     */
    readonly inputs: InputsManager;
    /**
     * A manager for the editor's snapping feature.
     *
     * @public
     */
    readonly snaps: SnapManager;
    /**
     * A manager for performance measurement hooks.
     *
     * @public
     */
    readonly performance: PerformanceManager;
    /**
     * A manager for the spatial index, tracking where shapes exist on the canvas.
     *
     * @internal
     */
    private readonly _spatialIndex;
    /**
     * A manager for the any asynchronous events and making sure they're
     * cleaned up upon disposal.
     *
     * @public
     */
    readonly timers: {
        setTimeout: (handler: TimerHandler, timeout?: number | undefined, ...args: any[]) => number;
        setInterval: (handler: TimerHandler, timeout?: number | undefined, ...args: any[]) => number;
        requestAnimationFrame: (callback: FrameRequestCallback) => number;
        dispose: () => void;
    };
    /**
     * A manager for remote peer collaborators connected to this editor.
     *
     * @public
     */
    readonly collaborators: CollaboratorsManager;
    /**
     * A manager for the user and their preferences.
     *
     * @public
     */
    readonly user: UserPreferencesManager;
    /**
     * A manager for the editor's themes.
     *
     * @internal
     */
    private readonly _themeManager;
    /**
     * A helper for measuring text.
     *
     * @public
     */
    readonly textMeasure: TextManager;
    /**
     * A utility for managing the set of fonts that should be rendered in the document.
     *
     * @public
     */
    readonly fonts: FontManager;
    /**
     * A manager for the editor's scribbles.
     *
     * @public
     */
    readonly scribbles: ScribbleManager;
    /**
     * A manager for canvas overlay UI elements (selection handles, shape handles, etc.).
     *
     * @public
     */
    readonly overlays: OverlayManager;
    /**
     * A manager for side effects and correct state enforcement. See {@link @tldraw/store#StoreSideEffects} for details.
     *
     * @public
     */
    readonly sideEffects: StoreSideEffects<TLRecord>;
    /**
     * A manager for moving the camera when the mouse is at the edge of the screen.
     *
     * @public
     */
    edgeScrollManager: EdgeScrollManager;
    /**
     * A manager for ensuring correct focus. See FocusManager for details.
     *
     * @internal
     */
    private focusManager;
    /**
     * The current HTML element containing the editor.
     *
     * @example
     * ```ts
     * const container = editor.getContainer()
     * ```
     *
     * @public
     */
    getContainer: () => HTMLElement;
    /**
     * The document that the editor's container element belongs to.
     * Use this instead of the global `document` to support cross-window embedding.
     *
     * @internal
     */
    getContainerDocument(): Document;
    /**
     * The window that the editor's container element belongs to.
     * Use this instead of the global `window` to support cross-window embedding.
     *
     * @internal
     */
    getContainerWindow(): Window & typeof globalThis;
    /**
     * Dispose the editor.
     *
     * @public
     */
    dispose(): void;
    /**
     * Get the current color mode (`'light'` or `'dark'`), based on the user's dark mode preference.
     *
     * @public
     */
    getColorMode(): 'light' | 'dark';
    /**
     * Set the color mode. Note that this is a convenience method that passes the mode to
     * `user.updateUserPreferences`, which is the source of truth for the user's color mode preference.
     *
     * @public
     */
    setColorMode(mode: 'light' | 'dark'): this;
    /**
     * Get the id of the current theme.
     *
     * @public
     */
    getCurrentThemeId(): TLThemeId;
    /**
     * Get the current theme definition.
     *
     * @public
     */
    getCurrentTheme(): TLTheme;
    /**
     * Set the current theme by id.
     *
     * @public
     */
    setCurrentTheme(id: TLThemeId): this;
    /**
     * Get all registered theme definitions.
     *
     * @public
     */
    getThemes(): TLThemes;
    /**
     * Get a single theme definition by id.
     *
     * @public
     */
    getTheme(id: TLThemeId): TLTheme | undefined;
    /**
     * Replace all theme definitions, or update them via a callback that receives a deep copy.
     * The `'default'` theme must always be present in the result.
     *
     * @example
     * ```ts
     * // Replace all themes
     * editor.updateThemes({ default: myDefaultTheme, ocean: myOceanTheme })
     *
     * // Update via callback
     * editor.updateThemes((themes) => {
     *   delete themes.ocean
     *   return themes
     * })
     * ```
     *
     * @public
     */
    updateThemes(themes: TLThemes | ((themes: TLThemes) => TLThemes)): this;
    /**
     * Register or update a single theme definition. The theme is keyed by its `id` property.
     *
     * @example
     * ```ts
     * // Override a property on the default theme
     * editor.updateTheme({ ...editor.getTheme('default')!, fontSize: 24 })
     *
     * // Register a new theme
     * editor.updateTheme({ id: 'ocean', ...myOceanTheme })
     * ```
     *
     * @public
     */
    updateTheme(theme: TLTheme): this;
    /**
     * A map of shape utility classes (TLShapeUtils) by shape type.
     *
     * @public
     */
    shapeUtils: {
        readonly [K in string]?: ShapeUtil<TLShape>;
    };
    /** @internal */
    private _shapeUtilsByAssetType;
    styleProps: {
        [key: string]: Map<StyleProp<any>, string>;
    };
    /**
     * Get a shape util from a shape itself.
     *
     * @example
     * ```ts
     * const util = editor.getShapeUtil(myArrowShape)
     * const util = editor.getShapeUtil('arrow')
     * const util = editor.getShapeUtil<TLArrowShape>(myArrowShape)
     * const util = editor.getShapeUtil(TLArrowShape)('arrow')
     * ```
     *
     * @param shape - A shape, shape partial, or shape type.
     *
     * @public
     */
    getShapeUtil<K extends TLShape['type']>(type: K): ShapeUtil<Extract<TLShape, {
        type: K;
    }>>;
    getShapeUtil<S extends TLShape>(shape: S | TLShapePartial<S> | S['type']): ShapeUtil<S>;
    getShapeUtil<T extends ShapeUtil>(type: T extends ShapeUtil<infer R> ? R['type'] : string): T;
    /**
     * Returns true if the editor has a shape util for the given shape / shape type.
     *
     * @param shape - A shape, shape partial, or shape type.
     */
    hasShapeUtil(shape: TLShape | TLShapePartial<TLShape>): boolean;
    hasShapeUtil(type: TLShape['type']): boolean;
    hasShapeUtil<T extends ShapeUtil>(type: T extends ShapeUtil<infer R> ? R['type'] : string): boolean;
    /**
     * Get the shape util that handles the given asset type.
     * Returns the shape util whose {@link ShapeUtil.handledAssetTypes} includes
     * the given asset type, or undefined if none matches.
     *
     * @param assetType - The asset type string.
     * @public
     */
    getShapeUtilForAssetType(assetType: string): ShapeUtil | undefined;
    /**
     * A map of shape utility classes (TLShapeUtils) by shape type.
     *
     * @public
     */
    bindingUtils: {
        readonly [K in string]?: BindingUtil<TLBinding>;
    };
    /**
     * Get a binding util from a binding itself.
     *
     * @example
     * ```ts
     * const util = editor.getBindingUtil(myArrowBinding)
     * const util = editor.getBindingUtil('arrow')
     * const util = editor.getBindingUtil<TLArrowBinding>(myArrowBinding)
     * const util = editor.getBindingUtil(TLArrowBinding)('arrow')
     * ```
     *
     * @param binding - A binding, binding partial, or binding type.
     *
     * @public
     */
    getBindingUtil<K extends TLBinding['type']>(type: K): BindingUtil<Extract<TLBinding, {
        type: K;
    }>>;
    getBindingUtil<S extends TLBinding>(binding: S | {
        type: S['type'];
    }): BindingUtil<S>;
    getBindingUtil<T extends BindingUtil>(type: T extends BindingUtil<infer R> ? R['type'] : string): T;
    /**
     * A map of asset utility classes by asset type.
     *
     * @public
     */
    assetUtils: {
        readonly [K in string]?: AssetUtil<TLAsset>;
    };
    /**
     * Get an asset util from an asset or asset type.
     *
     * @param arg - An asset, asset type string, or object with type.
     *
     * @public
     */
    getAssetUtil<S extends TLAsset>(asset: S | {
        type: S['type'];
    }): AssetUtil<S>;
    getAssetUtil(type: string): AssetUtil;
    /**
     * Returns true if the editor has an asset util for the given asset type.
     *
     * @public
     */
    hasAssetUtil(arg: string | {
        type: string;
    }): boolean;
    /**
     * Get the asset util that accepts the given MIME type.
     * Returns null if no registered asset util accepts the MIME type.
     *
     * @public
     */
    getAssetUtilForMimeType(mimeType: string): AssetUtil | null;
    /**
     * A manager for the editor's history.
     *
     * @readonly
     */
    protected readonly history: HistoryManager<TLRecord>;
    /**
     * Undo to the last mark.
     *
     * @example
     * ```ts
     * editor.undo()
     * ```
     *
     * @public
     */
    undo(): this;
    /**
     * Whether the editor can undo.
     *
     * @public
     */
    canUndo(): boolean;
    getCanUndo(): boolean;
    /**
     * Redo to the next mark.
     *
     * @example
     * ```ts
     * editor.redo()
     * ```
     *
     * @public
     */
    redo(): this;
    /**
     * Whether the editor can redo.
     *
     * @public
     */
    canRedo(): boolean;
    getCanRedo(): boolean;
    clearHistory(): this;
    /**
     * Create a new "mark", or stopping point, in the undo redo history. Creating a mark will clear
     * any redos. You typically want to do this just before a user interaction begins or is handled.
     *
     * @example
     * ```ts
     * editor.markHistoryStoppingPoint()
     * editor.flipShapes(editor.getSelectedShapes())
     * ```
     * @example
     * ```ts
     * const beginRotateMark = editor.markHistoryStoppingPoint()
     * // if the use cancels the rotation, you can bail back to this mark
     * editor.bailToMark(beginRotateMark)
     * ```
     *
     * @public
     * @param name - The name of the mark, useful for debugging the undo/redo stacks
     * @returns a unique id for the mark that can be used with `squashToMark` or `bailToMark`.
     */
    markHistoryStoppingPoint(name?: string): string;
    /**
     * @internal this is only used to implement some backwards-compatibility logic. Should be fine to delete after 6 months or whatever.
     */
    getMarkIdMatching(idSubstring: string): string | null;
    /**
     * Whether the editor is currently replaying history (i.e. an undo or redo is being applied).
     *
     * @internal
     */
    isReplayingHistory(): boolean;
    /**
     * Coalesces all changes since the given mark into a single change, removing any intermediate marks.
     *
     * This is useful if you need to 'compress' the recent history to simplify the undo/redo experience of a complex interaction.
     *
     * @example
     * ```ts
     * const bumpShapesMark = editor.markHistoryStoppingPoint()
     * // ... some changes
     * editor.squashToMark(bumpShapesMark)
     * ```
     *
     * @param markId - The mark id to squash to.
     */
    squashToMark(markId: string): this;
    /**
     * Undo to the closest mark, discarding the changes so they cannot be redone.
     *
     * @example
     * ```ts
     * editor.bail()
     * ```
     *
     * @public
     */
    bail(): this;
    /**
     * Undo to the given mark, discarding the changes so they cannot be redone.
     *
     * @example
     * ```ts
     * const beginDrag = editor.markHistoryStoppingPoint()
     * // ... some changes
     * editor.bailToMark(beginDrag)
     * ```
     *
     * @public
     */
    bailToMark(id: string): this;
    private _shouldIgnoreShapeLock;
    /**
     * Run a function in a transaction with optional options for context.
     * You can use the options to change the way that history is treated
     * or allow changes to locked shapes.
     *
     * @example
     * ```ts
     * // updating with
     * editor.run(() => {
     * 	editor.updateShape({ ...myShape, x: 100 })
     * }, { history: "ignore" })
     *
     * // forcing changes / deletions for locked shapes
     * editor.toggleLock([myShape])
     * editor.run(() => {
     * 	editor.updateShape({ ...myShape, x: 100 })
     * 	editor.deleteShape(myShape)
     * }, { ignoreShapeLock: true }, )
     * ```
     *
     * @param fn - The callback function to run.
     * @param opts - The options for the batch.
     *
     *
     * @public
     */
    run(fn: () => void, opts?: TLEditorRunOptions): this;
    /** @internal */
    annotateError(error: unknown, { origin, willCrashApp, tags, extras }: {
        origin: string;
        willCrashApp: boolean;
        tags?: Record<string, string | boolean | number>;
        extras?: Record<string, unknown>;
    }): this;
    /** @internal */
    createErrorAnnotations(origin: string, willCrashApp: boolean | 'unknown'): {
        tags: {
            origin: string;
            willCrashApp: "unknown" | boolean;
        };
        extras: {
            activeStateNode: string;
            selectedShapes: ({
                id: TLShapeId;
                typeName: "shape";
                type: "arrow";
                x: number;
                y: number;
                rotation: number;
                index: IndexKey;
                parentId: TLParentId;
                isLocked: boolean;
                opacity: number;
                meta: JsonObject;
                props: any;
            } | {
                id: TLShapeId;
                typeName: "shape";
                type: "my-custom-shape";
                x: number;
                y: number;
                rotation: number;
                index: IndexKey;
                parentId: TLParentId;
                isLocked: boolean;
                opacity: number;
                meta: JsonObject;
                props: any;
            } | {
                id: TLShapeId;
                typeName: "shape";
                type: "test-shape";
                x: number;
                y: number;
                rotation: number;
                index: IndexKey;
                parentId: TLParentId;
                isLocked: boolean;
                opacity: number;
                meta: JsonObject;
                props: any;
            } | {
                id: TLShapeId;
                typeName: "shape";
                type: "bookmark";
                x: number;
                y: number;
                rotation: number;
                index: IndexKey;
                parentId: TLParentId;
                isLocked: boolean;
                opacity: number;
                meta: JsonObject;
                props: any;
            } | {
                id: TLShapeId;
                typeName: "shape";
                type: "draw";
                x: number;
                y: number;
                rotation: number;
                index: IndexKey;
                parentId: TLParentId;
                isLocked: boolean;
                opacity: number;
                meta: JsonObject;
                props: any;
            } | {
                id: TLShapeId;
                typeName: "shape";
                type: "embed";
                x: number;
                y: number;
                rotation: number;
                index: IndexKey;
                parentId: TLParentId;
                isLocked: boolean;
                opacity: number;
                meta: JsonObject;
                props: any;
            } | {
                id: TLShapeId;
                typeName: "shape";
                type: "frame";
                x: number;
                y: number;
                rotation: number;
                index: IndexKey;
                parentId: TLParentId;
                isLocked: boolean;
                opacity: number;
                meta: JsonObject;
                props: any;
            } | {
                id: TLShapeId;
                typeName: "shape";
                type: "geo";
                x: number;
                y: number;
                rotation: number;
                index: IndexKey;
                parentId: TLParentId;
                isLocked: boolean;
                opacity: number;
                meta: JsonObject;
                props: any;
            } | {
                id: TLShapeId;
                typeName: "shape";
                type: "group";
                x: number;
                y: number;
                rotation: number;
                index: IndexKey;
                parentId: TLParentId;
                isLocked: boolean;
                opacity: number;
                meta: JsonObject;
                props: any;
            } | {
                id: TLShapeId;
                typeName: "shape";
                type: "highlight";
                x: number;
                y: number;
                rotation: number;
                index: IndexKey;
                parentId: TLParentId;
                isLocked: boolean;
                opacity: number;
                meta: JsonObject;
                props: any;
            } | {
                id: TLShapeId;
                typeName: "shape";
                type: "image";
                x: number;
                y: number;
                rotation: number;
                index: IndexKey;
                parentId: TLParentId;
                isLocked: boolean;
                opacity: number;
                meta: JsonObject;
                props: any;
            } | {
                id: TLShapeId;
                typeName: "shape";
                type: "line";
                x: number;
                y: number;
                rotation: number;
                index: IndexKey;
                parentId: TLParentId;
                isLocked: boolean;
                opacity: number;
                meta: JsonObject;
                props: any;
            } | {
                id: TLShapeId;
                typeName: "shape";
                type: "note";
                x: number;
                y: number;
                rotation: number;
                index: IndexKey;
                parentId: TLParentId;
                isLocked: boolean;
                opacity: number;
                meta: JsonObject;
                props: any;
            } | {
                id: TLShapeId;
                typeName: "shape";
                type: "text";
                x: number;
                y: number;
                rotation: number;
                index: IndexKey;
                parentId: TLParentId;
                isLocked: boolean;
                opacity: number;
                meta: JsonObject;
                props: any;
            } | {
                id: TLShapeId;
                typeName: "shape";
                type: "video";
                x: number;
                y: number;
                rotation: number;
                index: IndexKey;
                parentId: TLParentId;
                isLocked: boolean;
                opacity: number;
                meta: JsonObject;
                props: any;
            })[];
            selectionCount: number;
            editingShape: TLShape | undefined;
            inputs: {
                originPagePoint: import("@tldraw/tlschema").VecModel;
                originScreenPoint: import("@tldraw/tlschema").VecModel;
                previousPagePoint: import("@tldraw/tlschema").VecModel;
                previousScreenPoint: import("@tldraw/tlschema").VecModel;
                currentPagePoint: import("@tldraw/tlschema").VecModel;
                currentScreenPoint: import("@tldraw/tlschema").VecModel;
                pointerVelocity: import("@tldraw/tlschema").VecModel;
                shiftKey: boolean;
                metaKey: boolean;
                ctrlKey: boolean;
                altKey: boolean;
                isPen: boolean;
                isDragging: boolean;
                isPointing: boolean;
                isPinching: boolean;
                isEditing: boolean;
                isPanning: boolean;
                isSpacebarPanning: boolean;
                keys: string[];
                buttons: number[];
            };
            pageState: TLInstancePageState;
            instanceState: TLInstance;
            collaboratorCount: number;
        };
    } | {
        tags: {
            origin: string;
            willCrashApp: "unknown" | boolean;
        };
        extras: {
            activeStateNode?: undefined;
            selectedShapes?: undefined;
            selectionCount?: undefined;
            editingShape?: undefined;
            inputs?: undefined;
            pageState?: undefined;
            instanceState?: undefined;
            collaboratorCount?: undefined;
        };
    };
    /** @internal */
    private _crashingError;
    /**
     * We can't use an `atom` here because there's a chance that when `crashAndReportError` is called,
     * we're in a transaction that's about to be rolled back due to the same error we're currently
     * reporting.
     *
     * Instead, to listen to changes to this value, you need to listen to editor's `crash` event.
     *
     * @internal
     */
    getCrashingError(): unknown;
    /** @internal */
    crash(error: unknown): this;
    /**
     * The editor's current path of active states.
     *
     * @example
     * ```ts
     * editor.getPath() // "select.idle"
     * ```
     *
     * @public
     */
    getPath(): string;
    /**
     * Get whether a certain tool (or other state node) is currently active.
     *
     * @example
     * ```ts
     * editor.isIn('select')
     * editor.isIn('select.brushing')
     * ```
     *
     * @param path - The path of active states, separated by periods.
     *
     * @public
     */
    isIn(path: string): boolean;
    /**
     * Get whether the state node is in any of the given active paths.
     *
     * @example
     * ```ts
     * state.isInAny('select', 'erase')
     * state.isInAny('select.brushing', 'erase.idle')
     * ```
     *
     * @public
     */
    isInAny(...paths: string[]): boolean;
    /**
     * Set the selected tool.
     *
     * @example
     * ```ts
     * editor.setCurrentTool('hand')
     * editor.setCurrentTool('hand', { date: Date.now() })
     * ```
     *
     * @param id - The id of the tool to select.
     * @param info - Arbitrary data to pass along into the transition.
     *
     * @public
     */
    setCurrentTool(id: string, info?: {}): this;
    /**
     * The current selected tool.
     *
     * @public
     */
    getCurrentTool(): StateNode;
    /**
     * The id of the current selected tool.
     *
     * @public
     */
    getCurrentToolId(): string;
    /**
     * Get a descendant by its path.
     *
     * @example
     * ```ts
     * editor.getStateDescendant('select')
     * editor.getStateDescendant('select.brushing')
     * ```
     *
     * @param path - The descendant's path of state ids, separated by periods.
     *
     * @public
     */
    getStateDescendant<T extends StateNode>(path: string): T | undefined;
    /**
     * The global document settings that apply to all users.
     *
     * @public
     **/
    getDocumentSettings(): TLDocument;
    /**
     * Update the global document settings that apply to all users.
     *
     * @public
     **/
    updateDocumentSettings(settings: Partial<TLDocument>): this;
    /**
     * The current instance's state.
     *
     * @public
     */
    getInstanceState(): TLInstance;
    /**
     * Update the instance's state.
     *
     * @param partial - A partial object to update the instance state with.
     * @param historyOptions - History batch options.
     *
     * @public
     */
    updateInstanceState(partial: Partial<Omit<TLInstance, 'currentPageId'>>, historyOptions?: TLHistoryBatchOptions): this;
    /** @internal */
    _updateInstanceState(partial: Partial<Omit<TLInstance, 'currentPageId'>>, opts?: TLHistoryBatchOptions): void;
    /** @internal */
    private _isChangingStyleTimeout;
    menus: {
        getOpenMenus: () => string[];
        addOpenMenu: (id: string) => void;
        deleteOpenMenu: (id: string) => void;
        clearOpenMenus: () => void;
        isMenuOpen: (id: string) => boolean;
        hasOpenMenus: () => boolean;
        hasAnyOpenMenus: () => boolean;
    };
    /**
     * Set the cursor.
     *
     * No-op when the partial wouldn't change the current cursor — `setCursor`
     * is called from pointer-move hot paths (see `updateHoveredOverlayId`,
     * various tool states) and skipping redundant writes avoids needlessly
     * dirtying instance state.
     *
     * @param cursor - The cursor to set.
     * @public
     */
    setCursor(cursor: Partial<TLCursor>): this;
    /**
     * Page states.
     *
     * @public
     */
    getPageStates(): TLInstancePageState[];
    private _getPageStatesQuery;
    /**
     * The current page state.
     *
     * @public
     */
    getCurrentPageState(): TLInstancePageState;
    private _getCurrentPageStateId;
    /**
     * Update this instance's page state.
     *
     * @example
     * ```ts
     * editor.updateCurrentPageState({ id: 'page1', editingShapeId: 'shape:123' })
     * ```
     *
     * @param partial - The partial of the page state object containing the changes.
     *
     * @public
     */
    updateCurrentPageState(partial: Partial<Omit<TLInstancePageState, 'selectedShapeIds' | 'editingShapeId' | 'pageId' | 'focusedGroupId'>>): this;
    _updateCurrentPageState(partial: Partial<Omit<TLInstancePageState, 'selectedShapeIds'>>): void;
    /**
     * The current selected ids.
     *
     * @public
     */
    getSelectedShapeIds(): TLShapeId[];
    /**
     * An array containing all of the currently selected shapes.
     *
     * @public
     * @readonly
     */
    getSelectedShapes(): TLShape[];
    /**
     * Select one or more shapes.
     *
     * @example
     * ```ts
     * editor.setSelectedShapes(['id1'])
     * editor.setSelectedShapes(['id1', 'id2'])
     * ```
     *
     * @param shapes - The shape (or shape ids) to select.
     *
     * @public
     */
    setSelectedShapes(shapes: TLShapeId[] | TLShape[]): this;
    /**
     * Determine whether or not any of a shape's ancestors are selected.
     *
     * @param shape - The shape (or shape id) of the shape to check.
     *
     * @public
     */
    isAncestorSelected(shape: TLShape | TLShapeId): boolean;
    /**
     * Select one or more shapes.
     *
     * @example
     * ```ts
     * editor.select('id1')
     * editor.select('id1', 'id2')
     * ```
     *
     * @param shapes - The shape (or the shape ids) to select.
     *
     * @public
     */
    select(...shapes: TLShapeId[] | TLShape[]): this;
    /**
     * Remove a shape from the existing set of selected shapes.
     *
     * @example
     * ```ts
     * editor.deselect(shape.id)
     * ```
     *
     * @public
     */
    deselect(...shapes: TLShapeId[] | TLShape[]): this;
    /**
     * Select all shapes. If the user has selected shapes that share a parent,
     * select all shapes within that parent. If the user has not selected any shapes,
     * or if the shapes shapes are only on select all shapes on the current page.
     *
     * @example
     * ```ts
     * editor.selectAll()
     * ```
     *
     * @public
     */
    selectAll(): this;
    /**
     * Select the next shape in the reading order or in cardinal order.
     *
     * @example
     * ```ts
     * editor.selectAdjacentShape('next')
     * ```
     *
     * @public
     */
    selectAdjacentShape(direction: TLAdjacentDirection): void;
    /**
     * Generates a reading order for shapes based on rows grouping.
     * Tries to keep a natural reading order (left-to-right, top-to-bottom).
     *
     * @public
     */
    getCurrentPageShapesInReadingOrder(): TLShape[];
    private _getShapesInReadingOrder;
    /**
     * Find the nearest adjacent shape in a specific direction.
     *
     * @public
     */
    getNearestAdjacentShape(shapes: TLShape[], currentShapeId: TLShapeId, direction: 'left' | 'right' | 'up' | 'down'): TLShapeId;
    selectParentShape(): void;
    selectFirstChildShape(): void;
    private _selectShapesAndZoom;
    /**
     * Clear the selection.
     *
     * @example
     * ```ts
     * editor.selectNone()
     * ```
     *
     * @public
     */
    selectNone(): this;
    /**
     * The id of the editor's only selected shape.
     *
     * @returns Null if there is no shape or more than one selected shape, otherwise the selected shape's id.
     *
     * @public
     * @readonly
     */
    getOnlySelectedShapeId(): TLShapeId | null;
    /**
     * The editor's only selected shape.
     *
     * @returns Null if there is no shape or more than one selected shape, otherwise the selected shape.
     *
     * @public
     * @readonly
     */
    getOnlySelectedShape(): TLShape | null;
    /**
     * Get the page bounds of all the provided shapes.
     *
     * @public
     */
    getShapesPageBounds(shapeIds: TLShapeId[]): Box | null;
    /**
     * The current page bounds of all the selected shapes. If the
     * selection is rotated, then these bounds are the axis-aligned
     * box that the rotated bounds would fit inside of.
     *
     * @readonly
     *
     * @public
     */
    getSelectionPageBounds(): Box | null;
    /**
     * The bounds of the selection bounding box in the current page space.
     *
     * @readonly
     * @public
     */
    getSelectionScreenBounds(): Box | undefined;
    /**
     * @internal
     */
    getShapesSharedRotation(shapeIds: TLShapeId[]): number;
    /**
     * The rotation of the selection bounding box in the current page space.
     *
     * @readonly
     * @public
     */
    getSelectionRotation(): number;
    /**
     * @internal
     */
    getShapesRotatedPageBounds(shapeIds: TLShapeId[]): Box | undefined;
    /**
     * The bounds of the selection bounding box in the current page space.
     *
     * @readonly
     * @public
     */
    getSelectionRotatedPageBounds(): Box | undefined;
    /**
     * The bounds of the selection bounding box in the current page space.
     *
     * @readonly
     * @public
     */
    getSelectionRotatedScreenBounds(): Box | undefined;
    /**
     * The current focused group id.
     *
     * @public
     */
    getFocusedGroupId(): TLShapeId | TLPageId;
    /**
     * The current focused group.
     *
     * @public
     */
    getFocusedGroup(): TLShape | undefined;
    /**
     * Set the current focused group shape.
     *
     * @param shape - The group shape id (or group shape's id) to set as the focused group shape.
     *
     * @public
     */
    setFocusedGroup(shape: TLShapeId | TLGroupShape | null): this;
    /**
     * Exit the current focused group, moving up to the next parent group if there is one.
     *
     * @public
     */
    popFocusedGroupId(): this;
    /**
     * The current editing shape's id.
     *
     * @public
     */
    getEditingShapeId(): TLShapeId | null;
    /**
     * The current editing shape.
     *
     * @public
     */
    getEditingShape(): TLShape | undefined;
    /**
     * Whether the shape can be edited.
     *
     * @param shape - The shape (or shape id) to check if it can be edited.
     * @param info - The info about the edit start.
     *
     * @public
     * @returns true if the shape can be edited, false otherwise.
     */
    canEditShape<T extends TLShape | TLShapeId>(shape: T | null, info?: TLEditStartInfo): shape is T;
    /**
     * Set the current editing shape.
     *
     * @example
     * ```ts
     * editor.setEditingShape(myShape)
     * editor.setEditingShape(myShape.id)
     * ```
     *
     * @param shape - The shape (or shape id) to set as editing.
     *
     * @public
     */
    setEditingShape(shape: TLShapeId | TLShape | null): this;
    private _currentRichTextEditor;
    /**
     * The current editing shape's text editor.
     *
     * @public
     */
    getRichTextEditor(): TiptapEditor | null;
    /**
     * Set the current editing shape's rich text editor.
     *
     * @example
     * ```ts
     * editor.setRichTextEditor(richTextEditorView)
     * ```
     *
     * @param textEditor - The text editor to set as the current editing shape's text editor.
     *
     * @public
     */
    setRichTextEditor(textEditor: TiptapEditor | null): this;
    /**
     * The current hovered shape id.
     *
     * @readonly
     * @public
     */
    getHoveredShapeId(): TLShapeId | null;
    /**
     * The current hovered shape.
     *
     * @public
     */
    getHoveredShape(): TLShape | undefined;
    /**
     * Set the editor's current hovered shape.
     *
     * @example
     * ```ts
     * editor.setHoveredShape(myShape)
     * editor.setHoveredShape(myShape.id)
     * ```
     *
     * @param shape - The shape (or shape id) to set as hovered.
     *
     * @public
     */
    setHoveredShape(shape: TLShapeId | TLShape | null): this;
    /**
     * The editor's current hinting shape ids.
     *
     * @public
     */
    getHintingShapeIds(): TLShapeId[];
    /**
     * The editor's current hinting shapes.
     *
     * @public
     */
    getHintingShape(): NonNullable<TLShape | undefined>[];
    /**
     * Set the editor's current hinting shapes.
     *
     * @example
     * ```ts
     * editor.setHintingShapes([myShape])
     * editor.setHintingShapes([myShape.id])
     * ```
     *
     * @param shapes - The shapes (or shape ids) to set as hinting.
     *
     * @public
     */
    setHintingShapes(shapes: TLShapeId[] | TLShape[]): this;
    /**
     * The editor's current erasing ids.
     *
     * @public
     */
    getErasingShapeIds(): TLShapeId[];
    /**
     * The editor's current erasing shapes.
     *
     * @public
     */
    getErasingShapes(): NonNullable<TLShape | undefined>[];
    /**
     * Set the editor's current erasing shapes.
     *
     * @example
     * ```ts
     * editor.setErasingShapes([myShape])
     * editor.setErasingShapes([myShape.id])
     * ```
     *
     * @param shapes - The shapes (or shape ids) to set as hinting.
     *
     * @public
     */
    setErasingShapes(shapes: TLShapeId[] | TLShape[]): this;
    /**
     * The current cropping shape's id.
     *
     * @public
     */
    getCroppingShapeId(): TLShapeId | null;
    /**
     * Whether the shape can be cropped.
     *
     * @param shape - The shape (or shape id) to check if it can be cropped.
     *
     * @public
     * @returns true if the shape can be cropped, false otherwise.
     */
    canCropShape<T extends TLShape | TLShapeId>(shape: T | null): shape is T;
    /**
     * Set the current cropping shape.
     *
     * @example
     * ```ts
     * editor.setCroppingShape(myShape)
     * editor.setCroppingShape(myShape.id)
     * ```
     *
     *
     * @param shape - The shape (or shape id) to set as cropping.
     *
     * @public
     */
    setCroppingShape(shape: TLShapeId | TLShape | null): this;
    private _textOptions;
    /**
     * Get the current text options.
     *
     * @example
     * ```ts
     * editor.getTextOptions()
     * ```
     *
     *  @public */
    getTextOptions(): TLTextOptions;
    private _unsafe_getCameraId;
    /**
     * The current camera.
     *
     * @public
     */
    getCamera(): TLCamera;
    private _getFollowingPresence;
    private getViewportPageBoundsForFollowing;
    private getCameraForFollowing;
    /**
     * The current camera zoom level.
     *
     * @public
     */
    getZoomLevel(): number;
    /**
     * Get the scale factor used when creating or resizing shapes in dynamic size mode.
     *
     * @public
     */
    getResizeScaleFactor(): number;
    private _debouncedZoomLevel;
    /**
     * Get the debounced zoom level. When the camera is moving, this returns the zoom level
     * from when the camera started moving rather than the current zoom level. This can be
     * used to avoid expensive re-renders during camera movements.
     *
     * This behavior is controlled by the `useDebouncedZoom` option. When `useDebouncedZoom`
     * is `false`, this method always returns the current zoom level.
     *
     * @public
     */
    getDebouncedZoomLevel(): number;
    private _getAboveDebouncedZoomThreshold;
    /**
     * Get the efficient zoom level. This returns the current zoom level if there are less than a certain number of shapes on the page,
     * otherwise it returns the debounced zoom level. This can be used to avoid expensive re-renders during camera movements.
     *
     * @public
     * @example
     * ```ts
     * editor.getEfficientZoomLevel()
     * ```
     *
     * @public
     */
    getEfficientZoomLevel(): number;
    /**
     * Get the camera's initial or reset zoom level.
     *
     * @example
     * ```ts
     * editor.getInitialZoom()
     * ```
     *
     * @public */
    getInitialZoom(): number;
    /**
     * Get the camera's base level for calculating actual zoom levels based on the zoom steps.
     *
     * @example
     * ```ts
     * editor.getBaseZoom()
     * ```
     *
     * @public */
    getBaseZoom(): number;
    private _cameraOptions;
    /**
     * Get the current camera options.
     *
     * @example
     * ```ts
     * editor.getCameraOptions()
     * ```
     *
     *  @public */
    getCameraOptions(): TLCameraOptions;
    /**
     * Set the camera options. Changing the options won't immediately change the camera itself, so you may want to call `setCamera` after changing the options.
     *
     * @example
     * ```ts
     * editor.setCameraOptions(myCameraOptions)
     * editor.setCamera(editor.getCamera())
     * ```
     *
     * @param opts - The camera options to set.
     *
     * @public */
    setCameraOptions(opts: Partial<TLCameraOptions>): this;
    /** @internal */
    private getConstrainedCamera;
    /** @internal */
    private _setCamera;
    /**
     * Set the current camera.
     *
     * @example
     * ```ts
     * editor.setCamera({ x: 0, y: 0})
     * editor.setCamera({ x: 0, y: 0, z: 1.5})
     * editor.setCamera({ x: 0, y: 0, z: 1.5}, { animation: { duration: 1000, easing: (t) => t * t } })
     * ```
     *
     * @param point - The new camera position.
     * @param opts - The camera move options.
     *
     * @public
     */
    setCamera(point: VecLike, opts?: TLCameraMoveOptions): this;
    /**
     * Center the camera on a point (in the current page space).
     *
     * @example
     * ```ts
     * editor.centerOnPoint({ x: 100, y: 100 })
     * editor.centerOnPoint({ x: 100, y: 100 }, { animation: { duration: 200 } })
     * ```
     *
     * @param point - The point in the current page space to center on.
     * @param opts - The camera move options.
     *
     * @public
     */
    centerOnPoint(point: VecLike, opts?: TLCameraMoveOptions): this;
    /**
     * Zoom the camera to fit the current page's content in the viewport.
     *
     * @example
     * ```ts
     * editor.zoomToFit()
     * editor.zoomToFit({ animation: { duration: 200 } })
     * ```
     *
     * @param opts - The camera move options.
     *
     * @public
     */
    zoomToFit(opts?: TLCameraMoveOptions): this;
    /**
     * Set the zoom back to 100%.
     *
     * @example
     * ```ts
     * editor.resetZoom()
     * editor.resetZoom(editor.getViewportScreenCenter(), { animation: { duration: 200 } })
     * editor.resetZoom(editor.getViewportScreenCenter(), { animation: { duration: 200 } })
     * ```
     *
     * @param point - The screen point to zoom out on. Defaults to the viewport screen center.
     * @param opts - The camera move options.
     *
     * @public
     */
    resetZoom(point?: Vec, opts?: TLCameraMoveOptions): this;
    /**
     * Zoom the camera in.
     *
     * @example
     * ```ts
     * editor.zoomIn()
     * editor.zoomIn(editor.getViewportScreenCenter(), { animation: { duration: 200 } })
     * editor.zoomIn(editor.inputs.getCurrentScreenPoint(), { animation: { duration: 200 } })
     * ```
     *
     * @param point - The screen point to zoom in on. Defaults to the screen center
     * @param opts - The camera move options.
     *
     * @public
     */
    zoomIn(point?: Vec, opts?: TLCameraMoveOptions): this;
    /**
     * Zoom the camera out.
     *
     * @example
     * ```ts
     * editor.zoomOut()
     * editor.zoomOut(editor.getViewportScreenCenter(), { animation: { duration: 120 } })
     * editor.zoomOut(editor.inputs.getCurrentScreenPoint(), { animation: { duration: 120 } })
     * ```
     *
     * @param point - The point to zoom out on. Defaults to the viewport screen center.
     * @param opts - The camera move options.
     *
     * @public
     */
    zoomOut(point?: Vec, opts?: TLCameraMoveOptions): this;
    /**
     * Zoom the camera to fit the current selection in the viewport.
     *
     * @example
     * ```ts
     * editor.zoomToSelection()
     * editor.zoomToSelection({ animation: { duration: 200 } })
     * ```
     *
     * @param opts - The camera move options.
     *
     * @public
     */
    zoomToSelection(opts?: TLCameraMoveOptions): this;
    /**
     * Zoom the camera to the current selection if offscreen.
     *
     * @public
     */
    zoomToSelectionIfOffscreen(padding?: number, opts?: {
        targetZoom?: number;
        inset?: number;
    } & TLCameraMoveOptions): void;
    /**
     * Zoom the camera to fit a bounding box (in the current page space).
     *
     * @example
     * ```ts
     * editor.zoomToBounds(myBounds)
     * editor.zoomToBounds(myBounds, { animation: { duration: 200 } })
     * editor.zoomToBounds(myBounds, { animation: { duration: 200 }, inset: 0, targetZoom: 1 })
     * ```
     *
     * @param bounds - The bounding box.
     * @param opts - The camera move options, target zoom, or custom inset amount.
     *
     * @public
     */
    zoomToBounds(bounds: BoxLike, opts?: {
        targetZoom?: number;
        inset?: number;
    } & TLCameraMoveOptions): this;
    /**
     * Stop the current camera animation, if any.
     *
     * @example
     * ```ts
     * editor.stopCameraAnimation()
     * ```
     *
     * @public
     */
    stopCameraAnimation(): this;
    /** @internal */
    private _viewportAnimation;
    /** @internal */
    private _animateViewport;
    /** @internal */
    private _animateToViewport;
    /**
     * Slide the camera in a certain direction.
     *
     * @example
     * ```ts
     * editor.slideCamera({ speed: 1, direction: { x: 1, y: 0 }, friction: 0.1 })
     * ```
     *
     * @param opts - Options for the slide
     * @public
     */
    slideCamera(opts?: {
        speed: number;
        direction: VecLike;
        friction?: number | undefined;
        speedThreshold?: number | undefined;
        force?: boolean | undefined;
    }): this;
    /**
     * Animate the camera to a user's cursor position. This also briefly show the user's cursor if it's not currently visible.
     *
     * @example
     * ```ts
     * editor.zoomToUser(myUserId)
     * editor.zoomToUser(myUserId, { animation: { duration: 200 } })
     * ```
     *
     * @param userId - The id of the user to animate to.
     * @param opts - The camera move options.
     * @public
     */
    zoomToUser(userId: TLUserId, opts?: TLCameraMoveOptions): this;
    /** @internal */
    private _willSetInitialBounds;
    /** @internal */
    private _viewports;
    /** @public */
    registerViewport(viewport: TLViewport): () => void;
    /** @public */
    updateViewport(id: TLViewportId, patch: Partial<TLViewport>): this;
    /** @public */
    getViewport(id?: TLViewportId): TLViewport;
    /** @internal */
    private _resolveViewport;
    /**
     * Update the viewport. The viewport will measure the size and screen position of its container
     * element. This should be done whenever the container's position on the screen changes.
     *
     * @example
     * ```ts
     * editor.updateViewportScreenBounds(new Box(0, 0, 1280, 1024))
     * editor.updateViewportScreenBounds(new Box(0, 0, 1280, 1024), true)
     * ```
     *
     * @param screenBounds - The new screen bounds of the viewport.
     * @param center - Whether to preserve the viewport page center as the viewport changes.
     *
     * @public
     */
    updateViewportScreenBounds(screenBounds: Box | HTMLElement, center?: boolean): this;
    /**
     * The bounds of the editor's viewport in screen space.
     *
     * @public
     */
    getViewportScreenBounds(): Box;
    /**
     * The center of the editor's viewport in screen space.
     *
     * @public
     */
    getViewportScreenCenter(): Vec;
    /**
     * The current viewport in the current page space.
     *
     * @public
     */
    getViewportPageBounds(opts?: TLViewportOptions): Box;
    /**
     * Convert a point in screen space to a point in the current page space.
     *
     * @example
     * ```ts
     * editor.screenToPage({ x: 100, y: 100 })
     * ```
     *
     * @param point - The point in screen space.
     * @param opts - Options for using a registered viewport.
     *
     * @public
     */
    screenToPage(point: VecLike, opts?: TLViewportOptions): Vec;
    /**
     * Convert a point in the current page space to a point in current screen space.
     *
     * @example
     * ```ts
     * editor.pageToScreen({ x: 100, y: 100 })
     * ```
     *
     * @param point - The point in page space.
     * @param opts - Options for using a registered viewport.
     *
     * @public
     */
    pageToScreen(point: VecLike, opts?: TLViewportOptions): Vec;
    /**
     * Convert a point in the current page space to a point in current viewport space.
     *
     * @example
     * ```ts
     * editor.pageToViewport({ x: 100, y: 100 })
     * ```
     *
     * @param point - The point in page space.
     *
     * @public
     */
    pageToViewport(point: VecLike): Vec;
    /**
     * Returns a list of presence records for all peer collaborators.
     * This will return the latest presence record for each connected user.
     *
     * Convenience wrapper for {@link CollaboratorsManager.getCollaborators}.
     *
     * @public
     */
    getCollaborators(): TLInstancePresence[];
    /**
     * Returns a list of presence records for all peer collaborators on the current page.
     * This will return the latest presence record for each connected user.
     *
     * Convenience wrapper for {@link CollaboratorsManager.getCollaboratorsOnCurrentPage}.
     *
     * @public
     */
    getCollaboratorsOnCurrentPage(): TLInstancePresence[];
    /**
     * Returns a list of presence records for peer collaborators who should currently be
     * shown in the UI. Filters {@link Editor.getCollaborators} by activity state
     * (active / idle / inactive) and visibility rules such as following and highlighted
     * users. Re-evaluates on the collaborator visibility clock, so callers don't need to
     * drive their own activity timer.
     *
     * Convenience wrapper for {@link CollaboratorsManager.getVisibleCollaborators}.
     *
     * @public
     */
    getVisibleCollaborators(): TLInstancePresence[];
    /**
     * Returns a list of presence records for peer collaborators who should currently be
     * shown in the UI, filtered to those on the current page.
     *
     * Convenience wrapper for {@link CollaboratorsManager.getVisibleCollaboratorsOnCurrentPage}.
     *
     * @public
     */
    getVisibleCollaboratorsOnCurrentPage(): TLInstancePresence[];
    /**
     * Get the current user's ID for attribution purposes.
     * Also ensures a `user:` record exists in the store for the current user.
     * Returns `null` when the user store has no current user.
     *
     * @public
     */
    getAttributionUserId(): string | null;
    /**
     * Ensure a user record exists in the store for the given user,
     * updating it if the data has changed.
     *
     * @internal
     */
    _ensureUserRecord(user: TLUser): void;
    /**
     * Resolve a display name for a user ID. Asks the
     * {@link @tldraw/tlschema#TLUserStore} first (the app's source of truth),
     * falling back to the `user:` record in the store.
     *
     * @public
     */
    getAttributionDisplayName(userId: string | null): string | null;
    /**
     * Resolve a user record by ID. Asks the
     * {@link @tldraw/tlschema#TLUserStore} first (the app's source of truth),
     * falling back to the `user:` record in the store.
     *
     * @public
     */
    getAttributionUser(userId: string | null): TLUser | null;
    /**
     * Collect user IDs referenced by a set of shapes via shape-specific props
     * (e.g. `textFirstEditedBy` on notes).
     *
     * @internal
     */
    _getReferencedUserIds(shapes: TLShape[]): Set<string>;
    private _isLockedOnFollowingUser;
    /**
     * Start viewport-following a user.
     *
     * @example
     * ```ts
     * editor.startFollowingUser(myUserId)
     * ```
     *
     * @param userId - The id of the user to follow.
     *
     * @public
     */
    startFollowingUser(userId: TLUserId): this;
    /**
     * Stop viewport-following a user.
     *
     * @example
     * ```ts
     * editor.stopFollowingUser()
     * ```
     * @public
     */
    stopFollowingUser(): this;
    /** @internal */
    getUnorderedRenderingShapes(useEditorState: boolean, opts?: TLViewportOptions): TLRenderingShape[];
    private _cameraStateTimeoutRemaining;
    private _decayCameraStateTimeout;
    private _tickCameraState;
    private _setCameraState;
    /**
     * Whether the camera is moving or idle.
     *
     * @example
     * ```ts
     * editor.getCameraState()
     * ```
     *
     * @public
     */
    getCameraState(): "idle" | "moving";
    /**
     * Get the shapes that should be displayed in the current viewport.
     *
     * @example
     * ```ts
     * editor.getRenderingShapes()
     * ```
     *
     * @public
     */
    getRenderingShapes(opts?: TLViewportOptions): TLRenderingShape[];
    private _renderingShapesSortCache;
    private _getAllPagesQuery;
    /**
     * Info about the project's current pages.
     *
     * @example
     * ```ts
     * editor.getPages()
     * ```
     *
     * @public
     */
    getPages(): TLPage[];
    /**
     * The current page.
     *
     * @example
     * ```ts
     * editor.getCurrentPage()
     * ```
     *
     * @public
     */
    getCurrentPage(): TLPage;
    /**
     * The current page id.
     *
     * @example
     * ```ts
     * editor.getCurrentPageId()
     * ```
     *
     * @public
     */
    getCurrentPageId(): TLPageId;
    /**
     * Get a page.
     *
     * @example
     * ```ts
     * editor.getPage(myPage.id)
     * editor.getPage(myPage)
     * ```
     *
     * @param page - The page (or the page id) to get.
     *
     * @public
     */
    getPage(page: TLPageId | TLPage): TLPage | undefined;
    private readonly _currentPageShapeIds;
    /**
     * An array of all of the shapes on the current page.
     *
     * @example
     * ```ts
     * editor.getCurrentPageIds()
     * ```
     *
     * @public
     */
    getCurrentPageShapeIds(): Set<TLShapeId>;
    /**
     * @internal
     */
    getCurrentPageShapeIdsSorted(): TLShapeId[];
    /**
     * Get the ids of shapes on a page.
     *
     * @example
     * ```ts
     * const idsOnPage1 = editor.getPageShapeIds('page1')
     * const idsOnPage2 = editor.getPageShapeIds(myPage2)
     * ```
     *
     * @param page - The page (or the page id) to get the shape ids for.
     *
     * @public
     **/
    getPageShapeIds(page: TLPageId | TLPage): Set<TLShapeId>;
    /**
     * Set the current page.
     *
     * @example
     * ```ts
     * editor.setCurrentPage('page1')
     * editor.setCurrentPage(myPage1)
     * ```
     *
     * @param page - The page (or the page id) to set as the current page.
     *
     * @public
     */
    setCurrentPage(page: TLPageId | TLPage): this;
    /**
     * Update a page.
     *
     * @example
     * ```ts
     * editor.updatePage({ id: 'page2', name: 'Page 2' })
     * ```
     *
     * @param partial - The partial of the shape to update.
     *
     * @public
     */
    updatePage(partial: RequiredKeys<Partial<TLPage>, 'id'>): this;
    /**
     * Create a page whilst ensuring that the page name is unique.
     *
     * @example
     * ```ts
     * editor.createPage(myPage)
     * editor.createPage({ name: 'Page 2' })
     * ```
     *
     * @param page - The page (or page partial) to create.
     *
     * @public
     */
    createPage(page: Partial<TLPage>): this;
    /**
     * Delete a page.
     *
     * @example
     * ```ts
     * editor.deletePage('page1')
     * ```
     *
     * @param page - The page (or the page id) to delete.
     *
     * @public
     */
    deletePage(page: TLPageId | TLPage): this;
    /**
     * Duplicate a page.
     *
     * @param page - The page (or the page id) to duplicate. Defaults to the current page.
     * @param createId - The id of the new page. Defaults to a new id.
     *
     * @public
     */
    duplicatePage(page: TLPageId | TLPage, createId?: TLPageId): this;
    /**
     * Rename a page.
     *
     * @example
     * ```ts
     * editor.renamePage('page1', 'My Page')
     * ```
     *
     * @param page - The page (or the page id) to rename.
     * @param name - The new name.
     *
     * @public
     */
    renamePage(page: TLPageId | TLPage, name: string): this;
    private _getAllAssetsQuery;
    /**
     * Get all assets in the editor.
     *
     * @public
     */
    getAssets(): (import("@tldraw/tlschema").TLBookmarkAsset | TLImageAsset | TLVideoAsset)[];
    /**
     * Create one or more assets.
     *
     * @example
     * ```ts
     * editor.createAssets([...myAssets])
     * ```
     *
     * @param assets - The assets to create.
     *
     * @public
     */
    createAssets(assets: TLAsset[]): this;
    /**
     * Update one or more assets.
     *
     * @example
     * ```ts
     * editor.updateAssets([{ id: 'asset1', name: 'New name' }])
     * ```
     *
     * @param assets - The assets to update.
     *
     * @public
     */
    updateAssets(assets: TLAssetPartial[]): this;
    /**
     * Delete one or more assets.
     *
     * @example
     * ```ts
     * editor.deleteAssets(['asset1', 'asset2'])
     * ```
     *
     * @param assets - The assets (or asset ids) to delete.
     *
     * @public
     */
    deleteAssets(assets: TLAssetId[] | TLAsset[]): this;
    /**
     * Get an asset by its id.
     *
     * @example
     * ```ts
     * editor.getAsset('asset1')
     * ```
     *
     * @param asset - The asset (or asset id) to get.
     *
     * @public
     */
    getAsset<T extends TLAsset>(asset: T | T['id']): T | undefined;
    resolveAssetUrl(assetId: TLAssetId | null, context: {
        screenScale?: number;
        shouldResolveToOriginal?: boolean;
        dpr?: number;
    }): Promise<string | null>;
    /**
     * Upload an asset to the store's asset service, returning a URL that can be used to resolve the
     * asset.
     */
    uploadAsset(asset: TLAsset, file: File, abortSignal?: AbortSignal): Promise<{
        src: string;
        meta?: JsonObject;
    }>;
    private _shapeGeometryCaches;
    /**
     * Get the geometry of a shape in shape-space.
     *
     * @example
     * ```ts
     * editor.getShapeGeometry(myShape)
     * editor.getShapeGeometry(myShapeId)
     * editor.getShapeGeometry(myShapeId, { context: "arrow" })
     * ```
     *
     * @param shape - The shape (or shape id) to get the geometry for.
     * @param opts - Additional options about the request for geometry. Passed to {@link ShapeUtil.getGeometry}.
     *
     * @public
     */
    getShapeGeometry<T extends Geometry2d>(shape: TLShape | TLShapeId, opts?: TLGeometryOpts): T;
    private _getShapeHandlesCache;
    /**
     * Get the handles (if any) for a shape.
     *
     * @example
     * ```ts
     * editor.getShapeHandles(myShape)
     * editor.getShapeHandles(myShapeId)
     * ```
     *
     * @param shape - The shape (or shape id) to get the handles for.
     * @public
     */
    getShapeHandles<T extends TLShape>(shape: T | T['id']): TLHandle[] | undefined;
    /**
     * Get the local transform for a shape as a matrix model. This transform reflects both its
     * translation (x, y) from from either its parent's top left corner, if the shape's parent is
     * another shape, or else from the 0,0 of the page, if the shape's parent is the page; and the
     * shape's rotation.
     *
     * @example
     * ```ts
     * editor.getShapeLocalTransform(myShape)
     * ```
     *
     * @param shape - The shape to get the local transform for.
     *
     * @public
     */
    getShapeLocalTransform(shape: TLShape | TLShapeId): Mat;
    private _getShapePageTransformCache;
    /**
     * Get the local transform of a shape's parent as a matrix model.
     *
     * @example
     * ```ts
     * editor.getShapeParentTransform(myShape)
     * ```
     *
     * @param shape - The shape (or shape id) to get the parent transform for.
     *
     * @public
     */
    getShapeParentTransform(shape: TLShape | TLShapeId): Mat;
    /**
     * Get the transform of a shape in the current page space.
     *
     * @example
     * ```ts
     * editor.getShapePageTransform(myShape)
     * editor.getShapePageTransform(myShapeId)
     * ```
     *
     * @param shape - The shape (or shape id) to get the page transform for.
     *
     * @public
     */
    getShapePageTransform(shape: TLShape | TLShapeId): Mat;
    private _getShapePageBoundsCache;
    /**
     * Get the bounds of a shape in the current page space.
     *
     * @example
     * ```ts
     * editor.getShapePageBounds(myShape)
     * editor.getShapePageBounds(myShapeId)
     * ```
     *
     * @param shape - The shape (or shape id) to get the bounds for.
     *
     * @public
     */
    getShapePageBounds(shape: TLShape | TLShapeId): Box | undefined;
    private _getShapeClipPathCache;
    /**
     * Get the clip path for a shape.
     *
     * @example
     * ```ts
     * const clipPath = editor.getShapeClipPath(shape)
     * const clipPath = editor.getShapeClipPath(shape.id)
     * ```
     *
     * @param shape - The shape (or shape id) to get the clip path for.
     *
     * @returns The clip path or undefined.
     *
     * @public
     */
    getShapeClipPath(shape: TLShape | TLShapeId): string | undefined;
    private _getShapeMaskCache;
    /**
     * Get the mask (in the current page space) for a shape.
     *
     * @example
     * ```ts
     * const pageMask = editor.getShapeMask(shape.id)
     * ```
     *
     * @param shape - The shape (or the shape id) of the shape to get the mask for.
     *
     * @returns The mask for the shape.
     *
     * @public
     */
    getShapeMask(shape: TLShapeId | TLShape): VecLike[] | undefined;
    /**
     * Get the bounds of a shape in the current page space, incorporating any masks. For example, if the
     * shape were the child of a frame and was half way out of the frame, the bounds would be the half
     * of the shape that was in the frame.
     *
     * @example
     * ```ts
     * editor.getShapeMaskedPageBounds(myShape)
     * editor.getShapeMaskedPageBounds(myShapeId)
     * ```
     *
     * @param shape - The shape to get the masked bounds for.
     *
     * @public
     */
    getShapeMaskedPageBounds(shape: TLShapeId | TLShape): Box | undefined;
    private _getShapeMaskedPageBoundsCache;
    /**
     * Get the ancestors of a shape.
     *
     * @example
     * ```ts
     * const ancestors = editor.getShapeAncestors(myShape)
     * const ancestors = editor.getShapeAncestors(myShapeId)
     * ```
     *
     * @param shape - The shape (or shape id) to get the ancestors for.
     * @param acc - The accumulator.
     *
     * @public
     */
    getShapeAncestors(shape: TLShapeId | TLShape, acc?: TLShape[]): TLShape[];
    /**
     * Find the first ancestor matching the given predicate
     *
     * @example
     * ```ts
     * const ancestor = editor.findShapeAncestor(myShape)
     * const ancestor = editor.findShapeAncestor(myShape.id)
     * const ancestor = editor.findShapeAncestor(myShape.id, (shape) => shape.type === 'frame')
     * ```
     *
     * @param shape - The shape to check the ancestors for.
     * @param predicate - The predicate to match.
     *
     * @public
     */
    findShapeAncestor(shape: TLShape | TLShapeId, predicate: (parent: TLShape) => boolean): TLShape | undefined;
    /**
     * Returns true if the the given shape has the given ancestor.
     *
     * @param shape - The shape.
     * @param ancestorId - The id of the ancestor.
     *
     * @public
     */
    hasAncestor(shape: TLShape | TLShapeId | undefined, ancestorId: TLShapeId): boolean;
    /**
     * Get the common ancestor of two or more shapes that matches a predicate.
     *
     * @param shapes - The shapes (or shape ids) to check.
     * @param predicate - The predicate to match.
     */
    findCommonAncestor(shapes: TLShape[] | TLShapeId[], predicate?: (shape: TLShape) => boolean): TLShapeId | undefined;
    /**
     * Check whether a shape or its parent is locked.
     *
     * @param shape - The shape (or shape id) to check.
     *
     * @public
     */
    isShapeOrAncestorLocked(shape?: TLShape | TLShapeId): boolean;
    /**
     * Get shapes that are outside of the viewport.
     *
     * @public
     */
    getNotVisibleShapes(): Set<TLShapeId>;
    private _notVisibleShapes;
    private _culledShapesCache;
    /**
     * Get culled shapes (those that should not render), taking into account which shapes are selected or editing.
     *
     * @public
     */
    getCulledShapes(opts?: TLViewportOptions): Set<TLShapeId>;
    /**
     * The bounds of the current page (the common bounds of all of the shapes on the page).
     *
     * @public
     */
    getCurrentPageBounds(): Box | undefined;
    /**
     * Get the top-most selected shape at the given point, ignoring groups.
     *
     * @param point - The point to check.
     *
     * @returns The top-most selected shape at the given point, or undefined if there is no shape at the point.
     */
    getSelectedShapeAtPoint(point: VecLike): TLShape | undefined;
    /**
     * Get the shape at the current point.
     *
     * @param point - The point to check.
     * @param opts - Options for the check: `hitInside` to check if the point is inside the shape, `margin` to check if the point is within a margin of the shape, `hitFrameInside` to check if the point is inside the frame, and `filter` to filter the shapes to check.
     *
     * @returns The shape at the given point, or undefined if there is no shape at the point.
     */
    getShapeAtPoint(point: VecLike, opts?: TLGetShapeAtPointOptions): TLShape | undefined;
    /**
     * Get the shapes, if any, at a given page point.
     *
     * @example
     * ```ts
     * editor.getShapesAtPoint({ x: 100, y: 100 })
     * editor.getShapesAtPoint({ x: 100, y: 100 }, { hitInside: true, margin: 8 })
     * ```
     *
     * @param point - The page point to test.
     * @param opts - The options for the hit point testing.
     *
     * @returns An array of shapes at the given point, sorted in reverse order of their absolute z-index (top-most shape first).
     *
     * @public
     */
    getShapesAtPoint(point: VecLike, opts?: {
        margin?: number | undefined;
        hitInside?: boolean | undefined;
    }): TLShape[];
    /**
     * Get shape IDs within the given bounds.
     *
     * Note: Uses shape page bounds only. Frames with labels outside their bounds
     * may not be included even if the label is within the search bounds.
     *
     * Note: Results are unordered. If you need z-order, combine with sorted shapes:
     * ```ts
     * const candidates = editor.getShapeIdsInsideBounds(bounds)
     * const sorted = editor.getCurrentPageShapesSorted().filter(s => candidates.has(s.id))
     * ```
     *
     * @param bounds - The bounds to search within.
     * @returns Unordered set of shape IDs within the given bounds.
     *
     * @public
     */
    getShapeIdsInsideBounds(bounds: Box): Set<TLShapeId>;
    /**
     * Test whether a point (in the current page space) will will a shape. This method takes into account masks,
     * such as when a shape is the child of a frame and is partially clipped by the frame.
     *
     * @example
     * ```ts
     * editor.isPointInShape({ x: 100, y: 100 }, myShape)
     * ```
     *
     * @param shape - The shape to test against.
     * @param point - The page point to test (in the current page space).
     * @param opts - The options for the hit point testing.
     *
     * @public
     */
    isPointInShape(shape: TLShape | TLShapeId, point: VecLike, opts?: {
        margin?: number | undefined;
        hitInside?: boolean | undefined;
    }): boolean;
    /**
     * Convert a point in the current page space to a point in the local space of a shape. For example, if a
     * shape's page point were `{ x: 100, y: 100 }`, a page point at `{ x: 110, y: 110 }` would be at
     * `{ x: 10, y: 10 }` in the shape's local space.
     *
     * @example
     * ```ts
     * editor.getPointInShapeSpace(myShape, { x: 100, y: 100 })
     * ```
     *
     * @param shape - The shape to get the point in the local space of.
     * @param point - The page point to get in the local space of the shape.
     *
     * @public
     */
    getPointInShapeSpace(shape: TLShape | TLShapeId, point: VecLike): Vec;
    /**
     * Convert a delta in the current page space to a point in the local space of a shape's parent.
     *
     * @example
     * ```ts
     * editor.getPointInParentSpace(myShape.id, { x: 100, y: 100 })
     * ```
     *
     * @param shape - The shape to get the point in the local space of.
     * @param point - The page point to get in the local space of the shape.
     *
     * @public
     */
    getPointInParentSpace(shape: TLShapeId | TLShape, point: VecLike): Vec;
    /**
     * An array containing all of the shapes in the current page.
     *
     * @public
     */
    getCurrentPageShapes(): TLShape[];
    /**
     * An array containing all of the shapes in the current page, sorted in z-index order (accounting
     * for nested shapes): e.g. A, B, BA, BB, C.
     *
     * @public
     */
    getCurrentPageShapesSorted(): TLShape[];
    /**
     * An array containing all of the rendering shapes in the current page, sorted in z-index order (accounting
     * for nested shapes): e.g. A, B, BA, BB, C.
     *
     * @public
     */
    getCurrentPageRenderingShapesSorted(): TLShape[];
    /**
     * Get whether a shape matches the type of a TLShapeUtil.
     *
     * @example
     * ```ts
     * const isArrowShape = isShapeOfType(someShape, 'arrow')
     * ```
     *
     * @param util - the TLShapeUtil constructor to test against
     * @param shape - the shape to test
     *
     * @public
     */
    isShapeOfType<K extends TLShape['type']>(shape: TLShape, type: K): shape is Extract<TLShape, {
        type: K;
    }>;
    isShapeOfType<T extends TLShape>(shape: TLShape, type: T['type']): shape is Extract<TLShape, {
        type: T['type'];
    }>;
    isShapeOfType<T extends TLShape = TLShape>(shapeId: TLShapeId, type: T['type']): boolean;
    /**
     * Get whether a shape behaves like a frame — a container that has child
     * shapes, requires full-brush selection, blocks erasure from inside, etc.
     *
     * @example
     * ```ts
     * const isFrameLike = editor.isShapeFrameLike(someShape)
     * ```
     *
     * @param shape - The shape (or shape id) to test.
     *
     * @public
     */
    isShapeFrameLike(shape: TLShape | TLShapeId): boolean;
    /**
     * Get a shape by its id.
     *
     * @example
     * ```ts
     * editor.getShape('box1')
     * ```
     *
     * @param shape - The shape (or the id of the shape) to get.
     *
     * @public
     */
    getShape<T extends TLShape = TLShape>(shape: TLShape | TLParentId): T | undefined;
    /**
     * Get the parent shape for a given shape. Returns undefined if the shape is the direct child of
     * the page.
     *
     * @example
     * ```ts
     * editor.getShapeParent(myShape)
     * ```
     *
     * @public
     */
    getShapeParent(shape?: TLShape | TLShapeId): TLShape | undefined;
    /**
     * If siblingShape and targetShape are siblings, this returns targetShape. If targetShape has an
     * ancestor who is a sibling of siblingShape, this returns that ancestor. Otherwise, this returns
     * undefined.
     *
     * @internal
     */
    getShapeNearestSibling(siblingShape: TLShape, targetShape: TLShape | undefined): TLShape | undefined;
    /**
     * Get whether the given shape is the descendant of the given page.
     *
     * @example
     * ```ts
     * editor.isShapeInPage(myShape)
     * editor.isShapeInPage(myShape, 'page1')
     * ```
     *
     * @param shape - The shape to check.
     * @param pageId - The id of the page to check against. Defaults to the current page.
     *
     * @public
     */
    isShapeInPage(shape: TLShape | TLShapeId, pageId?: TLPageId): boolean;
    /**
     * Get the id of the containing page for a given shape.
     *
     * @param shape - The shape to get the page id for.
     *
     * @returns The id of the page that contains the shape, or undefined if the shape is undefined.
     *
     * @public
     */
    getAncestorPageId(shape?: TLShape | TLShapeId): TLPageId | undefined;
    /**
     * A cache of parents to children.
     *
     * @internal
     */
    private readonly _parentIdsToChildIds;
    /**
     * Reparent shapes to a new parent. This operation preserves the shape's current page positions /
     * rotations.
     *
     * @example
     * ```ts
     * editor.reparentShapes([box1, box2], 'frame1')
     * editor.reparentShapes([box1.id, box2.id], 'frame1')
     * editor.reparentShapes([box1.id, box2.id], 'frame1', 4)
     * ```
     *
     * @param shapes - The shapes (or shape ids) of the shapes to reparent.
     * @param parentId - The id of the new parent shape.
     * @param insertIndex - The index to insert the children.
     *
     * @public
     */
    reparentShapes(shapes: TLShapeId[] | TLShape[], parentId: TLParentId, insertIndex?: IndexKey): this;
    /**
     * Get the index above the highest child of a given parent.
     *
     * @param parent - The parent (or the id) of the parent.
     *
     * @returns The index.
     *
     * @public
     */
    getHighestIndexForParent(parent: TLParentId | TLPage | TLShape): IndexKey;
    /**
     * Get an array of all the children of a shape.
     *
     * @example
     * ```ts
     * editor.getSortedChildIdsForParent('frame1')
     * ```
     *
     * @param parent - The parent (or the id) of the parent shape.
     *
     * @public
     */
    getSortedChildIdsForParent(parent: TLParentId | TLPage | TLShape): TLShapeId[];
    /**
     * Run a visitor function for all descendants of a shape.
     *
     * @example
     * ```ts
     * editor.visitDescendants('frame1', myCallback)
     * ```
     *
     * @param parent - The parent (or the id) of the parent shape.
     * @param visitor - The visitor function.
     *
     * @public
     */
    visitDescendants(parent: TLParentId | TLPage | TLShape, visitor: (id: TLShapeId) => void | false): this;
    /**
     * Get the shape ids of all descendants of the given shapes (including the shapes themselves). IDs are returned in z-index order.
     *
     * @param ids - The ids of the shapes to get descendants of.
     *
     * @returns The descendant ids.
     *
     * @public
     */
    getShapeAndDescendantIds(ids: TLShapeId[]): Set<TLShapeId>;
    /**
     * Get the shape that some shapes should be dropped on at a given point.
     *
     * @param point - The point to find the parent for.
     * @param droppingShapes - The shapes that are being dropped.
     *
     * @returns The shape to drop on.
     *
     * @public
     */
    getDraggingOverShape(point: Vec, droppingShapes: TLShape[]): TLShape | undefined;
    /**
     * Get the shape that should be selected when you click on a given shape, assuming there is
     * nothing already selected. It will not return anything higher than or including the current
     * focus layer.
     *
     * @param shape - The shape to get the outermost selectable shape for.
     * @param filter - A function to filter the selectable shapes.
     *
     * @returns The outermost selectable shape.
     *
     * @public
     */
    getOutermostSelectableShape(shape: TLShape | TLShapeId, filter?: (shape: TLShape) => boolean): TLShape;
    private _getBindingsIndexCache;
    /**
     * Get a binding from the store by its ID if it exists.
     */
    getBinding(id: TLBindingId): TLBinding | undefined;
    /**
     * Get all bindings of a certain type _from_ a particular shape. These are the bindings whose
     * `fromId` matched the shape's ID.
     */
    getBindingsFromShape<K extends TLBinding['type']>(shape: TLShape | TLShapeId, type: K): Extract<TLBinding, {
        type: K;
    }>[];
    getBindingsFromShape<Binding extends TLBinding = TLBinding>(shape: TLShape | TLShapeId, type: Binding['type']): Binding[];
    /**
     * Get all bindings of a certain type _to_ a particular shape. These are the bindings whose
     * `toId` matches the shape's ID.
     */
    getBindingsToShape<K extends TLBinding['type']>(shape: TLShape | TLShapeId, type: K): Extract<TLBinding, {
        type: K;
    }>[];
    getBindingsToShape<Binding extends TLBinding = TLBinding>(shape: TLShape | TLShapeId, type: Binding['type']): Binding[];
    /**
     * Get all bindings involving a particular shape. This includes bindings where the shape is the
     * `fromId` or `toId`. If a type is provided, only bindings of that type are returned.
     */
    getBindingsInvolvingShape<K extends TLBinding['type']>(shape: TLShape | TLShapeId, type: K): Extract<TLBinding, {
        type: K;
    }>[];
    getBindingsInvolvingShape<Binding extends TLBinding = TLBinding>(shape: TLShape | TLShapeId, type?: Binding['type']): Binding[];
    /**
     * Create bindings from a list of partial bindings. You can omit the ID and most props of a
     * binding, but the `type`, `toId`, and `fromId` must all be provided.
     */
    createBindings<B extends TLBinding = TLBinding>(partials: TLBindingCreate<B>[]): this;
    /**
     * Create a single binding from a partial. You can omit the ID and most props of a binding, but
     * the `type`, `toId`, and `fromId` must all be provided.
     */
    createBinding<B extends TLBinding = TLBinding>(partial: TLBindingCreate<B>): this;
    /**
     * Update bindings from a list of partial bindings. Each partial must include an ID, which will
     * be used to match the binding to it's existing record. If there is no existing record, that
     * binding is skipped. The changes from the partial are merged into the existing record.
     */
    updateBindings(partials: (TLBindingUpdate | null | undefined)[]): this;
    /**
     * Update a binding from a partial binding. Each partial must include an ID, which will be used
     * to match the binding to it's existing record. If there is no existing record, that binding is
     * skipped. The changes from the partial are merged into the existing record.
     */
    updateBinding<B extends TLBinding = TLBinding>(partial: TLBindingUpdate<B>): this;
    /**
     * Delete several bindings by their IDs. If a binding ID doesn't exist, it's ignored.
     */
    deleteBindings(bindings: (TLBinding | TLBindingId)[], { isolateShapes }?: {
        isolateShapes?: boolean | undefined;
    }): this;
    /**
     * Delete a binding by its ID. If the binding doesn't exist, it's ignored.
     */
    deleteBinding(binding: TLBinding | TLBindingId, opts?: Parameters<this['deleteBindings']>[1]): this;
    canBindShapes({ fromShape, toShape, binding }: {
        fromShape: TLShape | {
            type: TLShape['type'];
        } | TLShape['type'];
        toShape: TLShape | {
            type: TLShape['type'];
        } | TLShape['type'];
        binding: TLBinding | {
            type: TLBinding['type'];
        } | TLBinding['type'];
    }): boolean;
    /**
     * Rotate shapes by a delta in radians.
     *
     * @example
     * ```ts
     * editor.rotateShapesBy(editor.getSelectedShapeIds(), Math.PI)
     * editor.rotateShapesBy(editor.getSelectedShapeIds(), Math.PI / 2)
     * ```
     *
     * @param shapes - The shapes (or shape ids) of the shapes to move.
     * @param delta - The delta in radians to apply to the selection rotation.
     * @param opts - The options for the rotation.
     */
    rotateShapesBy(shapes: TLShapeId[] | TLShape[], delta: number, opts?: {
        center?: VecLike;
    }): this;
    private getChangesToTranslateShape;
    /**
     * Move shapes by a delta.
     *
     * @example
     * ```ts
     * editor.nudgeShapes(['box1', 'box2'], { x: 8, y: 8 })
     * ```
     *
     * @param shapes - The shapes (or shape ids) to move.
     * @param offset - The offset to apply to the shapes.
     */
    nudgeShapes(shapes: TLShapeId[] | TLShape[], offset: VecLike): this;
    /**
     * Duplicate shapes.
     *
     * @example
     * ```ts
     * editor.duplicateShapes(['box1', 'box2'], { x: 8, y: 8 })
     * editor.duplicateShapes(editor.getSelectedShapes(), { x: 8, y: 8 })
     * ```
     *
     * @param shapes - The shapes (or shape ids) to duplicate.
     * @param offset - The offset (in pixels) to apply to the duplicated shapes.
     *
     * @public
     */
    duplicateShapes(shapes: TLShapeId[] | TLShape[], offset?: VecLike): this;
    /**
     * Move shapes to page.
     *
     * @example
     * ```ts
     * editor.moveShapesToPage(['box1', 'box2'], 'page1')
     * ```
     *
     * @param shapes - The shapes (or shape ids) of the shapes to move.
     * @param pageId - The id of the page where the shapes will be moved.
     *
     * @public
     */
    moveShapesToPage(shapes: TLShapeId[] | TLShape[], pageId: TLPageId): this;
    /**
     * Toggle the lock state of one or more shapes. If there is a mix of locked and unlocked shapes, all shapes will be locked.
     *
     * @param shapes - The shapes (or shape ids) to toggle.
     *
     * @public
     */
    toggleLock(shapes: TLShapeId[] | TLShape[]): this;
    /**
     * Send shapes to the back of the page's object list.
     *
     * @example
     * ```ts
     * editor.sendToBack(['id1', 'id2'])
     * editor.sendToBack(box1, box2)
     * ```
     *
     * @param shapes - The shapes (or shape ids) to move.
     *
     * @public
     */
    sendToBack(shapes: TLShapeId[] | TLShape[]): this;
    /**
     * Send shapes backward in the page's object list.
     *
     * @example
     * ```ts
     * editor.sendBackward(['id1', 'id2'])
     * editor.sendBackward([box1, box2])
     * ```
     *
     * By default, the operation will only consider overlapping shapes.
     * To consider all shapes, pass `{ considerAllShapes: true }` in the options.
     *
     * @example
     * ```ts
     * editor.sendBackward(['id1', 'id2'], { considerAllShapes: true })
     * ```
     *
     * @param shapes - The shapes (or shape ids) to move.
     * @param opts - The options for the backward operation.
     *
     * @public
     */
    sendBackward(shapes: TLShapeId[] | TLShape[], opts?: {
        considerAllShapes?: boolean;
    }): this;
    /**
     * Bring shapes forward in the page's object list.
     *
     * @example
     * ```ts
     * editor.bringForward(['id1', 'id2'])
     * editor.bringForward(box1,  box2)
     * ```
     *
     * By default, the operation will only consider overlapping shapes.
     * To consider all shapes, pass `{ considerAllShapes: true }` in the options.
     *
     * @example
     * ```ts
     * editor.bringForward(['id1', 'id2'], { considerAllShapes: true })
     * ```
     *
     * @param shapes - The shapes (or shape ids) to move.
     * @param opts - The options for the forward operation.
     *
     * @public
     */
    bringForward(shapes: TLShapeId[] | TLShape[], opts?: {
        considerAllShapes?: boolean;
    }): this;
    /**
     * Bring shapes to the front of the page's object list.
     *
     * @example
     * ```ts
     * editor.bringToFront(['id1', 'id2'])
     * editor.bringToFront([box1, box2])
     * ```
     *
     * @param shapes - The shapes (or shape ids) to move.
     *
     * @public
     */
    bringToFront(shapes: TLShapeId[] | TLShape[]): this;
    /**
     * Shared clustering logic for layout methods. Resolves shapes, optionally filters to
     * axis-aligned shapes, checks canBeLaidOut, and groups shapes into clusters via arrow bindings.
     *
     * @internal
     */
    private getShapeClusters;
    /**
     * @internal
     */
    private collectShapesViaArrowBindings;
    /**
     * Flip shape positions.
     *
     * @example
     * ```ts
     * editor.flipShapes([box1, box2], 'horizontal', 32)
     * editor.flipShapes(editor.getSelectedShapeIds(), 'horizontal', 32)
     * ```
     *
     * @param shapes - The ids of the shapes to flip.
     * @param operation - Whether to flip horizontally or vertically.
     *
     * @public
     */
    flipShapes(shapes: TLShapeId[] | TLShape[], operation: 'horizontal' | 'vertical'): this;
    /**
     * Stack shape.
     *
     * @example
     * ```ts
     * editor.stackShapes([box1, box2], 'horizontal')
     * editor.stackShapes(editor.getSelectedShapeIds(), 'horizontal')
     * ```
     *
     * @param shapes - The shapes (or shape ids) to stack.
     * @param operation - Whether to stack horizontally or vertically.
     * @param gap - The gap to leave between shapes. By default, uses the editor's `adjacentShapeMargin` option.
     *
     * @public
     */
    stackShapes(shapes: TLShapeId[] | TLShape[], operation: 'horizontal' | 'vertical', gap?: number): this;
    /**
     * Pack shapes into a grid centered on their current position. Based on potpack (https://github.com/mapbox/potpack).
     *
     * @example
     * ```ts
     * editor.packShapes([box1, box2])
     * editor.packShapes(editor.getSelectedShapeIds(), 32)
     * ```
     *
     *
     * @param shapes - The shapes (or shape ids) to pack.
     * @param gap - The padding to apply to the packed shapes. Defaults to the editor's `adjacentShapeMargin` option.
     */
    packShapes(shapes: TLShapeId[] | TLShape[], _gap?: number): this;
    /**
     * Align shape positions.
     *
     * @example
     * ```ts
     * editor.alignShapes([box1, box2], 'left')
     * editor.alignShapes(editor.getSelectedShapeIds(), 'left')
     * ```
     *
     * @param shapes - The shapes (or shape ids) to align.
     * @param operation - The align operation to apply.
     *
     * @public
     */
    alignShapes(shapes: TLShapeId[] | TLShape[], operation: 'left' | 'center-horizontal' | 'right' | 'top' | 'center-vertical' | 'bottom'): this;
    /**
     * Distribute shape positions.
     *
     * @example
     * ```ts
     * editor.distributeShapes([box1, box2], 'horizontal')
     * editor.distributeShapes(editor.getSelectedShapeIds(), 'horizontal')
     * ```
     *
     * @param shapes - The shapes (or shape ids) to distribute.
     * @param operation - Whether to distribute shapes horizontally or vertically.
     *
     * @public
     */
    distributeShapes(shapes: TLShapeId[] | TLShape[], operation: 'horizontal' | 'vertical'): this;
    /**
     * Stretch shape sizes and positions to fill their common bounding box.
     *
     * @example
     * ```ts
     * editor.stretchShapes([box1, box2], 'horizontal')
     * editor.stretchShapes(editor.getSelectedShapeIds(), 'horizontal')
     * ```
     *
     * @param shapes - The shapes (or shape ids) to stretch.
     * @param operation - Whether to stretch shapes horizontally or vertically.
     *
     * @public
     */
    stretchShapes(shapes: TLShapeId[] | TLShape[], operation: 'horizontal' | 'vertical'): this;
    /**
     * Resize and reposition a set of shapes so that their combined page bounds matches the given
     * target bounds.
     *
     * @example
     * ```ts
     * editor.resizeToBounds([box1, box2], { x: 0, y: 0, w: 500, h: 500 })
     * editor.resizeToBounds(editor.getSelectedShapeIds(), new Box(0, 0, 500, 500))
     * ```
     *
     * @param shapes - The shapes (or shape ids) to resize.
     * @param bounds - The target bounding box.
     *
     * @public
     */
    resizeToBounds(shapes: TLShapeId[] | TLShape[], bounds: BoxLike): this;
    /**
     * Resize a shape.
     *
     * @param shape - The shape (or the shape id of the shape) to resize.
     * @param scale - The scale factor to apply to the shape.
     * @param opts - Additional options.
     *
     * @public
     */
    resizeShape(shape: TLShapeId | TLShape, scale: VecLike, opts?: TLResizeShapeOptions): this;
    /**
     * Get the update for a resized shape without committing it to the store. Interactions that
     * resize many shapes at once use this to collect all of the updates and commit them in a
     * single batch. Returns null when there is nothing to update.
     *
     * Shapes that are rotated out of alignment with the scale axis cannot be resized with a
     * single update; those shapes are resized immediately (as `resizeShape` would do) and null
     * is returned.
     *
     * @internal
     */
    getResizeShapePartial(shape: TLShapeId | TLShape, scale: VecLike, opts?: TLResizeShapeOptions): TLShapePartial | null;
    /** @internal */
    private _scalePagePoint;
    /** @internal */
    private _resizeUnalignedShape;
    /**
     * Get the initial meta value for a shape.
     *
     * @example
     * ```ts
     * editor.getInitialMetaForShape = (shape) => {
     *   if (shape.type === 'note') {
     *     return { createdBy: myCurrentUser.id }
     *   }
     * }
     * ```
     *
     * @param shape - The shape to get the initial meta for.
     *
     * @public
     */
    getInitialMetaForShape(_shape: TLShape): JsonObject;
    /**
     * Get whether the provided shape can be created.
     *
     * @param shape - The shape or shape IDs to check.
     *
     * @public
     */
    canCreateShape(shape: OptionalKeys<TLShapePartial<TLShape>, 'id'> | TLShape['id']): boolean;
    /**
     * Get whether the provided shapes can be created.
     *
     * @param shapes - The shapes or shape IDs to create.
     *
     * @public
     */
    canCreateShapes(shapes: (TLShape['id'] | OptionalKeys<TLShapePartial<TLShape>, 'id'>)[]): boolean;
    /**
     * Create a single shape.
     *
     * @example
     * ```ts
     * editor.createShape(myShape)
     * editor.createShape({ id: 'box1', type: 'text', props: { richText: toRichText("ok") } })
     * ```
     *
     * @param shape - The shape (or shape partial) to create.
     *
     * @public
     */
    createShape<TShape extends TLShape>(shape: TLCreateShapePartial<TShape>): this;
    /**
     * Create shapes.
     *
     * @example
     * ```ts
     * editor.createShapes([myShape])
     * editor.createShapes([{ id: 'box1', type: 'text', props: { richText: toRichText("ok") } }])
     * ```
     *
     * @param shapes - The shapes (or shape partials) to create.
     *
     * @public
     */
    createShapes<TShape extends TLShape = TLShape>(shapes: TLCreateShapePartial<TShape>[]): this;
    private animatingShapes;
    /**
     * Animate a shape.
     *
     * @example
     * ```ts
     * editor.animateShape({ id: 'box1', type: 'box', x: 100, y: 100 })
     * editor.animateShape({ id: 'box1', type: 'box', x: 100, y: 100 }, { animation: { duration: 100, ease: t => t*t } })
     * ```
     *
     * @param partial - The shape partial to update.
     * @param opts - The animation's options.
     *
     * @public
     */
    animateShape(partial: TLShapePartial | null | undefined, opts?: TLCameraMoveOptions): this;
    /**
     * Animate shapes.
     *
     * @example
     * ```ts
     * editor.animateShapes([{ id: 'box1', type: 'box', x: 100, y: 100 }])
     * editor.animateShapes([{ id: 'box1', type: 'box', x: 100, y: 100 }], { animation: { duration: 100, ease: t => t*t } })
     * ```
     *
     * @param partials - The shape partials to update.
     * @param opts - The animation's options.
     *
     * @public
     */
    animateShapes(partials: (TLShapePartial | null | undefined)[], opts?: TLCameraMoveOptions): this;
    /**
     * Create a group containing the provided shapes.
     *
     * @example
     * ```ts
     * editor.groupShapes([myShape, myOtherShape])
     * editor.groupShapes([myShape, myOtherShape], { groupId: myGroupId, select: false })
     * ```
     *
     * @param shapes - The shapes (or shape ids) to group. Defaults to the selected shapes.
     * @param opts - An options object.
     *
     * @public
     */
    groupShapes(shapes: TLShape[], opts?: Partial<{
        groupId: TLShapeId;
        select: boolean;
    }>): this;
    groupShapes(ids: TLShapeId[], opts?: Partial<{
        groupId: TLShapeId;
        select: boolean;
    }>): this;
    /**
     * Ungroup some shapes.
     *
     * @example
     * ```ts
     * editor.ungroupShapes([myGroup, myOtherGroup])
     * editor.ungroupShapes([myGroup], { select: false })
     * ```
     *
     * @param shapes - The group shapes (or shape ids) to ungroup.
     * @param opts - An options object.
     *
     * @public
     */
    ungroupShapes(ids: TLShapeId[], opts?: Partial<{
        select: boolean;
    }>): this;
    ungroupShapes(shapes: TLShape[], opts?: Partial<{
        select: boolean;
    }>): this;
    /**
     * Update a shape using a partial of the shape.
     *
     * @example
     * ```ts
     * editor.updateShape({ id: 'box1', type: 'geo', props: { w: 100, h: 100 } })
     * ```
     *
     * @param partial - The shape partial to update.
     *
     * @public
     */
    updateShape<T extends TLShape = TLShape>(partial: TLShapePartial<T> | null | undefined): this;
    /**
     * Update shapes using partials of each shape.
     *
     * @example
     * ```ts
     * editor.updateShapes([{ id: 'box1', type: 'geo', props: { w: 100, h: 100 } }])
     * ```
     *
     * @param partials - The shape partials to update.
     *
     * @public
     */
    updateShapes<T extends TLShape>(partials: (TLShapePartial<T> | null | undefined)[]): this;
    /** @internal */
    _updateShapes(_partials: (TLShapePartial | null | undefined)[]): void;
    /** @internal */
    private _getUnlockedShapeIds;
    /**
     * Delete shapes.
     *
     * @example
     * ```ts
     * editor.deleteShapes(['box1', 'box2'])
     * ```
     *
     * @param ids - The ids of the shapes to delete.
     *
     * @public
     */
    deleteShapes(ids: TLShapeId[]): this;
    deleteShapes(shapes: TLShape[]): this;
    /**
     * Delete a shape.
     *
     * @example
     * ```ts
     * editor.deleteShape(shape.id)
     * ```
     *
     * @param id - The id of the shape to delete.
     *
     * @public
     */
    deleteShape(id: TLShapeId): this;
    deleteShape(shape: TLShape): this;
    /**
     * Get all the current styles among the users selected shapes
     *
     * @internal
     */
    private _extractSharedStyles;
    private _getSelectionSharedStyles;
    /**
     * Get the style for the next shape.
     *
     * @example
     * ```ts
     * const color = editor.getStyleForNextShape(DefaultColorStyle)
     * ```
     *
     * @param style - The style to get.
     *
     * @public */
    getStyleForNextShape<T>(style: StyleProp<T>): T;
    getShapeStyleIfExists<T>(shape: TLShape, style: StyleProp<T>): T | undefined;
    /**
     * A map of all the current styles either in the current selection, or that are relevant to the
     * current tool.
     *
     * @example
     * ```ts
     * const color = editor.getSharedStyles().get(DefaultColorStyle)
     * if (color && color.type === 'shared') {
     *   print('All selected shapes have the same color:', color.value)
     * }
     * ```
     *
     * @public
     */
    getSharedStyles(): ReadonlySharedStyleMap;
    /**
     * Get the currently selected shared opacity.
     * If any shapes are selected, this returns the shared opacity of the selected shapes.
     * Otherwise, this returns the chosen opacity for the next shape.
     *
     * @public
     */
    getSharedOpacity(): SharedStyle<number>;
    /**
     * Set the opacity for the next shapes. This will effect subsequently created shapes.
     *
     * @example
     * ```ts
     * editor.setOpacityForNextShapes(0.5)
     * ```
     *
     * @param opacity - The opacity to set. Must be a number between 0 and 1 inclusive.
     * @param historyOptions - The history options for the change.
     */
    setOpacityForNextShapes(opacity: number, historyOptions?: TLHistoryBatchOptions): this;
    /**
     * Set the current opacity. This will effect any selected shapes.
     *
     * @example
     * ```ts
     * editor.setOpacityForSelectedShapes(0.5)
     * ```
     *
     * @param opacity - The opacity to set. Must be a number between 0 and 1 inclusive.
     */
    setOpacityForSelectedShapes(opacity: number): this;
    /**
     * Set the value of a {@link @tldraw/tlschema#StyleProp} for the next shapes. This change will be applied to subsequently created shapes.
     *
     * @example
     * ```ts
     * editor.setStyleForNextShapes(DefaultColorStyle, 'red')
     * editor.setStyleForNextShapes(DefaultColorStyle, 'red', { ephemeral: true })
     * ```
     *
     * @param style - The style to set.
     * @param value - The value to set.
     * @param historyOptions - The history options for the change.
     *
     * @public
     */
    setStyleForNextShapes<T>(style: StyleProp<T>, value: T, historyOptions?: TLHistoryBatchOptions): this;
    /**
     * Set the value of a {@link @tldraw/tlschema#StyleProp}. This change will be applied to the currently selected shapes.
     *
     * @example
     * ```ts
     * editor.setStyleForSelectedShapes(DefaultColorStyle, 'red')
     * ```
     *
     * @param style - The style to set.
     * @param value - The value to set.
     *
     * @public
     */
    setStyleForSelectedShapes<S extends StyleProp<any>>(style: S, value: StylePropValue<S>): this;
    /** @internal */
    externalAssetContentHandlers: {
        [K in TLExternalAsset['type']]: {
            [Key in K]: null | ((info: TLExternalAsset & {
                type: Key;
            }) => Promise<TLAsset | undefined>);
        }[K];
    };
    /** @internal */
    private readonly temporaryAssetPreview;
    /**
     * Register an external asset handler. This handler will be called when the editor needs to
     * create an asset for some external content, like an image/video file or a bookmark URL. For
     * example, the 'file' type handler will be called when a user drops an image onto the canvas.
     *
     * The handler should extract any relevant metadata for the asset, upload it to blob storage
     * using {@link Editor.uploadAsset} if needed, and return the asset with the metadata & uploaded
     * URL.
     *
     * @example
     * ```ts
     * editor.registerExternalAssetHandler('file', myHandler)
     * ```
     *
     * @param type - The type of external content.
     * @param handler - The handler to use for this content type.
     *
     * @public
     */
    registerExternalAssetHandler<T extends TLExternalAsset['type']>(type: T, handler: null | ((info: TLExternalAsset & {
        type: T;
    }) => Promise<TLAsset>)): this;
    /**
     * Register a temporary preview of an asset. This is useful for showing a ghost image of
     * something that is being uploaded. Retrieve the placeholder with
     * {@link Editor.getTemporaryAssetPreview}. Placeholders last for 3 minutes by default, but this
     * can be configured using
     *
     * @example
     * ```ts
     * editor.createTemporaryAssetPreview(assetId, file)
     * ```
     *
     * @param assetId - The asset's id.
     * @param file - The raw file.
     *
     * @public
     */
    createTemporaryAssetPreview(assetId: TLAssetId, file: File): string | undefined;
    /**
     * Get temporary preview of an asset. This is useful for showing a ghost
     * image of something that is being uploaded.
     *
     * @example
     * ```ts
     * editor.getTemporaryAssetPreview('someId')
     * ```
     *
     * @param assetId - The asset's id.
     *
     * @public
     */
    getTemporaryAssetPreview(assetId: TLAssetId): string | undefined;
    /**
     * Get an asset for an external asset content type.
     *
     * @example
     * ```ts
     * const asset = await editor.getAssetForExternalContent({ type: 'file', file: myFile })
     * const asset = await editor.getAssetForExternalContent({ type: 'url', url: myUrl })
     * ```
     *
     * @param info - Info about the external content.
     * @returns The asset.
     */
    getAssetForExternalContent(info: TLExternalAsset): Promise<TLAsset | undefined>;
    hasExternalAssetHandler(type: TLExternalAsset['type']): boolean;
    /** @internal */
    externalContentHandlers: {
        [K in TLExternalContent<any>['type']]: {
            [Key in K]: null | ((info: Extract<TLExternalContent<any>, {
                type: Key;
            }>) => void);
        }[K];
    };
    /**
     * Register an external content handler. This handler will be called when the editor receives
     * external content of the provided type. For example, the 'image' type handler will be called
     * when a user drops an image onto the canvas.
     *
     * @example
     * ```ts
     * editor.registerExternalContentHandler('text', myHandler)
     * ```
     * @example
     * ```ts
     * editor.registerExternalContentHandler<'embed', MyEmbedType>('embed', myHandler)
     * ```
     *
     * @param type - The type of external content.
     * @param handler - The handler to use for this content type.
     *
     * @public
     */
    registerExternalContentHandler<T extends TLExternalContent<E>['type'], E>(type: T, handler: null | ((info: T extends TLExternalContent<E>['type'] ? Extract<TLExternalContent<E>, {
        type: T;
    }> : TLExternalContent<E>) => void)): this;
    /**
     * Handle external content, such as files, urls, embeds, or plain text which has been put into the app, for example by pasting external text or dropping external images onto canvas.
     *
     * @param info - Info about the external content.
     * @param opts - Options for handling external content, including force flag to bypass readonly checks.
     */
    putExternalContent<E>(info: TLExternalContent<E>, opts?: {
        force?: boolean | undefined;
    }): Promise<void>;
    /**
     * Handle replacing external content.
     *
     * @param info - Info about the external content.
     * @param opts - Options for handling external content, including force flag to bypass readonly checks.
     */
    replaceExternalContent<E>(info: TLExternalContent<E>, opts?: {
        force?: boolean | undefined;
    }): Promise<void>;
    /**
     * Get content that can be exported for the given shape ids.
     *
     * @param shapes - The shapes (or shape ids) to get content for.
     *
     * @returns The exported content.
     *
     * @public
     */
    getContentFromCurrentPage(shapes: TLShapeId[] | TLShape[]): TLContent | undefined;
    resolveAssetsInContent(content: TLContent | undefined): Promise<TLContent | undefined>;
    /**
     * Place content into the editor.
     *
     * @param content - The content.
     * @param opts - Options for placing the content.
     *
     * @public
     */
    putContentOntoCurrentPage(content: TLContent, opts?: {
        point?: VecLike;
        select?: boolean;
        preservePosition?: boolean;
        preserveIds?: boolean;
    }): this;
    /**
     * Get an exported SVG element of the given shapes.
     *
     * @param shapes - The shapes (or shape ids) to export.
     * @param opts - Options for the export.
     *
     * @returns The SVG element.
     *
     * @public
     */
    getSvgElement(shapes: TLShapeId[] | TLShape[], opts?: TLSvgExportOptions): Promise<{
        svg: SVGSVGElement;
        width: number;
        height: number;
        trimPadding: number;
    } | undefined>;
    /**
     * Get an exported SVG string of the given shapes.
     *
     * @param shapes - The shapes (or shape ids) to export.
     * @param opts - Options for the export.
     *
     * @returns The SVG element.
     *
     * @public
     */
    getSvgString(shapes: TLShapeId[] | TLShape[], opts?: TLSvgExportOptions): Promise<{
        svg: string;
        width: number;
        height: number;
        trimPadding: number;
    } | undefined>;
    /**
     * Get an exported image of the given shapes.
     *
     * @param shapes - The shapes (or shape ids) to export.
     * @param opts - Options for the export.
     *
     * @returns A blob of the image.
     * @public
     */
    toImage(shapes: TLShapeId[] | TLShape[], opts?: TLImageExportOptions): Promise<{
        blob: Blob;
        width: number;
        height: number;
    }>;
    /**
     * Get an exported image of the given shapes as a data URL.
     *
     * @param shapes - The shapes (or shape ids) to export.
     * @param opts - Options for the export.
     *
     * @returns A data URL of the image.
     * @public
     */
    toImageDataUrl(shapes: TLShapeId[] | TLShape[], opts?: TLImageExportOptions): Promise<{
        url: string;
        width: number;
        height: number;
    }>;
    /**
     * Dispatch a cancel event.
     *
     * @example
     * ```ts
     * editor.cancel()
     * ```
     *
     * @public
     */
    cancel(): this;
    /**
     * Dispatch an interrupt event.
     *
     * @example
     * ```ts
     * editor.interrupt()
     * ```
     *
     * @public
     */
    interrupt(): this;
    /**
     * Dispatch a complete event.
     *
     * @example
     * ```ts
     * editor.complete()
     * ```
     *
     * @public
     */
    complete(): this;
    /**
     * Dispatch a pointer move event in the current position of the pointer. This is useful when
     * external circumstances have changed (e.g. the camera moved or a shape was moved) and you want
     * the current interaction to respond to that change.
     *
     * @example
     * ```ts
     * editor.updatePointer()
     * ```
     *
     * @param options - The options for updating the pointer.
     * @returns The editor instance.
     * @public
     */
    updatePointer(options?: TLUpdatePointerOptions): this;
    /**
     * Puts the editor into focused mode.
     *
     * This makes the editor eligible to receive keyboard events and some pointer events (move, wheel).
     *
     * @example
     * ```ts
     * editor.focus()
     * ```
     *
     * By default this also dispatches a 'focus' event to the container element. To prevent this, pass `focusContainer: false`.
     *
     * @example
     * ```ts
     * editor.focus({ focusContainer: false })
     * ```
     *
     * @public
     */
    focus({ focusContainer }?: {
        focusContainer?: boolean | undefined;
    }): this;
    /**
     * Switches off the editor's focused mode.
     *
     * This makes the editor ignore keyboard events and some pointer events (move, wheel).
     *
     * @example
     * ```ts
     * editor.blur()
     * ```
     * By default this also dispatches a 'blur' event to the container element. To prevent this, pass `blurContainer: false`.
     *
     * @example
     * ```ts
     * editor.blur({ blurContainer: false })
     * ```
     *
     * @public
     */
    blur({ blurContainer }?: {
        blurContainer?: boolean | undefined;
    }): this;
    /**
     * @public
     * @returns true if the editor is focused
     */
    getIsFocused(): boolean;
    /**
     * @public
     * @returns true if the editor is in readonly mode
     */
    getIsReadonly(): boolean;
    /**
     * @public
     * @returns a snapshot of the store's UI and document state
     */
    getSnapshot(): TLEditorSnapshot;
    /**
     * Loads a snapshot into the editor.
     * @param snapshot - The snapshot to load.
     * @param opts - The options for loading the snapshot.
     * @returns
     */
    loadSnapshot(snapshot: Partial<TLEditorSnapshot> | TLStoreSnapshot, opts?: TLLoadSnapshotOptions): this;
    private _zoomToFitPageContentAt100Percent;
    private _navigateToDeepLink;
    /**
     * Handles navigating to the content specified by the query param in the given URL.
     *
     * Use {@link Editor.createDeepLink} to create a URL with a deep link query param.
     *
     * If no URL is provided, it will look for the param in the current `window.location.href`.
     *
     * @example
     * ```ts
     * editor.navigateToDeepLink()
     * ```
     *
     * The default parameter name is 'd'. You can override this by providing the `param` option.
     *
     * @example
     * ```ts
     * // disable page parameter and change viewport parameter to 'c'
     * editor.navigateToDeepLink({
     *   param: 'x',
     *   url: 'https://my-app.com/my-document?x=200.12.454.23.xyz123',
     * })
     * ```
     *
     * @param opts - Options for loading the state from the URL.
     */
    navigateToDeepLink(opts?: TLDeepLink | {
        url?: string | URL;
        param?: string;
    }): Editor;
    /**
     * Turns the given URL into a deep link by adding a query parameter.
     *
     * e.g. `https://my-app.com/my-document?d=100.100.200.200.xyz123`
     *
     * If no URL is provided, it will use the current `window.location.href`.
     *
     * @example
     * ```ts
     * // create a deep link to the current page + viewport
     * navigator.clipboard.writeText(editor.createDeepLink())
     * ```
     *
     * You can link to a particular set of shapes by providing a `to` parameter.
     *
     * @example
     * ```ts
     * // create a deep link to the set of currently selected shapes
     * navigator.clipboard.writeText(editor.createDeepLink({
     *   to: { type: 'selection', shapeIds: editor.getSelectedShapeIds() }
     * }))
     * ```
     *
     * The default query param is 'd'. You can override this by providing a `param` parameter.
     *
     * @example
     * ```ts
     * // Use `x` as the param name instead
     * editor.createDeepLink({ param: 'x' })
     * ```
     *
     * @param opts - Options for adding the state to the URL.
     * @returns the updated URL
     */
    createDeepLink(opts?: {
        url?: string | URL;
        param?: string;
        to?: TLDeepLink;
    }): URL;
    /**
     * Register a listener for changes to a deep link for the current document.
     *
     * You'll typically want to use this indirectly via the {@link TldrawEditorBaseProps.deepLinks} prop on the `<Tldraw />` component.
     *
     * By default this will update `window.location` in place, but you can provide a custom callback
     * to handle state changes on your own.
     *
     * @example
     * ```ts
     * editor.registerDeepLinkListener({
     *   onChange(url) {
     *     window.history.replaceState({}, document.title, url.toString())
     *   }
     * })
     * ```
     *
     * You can also provide a custom URL to update, in which case you must also provide `onChange`.
     *
     * @example
     * ```ts
     * editor.registerDeepLinkListener({
     *   getUrl: () => `https://my-app.com/my-document`,
     *   onChange(url) {
     *     setShareUrl(url.toString())
     *   }
     * })
     * ```
     *
     * By default this will update with a debounce interval of 500ms, but you can provide a custom interval.
     *
     * @example
     * ```ts
     * editor.registerDeepLinkListener({ debounceMs: 1000 })
     * ```
     * The default parameter name is `d`. You can override this by providing a `param` option.
     *
     * @example
     * ```ts
     * editor.registerDeepLinkListener({ param: 'x' })
     * ```
     * @param opts - Options for setting up the listener.
     * @returns a function that will stop the listener.
     */
    registerDeepLinkListener(opts?: TLDeepLinkOptions): () => void;
    /**
     * A manager for recording multiple click events.
     *
     * @internal
     */
    protected _clickManager: ClickManager;
    /**
     * Prevent a double click event from firing the next time the user clicks
     *
     * @public
     */
    cancelDoubleClick(): void;
    /**
     * The previous cursor. Used for restoring the cursor after pan events.
     *
     * @internal
     */
    private _prevCursor;
    /** @internal */
    private _shiftKeyTimeout;
    /** @internal */
    _setShiftKeyTimeout(): void;
    /** @internal */
    private _altKeyTimeout;
    /** @internal */
    _setAltKeyTimeout(): void;
    /** @internal */
    private _ctrlKeyTimeout;
    /** @internal */
    _setCtrlKeyTimeout(): void;
    /** @internal */
    private _metaKeyTimeout;
    /** @internal */
    _setMetaKeyTimeout(): void;
    /** @internal */
    private _restoreToolId;
    /** @internal */
    private _didPinch;
    /** @internal */
    private _selectedShapeIdsAtPointerDown;
    /**
     * Whether `_selectedShapeIdsAtPointerDown` holds a pre-gesture selection
     * captured by a `pointer_down` (the touch path) that a following pinch
     * should restore. False when no pointer_down preceded the pinch (the
     * Safari trackpad path uses gesture events), in which case `pinch_start`
     * captures the live selection instead.
     * @internal
     */
    private _didCaptureSelectionAtPointerDown;
    /** @internal */
    private _longPressTimeout;
    /** @internal */
    capturedPointerId: number | null;
    /** @internal */
    private readonly performanceTracker;
    /** @internal */
    private performanceTrackerTimeout;
    /** @internal */
    private handledEvents;
    /**
     * In tldraw, events are sometimes handled by multiple components. For example, the shapes might
     * have events, but the canvas handles events too. The way that the canvas handles events can
     * interfere with the with the shapes event handlers - for example, it calls `.preventDefault()`
     * on `pointerDown`, which also prevents `click` events from firing on the shapes.
     *
     * You can use `.stopPropagation()` to prevent the event from propagating to the rest of the
     * DOM, but that can impact non-tldraw event handlers set up elsewhere. By using
     * `markEventAsHandled`, you'll stop other parts of tldraw from handling the event without
     * impacting other, non-tldraw event handlers. See also {@link Editor.wasEventAlreadyHandled}.
     *
     * @public
     */
    markEventAsHandled(e: Event | {
        nativeEvent: Event;
    }): void;
    /**
     * Checks if an event has already been handled. See {@link Editor.markEventAsHandled}.
     *
     * @public
     */
    wasEventAlreadyHandled(e: Event | {
        nativeEvent: Event;
    }): boolean;
    /**
     * Dispatch an event to the editor.
     *
     * @example
     * ```ts
     * editor.dispatch(myPointerEvent)
     * ```
     *
     * @param info - The event info.
     *
     * @public
     */
    dispatch(info: TLEventInfo): this;
    private _pendingEventsForNextTick;
    private _flushEventsForTick;
    _flushEventForTick(info: TLEventInfo): this | undefined;
    /** @internal */
    private maybeTrackPerformance;
}
//# sourceMappingURL=Editor.d.ts.map