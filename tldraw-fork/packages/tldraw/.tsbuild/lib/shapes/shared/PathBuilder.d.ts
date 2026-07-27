import { Geometry2d, Geometry2dFilters, Geometry2dOptions, Group2d, PerfectDashTerminal, Vec, VecLike, VecModel } from '@tldraw/editor';
import { SVGProps } from 'react';
/** @public */
export interface BasePathBuilderOpts {
    strokeWidth: number;
    forceSolid?: boolean;
    onlyFilled?: boolean;
    props?: SVGProps<SVGPathElement & SVGGElement>;
}
/** @public */
export interface SolidPathBuilderOpts extends BasePathBuilderOpts {
    style: 'solid';
}
/** @public */
export interface DashedPathBuilderOpts extends BasePathBuilderOpts {
    style: 'dashed' | 'dotted';
    snap?: number;
    end?: PerfectDashTerminal;
    start?: PerfectDashTerminal;
    lengthRatio?: number;
}
/** @public */
export interface DrawPathBuilderDOpts {
    strokeWidth: number;
    randomSeed: string;
    offset?: number;
    roundness?: number;
    passes?: number;
    onlyFilled?: boolean;
}
/** @public */
export interface DrawPathBuilderOpts extends BasePathBuilderOpts, DrawPathBuilderDOpts {
    style: 'draw';
}
/** @public */
export interface NonePathBuilderOpts extends BasePathBuilderOpts {
    style: 'none';
}
/** @public */
export type PathBuilderOpts = SolidPathBuilderOpts | DashedPathBuilderOpts | DrawPathBuilderOpts | NonePathBuilderOpts;
/** @public */
export interface PathBuilderCommandOpts {
    /**
     * When converting to a draw-style line, how much offset from the original point should be
     * applied?
     */
    offset?: number;
    /**
     * When converting to a draw-style line, how much roundness should be applied to the end of this
     * line?
     */
    roundness?: number;
    /**
     * When converting to a dash- or dot-style line, should the current segment be merged with the
     * previous segment when calculating the dash pattern? This is false by default, meaning each
     * command will start/end on a dash/dot boundary.
     */
    mergeWithPrevious?: boolean;
}
/** @internal */
export interface PathBuilderCommandInfo {
    tangentStart: VecModel;
    tangentEnd: VecModel;
    length: number;
}
/** @internal */
export interface PathBuilderCommandBase {
    opts?: PathBuilderCommandOpts;
    x: number;
    y: number;
    isClose: boolean;
    _info?: PathBuilderCommandInfo;
}
/** @public */
export interface PathBuilderLineOpts extends PathBuilderCommandOpts {
    geometry?: Omit<Geometry2dOptions, 'isClosed'> | false;
    dashStart?: PerfectDashTerminal;
    dashEnd?: PerfectDashTerminal;
}
/** @internal */
export interface MoveToPathBuilderCommand extends PathBuilderCommandBase {
    type: 'move';
    closeIdx: number | null;
    opts?: PathBuilderLineOpts;
}
/** @internal */
export interface LineToPathBuilderCommand extends PathBuilderCommandBase {
    type: 'line';
}
/** @internal */
export interface CubicBezierToPathBuilderCommand extends PathBuilderCommandBase {
    type: 'cubic';
    cp1: VecModel;
    cp2: VecModel;
    resolution?: number;
}
/** @internal */
export type PathBuilderCommand = MoveToPathBuilderCommand | LineToPathBuilderCommand | CubicBezierToPathBuilderCommand;
/** @public */
export interface PathBuilderToDOpts {
    startIdx?: number;
    endIdx?: number;
    onlyFilled?: boolean;
}
/** @public */
export declare class PathBuilder {
    static lineThroughPoints(points: VecLike[], opts?: PathBuilderLineOpts & {
        endOffsets?: number;
    }): PathBuilder;
    static cubicSplineThroughPoints(points: VecLike[], opts?: PathBuilderLineOpts & {
        endOffsets?: number;
    }): PathBuilder;
    constructor();
    /** @internal */
    commands: PathBuilderCommand[];
    private lastMoveTo;
    private assertHasMoveTo;
    moveTo(x: number, y: number, opts?: PathBuilderLineOpts): this;
    lineTo(x: number, y: number, opts?: PathBuilderCommandOpts): this;
    circularArcTo(radius: number, largeArcFlag: boolean, sweepFlag: boolean, x2: number, y2: number, opts?: PathBuilderCommandOpts): this;
    arcTo(rx: number, ry: number, largeArcFlag: boolean, sweepFlag: boolean, xAxisRotationRadians: number, x2: number, y2: number, opts?: PathBuilderCommandOpts): this;
    cubicBezierTo(x: number, y: number, cp1X: number, cp1Y: number, cp2X: number, cp2Y: number, opts?: PathBuilderCommandOpts): this;
    private cubicBezierToWithResolution;
    close(): this;
    toD(opts?: PathBuilderToDOpts): string;
    toSvg(opts: PathBuilderOpts): import("react/jsx-runtime").JSX.Element | null;
    toPath2D(opts: PathBuilderOpts): Path2D;
    toGeometry(): PathBuilderGeometry2d | Group2d;
    private toSolidSvg;
    private toDashedSvg;
    private toDrawSvg;
    toDrawD(opts: DrawPathBuilderDOpts): string;
    private calculateSegmentLength;
    /** @internal */
    getCommands(): readonly PathBuilderCommand[];
    /** @internal */
    getCommandInfo(): (PathBuilderCommandInfo | undefined)[];
}
/** @public */
export declare class PathBuilderGeometry2d extends Geometry2d {
    private readonly path;
    private readonly startIdx;
    private readonly endIdx;
    constructor(path: PathBuilder, startIdx: number, endIdx: number, options: Geometry2dOptions);
    private _segments;
    getSegments(): Geometry2d[];
    getVertices(filters: Geometry2dFilters): Vec[];
    nearestPoint(point: VecLike, _filters?: Geometry2dFilters): Vec;
    hitTestLineSegment(A: VecLike, B: VecLike, distance?: number, filters?: Geometry2dFilters): boolean;
    getSvgPathData(): string;
}
//# sourceMappingURL=PathBuilder.d.ts.map