import { Box, ExtractShapeByProps, TLRichText, TLShapeId } from '@tldraw/editor';
import React from 'react';
/** @public */
export interface RichTextLabelProps {
    shapeId: TLShapeId;
    type: ExtractShapeByProps<{
        richText: TLRichText;
    }>['type'];
    fontFamily: string;
    fontSize: number;
    lineHeight: number;
    textAlign: 'start' | 'center' | 'end';
    verticalAlign: 'start' | 'middle' | 'end';
    wrap?: boolean;
    richText?: TLRichText;
    labelColor: string;
    bounds?: Box;
    isSelected: boolean;
    onKeyDown?(e: KeyboardEvent): void;
    classNamePrefix?: string;
    style?: React.CSSProperties;
    textWidth?: number;
    textHeight?: number;
    padding?: number;
    hasCustomTabBehavior?: boolean;
    showTextOutline?: boolean;
}
/**
 * Renders a text label that can be used inside of shapes.
 * The component has the ability to be edited in place and furthermore
 * supports rich text editing.
 *
 * @public @react
 */
export declare const RichTextLabel: React.NamedExoticComponent<RichTextLabelProps>;
/** @public */
export interface RichTextSVGProps {
    bounds: Box;
    richText: TLRichText;
    fontSize: number;
    fontFamily: string;
    lineHeight: number;
    textAlign: 'start' | 'center' | 'end';
    verticalAlign: 'start' | 'middle' | 'end';
    wrap?: boolean;
    labelColor: string;
    padding: number;
    showTextOutline?: boolean;
}
/**
 * Renders a rich text string as SVG given bounds and text properties.
 *
 * @public @react
 */
export declare function RichTextSVG({ bounds, richText, fontSize, fontFamily, lineHeight, textAlign, verticalAlign, wrap, labelColor, padding, showTextOutline }: RichTextSVGProps): import("react/jsx-runtime").JSX.Element;
//# sourceMappingURL=RichTextLabel.d.ts.map