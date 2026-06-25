import { Box, Vec } from '@tldraw/editor';
import { ElbowArrowBoxEdges, ElbowArrowInfoWithoutRoute, ElbowArrowOptions } from '../definitions';
/**
 * A transform that can be applied when working on elbow arrows. This only models flipping x/y or
 * transposing x/y (for 90 degree rotations).
 */
export interface ElbowArrowTransform {
    readonly x: 1 | -1;
    readonly y: 1 | -1;
    readonly transpose: boolean;
}
export declare const ElbowArrowTransform: {
    Identity: {
        readonly x: 1;
        readonly y: 1;
        readonly transpose: false;
    };
    Rotate90: {
        readonly x: -1;
        readonly y: 1;
        readonly transpose: true;
    };
    Rotate180: {
        readonly x: -1;
        readonly y: -1;
        readonly transpose: false;
    };
    Rotate270: {
        readonly x: 1;
        readonly y: -1;
        readonly transpose: true;
    };
    FlipX: {
        readonly x: -1;
        readonly y: 1;
        readonly transpose: false;
    };
    FlipY: {
        readonly x: 1;
        readonly y: -1;
        readonly transpose: false;
    };
};
export declare function transformElbowArrowTransform(a: ElbowArrowTransform, b: ElbowArrowTransform): {
    x: -1 | 1;
    y: -1 | 1;
    transpose: boolean;
};
export declare function debugElbowArrowTransform(transform: ElbowArrowTransform): "FlipX" | "FlipY" | "Identity" | "Rotate180" | "Rotate270" | "Rotate90" | "Transpose" | "spooky (transpose + flip both)";
export interface ElbowArrowWorkingBox {
    original: Box;
    expanded: Box;
    edges: ElbowArrowBoxEdges;
    isPoint: boolean;
}
export declare class ElbowArrowWorkingInfo {
    options: ElbowArrowOptions;
    A: ElbowArrowWorkingBox;
    B: ElbowArrowWorkingBox;
    common: {
        original: Box;
        expanded: Box;
    };
    gapX: number;
    gapY: number;
    midX: number | null;
    midY: number | null;
    bias: Vec;
    constructor(info: ElbowArrowInfoWithoutRoute);
    transform: ElbowArrowTransform;
    inverse: ElbowArrowTransform;
    apply(transform: ElbowArrowTransform): void;
    reset(): void;
    vec(x: number, y: number): Vec;
}
//# sourceMappingURL=ElbowArrowWorkingInfo.d.ts.map