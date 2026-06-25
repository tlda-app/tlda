import { TLRichText } from '../misc/TLRichText';
import { RecordProps } from '../recordsWithProps';
import { TLDefaultColorStyle } from '../styles/TLColorStyle';
import { TLDefaultFontStyle } from '../styles/TLFontStyle';
import { TLDefaultHorizontalAlignStyle } from '../styles/TLHorizontalAlignStyle';
import { TLDefaultSizeStyle } from '../styles/TLSizeStyle';
import { TLDefaultVerticalAlignStyle } from '../styles/TLVerticalAlignStyle';
import { TLBaseShape } from './TLBaseShape';
/**
 * Properties for a note shape. Note shapes represent sticky notes or text annotations
 * with rich formatting capabilities and various styling options.
 *
 * @public
 * @example
 * ```ts
 * const noteProps: TLNoteShapeProps = {
 *   color: 'yellow',
 *   labelColor: 'black',
 *   size: 'm',
 *   font: 'draw',
 *   fontSizeAdjustment: null,
 *   align: 'middle',
 *   verticalAlign: 'middle',
 *   growY: 0,
 *   url: '',
 *   richText: toRichText('Hello **world**!'),
 *   scale: 1
 * }
 * ```
 */
export interface TLNoteShapeProps {
    /** Background color style of the note */
    color: TLDefaultColorStyle;
    /** Text color style for the note content */
    labelColor: TLDefaultColorStyle;
    /** Size style determining the font size and note dimensions */
    size: TLDefaultSizeStyle;
    /** Font family style for the note text */
    font: TLDefaultFontStyle;
    /** Ratio to scale the base font size when text needs to shrink to fit. Null means needs recomputation, 1 means no adjustment, and values less than 1 indicate shrinkage. */
    fontSizeAdjustment: number | null;
    /** Horizontal alignment of text within the note */
    align: TLDefaultHorizontalAlignStyle;
    /** Vertical alignment of text within the note */
    verticalAlign: TLDefaultVerticalAlignStyle;
    /** Additional height growth for the note beyond its base size */
    growY: number;
    /** Optional URL associated with the note for linking */
    url: string;
    /** Rich text content with formatting like bold, italic, etc. */
    richText: TLRichText;
    /** Scale factor applied to the note shape for display */
    scale: number;
    /** User ID of the person who first edited the note text */
    textFirstEditedBy: string | null;
}
/**
 * A note shape representing a sticky note or text annotation on the canvas.
 * Note shapes support rich text formatting, various styling options, and can
 * be used for annotations, reminders, or general text content.
 *
 * @public
 * @example
 * ```ts
 * const noteShape: TLNoteShape = {
 *   id: 'shape:note1',
 *   type: 'note',
 *   x: 100,
 *   y: 100,
 *   rotation: 0,
 *   index: 'a1',
 *   parentId: 'page:main',
 *   isLocked: false,
 *   opacity: 1,
 *   props: {
 *     color: 'light-blue',
 *     labelColor: 'black',
 *     size: 's',
 *     font: 'sans',
 *     fontSizeAdjustment: 0.85,
 *     align: 'start',
 *     verticalAlign: 'start',
 *     growY: 50,
 *     url: 'https://example.com',
 *     richText: toRichText('Important **note**!'),
 *     scale: 1
 *   },
 *   meta: {},
 *   typeName: 'shape'
 * }
 * ```
 */
export type TLNoteShape = TLBaseShape<'note', TLNoteShapeProps>;
/**
 * Validation schema for note shape properties. Defines the runtime validation rules
 * for all properties of note shapes, ensuring data integrity and type safety.
 *
 * @public
 * @example
 * ```ts
 * import { noteShapeProps } from '@tldraw/tlschema'
 *
 * // Used internally by the validation system
 * const validator = T.object(noteShapeProps)
 * const validatedProps = validator.validate(someNoteProps)
 * ```
 */
export declare const noteShapeProps: RecordProps<TLNoteShape>;
declare const Versions: {
    readonly AddUrlProp: "com.tldraw.shape.note/1";
    readonly RemoveJustify: "com.tldraw.shape.note/2";
    readonly MigrateLegacyAlign: "com.tldraw.shape.note/3";
    readonly AddVerticalAlign: "com.tldraw.shape.note/4";
    readonly MakeUrlsValid: "com.tldraw.shape.note/5";
    readonly AddFontSizeAdjustment: "com.tldraw.shape.note/6";
    readonly AddScale: "com.tldraw.shape.note/7";
    readonly AddLabelColor: "com.tldraw.shape.note/8";
    readonly AddRichText: "com.tldraw.shape.note/9";
    readonly AddRichTextAttrs: "com.tldraw.shape.note/10";
    readonly AddFirstEditedBy: "com.tldraw.shape.note/11";
    readonly MakeFontSizeAdjustmentRatio: "com.tldraw.shape.note/12";
};
/**
 * Version identifiers for note shape migrations. These version numbers track
 * significant schema changes over time, enabling proper data migration between versions.
 *
 * @public
 */
export { Versions as noteShapeVersions };
/**
 * Migration sequence for note shapes. Handles schema evolution over time by defining
 * how to upgrade and downgrade note shape data between different versions. Includes
 * migrations for URL properties, text alignment changes, vertical alignment addition,
 * font size adjustments, scaling support, label color, the transition from plain text to rich text,
 * and support for attrs property on richText.
 *
 * @public
 */
export declare const noteShapeMigrations: import("..").TLPropsMigrations;
//# sourceMappingURL=TLNoteShape.d.ts.map