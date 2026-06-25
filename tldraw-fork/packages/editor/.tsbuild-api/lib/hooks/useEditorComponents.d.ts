import { ReactNode } from 'react';
import type { TLEditorComponents } from './EditorComponentsContext';
export { useEditorComponents } from './EditorComponentsContext';
export type { TLEditorComponents } from './EditorComponentsContext';
interface ComponentsContextProviderProps {
    overrides?: TLEditorComponents;
    children: ReactNode;
}
export declare function EditorComponentsProvider({ overrides, children }: ComponentsContextProviderProps): import("react/jsx-runtime").JSX.Element;
//# sourceMappingURL=useEditorComponents.d.ts.map