import { Atom, Editor } from '@tldraw/editor';
import { ReactNode } from 'react';
import { TLUiIconType } from '../icon-types';
/** @public */
export type AlertSeverity = 'success' | 'info' | 'warning' | 'error';
/** @public */
export interface TLUiToast {
    id: string;
    icon?: TLUiIconType;
    iconLabel?: string;
    severity?: AlertSeverity;
    title?: string;
    description?: string;
    actions?: TLUiToastAction[];
    keepOpen?: boolean;
    closeLabel?: string;
}
/** @public */
export interface TLUiToastAction {
    type: 'primary' | 'danger' | 'normal';
    label: string;
    onClick(): void;
}
/** @public */
export interface TLUiToastsContextType {
    addToast(toast: Omit<TLUiToast, 'id'> & {
        id?: string;
    }): string;
    removeToast(id: TLUiToast['id']): string;
    clearToasts(): void;
    toasts: Atom<TLUiToast[]>;
}
/** @internal */
export declare const ToastsContext: import("react").Context<TLUiToastsContextType | null>;
/** @public */
export interface TLUiToastsProviderProps {
    overrides?(editor: Editor): TLUiToastsContextType;
    children: ReactNode;
}
/** @public @react */
export declare function TldrawUiToastsProvider({ children }: TLUiToastsProviderProps): import("react/jsx-runtime").JSX.Element;
/** @public */
export declare function useToasts(): TLUiToastsContextType;
//# sourceMappingURL=toasts.d.ts.map