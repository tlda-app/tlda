import { ReactNode } from 'react';
/** @public */
export interface TLUiDropdownMenuRootProps {
    id: string;
    children: ReactNode;
    modal?: boolean;
    debugOpen?: boolean;
}
/** @public @react */
export declare function TldrawUiDropdownMenuRoot({ id, children, modal, debugOpen }: TLUiDropdownMenuRootProps): import("react/jsx-runtime").JSX.Element;
/** @public */
export interface TLUiDropdownMenuTriggerProps {
    children?: ReactNode;
}
/** @public @react */
export declare function TldrawUiDropdownMenuTrigger({ children, ...rest }: TLUiDropdownMenuTriggerProps): import("react/jsx-runtime").JSX.Element;
/** @public */
export interface TLUiDropdownMenuContentProps {
    id?: string;
    className?: string;
    side?: 'bottom' | 'top' | 'right' | 'left';
    align?: 'start' | 'center' | 'end';
    sideOffset?: number;
    alignOffset?: number;
    children: ReactNode;
}
/** @public @react */
export declare function TldrawUiDropdownMenuContent({ className, side, align, sideOffset, alignOffset, children }: TLUiDropdownMenuContentProps): import("react/jsx-runtime").JSX.Element;
/** @public */
export interface TLUiDropdownMenuSubProps {
    id: string;
    children: ReactNode;
}
/** @public @react */
export declare function TldrawUiDropdownMenuSub({ id, children }: TLUiDropdownMenuSubProps): import("react/jsx-runtime").JSX.Element;
/** @public */
export interface TLUiDropdownMenuSubTriggerProps {
    label: string;
    id?: string;
    title?: string;
    disabled?: boolean;
}
/** @public @react */
export declare function TldrawUiDropdownMenuSubTrigger({ id, label, title, disabled }: TLUiDropdownMenuSubTriggerProps): import("react/jsx-runtime").JSX.Element;
/** @public */
export interface TLUiDropdownMenuSubContentProps {
    id?: string;
    alignOffset?: number;
    sideOffset?: number;
    size?: 'tiny' | 'small' | 'medium' | 'wide';
    children: ReactNode;
}
/** @public @react */
export declare function TldrawUiDropdownMenuSubContent({ id, alignOffset, sideOffset, size, children }: TLUiDropdownMenuSubContentProps): import("react/jsx-runtime").JSX.Element;
/** @public */
export interface TLUiDropdownMenuGroupProps {
    children: ReactNode;
    className?: string;
}
/** @public @react */
export declare function TldrawUiDropdownMenuGroup({ className, children }: TLUiDropdownMenuGroupProps): import("react/jsx-runtime").JSX.Element;
/** @public @react */
export declare function TldrawUiDropdownMenuIndicator(): import("react/jsx-runtime").JSX.Element;
/** @public */
export interface TLUiDropdownMenuItemProps {
    noClose?: boolean;
    children: ReactNode;
}
/** @public @react */
export declare function TldrawUiDropdownMenuItem({ noClose, children }: TLUiDropdownMenuItemProps): import("react/jsx-runtime").JSX.Element;
/** @public */
export interface TLUiDropdownMenuCheckboxItemProps {
    checked?: boolean;
    onSelect?(e: Event): void;
    disabled?: boolean;
    title: string;
    children: ReactNode;
}
/** @public @react */
export declare function TldrawUiDropdownMenuCheckboxItem({ children, onSelect, ...rest }: TLUiDropdownMenuCheckboxItemProps): import("react/jsx-runtime").JSX.Element;
//# sourceMappingURL=TldrawUiDropdownMenu.d.ts.map