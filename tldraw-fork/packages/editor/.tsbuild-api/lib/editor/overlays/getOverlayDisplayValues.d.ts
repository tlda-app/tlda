import { TLTheme } from '@tldraw/tlschema';
import type { Editor } from '../Editor';
import { TLOverlay } from './OverlayUtil';
/** @public */
export interface OverlayOptionsWithDisplayValues<Overlay extends TLOverlay, DisplayValues extends object> {
    getDefaultDisplayValues(editor: Editor, overlay: Overlay, theme: TLTheme, colorMode: 'dark' | 'light'): DisplayValues;
    getCustomDisplayValues(editor: Editor, overlay: Overlay, theme: TLTheme, colorMode: 'dark' | 'light'): Partial<DisplayValues>;
}
/**
 * Get the resolved display values for an overlay, merging the base values with any overrides.
 *
 * @public
 */
export declare function getOverlayDisplayValues<Overlay extends TLOverlay, DisplayValues extends object>(util: {
    editor: Editor;
    options: OverlayOptionsWithDisplayValues<Overlay, DisplayValues>;
}, overlay: Overlay, colorMode?: 'dark' | 'light'): DisplayValues;
//# sourceMappingURL=getOverlayDisplayValues.d.ts.map