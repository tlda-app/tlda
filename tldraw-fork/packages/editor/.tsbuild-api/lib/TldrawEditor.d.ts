import { MigrationSequence } from '@tldraw/store';
import { TLShape, TLStore, TLStoreSnapshot, TLThemeId, TLThemes } from '@tldraw/tlschema';
import React, { ReactNode } from 'react';
import { TLCurrentUser } from './config/createTLCurrentUser';
import { TLStoreBaseOptions } from './config/createTLStore';
import { TLAnyAssetUtilConstructor } from './config/defaultAssets';
import { TLAnyBindingUtilConstructor } from './config/defaultBindings';
import { TLAnyShapeUtilConstructor } from './config/defaultShapes';
import { TLEditorSnapshot } from './config/TLEditorSnapshot';
import { Editor } from './editor/Editor';
import { TLAnyOverlayUtilConstructor } from './editor/overlays/OverlayUtil';
import { TLStateNodeConstructor } from './editor/tools/StateNode';
import { TLCameraOptions } from './editor/types/misc-types';
import type { TLEditorComponents } from './hooks/EditorComponentsContext';
import { TldrawOptions } from './options';
import { TLDeepLinkOptions } from './utils/deepLinks';
import { TLTextOptions } from './utils/richText';
import { TLStoreWithStatus } from './utils/sync/StoreWithStatus';
/**
 * Props for the {@link tldraw#Tldraw} and {@link TldrawEditor} components, when passing in a
 * `TLStore` directly. If you would like tldraw to create a store for you, use
 * {@link TldrawEditorWithoutStoreProps}.
 *
 * @public
 */
export interface TldrawEditorWithStoreProps {
    /**
     * The store to use in the editor.
     */
    store: TLStore | TLStoreWithStatus;
}
/**
 * Props for the {@link tldraw#Tldraw} and {@link TldrawEditor} components, when not passing in a
 * `TLStore` directly. If you would like to pass in a store directly, use
 * {@link TldrawEditorWithStoreProps}.
 *
 * @public
 */
export interface TldrawEditorWithoutStoreProps extends TLStoreBaseOptions {
    store?: undefined;
    /**
     * Additional migrations to use in the store
     */
    migrations?: readonly MigrationSequence[];
    /**
     * A starting snapshot of data to pre-populate the store. Do not supply both this and
     * `initialData`.
     */
    snapshot?: TLEditorSnapshot | TLStoreSnapshot;
    /**
     * If you would like to persist the store to the browser's local IndexedDB storage and sync it
     * across tabs, provide a key here. Each key represents a single tldraw document.
     */
    persistenceKey?: string;
    sessionId?: string;
}
/** @public */
export type TldrawEditorStoreProps = TldrawEditorWithoutStoreProps | TldrawEditorWithStoreProps;
/**
 * Props for the {@link tldraw#Tldraw} and {@link TldrawEditor} components.
 *
 * @public
 **/
export type TldrawEditorProps = TldrawEditorBaseProps & TldrawEditorStoreProps;
/**
 * Base props for the {@link tldraw#Tldraw} and {@link TldrawEditor} components.
 *
 * @public
 */
export interface TldrawEditorBaseProps {
    /**
     * The component's children.
     */
    children?: ReactNode;
    /**
     * An array of shape utils to use in the editor.
     */
    shapeUtils?: readonly TLAnyShapeUtilConstructor[];
    /**
     * An array of binding utils to use in the editor.
     */
    bindingUtils?: readonly TLAnyBindingUtilConstructor[];
    /**
     * An array of asset utils to use in the editor.
     */
    assetUtils?: readonly TLAnyAssetUtilConstructor[];
    /**
     * An array of overlay utils to use in the editor for canvas overlay UI elements.
     */
    overlayUtils?: readonly TLAnyOverlayUtilConstructor[];
    /**
     * An array of tools to add to the editor's state chart.
     */
    tools?: readonly TLStateNodeConstructor[];
    /**
     * Whether to automatically focus the editor when it mounts.
     */
    autoFocus?: boolean;
    /**
     * Overrides for the editor's components, such as handles, collaborator cursors, etc.
     */
    components?: TLEditorComponents;
    /**
     * Called when the editor has mounted.
     */
    onMount?: TLOnMountHandler;
    /**
     * The editor's initial state (usually the id of the first active tool).
     */
    initialState?: string;
    /**
     * A classname to pass to the editor's container.
     */
    className?: string;
    /**
     * The user interacting with the editor.
     */
    user?: TLCurrentUser;
    /**
     * The editor's color scheme. Defaults to `'light'`.
     *
     * - `'light'` - Always use light mode.
     * - `'dark'` - Always use dark mode.
     * - `'system'` - Follow the OS color scheme preference.
     */
    colorScheme?: 'dark' | 'light' | 'system';
    /**
     * Named themes for the editor.
     */
    themes?: Partial<TLThemes>;
    /**
     * The id of the initially active theme. Defaults to `'default'`.
     */
    initialTheme?: TLThemeId;
    /**
     * Camera options for the editor.
     *
     * @deprecated Use `options.cameraOptions` instead. This will be removed in a future release.
     */
    cameraOptions?: Partial<TLCameraOptions>;
    /**
     * Options for the editor.
     */
    options?: Partial<TldrawOptions>;
    /**
     * Text options for the editor.
     *
     * @deprecated Use `options.text` instead. This prop will be removed in a future release.
     */
    textOptions?: TLTextOptions;
    /**
     * The license key.
     */
    licenseKey?: string;
    /**
     * Options for syncing the editor's camera state with the URL.
     *
     * @deprecated Use `options.deepLinks` instead. This prop will be removed in a future release.
     */
    deepLinks?: TLDeepLinkOptions | true;
    /**
     * Provides a way to hide shapes.
     *
     * Hidden shapes will not render in the editor, and they will not be eligible for hit test via
     * {@link @tldraw/editor#Editor.getShapeAtPoint} and {@link @tldraw/editor#Editor.getShapesAtPoint}. But otherwise they will
     * remain in the store and participate in all other operations.
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
    getShapeVisibility?(shape: TLShape, editor: Editor): 'hidden' | 'inherit' | 'visible' | null | undefined;
    /**
     * The URLs for the fonts to use in the editor.
     */
    assetUrls?: {
        fonts?: {
            [key: string]: string | undefined;
        };
    };
}
/**
 * Called when the editor has mounted.
 * @example
 * ```ts
 * <Tldraw onMount={(editor) => editor.selectAll()} />
 * ```
 * @param editor - The editor instance.
 *
 * @public
 */
export type TLOnMountHandler = (editor: Editor) => (() => undefined | void) | undefined | void;
declare global {
    interface Window {
        tldrawReady: boolean;
    }
}
/** @internal */
export declare const TL_CONTAINER_CLASS = "tl-container";
/** @public @react */
export declare const TldrawEditor: React.NamedExoticComponent<TldrawEditorProps>;
/** @public */
export interface LoadingScreenProps {
    children: ReactNode;
}
/** @public @react */
export declare function LoadingScreen({ children }: LoadingScreenProps): import("react/jsx-runtime").JSX.Element;
/** @public @react */
export declare function ErrorScreen({ children }: LoadingScreenProps): import("react/jsx-runtime").JSX.Element;
/** @internal */
export declare function useOnMount(onMount?: TLOnMountHandler): void;
//# sourceMappingURL=TldrawEditor.d.ts.map