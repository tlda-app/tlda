import { Editor, ExtractShapeByProps, TLShapeId } from '@tldraw/editor';
import React from 'react';
/** @public */
export declare function useEditablePlainText(shapeId: TLShapeId, type: ExtractShapeByProps<{
    text: string;
}>['type'], text?: string): {
    rInput: React.RefObject<HTMLTextAreaElement | null>;
    handleKeyDown: (e: KeyboardEvent) => void;
    handleChange: ({ plaintext }: {
        plaintext: string;
    }) => void;
    isEmpty: boolean;
    handleFocus: () => void;
    handleBlur: () => void;
    handleInputPointerDown: (e: React.PointerEvent<Element>) => void;
    handleDoubleClick: (e: Event | {
        nativeEvent: Event;
    }) => void;
    handlePaste: (e: ClipboardEvent | React.ClipboardEvent<HTMLTextAreaElement>) => void;
    isEditing: boolean;
    isReadyForEditing: boolean;
};
/** @internal */
export declare function useIsReadyForEditing(editor: Editor, shapeId: TLShapeId): boolean;
/** @internal */
export declare function useEditableTextCommon(shapeId: TLShapeId): {
    handleFocus: () => void;
    handleBlur: () => void;
    handleInputPointerDown: (e: React.PointerEvent<Element>) => void;
    handleDoubleClick: (e: Event | {
        nativeEvent: Event;
    }) => void;
    handlePaste: (e: ClipboardEvent | React.ClipboardEvent<HTMLTextAreaElement>) => void;
    isEditing: boolean;
    isReadyForEditing: boolean;
};
//# sourceMappingURL=useEditablePlainText.d.ts.map