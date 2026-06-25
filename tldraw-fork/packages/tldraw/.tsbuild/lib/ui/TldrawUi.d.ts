import React, { ReactNode } from 'react';
import { TLUiAssetUrlOverrides } from './assetUrls';
import { TLUiComponents } from './context/components';
import { TLUiContextProviderProps } from './context/TldrawUiContextProvider';
/** @public */
export interface TldrawUiProps extends TLUiContextProviderProps {
    /**
     * The component's children.
     */
    children?: ReactNode;
    /**
     * Whether to hide the user interface and only display the canvas.
     */
    hideUi?: boolean;
    /**
     * Overrides for the UI components.
     */
    components?: TLUiComponents;
    /**
     * Additional items to add to the debug menu (will be deprecated)
     */
    renderDebugMenuItems?(): React.ReactNode;
    /** Asset URL override. */
    assetUrls?: TLUiAssetUrlOverrides;
}
/**
 * @public
 * @react
 */
export declare const TldrawUi: React.NamedExoticComponent<TldrawUiProps>;
/** @public @react */
export declare function TldrawUiInFrontOfTheCanvas(): import("react/jsx-runtime").JSX.Element;
//# sourceMappingURL=TldrawUi.d.ts.map