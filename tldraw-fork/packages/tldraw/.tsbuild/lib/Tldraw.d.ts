import { TLEditorComponents, TLTextOptions, TldrawEditorBaseProps, TldrawEditorStoreProps } from '@tldraw/editor';
import { TLEmbedDefinition } from './defaultEmbedDefinitions';
import { TLExternalContentProps } from './defaultExternalContentHandlers';
import { TLUiAssetUrlOverrides } from './ui/assetUrls';
import { TLUiComponents } from './ui/context/components';
import { TldrawUiProps } from './ui/TldrawUi';
/**
 * Override the default react components used by the editor and UI. Set components to null to
 * disable them entirely.
 *
 * @example
 * ```tsx
 * import {Tldraw, TLComponents} from 'tldraw'
 *
 * const components: TLComponents = {
 *    Scribble: MyCustomScribble,
 * }
 *
 * export function MyApp() {
 *   return <Tldraw components={components} />
 * }
 * ```
 *
 *
 * @public
 */
export interface TLComponents extends TLEditorComponents, TLUiComponents {
}
/** @public */
export interface TldrawBaseProps extends TldrawUiProps, TldrawEditorBaseProps, TLExternalContentProps {
    /** Urls for custom assets.
     *
     * ⚠︎ Important! This must be memoized (with useMemo) or defined outside of any React component.
     */
    assetUrls?: TLUiAssetUrlOverrides;
    /** Overrides for tldraw's components.
     *
     * ⚠︎ Important! This must be memoized (with useMemo) or defined outside of any React component.
     */
    components?: TLComponents;
    /** Custom definitions for tldraw's embeds.
     *
     * ⚠︎ Important! This must be memoized (with useMemo) or defined outside of any React component.
     *
     * @deprecated Use `EmbedShapeUtil.configure({ embedDefinitions: embeds })` instead.
     */
    embeds?: TLEmbedDefinition[];
    /**
     * Text options for the editor.
     *
     * @deprecated Use `options.text` instead. This prop will be removed in a future release.
     */
    textOptions?: TLTextOptions;
    /**
     * The locale to use for the editor's UI. When set, this takes priority over
     * both the browser's language preferences (`navigator.languages`) and the
     * user's locale preference (e.g. via
     * `editor.user.updateUserPreferences({ locale: '...' })`), giving the
     * application explicit control over the displayed language.
     *
     * @example
     * ```tsx
     * <Tldraw locale="fr" />
     * ```
     */
    locale?: string;
}
/** @public */
export type TldrawProps = TldrawBaseProps & TldrawEditorStoreProps;
/** @public @react */
export declare function Tldraw(props: TldrawProps): import("react/jsx-runtime").JSX.Element;
//# sourceMappingURL=Tldraw.d.ts.map