import { T } from '@tldraw/validate';
import { VecModel } from '../misc/geometry-types';
import { RecordProps } from '../recordsWithProps';
import { TLDefaultColorStyle } from '../styles/TLColorStyle';
import { TLDefaultDashStyle } from '../styles/TLDashStyle';
import { TLDefaultFillStyle } from '../styles/TLFillStyle';
import { TLDefaultSizeStyle } from '../styles/TLSizeStyle';
import { TLBaseShape } from './TLBaseShape';
/**
 * A segment of a draw shape representing either freehand drawing or straight line segments.
 *
 * @public
 */
export interface TLDrawShapeSegment {
    /** Type of drawing segment - 'free' for freehand curves, 'straight' for line segments */
    type: 'free' | 'straight';
    /**
     * Delta-encoded base64 path data.
     * First point stored as Float32 (12 bytes) for precision, subsequent points as Float16 deltas (6 bytes each).
     */
    path: string;
}
/**
 * Validator for draw shape segments ensuring proper structure and data types.
 *
 * @public
 */
export declare const DrawShapeSegment: T.ObjectValidator<TLDrawShapeSegment>;
/**
 * Properties for the draw shape, which represents freehand drawing and sketching.
 *
 * @public
 */
export interface TLDrawShapeProps {
    /** Color style for the drawing stroke */
    color: TLDefaultColorStyle;
    /** Fill style for closed drawing shapes */
    fill: TLDefaultFillStyle;
    /** Dash pattern style for the stroke */
    dash: TLDefaultDashStyle;
    /** Size/thickness of the drawing stroke */
    size: TLDefaultSizeStyle;
    /** Array of segments that make up the complete drawing path */
    segments: TLDrawShapeSegment[];
    /** Whether the drawing is complete (user finished drawing) */
    isComplete: boolean;
    /** Whether the drawing path forms a closed shape */
    isClosed: boolean;
    /** Whether this drawing was created with a pen/stylus device */
    isPen: boolean;
    /** Scale factor applied to the drawing */
    scale: number;
    /** Horizontal scale factor for lazy resize */
    scaleX: number;
    /** Vertical scale factor for lazy resize */
    scaleY: number;
}
/**
 * A draw shape represents freehand drawing, sketching, and pen input on the canvas.
 * Draw shapes are composed of segments that can be either smooth curves or straight lines.
 *
 * @public
 * @example
 * ```ts
 * const drawShape: TLDrawShape = {
 *   id: createShapeId(),
 *   typeName: 'shape',
 *   type: 'draw',
 *   x: 50,
 *   y: 50,
 *   rotation: 0,
 *   index: 'a1',
 *   parentId: 'page:page1',
 *   isLocked: false,
 *   opacity: 1,
 *   props: {
 *     color: 'black',
 *     fill: 'none',
 *     dash: 'solid',
 *     size: 'm',
 *     segments: [{
 *       type: 'free',
 *       points: [{ x: 0, y: 0, z: 0.5 }, { x: 20, y: 15, z: 0.6 }]
 *     }],
 *     isComplete: true,
 *     isClosed: false,
 *     isPen: false,
 *     scale: 1
 *   },
 *   meta: {}
 * }
 * ```
 */
export type TLDrawShape = TLBaseShape<'draw', TLDrawShapeProps>;
/**
 * Validation schema for draw shape properties.
 *
 * @public
 * @example
 * ```ts
 * // Validate draw shape properties
 * const props = {
 *   color: 'red',
 *   fill: 'solid',
 *   segments: [{ type: 'free', points: [] }],
 *   isComplete: true
 * }
 * const isValid = drawShapeProps.color.isValid(props.color)
 * ```
 */
/** @public */
export declare const drawShapeProps: RecordProps<TLDrawShape>;
declare const Versions: {
    readonly AddInPen: "com.tldraw.shape.draw/1";
    readonly AddScale: "com.tldraw.shape.draw/2";
    readonly Base64: "com.tldraw.shape.draw/3";
    readonly LegacyPointsConversion: "com.tldraw.shape.draw/4";
};
/**
 * Version identifiers for draw shape migrations.
 *
 * @public
 */
export { Versions as drawShapeVersions };
/**
 * Migration sequence for draw shape properties across different schema versions.
 * Handles adding pen detection and scale properties to existing draw shapes.
 *
 * @public
 */
export declare const drawShapeMigrations: import("..").TLPropsMigrations;
/**
 * Compress legacy draw shape segments by converting VecModel[] points to delta-encoded base64 format.
 * This function is useful for converting old draw shape data to the new compressed format.
 * Uses delta encoding for improved Float16 precision.
 *
 * @public
 */
export declare function compressLegacySegments(segments: {
    type: 'free' | 'straight';
    points: VecModel[];
}[]): TLDrawShapeSegment[];
//# sourceMappingURL=TLDrawShape.d.ts.map