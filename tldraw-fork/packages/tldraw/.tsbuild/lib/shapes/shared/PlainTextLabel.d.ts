import { Box, ExtractShapeByProps, TLShapeId } from '@tldraw/editor';
import React from 'react';
/** @public */
export interface PlainTextLabelProps {
    shapeId: TLShapeId;
    type: ExtractShapeByProps<{
        text: string;
    }>['type'];
    fontFamily: string;
    fontSize: number;
    lineHeight: number;
    textAlign: 'start' | 'center' | 'end';
    verticalAlign: 'start' | 'middle' | 'end';
    wrap?: boolean;
    text?: string;
    labelColor: string;
    bounds?: Box;
    isSelected: boolean;
    onKeyDown?(e: KeyboardEvent): void;
    classNamePrefix?: string;
    style?: React.CSSProperties;
    textWidth?: number;
    textHeight?: number;
    padding?: number;
    showTextOutline?: boolean;
}
/**
 * Renders a text label that can be used inside of shapes.
 * The component has the ability to be edited in place and furthermore
 * supports rich text editing.
 *
 * @public @react
 */
export declare const PlainTextLabel: React.NamedExoticComponent<PlainTextLabelProps>;
//# sourceMappingURL=PlainTextLabel.d.ts.map