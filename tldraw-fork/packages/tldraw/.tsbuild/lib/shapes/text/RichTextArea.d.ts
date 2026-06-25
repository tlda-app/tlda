import { TLRichText, TLShapeId } from '@tldraw/editor';
import React from 'react';
/** @public */
export interface TextAreaProps {
    isEditing: boolean;
    text?: string;
    shapeId: TLShapeId;
    richText?: TLRichText;
    handleFocus(): void;
    handleBlur(): void;
    handleKeyDown(e: KeyboardEvent): void;
    handleChange(changeInfo: {
        plaintext?: string;
        richText?: TLRichText;
    }): void;
    handleInputPointerDown(e: React.PointerEvent<HTMLElement>): void;
    handleDoubleClick(e: any): any;
    handlePaste(e: ClipboardEvent | React.ClipboardEvent<HTMLTextAreaElement>): void;
    hasCustomTabBehavior?: boolean;
}
/**
 * N.B. In Development mode you need to ensure you're testing this without StrictMode on.
 * Otherwise it's not gonna work as expected on iOS.
 * Specifically, it means that the virtual keyboard won't pop open sometimes
 * (iOS starts flipping out when you render multiple times when trying to focus something) .
 */
/**
 * A rich text area that can be used for editing text with rich text formatting.
 * This component uses the TipTap editor under the hood.
 *
 * @public @react
 */
export declare const RichTextArea: React.ForwardRefExoticComponent<TextAreaProps & React.RefAttributes<HTMLDivElement>>;
//# sourceMappingURL=RichTextArea.d.ts.map