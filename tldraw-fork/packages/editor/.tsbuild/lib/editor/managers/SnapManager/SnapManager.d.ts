import { TLShapeId } from '@tldraw/tlschema';
import { Vec, VecLike } from '../../../primitives/Vec';
import type { Editor } from '../../Editor';
import { BoundsSnaps } from './BoundsSnaps';
import { HandleSnaps } from './HandleSnaps';
/** @public */
export interface PointsSnapIndicator {
    id: string;
    type: 'points';
    points: VecLike[];
}
/** @public */
export interface GapsSnapIndicator {
    id: string;
    type: 'gaps';
    direction: 'horizontal' | 'vertical';
    gaps: Array<{
        startEdge: [VecLike, VecLike];
        endEdge: [VecLike, VecLike];
    }>;
}
/** @public */
export type SnapIndicator = PointsSnapIndicator | GapsSnapIndicator;
/** @public */
export interface SnapData {
    nudge: Vec;
}
/** @public */
export declare class SnapManager {
    readonly editor: Editor;
    readonly shapeBounds: BoundsSnaps;
    readonly handles: HandleSnaps;
    private _snapIndicators;
    constructor(editor: Editor);
    getIndicators(): SnapIndicator[];
    clearIndicators(): void;
    setIndicators(indicators: SnapIndicator[]): void;
    getSnapThreshold(): number;
    getSnappableShapes(): Set<TLShapeId>;
    getCurrentCommonAncestor(): TLShapeId | undefined;
}
//# sourceMappingURL=SnapManager.d.ts.map