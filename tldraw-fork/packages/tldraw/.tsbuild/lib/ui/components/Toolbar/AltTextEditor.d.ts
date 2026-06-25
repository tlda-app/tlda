import { TLShapeId } from '@tldraw/editor';
/** @public */
export interface AltTextEditorProps {
    shapeId: TLShapeId;
    onClose(): void;
    source: 'image-toolbar' | 'video-toolbar';
}
/** @public @react */
export declare function AltTextEditor({ shapeId, onClose, source }: AltTextEditorProps): import("react/jsx-runtime").JSX.Element;
//# sourceMappingURL=AltTextEditor.d.ts.map