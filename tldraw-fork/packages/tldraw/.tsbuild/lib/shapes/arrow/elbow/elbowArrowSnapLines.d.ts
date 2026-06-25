import { Editor, TLShapeId, VecLike } from '@tldraw/editor';
/**
 * A snap line for an elbow arrow segment.
 *
 * This should already belong to ElbowArrowSnapLines establishing an angle of the line.
 */
interface ElbowArrowSnapLine {
    /** The id of the shape that the snap line starts from. */
    startBoundShapeId: TLShapeId | undefined;
    /** The id of the shape that the snap line ends at. */
    endBoundShapeId: TLShapeId | undefined;
    /** The perpendicular distance from the snap line to the origin. */
    perpDistance: number;
}
/**
 * A map from an angle (0-π) to a set of snap lines. Snap lines are stored in page space. They're
 * modelled as an angle (the angle of the line itself) and a perpendicular signed distance from the
 * page origin. Each line is effectively infinite in length, but modelling them in this way makes it
 * pretty efficient for us to query for relevant snap lines.
 */
type ElbowArrowSnapLines = Map<number, Set<ElbowArrowSnapLine>>;
export declare function getElbowArrowSnapLines(editor: Editor): ElbowArrowSnapLines;
/**
 * Return the signed distance from the origin to a point on a line of angle `lineAngle` that passes
 * through the point `pointOnLine`.
 */
export declare function perpDistanceToLineAngle(pointOnLine: VecLike, lineAngle: number): number;
/**
 * Return the signed distance from the origin to the line segment defined by `A` and `B`.
 */
export declare function perpDistanceToLine(A: VecLike, B: VecLike): number;
export {};
//# sourceMappingURL=elbowArrowSnapLines.d.ts.map