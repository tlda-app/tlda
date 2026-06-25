import { Atom } from '@tldraw/editor';
/** @public */
export type A11yPriority = 'polite' | 'assertive';
/** @public */
export interface TLUiA11y {
    msg: string | undefined;
    priority?: A11yPriority;
}
/** @public */
export interface TLUiA11yContextType {
    announce(msg: TLUiA11y): void;
    currentMsg: Atom<TLUiA11y>;
}
/** @internal */
export declare const A11yContext: import("react").Context<TLUiA11yContextType | null>;
/** @public */
export interface A11yProviderProps {
    children: React.ReactNode;
}
/** @public @react */
export declare function TldrawUiA11yProvider({ children }: A11yProviderProps): import("react/jsx-runtime").JSX.Element;
/** @public */
export declare function useA11y(): TLUiA11yContextType;
//# sourceMappingURL=a11y.d.ts.map