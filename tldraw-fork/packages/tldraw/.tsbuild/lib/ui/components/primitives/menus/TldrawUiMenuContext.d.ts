import { TLUiEventSource } from '../../../context/events';
/** @public */
export type TLUiMenuContextType = 'menu' | 'small-icons' | 'context-menu' | 'icons' | 'keyboard-shortcuts' | 'helper-buttons' | 'toolbar' | 'toolbar-overflow';
/** @public */
export declare function useTldrawUiMenuContext(): {
    type: TLUiMenuContextType;
    sourceId: TLUiEventSource;
};
/** @public */
export interface TLUiMenuContextProviderProps {
    type: TLUiMenuContextType;
    sourceId: TLUiEventSource;
    children: React.ReactNode;
}
/** @public @react */
export declare function TldrawUiMenuContextProvider({ type, sourceId, children }: TLUiMenuContextProviderProps): import("react/jsx-runtime").JSX.Element;
//# sourceMappingURL=TldrawUiMenuContext.d.ts.map