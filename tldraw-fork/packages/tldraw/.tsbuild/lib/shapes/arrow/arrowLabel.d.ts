import { Arc2d, Box, Edge2d, Editor, Geometry2d, Polyline2d, TLArrowShape, TLShape } from '@tldraw/editor';
export declare function getArrowBodyGeometry(editor: Editor, shape: TLArrowShape): Arc2d | Edge2d | Polyline2d;
export declare function getArrowLabelPosition(editor: Editor, shape: TLArrowShape, isEditing: boolean): {
    box: Box;
    debugGeom: Geometry2d[];
};
export declare function getArrowLabelDefaultPosition(editor: Editor, shape: TLArrowShape): number;
/** @internal */
export declare function isOverArrowLabel(editor: Editor, shape: TLShape): boolean;
//# sourceMappingURL=arrowLabel.d.ts.map