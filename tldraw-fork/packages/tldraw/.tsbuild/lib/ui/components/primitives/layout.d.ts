import { HTMLAttributes, ReactNode } from 'react';
/** @public */
export interface TldrawUiOrientationContext {
    orientation: 'horizontal' | 'vertical';
    tooltipSide: 'top' | 'right' | 'bottom' | 'left';
}
/** @public */
export interface TldrawUiOrientationProviderProps {
    children: ReactNode;
    orientation: 'horizontal' | 'vertical';
    tooltipSide?: 'top' | 'right' | 'bottom' | 'left';
}
/** @public @react */
export declare function TldrawUiOrientationProvider({ children, orientation, tooltipSide }: TldrawUiOrientationProviderProps): import("react/jsx-runtime").JSX.Element;
/** @public */
export declare function useTldrawUiOrientation(): TldrawUiOrientationContext;
/** @public */
export interface TLUiLayoutProps extends HTMLAttributes<HTMLDivElement> {
    children: ReactNode;
    tooltipSide?: 'top' | 'right' | 'bottom' | 'left';
    asChild?: boolean;
}
/**
 * A row, usually of UI controls like buttons, select dropdown, checkboxes, etc.
 *
 * @public @react
 */
export declare const TldrawUiRow: import("react").ForwardRefExoticComponent<TLUiLayoutProps & import("react").RefAttributes<HTMLDivElement>>;
/**
 * A column, usually of UI controls like buttons, select dropdown, checkboxes, etc.
 *
 * @public @react
 */
export declare const TldrawUiColumn: import("react").ForwardRefExoticComponent<TLUiLayoutProps & import("react").RefAttributes<HTMLDivElement>>;
/**
 * A tight grid 4 elements wide, usually of UI controls like buttons, select dropdown, checkboxes,
 * etc.
 *
 * @public @react */
export declare const TldrawUiGrid: import("react").ForwardRefExoticComponent<TLUiLayoutProps & import("react").RefAttributes<HTMLDivElement>>;
//# sourceMappingURL=layout.d.ts.map