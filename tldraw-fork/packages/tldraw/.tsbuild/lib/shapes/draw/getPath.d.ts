import { TLDefaultDashStyle, TLDrawShape, TLDrawShapeSegment, Vec } from '@tldraw/editor';
import { StrokeOptions } from '../shared/freehand/types';
export declare function getHighlightFreehandSettings({ strokeWidth, showAsComplete }: {
    strokeWidth: number;
    showAsComplete: boolean;
}): StrokeOptions;
export declare function getFreehandOptions(shapeProps: {
    dash: TLDefaultDashStyle;
    isPen: boolean;
    isComplete: boolean;
}, strokeWidth: number, forceComplete: boolean, forceSolid: boolean): StrokeOptions;
/** @public */
export declare function getPointsFromDrawSegment(segment: TLDrawShapeSegment, scaleX: number, scaleY: number, points?: Vec[]): Vec[];
/** @public */
export declare function getPointsFromDrawSegments(segments: TLDrawShapeSegment[], scaleX?: number, scaleY?: number): Vec[];
export declare function getDrawShapeStrokeDashArray(shape: TLDrawShape, strokeWidth: number, dotAdjustment: number): string;
//# sourceMappingURL=getPath.d.ts.map