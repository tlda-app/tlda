import { Editor, TLShapeId } from '@tldraw/editor';
export declare function SkipToMainContent(): import("react/jsx-runtime").JSX.Element;
/** @public @react */
export declare const DefaultA11yAnnouncer: import("react").NamedExoticComponent<object>;
/**
 * Core function to generate accessibility announcements for selected shapes
 * @public
 */
export declare function generateShapeAnnouncementMessage(args: {
    editor: Editor;
    selectedShapeIds: TLShapeId[];
    msg(id: string, values?: Record<string, any>): string;
}): string;
/** @public */
export declare function useSelectedShapesAnnouncer(): void;
//# sourceMappingURL=A11y.d.ts.map