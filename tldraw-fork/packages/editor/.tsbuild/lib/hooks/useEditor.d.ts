import React from 'react';
import type { Editor } from '../editor/Editor';
/** @public */
export declare const EditorContext: React.Context<Editor | null>;
/** @public */
export declare function useEditor(): Editor;
/** @public */
export declare function useMaybeEditor(): Editor | null;
/** @public */
export interface EditorProviderProps {
    editor: Editor;
    children: React.ReactNode;
}
/** @public @react */
export declare function EditorProvider({ editor, children }: EditorProviderProps): import("react/jsx-runtime").JSX.Element;
//# sourceMappingURL=useEditor.d.ts.map