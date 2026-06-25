import { TLShape } from '@tldraw/tlschema';
import { TLBaseBoxShape } from '../../shapes/BaseBoxShapeUtil';
import { StateNode, TLStateNodeConstructor } from '../StateNode';
/** @public */
export declare abstract class BaseBoxShapeTool extends StateNode {
    static id: string;
    static initial: string;
    static children(): TLStateNodeConstructor[];
    abstract shapeType: TLBaseBoxShape['type'];
    onCreate?(_shape: TLShape | null): void | null;
}
//# sourceMappingURL=BaseBoxShapeTool.d.ts.map