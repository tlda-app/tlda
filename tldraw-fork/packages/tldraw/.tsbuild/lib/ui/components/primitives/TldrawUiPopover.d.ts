import React from 'react';
/** @public */
export interface TLUiPopoverProps {
    id: string;
    open?: boolean;
    children: React.ReactNode;
    onOpenChange?(isOpen: boolean): void;
    className?: string;
}
/** @public @react */
export declare function TldrawUiPopover({ id, children, onOpenChange, open, className }: TLUiPopoverProps): import("react/jsx-runtime").JSX.Element;
/** @public */
export interface TLUiPopoverTriggerProps {
    children?: React.ReactNode;
}
/** @public @react */
export declare function TldrawUiPopoverTrigger({ children }: TLUiPopoverTriggerProps): import("react/jsx-runtime").JSX.Element;
/** @public */
export interface TLUiPopoverContentProps {
    children: React.ReactNode;
    side: 'top' | 'bottom' | 'left' | 'right';
    align?: 'start' | 'center' | 'end';
    alignOffset?: number;
    sideOffset?: number;
    disableEscapeKeyDown?: boolean;
    autoFocusFirstButton?: boolean;
}
/** @public @react */
export declare function TldrawUiPopoverContent({ side, children, align, sideOffset, alignOffset, disableEscapeKeyDown, autoFocusFirstButton }: TLUiPopoverContentProps): import("react/jsx-runtime").JSX.Element;
//# sourceMappingURL=TldrawUiPopover.d.ts.map