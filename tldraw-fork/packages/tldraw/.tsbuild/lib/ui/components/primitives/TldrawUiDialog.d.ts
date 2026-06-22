import { CSSProperties, ReactNode } from 'react';
/** @public */
export interface TLUiDialogHeaderProps {
    className?: string;
    children: ReactNode;
}
/** @public @react */
export declare function TldrawUiDialogHeader({ className, children }: TLUiDialogHeaderProps): import("react/jsx-runtime").JSX.Element;
/** @public */
export interface TLUiDialogTitleProps {
    className?: string;
    children: ReactNode;
    style?: CSSProperties;
}
/** @public @react */
export declare function TldrawUiDialogTitle({ className, children, style }: TLUiDialogTitleProps): import("react/jsx-runtime").JSX.Element;
/** @public @react */
export declare function TldrawUiDialogCloseButton(): import("react/jsx-runtime").JSX.Element;
/** @public */
export interface TLUiDialogBodyProps {
    className?: string;
    children: ReactNode;
    style?: CSSProperties;
}
/** @public @react */
export declare function TldrawUiDialogBody({ className, children, style }: TLUiDialogBodyProps): import("react/jsx-runtime").JSX.Element;
/** @public */
export interface TLUiDialogFooterProps {
    className?: string;
    children?: ReactNode;
}
/** @public @react */
export declare function TldrawUiDialogFooter({ className, children }: TLUiDialogFooterProps): import("react/jsx-runtime").JSX.Element;
//# sourceMappingURL=TldrawUiDialog.d.ts.map