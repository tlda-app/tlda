import { Editor, TLShape, TLTheme } from '@tldraw/editor';
/** @public */
export interface ShapeOptionsWithDisplayValues<Shape extends TLShape, DisplayValues extends object> {
    getDefaultDisplayValues(editor: Editor, shape: Shape, theme: TLTheme, colorMode: 'light' | 'dark'): DisplayValues;
    getCustomDisplayValues(editor: Editor, shape: Shape, theme: TLTheme, colorMode: 'light' | 'dark'): Partial<DisplayValues>;
}
/**
 * Get the resolved display values for a shape, merging the base values with any overrides.
 *
 * @public
 */
export declare function getDisplayValues<Shape extends TLShape, DisplayValues extends object>(util: {
    editor: Editor;
    options: ShapeOptionsWithDisplayValues<Shape, DisplayValues>;
}, shape: Shape, colorMode?: 'light' | 'dark'): DisplayValues;
//# sourceMappingURL=getDisplayValues.d.ts.map