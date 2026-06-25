import { TLRichText } from '../misc/TLRichText';
import { RecordProps } from '../recordsWithProps';
import { TLDefaultColorStyle } from '../styles/TLColorStyle';
import { TLDefaultFontStyle } from '../styles/TLFontStyle';
import { TLDefaultSizeStyle } from '../styles/TLSizeStyle';
import { TLDefaultTextAlignStyle } from '../styles/TLTextAlignStyle';
import { TLBaseShape } from './TLBaseShape';
/**
 * Configuration interface defining properties for text shapes in tldraw.
 * Text shapes support rich formatting, styling, and automatic sizing.
 *
 * @public
 * @example
 * ```ts
 * const textProps: TLTextShapeProps = {
 *   color: 'black',
 *   size: 'm',
 *   font: 'draw',
 *   textAlign: 'start',
 *   w: 200,
 *   richText: toRichText('Hello **bold** text'),
 *   scale: 1,
 *   autoSize: true
 * }
 * ```
 */
export interface TLTextShapeProps {
    color: TLDefaultColorStyle;
    size: TLDefaultSizeStyle;
    font: TLDefaultFontStyle;
    textAlign: TLDefaultTextAlignStyle;
    w: number;
    richText: TLRichText;
    scale: number;
    autoSize: boolean;
}
/**
 * A text shape that can display formatted text content with various styling options.
 * Text shapes support rich formatting, automatic sizing, and consistent styling through
 * the tldraw style system.
 *
 * @public
 * @example
 * ```ts
 * const textShape: TLTextShape = {
 *   id: 'shape:text123',
 *   typeName: 'shape',
 *   type: 'text',
 *   x: 100,
 *   y: 200,
 *   rotation: 0,
 *   index: 'a1',
 *   parentId: 'page:main',
 *   isLocked: false,
 *   opacity: 1,
 *   props: {
 *     color: 'black',
 *     size: 'm',
 *     font: 'draw',
 *     textAlign: 'start',
 *     w: 200,
 *     richText: toRichText('Sample text'),
 *     scale: 1,
 *     autoSize: false
 *   },
 *   meta: {}
 * }
 * ```
 */
export type TLTextShape = TLBaseShape<'text', TLTextShapeProps>;
/**
 * Validation schema for text shape properties. This defines the runtime validation
 * rules that ensure text shape data integrity when records are stored or transmitted.
 *
 * @public
 * @example
 * ```ts
 * import { textShapeProps } from '@tldraw/tlschema'
 *
 * // Validate text shape properties
 * const isValid = textShapeProps.richText.isValid(myRichText)
 * if (isValid) {
 *   // Properties are valid, safe to use
 * }
 * ```
 */
export declare const textShapeProps: RecordProps<TLTextShape>;
declare const Versions: {
    readonly RemoveJustify: "com.tldraw.shape.text/1";
    readonly AddTextAlign: "com.tldraw.shape.text/2";
    readonly AddRichText: "com.tldraw.shape.text/3";
    readonly AddRichTextAttrs: "com.tldraw.shape.text/4";
};
/**
 * Version identifiers for text shape migrations. These constants track
 * the evolution of the text shape schema over time.
 *
 * @public
 * @example
 * ```ts
 * import { textShapeVersions } from '@tldraw/tlschema'
 *
 * // Check if shape data needs migration
 * if (shapeVersion < textShapeVersions.AddRichTextAttrs) {
 *   // Apply rich text attrs migration
 * }
 * ```
 */
export { Versions as textShapeVersions };
/**
 * Migration sequence for text shape schema evolution. This handles transforming
 * text shape data between different versions as the schema evolves over time.
 *
 * Key migrations include:
 * - RemoveJustify: Replaced 'justify' alignment with 'start'
 * - AddTextAlign: Migrated from 'align' to 'textAlign' property
 * - AddRichText: Converted plain text to rich text format
 * - AddRichTextAttrs: Added support for attrs property on richText
 *
 * @public
 */
export declare const textShapeMigrations: import("..").TLPropsMigrations;
//# sourceMappingURL=TLTextShape.d.ts.map