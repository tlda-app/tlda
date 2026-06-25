import { RecursivePartial } from '@tldraw/editor';
import { ReactNode } from 'react';
import { TLUiAssetUrls } from '../assetUrls';
import { TLUiOverrides } from '../overrides';
import { TLUiComponents } from './components';
import { TLUiEventHandler } from './events';
/** @public */
export interface TLUiContextProviderProps {
    /**
     * Urls for where to find fonts and other assets for the UI.
     */
    assetUrls?: RecursivePartial<TLUiAssetUrls>;
    /**
     * Overrides for the UI.
     */
    overrides?: TLUiOverrides | TLUiOverrides[];
    /**
     * Overrides for the UI components.
     */
    components?: TLUiComponents;
    /**
     * Callback for when an event occurs in the UI.
     */
    onUiEvent?: TLUiEventHandler;
    /**
     * Whether to always should the mobile breakpoints.
     */
    forceMobile?: boolean;
    /**
     * The component's children.
     */
    children?: ReactNode;
    /**
     * Supported mime types for media files.
     */
    mediaMimeTypes?: string[];
}
/** @public @react */
export declare const TldrawUiContextProvider: import("react").NamedExoticComponent<TLUiContextProviderProps>;
//# sourceMappingURL=TldrawUiContextProvider.d.ts.map