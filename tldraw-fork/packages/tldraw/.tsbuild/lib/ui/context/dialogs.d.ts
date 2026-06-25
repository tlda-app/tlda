import { Atom, Editor } from '@tldraw/editor';
import { ComponentType, ReactNode } from 'react';
/** @public */
export interface TLUiDialogProps {
    onClose(): void;
}
/** @public */
export interface TLUiDialog {
    id: string;
    onClose?(): void;
    component: ComponentType<TLUiDialogProps>;
    preventBackgroundClose?: boolean;
}
/** @public */
export interface TLUiDialogsContextType {
    addDialog(dialog: Omit<TLUiDialog, 'id'> & {
        id?: string;
    }): string;
    removeDialog(id: string): string;
    clearDialogs(): void;
    dialogs: Atom<TLUiDialog[]>;
}
/** @internal */
export declare const DialogsContext: import("react").Context<TLUiDialogsContextType | null>;
/** @public */
export interface TLUiDialogsProviderProps {
    context?: string;
    overrides?(editor: Editor): TLUiDialogsContextType;
    children: ReactNode;
}
/** @public @react */
export declare function TldrawUiDialogsProvider({ context, children }: TLUiDialogsProviderProps): import("react/jsx-runtime").JSX.Element;
/** @public */
export declare function useDialogs(): TLUiDialogsContextType;
//# sourceMappingURL=dialogs.d.ts.map