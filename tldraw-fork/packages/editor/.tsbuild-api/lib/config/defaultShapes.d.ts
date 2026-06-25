import { GroupShapeUtil } from '../editor/shapes/group/GroupShapeUtil';
import { TLShapeUtilConstructor } from '../editor/shapes/ShapeUtil';
/** @public */
export type TLAnyShapeUtilConstructor = TLShapeUtilConstructor<any>;
/** @public */
export declare const coreShapes: readonly [typeof GroupShapeUtil];
export declare function checkShapesAndAddCore(customShapes: readonly TLAnyShapeUtilConstructor[]): TLAnyShapeUtilConstructor[];
//# sourceMappingURL=defaultShapes.d.ts.map