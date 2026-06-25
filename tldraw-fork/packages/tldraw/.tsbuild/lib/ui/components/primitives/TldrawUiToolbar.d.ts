import React from 'react';
/** @public */
export interface TLUiToolbarProps extends React.HTMLAttributes<HTMLDivElement> {
    children?: React.ReactNode;
    className?: string;
    dir?: 'ltr' | 'rtl';
    label: string;
    orientation?: 'horizontal' | 'vertical' | 'grid';
    tooltipSide?: 'top' | 'right' | 'bottom' | 'left';
}
/** @public @react */
export declare const TldrawUiToolbar: React.ForwardRefExoticComponent<TLUiToolbarProps & React.RefAttributes<HTMLDivElement>>;
/** @public */
export interface TLUiToolbarButtonProps extends React.HTMLAttributes<HTMLButtonElement> {
    asChild?: boolean;
    children?: React.ReactNode;
    className?: string;
    disabled?: boolean;
    isActive?: boolean;
    type: 'icon' | 'tool' | 'menu';
    tooltip?: string;
}
/** @public @react */
export declare const TldrawUiToolbarButton: React.ForwardRefExoticComponent<TLUiToolbarButtonProps & React.RefAttributes<HTMLButtonElement>>;
/** @public */
export interface TLUiToolbarToggleGroupProps extends React.HTMLAttributes<HTMLDivElement> {
    children?: React.ReactNode;
    className?: string;
    dir?: 'ltr' | 'rtl';
    value: any;
    defaultValue?: any;
    type: 'single' | 'multiple';
    asChild?: boolean;
}
/** @public @react */
export declare function TldrawUiToolbarToggleGroup({ children, className, type, asChild, ...props }: TLUiToolbarToggleGroupProps): import("react/jsx-runtime").JSX.Element;
/** @public */
export interface TLUiToolbarToggleItemProps extends React.HTMLAttributes<HTMLButtonElement> {
    children?: React.ReactNode;
    className?: string;
    type: 'icon' | 'tool';
    value: string;
    tooltip?: React.ReactNode;
}
/** @public @react */
export declare function TldrawUiToolbarToggleItem({ children, className, type, value, tooltip, ...props }: TLUiToolbarToggleItemProps): import("react/jsx-runtime").JSX.Element;
//# sourceMappingURL=TldrawUiToolbar.d.ts.map