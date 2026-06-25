import React from 'react';
/** @public */
export interface TldrawUiTooltipProps {
    children: React.ReactNode;
    content?: string | React.ReactNode;
    side?: 'top' | 'right' | 'bottom' | 'left';
    sideOffset?: number;
    disabled?: boolean;
    showOnMobile?: boolean;
    delayDuration?: number;
}
/** @public */
export declare function hideAllTooltips(): void;
/** @public */
export interface TldrawUiTooltipProviderProps {
    children: React.ReactNode;
}
/** @public @react */
export declare function TldrawUiTooltipProvider({ children }: TldrawUiTooltipProviderProps): import("react/jsx-runtime").JSX.Element;
/** @public @react */
export declare const TldrawUiTooltip: React.ForwardRefExoticComponent<TldrawUiTooltipProps & React.RefAttributes<HTMLButtonElement>>;
//# sourceMappingURL=TldrawUiTooltip.d.ts.map