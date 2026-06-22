import { ReadonlySharedStyleMap, StyleProp } from '@tldraw/editor';
/** @public */
export interface StylePanelContext {
    styles: ReadonlySharedStyleMap;
    enhancedA11yMode: boolean;
    onHistoryMark(id: string): void;
    onValueChange<T>(style: StyleProp<T>, value: T): void;
    onOpacityChange(opacity: number): void;
}
/** @public */
export interface StylePanelContextProviderProps {
    children: React.ReactNode;
    styles: ReadonlySharedStyleMap;
}
/** @public @react */
export declare function StylePanelContextProvider({ children, styles }: StylePanelContextProviderProps): import("react/jsx-runtime").JSX.Element;
/** @public */
export declare function useStylePanelContext(): StylePanelContext;
//# sourceMappingURL=StylePanelContext.d.ts.map