import { Editor } from '@tldraw/editor';
/**
 * Hide the "back to content" helper button right away, regardless of where the
 * camera currently is. This is used when the user has explicitly chosen to
 * navigate back to the content (e.g. via the "move focus to canvas" button): the
 * button should disappear on intent rather than waiting for the camera animation
 * to physically bring a shape back into the viewport. The button falls back to
 * its normal reactive logic after `durationMs`, by which point the camera has
 * arrived and the content is visible.
 * @internal
 */
export declare function suppressBackToContent(editor: Editor, durationMs: number): void;
export declare function BackToContent(): import("react/jsx-runtime").JSX.Element | null;
//# sourceMappingURL=BackToContent.d.ts.map