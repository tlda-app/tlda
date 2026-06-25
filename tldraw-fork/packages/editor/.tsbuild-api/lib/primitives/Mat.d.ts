import { Box } from './Box';
import { Vec, VecLike } from './Vec';
/** @public */
export type MatLike = Mat | MatModel;
/** @public */
export interface MatModel {
    a: number;
    b: number;
    c: number;
    d: number;
    e: number;
    f: number;
}
/** @public */
export declare class Mat {
    constructor(a: number, b: number, c: number, d: number, e: number, f: number);
    a: number;
    b: number;
    c: number;
    d: number;
    e: number;
    f: number;
    equals(m: Mat | MatModel): boolean;
    identity(): this;
    multiply(m: Mat | MatModel): this;
    rotate(r: number, cx?: number, cy?: number): Mat;
    translate(x: number, y: number): Mat;
    scale(x: number, y: number): this;
    invert(): this;
    applyToPoint(point: VecLike): Vec;
    applyToPoints(points: VecLike[]): Vec[];
    rotation(): number;
    point(): Vec;
    decomposed(): {
        rotation: number;
        scaleX: number;
        scaleY: number;
        x: number;
        y: number;
    };
    toCssString(): string;
    setTo(model: MatModel): this;
    decompose(): {
        rotation: number;
        scaleX: number;
        scaleY: number;
        x: number;
        y: number;
    };
    clone(): Mat;
    static Identity(): Mat;
    static Translate(x: number, y: number): Mat;
    static Rotate(r: number, cx?: number, cy?: number): Mat;
    static Scale(x: number, y: number): Mat;
    static Scale(x: number, y: number, cx: number, cy: number): Mat;
    static Multiply(m1: MatModel, m2: MatModel): MatModel;
    static Inverse(m: MatModel): MatModel;
    static Absolute(m: MatLike): MatModel;
    static Compose(...matrices: MatLike[]): Mat;
    static Point(m: MatLike): Vec;
    static Rotation(m: MatLike): number;
    static Decompose(m: MatLike): {
        rotation: number;
        scaleX: number;
        scaleY: number;
        x: number;
        y: number;
    };
    static Smooth(m: MatLike, precision?: number): MatLike;
    static toCssString(m: MatLike): string;
    static applyToPoint(m: MatLike, point: VecLike): Vec;
    static applyToXY(m: MatLike, x: number, y: number): number[];
    static applyToPoints(m: MatLike, points: VecLike[]): Vec[];
    static applyToBounds(m: MatLike, box: Box): Box;
    static From(m: MatLike): Mat;
    static Cast(m: MatLike): Mat;
}
/** @public */
export declare function decomposeMatrix(m: MatLike): {
    rotation: number;
    scaleX: number;
    scaleY: number;
    x: number;
    y: number;
};
//# sourceMappingURL=Mat.d.ts.map