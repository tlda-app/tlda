import { Editor, TLArrowShape, VecLike } from '@tldraw/editor';
import { TLArrowBindings } from '../shared';
import { ElbowArrowEdge, ElbowArrowInfo, ElbowArrowOptions, ElbowArrowRoute, ElbowArrowTerminal } from './definitions';
export declare function getElbowArrowInfo(editor: Editor, arrow: TLArrowShape, bindings: TLArrowBindings, arrowStrokeWidth?: number): ElbowArrowInfo;
/**
 * Take the route from `getElbowArrowInfo` (which represents the visible body of the arrow) and
 * convert it into a path we can use to show that paths to the handles, which may extend further
 * into the target shape geometries.
 * @returns
 */
export declare function getRouteHandlePath(info: ElbowArrowInfo, route: ElbowArrowRoute): ElbowArrowRoute;
/**
 * Take a normalizes anchor and return the side we think it's closest to.
 */
export declare function getEdgeFromNormalizedAnchor(normalizedAnchor: VecLike): "bottom" | "left" | "right" | "top" | null;
export declare function getUsableEdge(a: ElbowArrowTerminal, b: ElbowArrowTerminal, side: 'top' | 'right' | 'bottom' | 'left', options: ElbowArrowOptions): ElbowArrowEdge | null;
//# sourceMappingURL=getElbowArrowInfo.d.ts.map